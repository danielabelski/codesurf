import { promises as fs } from 'fs'
import { join } from 'path'
import { CONTEX_HOME } from '../paths'

/**
 * Append-only JSONL event log for chat-tile queued messages.
 *
 * Each line is a single JSON object describing one mutation:
 *   - enqueue:  a user draft was queued while the agent was busy
 *   - dispatch: a queued message left the queue to be sent to the agent
 *   - delete:   a queued message was removed via the trash button
 *   - complete: a dispatched message finished successfully (optional, currently unused)
 *   - clear:    all queued messages for a tile were cleared (e.g. "New chat")
 *
 * The log is intentionally cheap to write (append-only, no rewrites) so we
 * never lose a queued message to a crash mid-debounce. Orphans can be
 * recovered by scanning the log and pairing enqueues with later
 * dispatch/delete/clear events.
 */

export type QueuedMessageEventType =
  | 'enqueue'
  | 'dispatch'
  | 'delete'
  | 'complete'
  | 'clear'

export interface QueuedMessageEvent {
  type: QueuedMessageEventType
  at: number
  workspaceId: string
  tileId: string
  /** Present for enqueue/dispatch/delete/complete; empty/omitted for clear. */
  queueId?: string
  /** Only on enqueue. */
  content?: string
  /** Only on enqueue. */
  preview?: string
  /** Only on enqueue. */
  attachmentCount?: number
  /** Only on enqueue. */
  createdAt?: number
}

export interface ActiveQueuedMessage {
  queueId: string
  workspaceId: string
  tileId: string
  content: string
  preview: string
  attachmentCount: number
  createdAt: number
  enqueuedAt: number
}

const LOG_PATH = join(CONTEX_HOME, 'queued-messages.log.jsonl')

async function ensureLogDir(): Promise<void> {
  await fs.mkdir(CONTEX_HOME, { recursive: true })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function coerceEvent(raw: unknown): QueuedMessageEvent | null {
  if (!isPlainObject(raw)) return null
  const type = raw.type
  if (type !== 'enqueue' && type !== 'dispatch' && type !== 'delete' && type !== 'complete' && type !== 'clear') return null
  const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId : ''
  const tileId = typeof raw.tileId === 'string' ? raw.tileId : ''
  if (!workspaceId || !tileId) return null
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now()
  const ev: QueuedMessageEvent = { type, workspaceId, tileId, at }
  if (typeof raw.queueId === 'string') ev.queueId = raw.queueId
  if (typeof raw.content === 'string') ev.content = raw.content
  if (typeof raw.preview === 'string') ev.preview = raw.preview
  if (typeof raw.attachmentCount === 'number') ev.attachmentCount = raw.attachmentCount
  if (typeof raw.createdAt === 'number') ev.createdAt = raw.createdAt
  return ev
}

/** Append one event to the log. Best-effort; swallows IO errors. */
export async function appendQueuedMessageEvent(event: QueuedMessageEvent): Promise<void> {
  try {
    await ensureLogDir()
    const line = JSON.stringify(event) + '\n'
    await fs.appendFile(LOG_PATH, line, 'utf8')
  } catch {
    // Intentionally swallow — log is best-effort; never crash the main process.
  }
}

/**
 * Replay the log and return queued messages that were enqueued but never
 * dispatched / deleted / cleared. These are the candidates for "orphan"
 * recovery after a crash or tile deletion.
 */
export async function listActiveQueuedMessages(): Promise<ActiveQueuedMessage[]> {
  let raw: string
  try {
    raw = await fs.readFile(LOG_PATH, 'utf8')
  } catch {
    return []
  }

  const active = new Map<string, ActiveQueuedMessage>()
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const ev = coerceEvent(parsed)
    if (!ev) continue

    if (ev.type === 'clear') {
      // Remove all active entries for this tile.
      for (const [key, entry] of active) {
        if (entry.tileId === ev.tileId && entry.workspaceId === ev.workspaceId) {
          active.delete(key)
        }
      }
      continue
    }

    const keyId = ev.queueId
    if (!keyId) continue
    const key = `${ev.workspaceId}:${ev.tileId}:${keyId}`

    if (ev.type === 'enqueue') {
      active.set(key, {
        queueId: keyId,
        workspaceId: ev.workspaceId,
        tileId: ev.tileId,
        content: ev.content ?? '',
        preview: ev.preview ?? '',
        attachmentCount: ev.attachmentCount ?? 0,
        createdAt: ev.createdAt ?? ev.at,
        enqueuedAt: ev.at,
      })
    } else {
      // dispatch / delete / complete — remove from active set.
      active.delete(key)
    }
  }

  return Array.from(active.values()).sort((a, b) => a.enqueuedAt - b.enqueuedAt)
}

/** For diagnostics / manual reset. */
export function queuedMessagesLogPath(): string {
  return LOG_PATH
}
