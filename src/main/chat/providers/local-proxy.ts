/**
 * Extension local-proxy transport — HTTP POST to an Anthropic-/messages-shaped endpoint.
 */

import * as http from 'http'
import { parseClaudeStream } from '../../agent-stream'
import { ensureLocalProxyRunning } from '../../ipc/localProxy'
import type { ChatRequest } from '../types'
import {
  activeHttpRequests,
  chatRequestScope,
  chatStreamScopeKey,
  getPreparedMessages,
  sendStream,
} from '../runtime'

function bufferHttpResponse(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    res.on('data', (chunk: Buffer) => chunks.push(chunk))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    res.on('error', reject)
  })
}

export function chatLocalProxy(req: ChatRequest): void {
  const scope = chatRequestScope(req)
  const scopeKey = chatStreamScopeKey(scope)
  const transport = req.providerTransport
  if (!transport || transport.type !== 'local-proxy') {
    sendStream(scope, { type: 'error', error: `Unsupported provider: ${req.provider}` })
    sendStream(scope, { type: 'done' })
    return
  }

  void (async () => {
    if (transport.autoStart !== false) {
      const configuredPort = (() => {
        try {
          const url = new URL(transport.baseUrl)
          return url.port ? Number(url.port) : 80
        } catch {
          return undefined
        }
      })()
      const started = await ensureLocalProxyRunning(configuredPort)
      if (!started.ok) {
        throw new Error(started.message || 'Failed to start the local proxy')
      }
    }

    const baseUrl = transport.baseUrl.replace(/\/+$/, '')
    const targetUrl = new URL(`${baseUrl}/messages`)
    const body = JSON.stringify({
      model: req.model,
      stream: true,
      max_tokens: 4096,
      messages: getPreparedMessages(req).map(message => ({
        role: message.role,
        content: message.content,
      })),
    })

    const request = http.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port ? Number(targetUrl.port) : 80,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'anthropic-version': '2023-06-01',
        ...(transport.apiKey ? {
          'x-api-key': transport.apiKey,
          Authorization: `Bearer ${transport.apiKey}`,
        } : {}),
      },
      timeout: 120_000,
    }, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        void bufferHttpResponse(res).then((raw) => {
          activeHttpRequests.delete(scopeKey)
          let errorMessage = `Proxy request failed (${res.statusCode ?? 500})`
          try {
            const parsed = JSON.parse(raw)
            errorMessage = parsed?.error?.message ?? errorMessage
          } catch {
            if (raw.trim()) errorMessage = raw.trim()
          }
          sendStream(scope, { type: 'error', error: errorMessage })
          sendStream(scope, { type: 'done' })
        }).catch((err: Error) => {
          activeHttpRequests.delete(scopeKey)
          sendStream(scope, { type: 'error', error: err.message })
          sendStream(scope, { type: 'done' })
        })
        return
      }

      res.on('close', () => {
        activeHttpRequests.delete(scopeKey)
      })
      parseClaudeStream(req.cardId, res, event => sendStream(scope, { ...event }))
    })

    request.on('timeout', () => {
      request.destroy(new Error('Proxy request timed out'))
    })

    request.on('error', (err) => {
      if (!activeHttpRequests.has(scopeKey)) return
      activeHttpRequests.delete(scopeKey)
      sendStream(scope, { type: 'error', error: err.message })
      sendStream(scope, { type: 'done' })
    })

    activeHttpRequests.set(scopeKey, request)
    request.write(body)
    request.end()
  })().catch((err: Error) => {
    activeHttpRequests.delete(scopeKey)
    sendStream(scope, { type: 'error', error: err.message })
    sendStream(scope, { type: 'done' })
  })
}
