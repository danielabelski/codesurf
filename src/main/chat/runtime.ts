import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { ChildProcess } from 'child_process'
import * as http from 'http'
import { promises as fs, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { CODESURF_HOME } from '../paths'
import { daemonClient } from '../daemon/client'
import { broadcastToRenderer } from '../utils/broadcast'
import { log as scopedLog } from '../utils/logger.ts'
import type { ChatMessage, ChatRequest, RuntimeChatSessionState } from './types'
import {
  acknowledgeThrough,
  publishTurnSummary,
  setMemberState,
} from '../agent-room'
import {
  RoomStreamAccumulator,
  chatStreamScopeKey,
  createChatStreamScope,
  type ChatStreamScope,
} from './room-stream-scope.ts'
import { RoomContextAcknowledgements } from './room-context-acknowledgements.ts'

export type { RuntimeChatSessionState } from './types'
export {
  chatStreamScopeKey,
  createChatStreamScope,
  type ChatStreamScope,
} from './room-stream-scope.ts'

const chatLog = scopedLog.scope('Chat')

export function log(...args: unknown[]): void {
  // Preserve the legacy CODESURF_CHAT_DEBUG gate so existing usage is unchanged,
  // but route through the central logger so output format stays consistent.
  if (process.env.CODESURF_CHAT_DEBUG !== '1') return
  chatLog.debug(...args)
}

const roomStreamAccumulator = new RoomStreamAccumulator(
  (workspaceId, cardId, summary) => {
    try {
      publishTurnSummary(workspaceId, cardId, summary, 'chat')
    } catch {
      // room optional
    }
  },
  (workspaceId, cardId) => {
    try {
      setMemberState(workspaceId, cardId, { tileType: 'chat', status: 'idle' })
    } catch {
      // room optional
    }
  },
)

export function chatRequestScope(
  req: Pick<ChatRequest, 'workspaceId' | 'cardId'>,
): ChatStreamScope {
  return createChatStreamScope(req.workspaceId, req.cardId)
}

const pendingRoomAcknowledgements = new RoomContextAcknowledgements()

function settleRoomContextAcknowledgement(
  scope: ChatStreamScope,
  outcome: 'delivered' | 'failed' | 'stopped',
): void {
  const pending = pendingRoomAcknowledgements.settle(scope, outcome)
  if (!pending) return
  acknowledgeThrough(pending.workspaceId, pending.cardId, pending.sequence)
}

export function registerRoomContextAcknowledgement(req: ChatRequest): void {
  const workspaceId = String(req.workspaceId ?? '').trim()
  const cardId = String(req.cardId ?? '').trim()
  const sequence = req.roomAckSequence
  if (!workspaceId || !cardId || !Number.isSafeInteger(sequence) || Number(sequence) < 0) {
    return
  }
  const scope = createChatStreamScope(workspaceId, cardId)
  pendingRoomAcknowledgements.register(scope, Number(sequence))
}

export function acknowledgeRoomContext(req: ChatRequest): void {
  settleRoomContextAcknowledgement(chatRequestScope(req), 'delivered')
}

export function discardRoomContextAcknowledgement(scope: ChatStreamScope): void {
  settleRoomContextAcknowledgement(scope, 'stopped')
}

export function sendStream(scope: ChatStreamScope, event: Record<string, unknown>): void {
  log('sendStream', event.type, event.text ? `"${String(event.text).slice(0, 50)}"` : '', event.error ?? '')

  if (event.type === 'error') {
    settleRoomContextAcknowledgement(scope, 'failed')
  } else {
    settleRoomContextAcknowledgement(scope, 'delivered')
  }

  roomStreamAccumulator.record(scope, event)

  broadcastToRenderer('agent:stream', {
    workspaceId: scope.workspaceId,
    cardId: scope.cardId,
    ...event,
  })
}

export function cloneChatMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => ({
    role: message.role,
    content: String(message.content ?? ''),
  }))
}

export function getPreparedMessages(req: ChatRequest): ChatMessage[] {
  return Array.isArray(req.expandedMessages) && req.expandedMessages.length > 0
    ? req.expandedMessages
    : req.messages
}

export async function upsertRuntimeSessionState(req: ChatRequest, state: RuntimeChatSessionState): Promise<void> {
  if (!req.workspaceId) return
  try {
    await daemonClient.upsertRuntimeSession(req.workspaceId, req.cardId, state)
  } catch (error) {
    log('upsertRuntimeSession error', req.cardId, error)
  }
}

// Active Claude SDK queries
export const activeQueries = new Map<string, Query>()

// Active CLI subprocesses (codex, openclaw, hermes, etc.)
export const activeProcesses = new Map<string, ChildProcess>()

// Active HTTP requests (proxy-backed providers)
export const activeHttpRequests = new Map<string, http.ClientRequest>()

// Stored session IDs for multi-turn conversations. New entries are explicitly
// workspace scoped. Legacy card-only entries are retained on load/write so an
// older app can still read the file, but scoped requests never claim them.
export const sessionIds = new Map<string, string>()

export function sessionStorageKey(scope: ChatStreamScope, provider: string): string {
  if (!scope.workspaceId) return `${scope.cardId}:${provider}`
  return `v2:${JSON.stringify([scope.workspaceId, scope.cardId, provider])}`
}

export function getCardSessionId(scope: ChatStreamScope, provider: string): string | undefined {
  return sessionIds.get(sessionStorageKey(scope, provider))
}

export function setCardSessionId(scope: ChatStreamScope, provider: string, sessionId: string): void {
  sessionIds.set(sessionStorageKey(scope, provider), sessionId)
  persistSessionIds()
}

function isSessionKeyForScope(key: string, scope: ChatStreamScope): boolean {
  if (!scope.workspaceId) {
    return key === scope.cardId || key.startsWith(`${scope.cardId}:`)
  }
  if (!key.startsWith('v2:')) return false
  try {
    const parsed = JSON.parse(key.slice(3))
    return Array.isArray(parsed)
      && parsed[0] === scope.workspaceId
      && parsed[1] === scope.cardId
  } catch {
    return false
  }
}

export function deleteCardSessionIds(scope: ChatStreamScope): void {
  for (const key of [...sessionIds.keys()]) {
    if (isSessionKeyForScope(key, scope)) {
      sessionIds.delete(key)
    }
  }
}

// Persist session IDs to disk so they survive main-process restarts.
export const SESSION_IDS_PATH = join(CODESURF_HOME, 'session-ids.json')
let sessionIdsPersistTimer: ReturnType<typeof setTimeout> | null = null

export function persistSessionIds(): void {
  if (sessionIdsPersistTimer) return
  sessionIdsPersistTimer = setTimeout(async () => {
    sessionIdsPersistTimer = null
    try {
      const data: Record<string, string> = {}
      for (const [key, value] of sessionIds) data[key] = value
      await fs.mkdir(dirname(SESSION_IDS_PATH), { recursive: true })
      await fs.writeFile(SESSION_IDS_PATH, JSON.stringify(data), 'utf8')
    } catch {
      // Best-effort — swallow errors.
    }
  }, 1000)
}

function loadPersistedSessionIds(): void {
  try {
    const raw = readFileSync(SESSION_IDS_PATH, 'utf8')
    const data = JSON.parse(raw)
    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string' && value && !sessionIds.has(key)) {
          sessionIds.set(key, value)
        }
      }
    }
  } catch {
    // File doesn't exist yet or is malformed — that's fine.
  }
}

// Load persisted session IDs on module init.
loadPersistedSessionIds()

export function isActiveQuery(scope: ChatStreamScope, query: Query): boolean {
  return activeQueries.get(chatStreamScopeKey(scope)) === query
}

export function clearActiveQuery(scope: ChatStreamScope, query: Query): void {
  const key = chatStreamScopeKey(scope)
  if (isActiveQuery(scope, query)) {
    activeQueries.delete(key)
  }
}
