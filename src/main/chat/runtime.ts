import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { ChildProcess } from 'child_process'
import * as http from 'http'
import { promises as fs, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { CONTEX_HOME } from '../paths'
import { daemonClient } from '../daemon/client'
import { broadcastToRenderer } from '../utils/broadcast'
import { log as scopedLog } from '../utils/logger.ts'
import type { ChatMessage, ChatRequest, RuntimeChatSessionState } from './types'

export type { RuntimeChatSessionState } from './types'

const chatLog = scopedLog.scope('Chat')

export function log(...args: unknown[]): void {
  // Preserve the legacy CODESURF_CHAT_DEBUG gate so existing usage is unchanged,
  // but route through the central logger so output format stays consistent.
  if (process.env.CODESURF_CHAT_DEBUG !== '1') return
  chatLog.debug(...args)
}

export function sendStream(cardId: string, event: Record<string, unknown>): void {
  log('sendStream', event.type, event.text ? `"${String(event.text).slice(0, 50)}"` : '', event.error ?? '')
  broadcastToRenderer('agent:stream', { cardId, ...event })
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

// Stored session IDs for multi-turn conversations (keyed by `cardId:provider`).
export const sessionIds = new Map<string, string>()

export function sessionStorageKey(cardId: string, provider: string): string {
  return `${cardId}:${provider}`
}

export function getCardSessionId(cardId: string, provider: string): string | undefined {
  return sessionIds.get(sessionStorageKey(cardId, provider))
}

export function setCardSessionId(cardId: string, provider: string, sessionId: string): void {
  sessionIds.set(sessionStorageKey(cardId, provider), sessionId)
  persistSessionIds()
}

export function deleteCardSessionIds(cardId: string): void {
  for (const key of [...sessionIds.keys()]) {
    if (key === cardId || key.startsWith(`${cardId}:`)) {
      sessionIds.delete(key)
    }
  }
}

// Persist session IDs to disk so they survive main-process restarts.
export const SESSION_IDS_PATH = join(CONTEX_HOME, 'session-ids.json')
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

export function isActiveQuery(cardId: string, query: Query): boolean {
  return activeQueries.get(cardId) === query
}

export function clearActiveQuery(cardId: string, query: Query): void {
  if (isActiveQuery(cardId, query)) {
    activeQueries.delete(cardId)
  }
}