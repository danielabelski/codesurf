import { spawn, execFileSync } from 'child_process'
import { getAgentPath, getShellEnvPath } from '../../agent-paths'
import { buildSafeSpawnEnv } from '../../ipc/terminal-helpers'
import {
  sanitizeAgentCliDiagnostic,
} from '../../agents/agent-cli-contracts'
import { buildHermesSpawnArgs } from './agent-mode-payloads'
import {
  activeProcesses,
  chatRequestScope,
  chatStreamScopeKey,
  getPreparedMessages,
  log,
  sendStream,
  type ChatStreamScope,
} from '../runtime'
import type { ChatRequest } from '../types'

// Store hermes session IDs for multi-turn resume
const hermesSessionIds = new Map<string, string>()

function resolveHermesBinary(): string | null {
  const detected = getAgentPath('hermes')
  if (detected) return detected
  try {
    const shellPath = getShellEnvPath()
    return execFileSync('which', ['hermes'], {
      encoding: 'utf-8',
      env: buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) }),
    }).trim() || null
  } catch {
    return null
  }
}

export function clearHermesSession(scope: ChatStreamScope): void {
  hermesSessionIds.delete(chatStreamScopeKey(scope))
}

export function chatHermes(req: ChatRequest): void {
  const scope = chatRequestScope(req)
  const scopeKey = chatStreamScopeKey(scope)
  const lastUserMsg = [...getPreparedMessages(req)].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(scope, { type: 'error', error: 'No user message' })
    return
  }

  const hermesBin = resolveHermesBinary()
  if (!hermesBin) {
    sendStream(scope, { type: 'error', error: 'Hermes CLI not found. Install: pip install hermes-agent' })
    return
  }

  const shellPath = getShellEnvPath()
  if (req.sessionId && !hermesSessionIds.has(scopeKey)) {
    hermesSessionIds.set(scopeKey, req.sessionId)
  }
  const existingSessionId = hermesSessionIds.get(scopeKey)

  log('chatHermes starting', {
    model: req.model,
    prompt: lastUserMsg.content.slice(0, 100),
    resuming: !!existingSessionId,
  })

  // Build the `hermes chat` argv from the shared, pure builder. It maps
  // AgentMode.tools onto Hermes' coarse toolset categories, re-injects the
  // persona on resumed turns (A-PR1 #1a), and FAILS CLOSED (throws) if a
  // selected agent's definition has not resolved (A-PR1 BLOCKING-1) — caught
  // below so we surface the reason instead of launching unrestricted.
  let args: string[]
  try {
    args = buildHermesSpawnArgs({
      agentId: req.agentId,
      agentMode: req.agentMode,
      mode: req.mode,
      model: req.model,
      userContent: lastUserMsg.content,
      existingSessionId,
      contextPrompt: req.contextPrompt,
    })
  } catch (err) {
    sendStream(scope, { type: 'error', error: err instanceof Error ? err.message : String(err) })
    sendStream(scope, { type: 'done' })
    return
  }

  const proc = spawn(hermesBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) }),
    ...(req.workspaceDir && { cwd: req.workspaceDir }),
  })

  activeProcesses.set(scopeKey, proc)

  // H-9: identity-guard — only clean up / emit done|error if this proc is
  // still the active one for this card. A rapid re-send replaces the map
  // entry before the old proc's close handler fires, so we must check first.
  const isCurrent = (): boolean => activeProcesses.get(scopeKey) === proc

  // NDJSON line dispatcher. Hermes' --stream-json mode emits one JSON event
  // per line on stdout, mapping directly to CodeSurf's existing stream event
  // schema (type: text | thinking | tool_start | tool_input | tool_summary
  // | session | error | done). Unparseable lines are treated as raw text so
  // an older Hermes binary that doesn't recognise --stream-json (and falls
  // through to plain output) still produces *something* in the UI rather
  // than silence.
  let stdoutBuf = ''
  const dispatchHermesEvents = (chunk: string, flushPartial = false): void => {
    stdoutBuf += chunk
    const lines = stdoutBuf.split(/\r?\n/)
    stdoutBuf = flushPartial ? '' : (lines.pop() ?? '')

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // Legacy fallback: plain "session_id: …" sentinel from a binary
      // without --stream-json. Surface it the way the old streamer did.
      const sessionLineMatch = trimmed.match(/^(?:session_id|session)\s*:\s*(\S+)$/i)
      if (sessionLineMatch?.[1]) {
        const sid = sessionLineMatch[1]
        hermesSessionIds.set(scopeKey, sid)
        sendStream(scope, { type: 'session', sessionId: sid })
        continue
      }

      let evt: any
      try {
        evt = JSON.parse(trimmed)
      } catch {
        sendStream(scope, { type: 'text', text: line + '\n' })
        continue
      }
      if (!evt || typeof evt !== 'object' || typeof evt.type !== 'string') {
        continue
      }

      switch (evt.type) {
        case 'session':
          if (typeof evt.sessionId === 'string' && evt.sessionId.trim()) {
            const sid = evt.sessionId.trim()
            hermesSessionIds.set(scopeKey, sid)
            sendStream(scope, { type: 'session', sessionId: sid })
          }
          break
        case 'text':
          if (typeof evt.text === 'string') {
            sendStream(scope, { type: 'text', text: evt.text })
          }
          break
        case 'thinking':
          if (typeof evt.text === 'string') {
            sendStream(scope, { type: 'thinking', text: evt.text })
          }
          break
        case 'tool_start':
          sendStream(scope, {
            type: 'tool_start',
            toolId: typeof evt.toolId === 'string' ? evt.toolId : undefined,
            toolName: typeof evt.toolName === 'string' ? evt.toolName : 'tool',
          })
          break
        case 'tool_input':
          sendStream(scope, {
            type: 'tool_input',
            toolId: typeof evt.toolId === 'string' ? evt.toolId : undefined,
            text: typeof evt.text === 'string' ? evt.text : '',
          })
          break
        case 'tool_summary':
          sendStream(scope, {
            type: 'tool_summary',
            toolId: typeof evt.toolId === 'string' ? evt.toolId : undefined,
            toolName: typeof evt.toolName === 'string' ? evt.toolName : undefined,
            text: typeof evt.text === 'string' ? evt.text : '',
          })
          break
        case 'error':
          sendStream(scope, {
            type: 'error',
            error: typeof evt.error === 'string' ? evt.error : 'Unknown Hermes error',
          })
          break
        case 'done':
          // Suppressed here — emitted from proc.on('close') below so we
          // always get a final 'done' even if Hermes exits mid-stream.
          break
        default:
          // Forward unrecognized event verbatim; the renderer can filter.
          sendStream(scope, evt as Record<string, unknown>)
      }
    }
  }

  proc.stdout?.on('data', (chunk: Buffer) => {
    dispatchHermesEvents(chunk.toString(), false)
  })

  let stderrBuf = ''
  proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString() })

  proc.on('close', (code) => {
    if (!isCurrent()) return // superseded by a new turn — suppress stale done/error
    dispatchHermesEvents('', true)
    activeProcesses.delete(scopeKey)
    if (code !== 0 && stderrBuf.trim()) {
      sendStream(scope, { type: 'error', error: sanitizeAgentCliDiagnostic(stderrBuf.trim()) })
    }
    sendStream(scope, { type: 'done' })
  })

  proc.on('error', (err) => {
    if (!isCurrent()) return // superseded — new turn owns the slot
    activeProcesses.delete(scopeKey)
    sendStream(scope, {
      type: 'error',
      error: err.message.includes('ENOENT')
        ? 'Hermes CLI not found. Install: pip install hermes-agent'
        : err.message,
    })
  })
}
