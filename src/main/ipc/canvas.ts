import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { dirname } from 'path'
import type { AggregatedSessionEntry, SessionEntryHint } from '../../shared/session-types'
import type { TileState } from '../../shared/types'
import {
  assertSafeWorkspaceArtifactId,
  canvasStatePath,
  ensureWorkspaceStorageMigrated,
  kanbanStatePath,
  loadWorkspaceTileState,
  saveWorkspaceTileState,
  sessionArchiveStatePath,
  tileSessionSummaryPath,
  tileStatePath,
} from '../storage/workspaceArtifacts'
import {
  appendQueuedMessageEvent,
  listActiveQueuedMessages,
  type QueuedMessageEvent,
} from '../storage/queuedMessagesLog'
import { getWorkspacePathById } from './workspace'
import { deleteFileIfExists } from '../utils/fs'
import { broadcastToRenderer } from '../utils/broadcast'
import { isRelayHostActive } from '../relay/registration'
import { syncWorkspaceRelayParticipants } from '../relay/service'
import { daemonClient } from '../daemon/client'
import { getIndexerStatus, indexAllSources, listThreadsFromDb, renameIndexedThread } from '../db/thread-indexer'
import { getExternalSessionChatState } from '../session-sources'
import { readArchivedSessionIds, writeArchivedSessionIds } from '../storage/sessionArchives'

interface TileSessionSummary {
  version: 1
  tileId: string
  sessionId: string | null
  provider: string
  model: string
  messageCount: number
  lastMessage: string | null
  title: string
  updatedAt: number
}

const tileSessionSummaryCache = new Map<string, TileSessionSummary | null>()

function truncateSessionText(text: string | null | undefined, length = 120): string | null {
  if (!text) return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > length ? normalized.slice(0, length) : normalized
}

function cleanSessionTitleCandidate(text: string | null | undefined, hardCap = 80): string | null {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return null

  let next = trimmed
    .replace(/\r\n/g, '\n')
    .split(/\r?\n/, 1)[0]
    .trim()

  next = next.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
  next = next.replace(/`([^`]+)`/g, '$1')
  next = next.replace(/^[-*+]\s+/, '')
  next = next.replace(/^\[[ xX]\]\s+/, '')
  next = next.replace(/^\d+\.\s+/, '')
  next = next.replace(/^#+\s+/, '')
  next = next.replace(/\s+/g, ' ').trim()

  if (!next) return null
  return next.length > hardCap ? `${next.slice(0, hardCap).trimEnd()}…` : next
}

function sessionTitleFromText(text: string | null | undefined, provider: string): string {
  return cleanSessionTitleCandidate(text) ?? `${provider} session`
}

function extractInitialSessionTitle(messages: Record<string, unknown>[]): string | null {
  for (const rawMessage of messages) {
    if (!rawMessage || typeof rawMessage !== 'object') continue
    const text = truncateSessionText(typeof rawMessage.content === 'string' ? rawMessage.content : null)
    const title = cleanSessionTitleCandidate(text)
    if (title) return title
  }
  return null
}

function extractTileSessionSummary(tileId: string, state: unknown): TileSessionSummary | null {
  if (!state || typeof state !== 'object') return null
  const record = state as Record<string, unknown>
  const messages = Array.isArray(record.messages) ? record.messages : null
  if (!messages || messages.length === 0) return null

  let lastMessage: string | null = null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Record<string, unknown> | null | undefined
    if (!message) continue
    const text = truncateSessionText(typeof message.content === 'string' ? message.content : null)
    if (text) {
      lastMessage = text
      break
    }
  }

  const provider = typeof record.provider === 'string' && record.provider.trim()
    ? record.provider
    : 'claude'
  const model = typeof record.model === 'string' ? record.model : ''
  const sessionId = typeof record.sessionId === 'string' ? record.sessionId : null

  const explicitTitle = cleanSessionTitleCandidate(typeof record.title === 'string' ? record.title : null)

  return {
    version: 1,
    tileId,
    sessionId,
    provider,
    model,
    messageCount: messages.length,
    lastMessage,
    title: explicitTitle ?? extractInitialSessionTitle(messages as Record<string, unknown>[]) ?? `${provider} session`,
    updatedAt: Date.now(),
  }
}

function sameTileSessionSummary(a: TileSessionSummary | null, b: TileSessionSummary | null): boolean {
  if (!a || !b) return a === b
  return a.tileId === b.tileId
    && a.sessionId === b.sessionId
    && a.provider === b.provider
    && a.model === b.model
    && a.messageCount === b.messageCount
    && a.lastMessage === b.lastMessage
    && a.title === b.title
}

async function readTileSessionSummary(summaryPath: string): Promise<TileSessionSummary | null> {
  if (tileSessionSummaryCache.has(summaryPath)) {
    return tileSessionSummaryCache.get(summaryPath) ?? null
  }

  try {
    const raw = await fs.readFile(summaryPath, 'utf8')
    const parsed = JSON.parse(raw) as TileSessionSummary
    tileSessionSummaryCache.set(summaryPath, parsed)
    return parsed
  } catch {
    tileSessionSummaryCache.set(summaryPath, null)
    return null
  }
}

async function writeTileSessionSummary(storageId: string, tileId: string, state: unknown): Promise<{ changed: boolean; summary: TileSessionSummary | null }> {
  const summaryPath = tileSessionSummaryPath(storageId, tileId)
  const previous = await readTileSessionSummary(summaryPath)
  const record = state && typeof state === 'object' ? state as Record<string, unknown> : null
  const linkedSessionEntryId = typeof record?.linkedSessionEntryId === 'string' ? record.linkedSessionEntryId.trim() : ''
  const preserveSessionSummary = record?.preserveSessionSummary === true

  if (linkedSessionEntryId) {
    const changed = previous !== null
    await deleteFileIfExists(summaryPath)
    tileSessionSummaryCache.set(summaryPath, null)
    return { changed, summary: null }
  }

  if (preserveSessionSummary) {
    if (previous) {
      tileSessionSummaryCache.set(summaryPath, previous)
      return { changed: false, summary: previous }
    }
    tileSessionSummaryCache.set(summaryPath, null)
    return { changed: false, summary: null }
  }

  const next = extractTileSessionSummary(tileId, state)

  if (!next) {
    const changed = previous !== null
    await deleteFileIfExists(summaryPath)
    tileSessionSummaryCache.set(summaryPath, null)
    return { changed, summary: null }
  }

  if (sameTileSessionSummary(previous, next)) {
    const stable = previous ?? next
    tileSessionSummaryCache.set(summaryPath, stable)
    return { changed: false, summary: stable }
  }

  const summaryToWrite: TileSessionSummary = {
    ...next,
    updatedAt: previous ? Date.now() : next.updatedAt,
  }
  await fs.writeFile(summaryPath, JSON.stringify(summaryToWrite, null, 2))
  tileSessionSummaryCache.set(summaryPath, summaryToWrite)
  return { changed: true, summary: summaryToWrite }
}

// Track the last-seen summary signature per tile so we only broadcast
// sessionsChanged when something user-visible actually changes (not every
// token during a streaming turn).
const sessionSummarySignatures = new Map<string, string>()

// Debounce sessionsChanged broadcasts per workspace. Chat tiles save their
// state often (per turn, per keystroke during draft input, ...); each save
// may legitimately change the session summary, but broadcasting that to the
// sidebar every time causes a refetch storm. Coalesce rapid calls into a
// single broadcast. 3s is long enough to absorb bursts of activity (typing +
// streaming) but short enough that list still feels live after a conversation
// pauses.
const SESSIONS_CHANGED_DEBOUNCE_MS = 3000
const sessionsChangedTimers = new Map<string, NodeJS.Timeout>()
const sessionsChangedCallCounts = new Map<string, number>()

function broadcastSessionsChanged(workspaceId: string, reason: string = 'unknown'): void {
  const key = workspaceId || '*'
  const existing = sessionsChangedTimers.get(key)
  const callCount = (sessionsChangedCallCounts.get(key) ?? 0) + 1
  sessionsChangedCallCounts.set(key, callCount)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    sessionsChangedTimers.delete(key)
    const count = sessionsChangedCallCounts.get(key) ?? 1
    sessionsChangedCallCounts.delete(key)
    // eslint-disable-next-line no-console
    console.log(`[sessions] broadcast workspaceId=${workspaceId || '(empty)'} reason=${reason} coalesced=${count}`)
    broadcastToRenderer('canvas:sessionsChanged', { workspaceId })
  }, SESSIONS_CHANGED_DEBOUNCE_MS)
  if (typeof timer.unref === 'function') timer.unref()
  sessionsChangedTimers.set(key, timer)
}

/** Immediate-fire variant: use when the event MUST land before a response
 *  (e.g. after delete/rename IPC replies so the renderer sees the result). */
function broadcastSessionsChangedNow(workspaceId: string, reason: string = 'explicit'): void {
  const existing = sessionsChangedTimers.get(workspaceId || '*')
  if (existing) {
    clearTimeout(existing)
    sessionsChangedTimers.delete(workspaceId || '*')
  }
  sessionsChangedCallCounts.delete(workspaceId || '*')
  // eslint-disable-next-line no-console
  console.log(`[sessions] broadcast(now) workspaceId=${workspaceId || '(empty)'} reason=${reason}`)
  broadcastToRenderer('canvas:sessionsChanged', { workspaceId })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function readWorkspaceArchivedSessionIds(workspaceId: string): Promise<Set<string>> {
  const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
  const paths = storageIds.map(storageId => sessionArchiveStatePath(storageId))
  return await readArchivedSessionIds(paths)
}

async function setWorkspaceSessionArchived(workspaceId: string, sessionEntryId: string, archived: boolean): Promise<boolean> {
  const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
  const primaryStorageId = storageIds[0] ?? workspaceId
  const archivePath = sessionArchiveStatePath(primaryStorageId)
  const archivedIds = await readArchivedSessionIds(storageIds.map(storageId => sessionArchiveStatePath(storageId)))
  const hadEntry = archivedIds.has(sessionEntryId)
  if (archived) archivedIds.add(sessionEntryId)
  else archivedIds.delete(sessionEntryId)
  if (hadEntry === archived) return false
  await writeArchivedSessionIds(archivePath, Array.from(archivedIds))
  return true
}

function applyArchivedSessionState(sessions: AggregatedSessionEntry[], archivedIds: Set<string>): AggregatedSessionEntry[] {
  return sessions.map(session => {
    const isArchived = archivedIds.has(session.id)
    return session.isArchived === isArchived ? session : { ...session, isArchived }
  })
}

function normalizeSessionPath(path: string | null | undefined): string | null {
  const normalized = String(path ?? '').trim()
  return normalized || null
}

function listIndexedSessionsForWorkspacePaths(workspaceProjectPaths: Set<string>): AggregatedSessionEntry[] {
  const byId = new Map<string, AggregatedSessionEntry>()
  for (const projectPath of workspaceProjectPaths) {
    const normalizedPath = normalizeSessionPath(projectPath)
    if (!normalizedPath) continue
    const scopedEntries = listThreadsFromDb(normalizedPath)
    for (const entry of scopedEntries) {
      const existing = byId.get(entry.id)
      if (!existing || entry.updatedAt > existing.updatedAt) {
        byId.set(entry.id, entry)
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

function sessionIdentityAgent(entry: AggregatedSessionEntry): string {
  if (entry.source === 'codesurf') {
    const provider = String(entry.provider ?? '').trim().toLowerCase()
    if (provider) return provider
  }
  return String(entry.source ?? 'codesurf').trim().toLowerCase() || 'codesurf'
}

function mergeSessionEntries(localSessions: AggregatedSessionEntry[], nativeSessions: AggregatedSessionEntry[]): AggregatedSessionEntry[] {
  const byKey = new Map<string, AggregatedSessionEntry>()

  const priority = (entry: AggregatedSessionEntry): number => {
    if (entry.id.startsWith('codesurf-runtime:')) return 5
    if (entry.id.startsWith('codesurf-job:')) return 4
    if (entry.id.startsWith('codesurf-tile:')) return 3
    return 1
  }

  for (const entry of [...nativeSessions, ...localSessions]) {
    const key = entry.sessionId ? `session:${sessionIdentityAgent(entry)}:${entry.sessionId}` : `entry:${entry.id}`
    const existing = byKey.get(key)
    if (!existing) {
      byKey.set(key, entry)
      continue
    }
    const existingPriority = priority(existing)
    const nextPriority = priority(entry)
    if (nextPriority > existingPriority || (nextPriority === existingPriority && entry.updatedAt > existing.updatedAt)) {
      byKey.set(key, entry)
    }
  }

  return [...byKey.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export function registerCanvasIPC(): void {
  ipcMain.handle('canvas:load', async (_, workspaceId: string) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    for (const storageId of storageIds) {
      try {
        const raw = await fs.readFile(canvasStatePath(storageId), 'utf8')
        return JSON.parse(raw)
      } catch {
        // try next alias storage dir
      }
    }
    return null
  })

  ipcMain.handle('canvas:save', async (_, workspaceId: string, state: unknown) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    const storageId = storageIds[0] ?? workspaceId
    const path = canvasStatePath(storageId)
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, JSON.stringify(state, null, 2))

    if (isRelayHostActive() && state && typeof state === 'object' && Array.isArray((state as { tiles?: unknown }).tiles)) {
      const tiles = (state as { tiles: TileState[] }).tiles
      const wsPath = await getWorkspacePathById(workspaceId)
      if (wsPath) {
        void syncWorkspaceRelayParticipants(workspaceId, wsPath, tiles).catch(err => {
          console.warn('[Canvas] relay participant sync skipped:', err)
        })
      }
    }
  })

  ipcMain.handle('kanban:load', async (_, workspaceId: string, tileId: string) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    for (const storageId of storageIds) {
      try {
        const raw = await fs.readFile(kanbanStatePath(storageId, tileId), 'utf8')
        return JSON.parse(raw)
      } catch {
        // try next alias storage dir
      }
    }
    return null
  })

  ipcMain.handle('kanban:save', async (_, workspaceId: string, tileId: string, state: unknown) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    const storageId = storageIds[0] ?? workspaceId
    const path = kanbanStatePath(storageId, tileId)
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, JSON.stringify(state, null, 2))
  })

  ipcMain.handle('canvas:loadTileState', async (_, workspaceId: string, tileId: string) => {
    return await loadWorkspaceTileState(workspaceId, tileId, null)
  })

  ipcMain.handle('canvas:saveTileState', async (_, workspaceId: string, tileId: string, state: unknown) => {
    const { storageId } = await saveWorkspaceTileState(workspaceId, tileId, state)

    const { changed, summary } = await writeTileSessionSummary(storageId, tileId, state)
    const isStreaming = state && typeof state === 'object' && (state as { isStreaming?: boolean }).isStreaming === true
    // Previously we broadcasted on ANY summary change, which fires every time
    // a chat message is appended (dozens of times during a streaming turn
    // even with isStreaming=true gating). That nuked sidebar stability.
    //
    // Instead: only broadcast when something the sidebar actually renders has
    // meaningfully changed vs what's already in the cache — i.e. the title
    // changed (rename or first message sets it) or this is the first save.
    const prevKey = sessionSummarySignatures.get(`${storageId}:${tileId}`) ?? null
    const nextKey = summary ? `${summary.title}|${summary.messageCount}` : null
    const titleOrFirstSaveChanged = prevKey === null
      ? nextKey !== null
      : nextKey !== null && prevKey.split('|')[0] !== nextKey.split('|')[0]
    if (summary) sessionSummarySignatures.set(`${storageId}:${tileId}`, nextKey!)
    else sessionSummarySignatures.delete(`${storageId}:${tileId}`)

    if (changed && !isStreaming && titleOrFirstSaveChanged) {
      broadcastSessionsChanged(workspaceId, 'saveTileState/title')
    }
  })

  ipcMain.handle('canvas:clearTileState', async (_, workspaceId: string, tileId: string) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    await Promise.all(storageIds.flatMap(storageId => [
      deleteFileIfExists(tileStatePath(storageId, tileId)),
      deleteFileIfExists(tileSessionSummaryPath(storageId, tileId)),
    ]))
    for (const storageId of storageIds) {
      tileSessionSummaryCache.delete(tileSessionSummaryPath(storageId, tileId))
    }
    broadcastSessionsChanged(workspaceId)
  })

  // List workspace sessions by merging our local runtime/tile sessions with
  // native CLI session stores (Claude/Codex/OpenCode/OpenClaw/etc.) relevant
  // to this workspace's project paths. Native sessions remain the source of
  // truth; local entries only win when they represent the actively loaded
  // runtime view of the same session.
  ipcMain.handle('canvas:listSessions', async (_, workspaceId: string, forceRefresh = false) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const workspaces = await daemonClient.listWorkspaces().catch(() => [])
    const workspaceEntry = workspaces.find(entry => entry.id === workspaceId) ?? null
    const workspacePath = normalizeSessionPath(workspaceEntry?.path) ?? await getWorkspacePathById(workspaceId)
    const workspaceProjectPaths = new Set<string>(
      (workspaceEntry?.projectPaths ?? [])
        .map(projectPath => normalizeSessionPath(projectPath))
        .filter((projectPath): projectPath is string => Boolean(projectPath)),
    )
    if (workspacePath) workspaceProjectPaths.add(workspacePath)

    const localSessions: AggregatedSessionEntry[] = await daemonClient.listLocalSessions(workspaceId).catch(() => [])
    for (const session of localSessions) {
      if (!session.projectPath) session.projectPath = workspacePath
    }

    let nativeSessions: AggregatedSessionEntry[] = []
    if (workspaceProjectPaths.size > 0) {
      if (forceRefresh) {
        await indexAllSources().catch(error => {
          console.warn('[sessions] thread index refresh failed:', error)
        })
      }

      nativeSessions = listIndexedSessionsForWorkspacePaths(workspaceProjectPaths)
      if (nativeSessions.length === 0) {
        await indexAllSources().catch(error => {
          console.warn('[sessions] initial thread index build failed:', error)
        })
        nativeSessions = listIndexedSessionsForWorkspacePaths(workspaceProjectPaths)
      }
    }

    const relevantNativeSessions = nativeSessions
      .filter(session => session.source !== 'codesurf')
      .map(session => ({
        ...session,
        projectPath: normalizeSessionPath(session.projectPath) ?? workspacePath,
      }))

    const archivedIds = await readWorkspaceArchivedSessionIds(workspaceId)
    return applyArchivedSessionState(mergeSessionEntries(localSessions, relevantNativeSessions), archivedIds)
  })

  ipcMain.handle('threads:indexStatus', () => {
    try { return { ok: true, status: getIndexerStatus() } }
    catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } }
  })

  ipcMain.handle('threads:reindex', async () => {
    try {
      await indexAllSources()
      return { ok: true, ...getIndexerStatus() }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('canvas:getSessionState', async (
    _,
    workspaceId: string,
    sessionEntryId: string,
    options?: {
      tailLimit?: number
      entryHint?: SessionEntryHint | null
    },
  ) => {
    const workspacePath = await getWorkspacePathById(workspaceId)

    if (sessionEntryId.startsWith('codesurf-runtime:') || sessionEntryId.startsWith('codesurf-tile:') || sessionEntryId.startsWith('codesurf-job:')) {
      return await daemonClient.getLocalSessionState(workspaceId, sessionEntryId).catch(() => null)
    }

    // For external sessions (claude, codex, cursor, openclaw, opencode) parse
    // directly in the main process — the daemon's HTTP path returns null when
    // its own walker cache misses the file, which falls back to opening the
    // raw JSONL. Parsing locally avoids the round-trip entirely and always
    // uses fresh data from disk.
    const local = await getExternalSessionChatState(workspacePath, sessionEntryId, {
      entryHint: options?.entryHint ?? null,
      tailLimit: typeof options?.tailLimit === 'number' ? options.tailLimit : undefined,
    }).catch(() => null)
    if (local) return local
    // Keep daemon as last-resort fallback in case a provider type is only
    // supported there (e.g. future cloud-only sources).
    return await daemonClient.getExternalSessionState(workspacePath, sessionEntryId).catch(() => null)
  })

  ipcMain.handle('canvas:deleteSession', async (_, workspaceId: string, sessionEntryId: string) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const workspacePath = await getWorkspacePathById(workspaceId)

    if (sessionEntryId.startsWith('codesurf-runtime:') || sessionEntryId.startsWith('codesurf-tile:') || sessionEntryId.startsWith('codesurf-job:')) {
      const result = await daemonClient.deleteLocalSession(workspaceId, sessionEntryId).catch(error => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
      if (result.ok) broadcastSessionsChangedNow(workspaceId)
      return result
    }

    const result = await daemonClient.deleteExternalSession(workspacePath, sessionEntryId).catch(error => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    if (result.ok) {
      await indexAllSources().catch(error => {
        console.warn('[sessions] thread index refresh after delete failed:', error)
      })
      broadcastSessionsChangedNow(workspaceId)
    }
    return result
  })

  ipcMain.handle('canvas:renameSession', async (_, workspaceId: string, sessionEntryId: string, title: string) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const workspacePath = await getWorkspacePathById(workspaceId)

    const result = (sessionEntryId.startsWith('codesurf-runtime:') || sessionEntryId.startsWith('codesurf-tile:') || sessionEntryId.startsWith('codesurf-job:'))
      ? await daemonClient.renameLocalSession(workspaceId, sessionEntryId, title).catch(error => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      : await daemonClient.renameExternalSession(workspacePath, sessionEntryId, title).catch(error => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))

    if (result.ok) {
      if (!(sessionEntryId.startsWith('codesurf-runtime:') || sessionEntryId.startsWith('codesurf-tile:') || sessionEntryId.startsWith('codesurf-job:'))) {
        renameIndexedThread(sessionEntryId, title)
      }
      broadcastSessionsChangedNow(workspaceId)
    }
    return result
  })

  ipcMain.handle('canvas:setSessionArchived', async (_, workspaceId: string, sessionEntryId: string, archived: boolean) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const changed = await setWorkspaceSessionArchived(workspaceId, sessionEntryId, archived).catch(error => {
      throw new Error(error instanceof Error ? error.message : String(error))
    })
    if (changed) broadcastSessionsChangedNow(workspaceId, archived ? 'archiveSession' : 'unarchiveSession')
    return { ok: true, changed, archived }
  })

  ipcMain.handle('canvas:listCheckpoints', async (_, workspaceId: string, sessionEntryId: string) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    if (!sessionEntryId.startsWith('codesurf-runtime:')) return []
    return await daemonClient.listCheckpoints(workspaceId, sessionEntryId).catch(() => [])
  })

  ipcMain.handle('canvas:restoreCheckpoint', async (_, workspaceId: string, checkpointId: string, sessionEntryId?: string) => {
    assertSafeWorkspaceArtifactId(workspaceId)
    const result = await daemonClient.restoreCheckpoint(workspaceId, checkpointId, sessionEntryId ?? null).catch(error => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    if (result.ok) broadcastSessionsChangedNow(workspaceId)
    return result
  })

  ipcMain.handle('canvas:deleteTileArtifacts', async (_, workspaceId: string, tileId: string) => {
    const storageIds = await ensureWorkspaceStorageMigrated(workspaceId)
    await Promise.all(storageIds.flatMap(storageId => [
      deleteFileIfExists(tileStatePath(storageId, tileId)),
      deleteFileIfExists(tileSessionSummaryPath(storageId, tileId)),
      deleteFileIfExists(kanbanStatePath(storageId, tileId)),
    ]))
    for (const storageId of storageIds) {
      tileSessionSummaryCache.delete(tileSessionSummaryPath(storageId, tileId))
    }
    // Any queued messages belonging to this tile are now orphaned by definition;
    // mark them cleared so the log stays consistent.
    try {
      await appendQueuedMessageEvent({
        type: 'clear',
        at: Date.now(),
        workspaceId,
        tileId,
      })
    } catch { /* best-effort */ }
    broadcastSessionsChanged(workspaceId)
  })

  // Queued-message event log (append-only JSONL) used to track orphans
  // across crashes and tile deletions.
  ipcMain.handle('canvas:queuedMessages:append', async (_, event: unknown) => {
    if (!event || typeof event !== 'object') return
    const record = event as Record<string, unknown>
    const type = record.type
    if (type !== 'enqueue' && type !== 'dispatch' && type !== 'delete' && type !== 'complete' && type !== 'clear') return
    const workspaceId = typeof record.workspaceId === 'string' ? record.workspaceId : ''
    const tileId = typeof record.tileId === 'string' ? record.tileId : ''
    if (!workspaceId || !tileId) return
    const payload: QueuedMessageEvent = {
      type,
      workspaceId,
      tileId,
      at: typeof record.at === 'number' ? record.at : Date.now(),
    }
    if (typeof record.queueId === 'string') payload.queueId = record.queueId
    if (typeof record.content === 'string') payload.content = record.content
    if (typeof record.preview === 'string') payload.preview = record.preview
    if (typeof record.attachmentCount === 'number') payload.attachmentCount = record.attachmentCount
    if (typeof record.createdAt === 'number') payload.createdAt = record.createdAt
    await appendQueuedMessageEvent(payload)
  })

  ipcMain.handle('canvas:queuedMessages:listActive', async () => {
    return await listActiveQueuedMessages()
  })
}
