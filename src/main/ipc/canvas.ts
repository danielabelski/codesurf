import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
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
import { writeJsonArtifactAtomic } from '../storage/jsonArtifacts'
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
import { getAgentPath, getShellEnvPath } from '../agent-paths'

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
const GENERATED_TITLE_MODEL = 'claude-haiku-4-5-20251001'
const GENERATED_TITLE_MAX_CHARS = 120
const GENERATED_TITLE_MAX_WORDS = 4
const GENERATED_TITLE_TRANSCRIPT_BUDGET = 90_000
const GENERATED_TITLE_HEAD_MESSAGES = 32
const GENERATED_TITLE_TAIL_MESSAGES = 96

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

function isLocalSessionEntry(sessionEntryId: string): boolean {
  return sessionEntryId.startsWith('codesurf-runtime:')
    || sessionEntryId.startsWith('codesurf-tile:')
    || sessionEntryId.startsWith('codesurf-job:')
}

function trimTranscriptText(text: string, maxChars = 2_000): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars).trimEnd()}…`
}

function formatTranscriptMessage(message: Record<string, unknown>, index: number): string | null {
  const role = typeof message.role === 'string' && message.role.trim()
    ? message.role.trim()
    : 'unknown'
  const content = typeof message.content === 'string' ? trimTranscriptText(message.content) : ''
  if (!content) return null
  return `${index + 1}. ${role}: ${content}`
}

function buildTitleTranscript(messages: Record<string, unknown>[]): string {
  if (messages.length === 0) return ''

  const selected = messages.length <= (GENERATED_TITLE_HEAD_MESSAGES + GENERATED_TITLE_TAIL_MESSAGES)
    ? messages
    : [
        ...messages.slice(0, GENERATED_TITLE_HEAD_MESSAGES),
        ...messages.slice(-GENERATED_TITLE_TAIL_MESSAGES),
      ]

  const chunks: string[] = []
  let used = 0

  for (let index = 0; index < selected.length; index += 1) {
    if (messages.length > selected.length && index === GENERATED_TITLE_HEAD_MESSAGES) {
      const omittedCount = messages.length - selected.length
      const omitted = `... ${omittedCount} earlier middle messages omitted for brevity ...`
      if (used + omitted.length > GENERATED_TITLE_TRANSCRIPT_BUDGET) break
      chunks.push(omitted)
      used += omitted.length + 1
    }

    const rawIndex = messages.length <= selected.length
      ? index
      : (index < GENERATED_TITLE_HEAD_MESSAGES ? index : messages.length - (selected.length - index))
    const formatted = formatTranscriptMessage(selected[index] as Record<string, unknown>, rawIndex)
    if (!formatted) continue
    if (used + formatted.length > GENERATED_TITLE_TRANSCRIPT_BUDGET) break
    chunks.push(formatted)
    used += formatted.length + 1
  }

  return chunks.join('\n')
}

function sanitizeGeneratedTitle(raw: string, fallback: string): string {
  const rawText = String(raw ?? '').trim()
  if (!rawText) return fallback

  const jsonMatch = rawText.match(/\{[\s\S]*"title"\s*:\s*"([^"]+)"[\s\S]*\}/)
  const candidates = [
    jsonMatch?.[1],
    ...rawText.split(/\r?\n/),
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)

  for (const candidate of candidates) {
    const normalized = candidate
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/^title\s*:\s*/i, '')
      .replace(/^new title\s*:\s*/i, '')
      .trim()

    if (!normalized) continue
    if (/^(i('|’)ll|i will|let me|here('|’)s|here is|the title is|i can|sure|okay|based on)\b/i.test(normalized)) continue
    if (/\b(read|reading|transcript|understand|generate|appropriate title|topic)\b/i.test(normalized)) continue

    const cleaned = cleanSessionTitleCandidate(normalized, GENERATED_TITLE_MAX_CHARS)
    if (!cleaned) continue

    const words = cleaned.split(/\s+/).filter(Boolean)
    if (words.length === 0) continue
    return words.slice(0, GENERATED_TITLE_MAX_WORDS).join(' ')
  }

  return fallback
}

async function generateTitleWithClaude(prompt: string): Promise<string> {
  const options: Options = {
    model: GENERATED_TITLE_MODEL,
    permissionMode: 'plan' as any,
    thinking: { type: 'disabled' } as any,
    persistSession: false,
  }
  const claudePath = getAgentPath('claude')
  if (claudePath) {
    ;(options as any).pathToClaudeCodeExecutable = claudePath
  }

  const q = query({ prompt, options })
  let text = ''

  for await (const msg of q) {
    if (msg.type === 'assistant') {
      const blocks = (msg as any).message?.content ?? []
      text += blocks
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('')
    } else if (msg.type === 'result' && typeof (msg as any).result === 'string' && (msg as any).result.trim()) {
      text = (msg as any).result
    }
  }

  return text.trim()
}

async function generateTitleWithCodex(prompt: string): Promise<string> {
  const codexBin = getAgentPath('codex') || 'codex'
  const shellPath = getShellEnvPath()
  const tempBase = join(tmpdir(), `codesurf-title-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const schemaPath = `${tempBase}.schema.json`
  const outputPath = `${tempBase}.out.json`

  await fs.writeFile(schemaPath, JSON.stringify({
    type: 'object',
    properties: {
      title: { type: 'string' },
    },
    required: ['title'],
    additionalProperties: false,
  }, null, 2))

  try {
    return await new Promise<string>((resolve, reject) => {
      const proc = spawn(codexBin, [
        'exec',
        '--model',
        'gpt-5.1-codex-mini',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ignore-user-config',
        '--ephemeral',
        '--color',
        'never',
        '--output-schema',
        schemaPath,
        '--output-last-message',
        outputPath,
        prompt,
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
      })

      let stderr = ''

      proc.stderr?.on('data', chunk => { stderr += chunk.toString() })
      proc.on('error', reject)
      proc.on('close', async code => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Codex exited with ${code}`))
          return
        }

        try {
          const raw = (await fs.readFile(outputPath, 'utf8')).trim()
          const parsed = JSON.parse(raw) as { title?: unknown }
          if (typeof parsed.title === 'string' && parsed.title.trim()) {
            resolve(parsed.title.trim())
            return
          }
          reject(new Error('Codex returned an invalid title payload.'))
        } catch (error) {
          reject(error)
        }
      })
    })
  } finally {
    await Promise.allSettled([
      fs.unlink(schemaPath),
      fs.unlink(outputPath),
    ])
  }
}

async function generateSessionTitleFromMessages(session: SessionEntryHint | AggregatedSessionEntry, messages: Record<string, unknown>[]): Promise<string> {
  const transcript = buildTitleTranscript(messages)
  const fallbackTitle = cleanSessionTitleCandidate(session.title, GENERATED_TITLE_MAX_CHARS) ?? 'Untitled thread'
  if (!transcript) return fallbackTitle

  const prompt = [
    'You rename chat threads.',
    'Return exactly one title, 2 to 4 words.',
    'Return only those words.',
    'No sentences. No explanation. No preamble. No markdown. No quotes.',
    'Prefer the concrete task, bug, feature, or decision being discussed.',
    'Do not use quotes, markdown, prefixes, or trailing punctuation unless required.',
    'Avoid generic titles like "Conversation", "Help", or "Question".',
    `Keep it under ${GENERATED_TITLE_MAX_CHARS} characters.`,
    '',
    `Current title: ${fallbackTitle}`,
    `Provider: ${session.provider || 'unknown'}`,
    `Model: ${session.model || 'unknown'}`,
    `Message count: ${messages.length}`,
    '',
    'Transcript:',
    transcript,
  ].join('\n')

  try {
    const generated = await generateTitleWithClaude(prompt)
    return sanitizeGeneratedTitle(generated, fallbackTitle)
  } catch (error) {
    console.warn('[sessions] Claude title generation failed, falling back to Codex:', error)
    const generated = await generateTitleWithCodex(prompt)
    return sanitizeGeneratedTitle(generated, fallbackTitle)
  }
}

async function loadSessionStateForTitleGeneration(
  workspaceId: string,
  sessionEntryId: string,
  entryHint: SessionEntryHint | null,
): Promise<{
  provider: string
  model: string
  messages: Record<string, unknown>[]
}> {
  const workspacePath = await getWorkspacePathById(workspaceId)

  if (isLocalSessionEntry(sessionEntryId)) {
    const local = await daemonClient.getLocalSessionState(workspaceId, sessionEntryId).catch(() => null)
    if (local && Array.isArray((local as Record<string, unknown>).messages)) {
      return {
        provider: typeof (local as any).provider === 'string' ? (local as any).provider : (entryHint?.provider ?? 'claude'),
        model: typeof (local as any).model === 'string' ? (local as any).model : (entryHint?.model ?? ''),
        messages: (local as any).messages as Record<string, unknown>[],
      }
    }

    if (sessionEntryId.startsWith('codesurf-tile:tile-state-')) {
      const tileId = sessionEntryId.replace('codesurf-tile:tile-state-', '').replace(/\.json$/, '')
      const tileState = await loadWorkspaceTileState<Record<string, unknown> | null>(workspaceId, tileId, null)
      if (tileState && Array.isArray(tileState.messages)) {
        return {
          provider: typeof tileState.provider === 'string' ? tileState.provider : (entryHint?.provider ?? 'claude'),
          model: typeof tileState.model === 'string' ? tileState.model : (entryHint?.model ?? ''),
          messages: tileState.messages as Record<string, unknown>[],
        }
      }
    }

    throw new Error('Could not load local session transcript.')
  }

  const external = await getExternalSessionChatState(workspacePath, sessionEntryId, { entryHint }).catch(() => null)
  if (external && Array.isArray(external.messages)) {
    return {
      provider: external.provider,
      model: external.model,
      messages: external.messages as Record<string, unknown>[],
    }
  }

  const fallback = await daemonClient.getExternalSessionState(workspacePath, sessionEntryId).catch(() => null)
  if (fallback && Array.isArray((fallback as Record<string, unknown>).messages)) {
    return {
      provider: typeof (fallback as any).provider === 'string' ? (fallback as any).provider : (entryHint?.provider ?? 'unknown'),
      model: typeof (fallback as any).model === 'string' ? (fallback as any).model : (entryHint?.model ?? ''),
      messages: (fallback as any).messages as Record<string, unknown>[],
    }
  }

  throw new Error('Could not load session transcript.')
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
  await writeJsonArtifactAtomic(summaryPath, summaryToWrite)
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

  const mergeCanonicalMetadata = (
    preferred: AggregatedSessionEntry,
    alternate: AggregatedSessionEntry,
  ): AggregatedSessionEntry => {
    const canonical = [preferred, alternate].find(candidate =>
      candidate.source !== 'codesurf'
      && typeof candidate.title === 'string'
      && candidate.title.trim().length > 0,
    ) ?? null

    if (!canonical) return preferred

    return {
      ...preferred,
      title: canonical.title,
      filePath: preferred.filePath || canonical.filePath,
      sizeBytes: (typeof preferred.sizeBytes === 'number' && preferred.sizeBytes > 0) ? preferred.sizeBytes : canonical.sizeBytes,
      sourceDetail: preferred.sourceDetail || canonical.sourceDetail,
      model: preferred.model || canonical.model,
    }
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
      byKey.set(key, mergeCanonicalMetadata(entry, existing))
      continue
    }
    byKey.set(key, mergeCanonicalMetadata(existing, entry))
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
    await writeJsonArtifactAtomic(path, state)

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
    await writeJsonArtifactAtomic(path, state)
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
      const local = await daemonClient.getLocalSessionState(workspaceId, sessionEntryId).catch(() => null)
      if (local) return local
      if (sessionEntryId.startsWith('codesurf-tile:tile-state-')) {
        const tileId = sessionEntryId.replace('codesurf-tile:tile-state-', '').replace(/\.json$/, '')
        return await loadWorkspaceTileState(workspaceId, tileId, null)
      }
      return null
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

  ipcMain.handle('canvas:generateSessionTitle', async (
    _,
    workspaceId: string,
    sessionEntryId: string,
    entryHint?: SessionEntryHint | null,
  ) => {
    assertSafeWorkspaceArtifactId(workspaceId)

    const state = await loadSessionStateForTitleGeneration(workspaceId, sessionEntryId, entryHint ?? null)
    if (!Array.isArray(state.messages) || state.messages.length === 0) {
      return { ok: false, error: 'Session has no transcript to summarize.' }
    }

    const title = await generateSessionTitleFromMessages({
      id: sessionEntryId,
      source: (entryHint?.source ?? 'codesurf') as SessionEntryHint['source'],
      provider: state.provider,
      model: state.model,
      messageCount: state.messages.length,
      title: entryHint?.title ?? '',
      sessionId: entryHint?.sessionId ?? null,
      filePath: entryHint?.filePath,
      projectPath: entryHint?.projectPath ?? null,
    }, state.messages)

    if (!title.trim()) {
      return { ok: false, error: 'Title generation returned an empty title.' }
    }

    const workspacePath = await getWorkspacePathById(workspaceId)
    const result = isLocalSessionEntry(sessionEntryId)
      ? await daemonClient.renameLocalSession(workspaceId, sessionEntryId, title).catch(error => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))
      : await daemonClient.renameExternalSession(workspacePath, sessionEntryId, title).catch(error => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }))

    if (result.ok) {
      if (!isLocalSessionEntry(sessionEntryId)) renameIndexedThread(sessionEntryId, title)
      broadcastSessionsChangedNow(workspaceId)
    }

    return result.ok
      ? { ok: true, title }
      : { ok: false, error: result.error || 'Failed to apply generated title.' }
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
