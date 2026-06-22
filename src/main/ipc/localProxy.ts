import { ipcMain } from 'electron'
import * as http from 'http'
import * as net from 'net'
import { randomUUID } from 'crypto'
import { readSettingsSync } from './workspace'
import { bus } from '../event-bus'

interface ConnectionRecord {
  id: string
  remoteAddr: string
  model: string
  backend: string
  startedAt: number
  requestCount: number
}

interface ProxyStats {
  requestsServed: number
  requestsFailed: number
  startedAt: number | null
  activeConnections: ConnectionRecord[]
}

// Module-level singleton
let proxyServer: http.Server | null = null
let proxyPort: number | null = null
let proxyToken: string | null = null
let stats: ProxyStats = {
  requestsServed: 0,
  requestsFailed: 0,
  startedAt: null,
  activeConnections: [],
}
let connCounter = 0

// Known local backends to probe in order
const LOCAL_BACKENDS = [
  { name: 'Ollama', base: 'http://localhost:11434', chatPath: '/api/chat', format: 'ollama' },
  { name: 'LM Studio', base: 'http://localhost:1234', chatPath: '/v1/chat/completions', format: 'openai' },
  { name: 'llama.cpp', base: 'http://localhost:8080', chatPath: '/v1/chat/completions', format: 'openai' },
]

async function probeBackend(base: string, path: string): Promise<boolean> {
  return new Promise(resolve => {
    const url = new URL(base)
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path,
      method: 'GET',
      timeout: 800,
    }
    const req = http.request(options, res => {
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.end()
  })
}

async function findLiveBackend(): Promise<typeof LOCAL_BACKENDS[0] | null> {
  for (const backend of LOCAL_BACKENDS) {
    const live = await probeBackend(backend.base, backend.chatPath)
    if (live) return backend
  }
  return null
}

// Transform Anthropic messages request → OpenAI chat completions request
function anthropicToOpenAI(body: Record<string, unknown>): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = []

  if (typeof body.system === 'string' && body.system) {
    messages.push({ role: 'system', content: body.system })
  }

  const incoming = body.messages as Array<{ role: string; content: unknown }> ?? []
  for (const m of incoming) {
    let text = ''
    if (typeof m.content === 'string') {
      text = m.content
    } else if (Array.isArray(m.content)) {
      // content blocks — extract text parts
      text = (m.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text')
        .map(b => b.text ?? '')
        .join('')
    }
    messages.push({ role: m.role, content: text })
  }

  return {
    model: body.model ?? 'default',
    messages,
    max_tokens: body.max_tokens ?? 4096,
    temperature: body.temperature ?? 1,
    stream: body.stream ?? false,
    stop: body.stop_sequences ?? undefined,
  }
}

// Transform Anthropic messages request → Ollama format
function anthropicToOllama(body: Record<string, unknown>): Record<string, unknown> {
  const openai = anthropicToOpenAI(body)
  return {
    model: openai.model,
    messages: openai.messages,
    stream: openai.stream,
    options: { temperature: openai.temperature },
  }
}

// Buffer a streamed response body
function bufferBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    res.on('error', reject)
  })
}

// Forward a proxied request and pipe back the response
function forwardRequest(
  backendBase: string,
  backendPath: string,
  outgoingBody: string,
  stream: boolean,
  clientRes: http.ServerResponse,
  onDone: (ok: boolean) => void,
): void {
  const url = new URL(backendBase)
  const options: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || 80,
    path: backendPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(outgoingBody),
    },
    timeout: 120_000,
  }

  const backendReq = http.request(options, backendRes => {
    if (stream) {
      // Set up Anthropic SSE response headers
      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })

      // Write message_start
      const msgId = `msg_${Date.now().toString(36)}`
      clientRes.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { id: msgId, type: 'message', role: 'assistant', model: '', content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
      })}\n\n`)
      clientRes.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)

      let buf = ''
      backendRes.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8')
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim() || line === 'data: [DONE]') continue
          const dataPart = line.startsWith('data: ') ? line.slice(6) : line
          try {
            const parsed = JSON.parse(dataPart)
            // Ollama format: parsed.message.content
            // OpenAI format: parsed.choices[0].delta.content
            let text: string | null = null
            if (parsed.message?.content !== undefined) {
              text = parsed.message.content
            } else if (parsed.choices?.[0]?.delta?.content !== undefined) {
              text = parsed.choices[0].delta.content
            }
            if (text !== null && text !== '') {
              clientRes.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text },
              })}\n\n`)
            }
            // Detect done signals
            const done = parsed.done === true || parsed.choices?.[0]?.finish_reason != null
            if (done) {
              clientRes.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
              clientRes.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })}\n\n`)
              clientRes.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
              clientRes.end()
              onDone(true)
            }
          } catch {
            // skip malformed lines
          }
        }
      })

      backendRes.on('end', () => {
        if (!clientRes.writableEnded) {
          clientRes.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
          clientRes.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
          clientRes.end()
        }
        onDone(true)
      })

      backendRes.on('error', () => {
        if (!clientRes.writableEnded) clientRes.end()
        onDone(false)
      })
    } else {
      // Non-streaming: buffer, transform, respond
      bufferBody(backendRes).then(raw => {
        let anthropicResponse: Record<string, unknown>
        try {
          const parsed = JSON.parse(raw)
          // Normalise OpenAI/Ollama non-stream response → Anthropic Messages response
          let text = ''
          if (parsed.message?.content) text = parsed.message.content
          else if (parsed.choices?.[0]?.message?.content) text = parsed.choices[0].message.content

          anthropicResponse = {
            id: `msg_${Date.now().toString(36)}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text }],
            model: parsed.model ?? '',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          }
        } catch {
          anthropicResponse = { error: { type: 'api_error', message: 'Backend parse error' } }
        }
        const responseBody = JSON.stringify(anthropicResponse)
        clientRes.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(responseBody),
        })
        clientRes.end(responseBody)
        onDone(true)
      }).catch(() => {
        clientRes.writeHead(502)
        clientRes.end(JSON.stringify({ error: { type: 'api_error', message: 'Backend error' } }))
        onDone(false)
      })
    }
  })

  backendReq.on('error', () => {
    if (!clientRes.writableEnded) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: { type: 'api_error', message: 'Backend unreachable' } }))
    }
    onDone(false)
  })

  backendReq.write(outgoingBody)
  backendReq.end()
}

function createProxyServer(_port: number, token: string): http.Server {
  const server = http.createServer(async (req, clientRes) => {
    // CORS preflight — this server is loopback-only and called from the main
    // process (Node http.request) or via Electron IPC; no browser cross-origin
    // fetch should be reaching it.  Reject preflight requests outright rather
    // than advertising a wildcard origin that any local web page could exploit.
    if (req.method === 'OPTIONS') {
      clientRes.writeHead(405)
      clientRes.end()
      return
    }

    // Health check — no auth required (no sensitive data exposed)
    if (req.method === 'GET' && req.url === '/health') {
      clientRes.writeHead(200, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ status: 'ok', uptime: stats.startedAt ? Date.now() - stats.startedAt : 0 }))
      return
    }

    // Bearer token auth — prevent any local process from using the proxy
    // without presenting the per-session token.
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      clientRes.writeHead(401, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: { type: 'authentication_error', message: 'Missing or invalid bearer token' } }))
      return
    }

    // Only handle messages endpoint
    if (req.method !== 'POST' || req.url !== '/v1/messages') {
      clientRes.writeHead(404, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: { type: 'not_found', message: 'Only /v1/messages is proxied' } }))
      return
    }

    // Read request body
    const rawChunks: Buffer[] = []
    for await (const chunk of req as AsyncIterable<Buffer>) rawChunks.push(chunk)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(Buffer.concat(rawChunks).toString('utf8'))
    } catch {
      clientRes.writeHead(400, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Invalid JSON' } }))
      return
    }

    const backend = await findLiveBackend()
    if (!backend) {
      clientRes.writeHead(503, { 'Content-Type': 'application/json' })
      clientRes.end(JSON.stringify({ error: { type: 'api_error', message: 'No local backend found. Start Ollama, LM Studio, or llama.cpp first.' } }))
      stats.requestsFailed++
      return
    }

    const stream = body.stream === true
    let outgoingBody: string
    if (backend.format === 'ollama') {
      outgoingBody = JSON.stringify(anthropicToOllama(body))
    } else {
      outgoingBody = JSON.stringify(anthropicToOpenAI(body))
    }

    const connId = `conn_${++connCounter}`
    const conn: ConnectionRecord = {
      id: connId,
      remoteAddr: req.socket.remoteAddress ?? 'unknown',
      model: String(body.model ?? 'unknown'),
      backend: backend.name,
      startedAt: Date.now(),
      requestCount: 1,
    }
    stats.activeConnections.push(conn)

    forwardRequest(backend.base, backend.chatPath, outgoingBody, stream, clientRes, ok => {
      if (ok) stats.requestsServed++
      else stats.requestsFailed++
      stats.activeConnections = stats.activeConnections.filter(c => c.id !== connId)
      bus.publish({ channel: 'localProxy:stats', type: 'data', source: 'localProxy', payload: { action: 'update', ...stats } })
    })
  })

  return server
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => { tester.close(); resolve(true) })
    tester.listen(port, '127.0.0.1')
  })
}

export function getProxyStatus(): { running: boolean; port: number; token: string | null; stats: ProxyStats } {
  const settings = readSettingsSync()
  return {
    running: proxyServer !== null,
    port: proxyPort ?? settings.localProxyPort ?? 1337,
    token: proxyToken,
    stats: { ...stats, activeConnections: [...stats.activeConnections] },
  }
}

async function startProxyServer(port: number): Promise<{ ok: boolean; port?: number; message?: string }> {
  if (proxyServer) {
    if (proxyPort === port) return { ok: true, port }
    return { ok: false, message: `Proxy already running on port ${proxyPort}` }
  }

  const free = await isPortFree(port)
  if (!free) {
    return { ok: false, message: `Port ${port} is already in use` }
  }

  return new Promise(resolve => {
    try {
      proxyToken = randomUUID()
      proxyServer = createProxyServer(port, proxyToken)
      proxyServer.listen(port, '127.0.0.1', () => {
        proxyPort = port
        stats = { requestsServed: 0, requestsFailed: 0, startedAt: Date.now(), activeConnections: [] }
        bus.publish({ channel: 'localProxy:stats', type: 'data', source: 'localProxy', payload: { action: 'started', port } })
        resolve({ ok: true, port })
      })
      proxyServer.on('error', (err: NodeJS.ErrnoException) => {
        proxyServer = null
        proxyPort = null
        proxyToken = null
        resolve({ ok: false, message: err.message })
      })
    } catch (err: unknown) {
      proxyServer = null
      proxyPort = null
      resolve({ ok: false, message: String(err) })
    }
  })
}

export async function ensureLocalProxyRunning(portOverride?: number): Promise<{ ok: boolean; port?: number; message?: string }> {
  const settings = readSettingsSync()
  return startProxyServer(portOverride ?? settings.localProxyPort ?? 1337)
}

export function registerLocalProxyIPC(): void {
  ipcMain.handle('localProxy:start', async () => {
    if (proxyServer) return { ok: true, message: 'Already running' }
    return ensureLocalProxyRunning()
  })

  ipcMain.handle('localProxy:stop', async () => {
    if (!proxyServer) return { ok: true, message: 'Not running' }
    return new Promise(resolve => {
      proxyServer!.close(() => {
        proxyServer = null
        proxyPort = null
        proxyToken = null
        stats = { ...stats, startedAt: null, activeConnections: [] }
        bus.publish({ channel: 'localProxy:stats', type: 'data', source: 'localProxy', payload: { action: 'stopped' } })
        resolve({ ok: true })
      })
    })
  })

  ipcMain.handle('localProxy:getStatus', () => getProxyStatus())

  ipcMain.handle('localProxy:probeBackends', async () => {
    const results = await Promise.all(
      LOCAL_BACKENDS.map(async b => ({
        name: b.name,
        base: b.base,
        live: await probeBackend(b.base, b.chatPath),
      }))
    )
    return results
  })
}
