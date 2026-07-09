import { randomUUID } from 'crypto'
import { ipcMain, type WebContents } from 'electron'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import type {
  CollabState,
  CollabSkills,
  CollabMailbox,
  CollabMessage,
  CollabMessageDraft,
  CollabMessageListItem,
  CollabMessageMeta,
  CollabMessageStatus,
  CollabMessageType,
} from '../../shared/types'
import {
  workspaceTileDir,
  workspaceTileContextDir,
  legacyWorkspaceTileDir,
  legacyWorkspaceTileContextDir,
  workspaceTileMessagesDir,
  workspaceTileMessageMailboxDir,
} from '../paths'
import {
  assertSafePathSegment,
  assertSafeWorkspacePath,
  resolveInside,
} from '../security/pathSegments.ts'
import { broadcastToRenderer } from '../utils/broadcast'

const MESSAGE_PROTOCOL = 'codesurf-message/v1' as const
const MESSAGE_MAILBOXES: CollabMailbox[] = ['inbox', 'sent', 'memory', 'bin']
const MESSAGE_MAILBOX_SET = new Set<string>(MESSAGE_MAILBOXES)

// ─── Helpers ────────────────────────────────────────────────────────────────

function assertSafeMailbox(mailbox: CollabMailbox): CollabMailbox {
  if (!MESSAGE_MAILBOX_SET.has(String(mailbox))) throw new Error('Invalid mailbox')
  return mailbox
}

function collabDir(workspacePath: string, tileId: string): string {
  return workspaceTileDir(assertSafeWorkspacePath(workspacePath), assertSafePathSegment(tileId, 'tileId'))
}

function legacyCollabDir(workspacePath: string, tileId: string): string {
  return legacyWorkspaceTileDir(assertSafeWorkspacePath(workspacePath), assertSafePathSegment(tileId, 'tileId'))
}

function contextDir(workspacePath: string, tileId: string): string {
  return workspaceTileContextDir(workspacePath, tileId)
}

function legacyContextDir(workspacePath: string, tileId: string): string {
  return legacyWorkspaceTileContextDir(workspacePath, tileId)
}

function messagesDir(workspacePath: string, tileId: string): string {
  return workspaceTileMessagesDir(workspacePath, tileId)
}

function mailboxDir(workspacePath: string, tileId: string, mailbox: CollabMailbox): string {
  return workspaceTileMessageMailboxDir(assertSafeWorkspacePath(workspacePath), assertSafePathSegment(tileId, 'tileId'), assertSafeMailbox(mailbox))
}

function contextFilePath(workspacePath: string, tileId: string, filename: string): string {
  return resolveInside(contextDir(workspacePath, tileId), assertSafePathSegment(filename, 'filename'))
}

function legacyContextFilePath(workspacePath: string, tileId: string, filename: string): string {
  return resolveInside(legacyContextDir(workspacePath, tileId), assertSafePathSegment(filename, 'filename'))
}

function messageFilePath(workspacePath: string, tileId: string, mailbox: CollabMailbox, filename: string): string {
  return resolveInside(mailboxDir(workspacePath, tileId, mailbox), assertSafePathSegment(filename, 'filename'))
}

async function ensureTileProtocolDirs(workspacePath: string, tileId: string): Promise<void> {
  const safeWorkspacePath = assertSafeWorkspacePath(workspacePath)
  const safeTileId = assertSafePathSegment(tileId, 'tileId')
  const tileDir = collabDir(safeWorkspacePath, safeTileId)

  await fs.mkdir(tileDir, { recursive: true })
  await fs.mkdir(contextDir(safeWorkspacePath, safeTileId), { recursive: true })
  await Promise.all(MESSAGE_MAILBOXES.map(mailbox => fs.mkdir(mailboxDir(safeWorkspacePath, safeTileId, mailbox), { recursive: true })))
}

async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

async function readJsonFromEither<T>(primary: string, legacy: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(primary, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return readJsonSafe(legacy, fallback)
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await fs.writeFile(path, JSON.stringify(data, null, 2))
}

async function removeDirIfExists(path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: true, force: true })
  } catch {
    // ignore missing paths
  }
}

async function pruneOrphanedTileDirs(rootDir: string, validTileIds: Set<string>): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true })
    const removed: string[] = []

    await Promise.all(entries.map(async entry => {
      if (!entry.isDirectory()) return
      if (entry.name.startsWith('.')) return
      if (validTileIds.has(entry.name)) return
      await removeDirIfExists(join(rootDir, entry.name))
      removed.push(entry.name)
    }))

    return removed.sort()
  } catch {
    return []
  }
}

function sanitizeFilenamePart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'message'
}

function frontmatterValue(value: string | number | undefined): string {
  if (value === undefined) return 'null'
  return JSON.stringify(value)
}

function parseFrontmatterValue(raw: string): string | number | null {
  const trimmed = raw.trim()
  if (trimmed === 'null') return null
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  const num = Number(trimmed)
  return Number.isFinite(num) ? num : trimmed
}

function extractPayload(body: string): { body: string; data?: Record<string, unknown> } {
  const match = body.match(/\n```(?:json\s+)?codesurf-data\n([\s\S]*?)\n```\s*$/)
  if (!match) return { body: body.trim() }

  try {
    return {
      body: body.slice(0, match.index).trim(),
      data: JSON.parse(match[1]) as Record<string, unknown>,
    }
  } catch {
    return { body: body.trim() }
  }
}

function renderMessageMarkdown(meta: CollabMessageMeta, body: string, data?: Record<string, unknown>): string {
  const lines = [
    '---',
    `protocol: ${frontmatterValue(meta.protocol)}`,
    `id: ${frontmatterValue(meta.id)}`,
    `threadId: ${frontmatterValue(meta.threadId)}`,
    `fromTileId: ${frontmatterValue(meta.fromTileId)}`,
    `toTileId: ${frontmatterValue(meta.toTileId)}`,
    `type: ${frontmatterValue(meta.type)}`,
    `subject: ${frontmatterValue(meta.subject)}`,
    `status: ${frontmatterValue(meta.status)}`,
    `createdAt: ${frontmatterValue(meta.createdAt)}`,
    `createdTs: ${frontmatterValue(meta.createdTs)}`,
    `updatedAt: ${frontmatterValue(meta.updatedAt)}`,
    `updatedTs: ${frontmatterValue(meta.updatedTs)}`,
    `replyToId: ${frontmatterValue(meta.replyToId)}`,
    '---',
    '',
    body.trim(),
  ]

  if (data && Object.keys(data).length > 0) {
    lines.push('', '```codesurf-data', JSON.stringify(data, null, 2), '```')
  }

  lines.push('')
  return lines.join('\n')
}

function parseMessageMarkdown(content: string, mailbox: CollabMailbox, filename: string): CollabMessage | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return null

  const values = new Map<string, string | number | null>()
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const rawValue = line.slice(idx + 1)
    values.set(key, parseFrontmatterValue(rawValue))
  }

  if (values.get('protocol') !== MESSAGE_PROTOCOL) return null

  const payload = extractPayload(match[2] ?? '')
  const meta: CollabMessageMeta = {
    protocol: MESSAGE_PROTOCOL,
    id: String(values.get('id') ?? ''),
    threadId: String(values.get('threadId') ?? ''),
    fromTileId: String(values.get('fromTileId') ?? ''),
    toTileId: String(values.get('toTileId') ?? ''),
    type: String(values.get('type') ?? 'note') as CollabMessageType,
    subject: String(values.get('subject') ?? ''),
    status: String(values.get('status') ?? 'unread') as CollabMessageStatus,
    createdAt: String(values.get('createdAt') ?? ''),
    createdTs: Number(values.get('createdTs') ?? 0),
    updatedAt: String(values.get('updatedAt') ?? values.get('createdAt') ?? ''),
    updatedTs: Number(values.get('updatedTs') ?? values.get('createdTs') ?? 0),
    replyToId: values.get('replyToId') ? String(values.get('replyToId')) : undefined,
  }

  if (!meta.id || !meta.fromTileId || !meta.toTileId) return null

  return {
    mailbox,
    filename,
    meta,
    body: payload.body,
    data: payload.data,
  }
}

async function readMessageFile(path: string, mailbox: CollabMailbox, filename: string): Promise<CollabMessage | null> {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return parseMessageMarkdown(raw, mailbox, filename)
  } catch {
    return null
  }
}

async function broadcastMessageChange(payload: {
  workspacePath: string
  tileId: string
  mailbox: CollabMailbox
  filename: string
  event: 'add' | 'change' | 'unlink'
  message?: CollabMessage | null
}): Promise<void> {
  broadcastToRenderer('collab:messageChanged', payload)
}

function parseMailboxAndFilename(rootDir: string, changedPath: string): { mailbox: CollabMailbox; filename: string } | null {
  const relative = changedPath.slice(rootDir.length + 1)
  const parts = relative.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const mailbox = parts[0] as CollabMailbox
  if (!MESSAGE_MAILBOXES.includes(mailbox)) return null
  return { mailbox, filename: parts.slice(1).join('/') }
}

// ─── Watcher state ──────────────────────────────────────────────────────────

const stateWatchers = new Map<string, { close: () => void }>()
const messageWatchers = new Map<string, { close: () => void }>()

// Per-sender teardown: when the renderer window closes without calling unwatch,
// stop the watchers it registered (mirrors the pattern in ipc/fs.ts).
type WatcherKey = string
const senderWatcherKeys = new WeakMap<WebContents, Set<WatcherKey>>()
const senderCleanupAttached = new WeakSet<WebContents>()

function trackCollabWatchSender(
  sender: WebContents,
  key: WatcherKey,
  type: 'state' | 'message',
): void {
  const existing = senderWatcherKeys.get(sender)
  if (existing) existing.add(`${type}:${key}`)
  else senderWatcherKeys.set(sender, new Set([`${type}:${key}`]))

  if (senderCleanupAttached.has(sender)) return
  senderCleanupAttached.add(sender)
  sender.once('destroyed', () => {
    const keys = senderWatcherKeys.get(sender)
    if (!keys) return
    for (const entry of keys) {
      const sep = entry.indexOf(':')
      const t = entry.slice(0, sep) as 'state' | 'message'
      const k = entry.slice(sep + 1)
      const [wp, tid] = k.split('\0')
      if (t === 'state') stopStateWatcher(wp, tid)
      else stopMessageWatcher(wp, tid)
    }
    senderWatcherKeys.delete(sender)
  })
}

async function startStateWatcher(workspacePath: string, tileId: string): Promise<void> {
  const key = `${workspacePath}:${tileId}`
  if (stateWatchers.has(key)) return

  const statePath = join(collabDir(workspacePath, tileId), 'state.json')
  const chokidar = await import('chokidar')
  const watcher = chokidar.watch(statePath, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  })

  watcher.on('change', async () => {
    const state = await readJsonSafe<CollabState>(statePath, { tasks: [], paused: false })
    broadcastToRenderer('collab:stateChanged', { workspacePath, tileId, state })
  })

  stateWatchers.set(key, { close: () => watcher.close() })
}

function stopStateWatcher(workspacePath: string, tileId: string): void {
  const key = `${workspacePath}:${tileId}`
  const watcher = stateWatchers.get(key)
  if (!watcher) return
  watcher.close()
  stateWatchers.delete(key)
}

async function startMessageWatcher(workspacePath: string, tileId: string): Promise<void> {
  const key = `${workspacePath}:${tileId}`
  if (messageWatchers.has(key)) return

  const rootDir = messagesDir(workspacePath, tileId)
  await ensureTileProtocolDirs(workspacePath, tileId)

  const chokidar = await import('chokidar')
  const watcher = chokidar.watch(join(rootDir, '**/*.md'), {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  })

  const onChange = async (event: 'add' | 'change' | 'unlink', changedPath: string) => {
    const parsed = parseMailboxAndFilename(rootDir, changedPath)
    if (!parsed) return

    if (event === 'unlink') {
      await broadcastMessageChange({
        workspacePath,
        tileId,
        mailbox: parsed.mailbox,
        filename: parsed.filename,
        event,
      })
      return
    }

    const message = await readMessageFile(changedPath, parsed.mailbox, parsed.filename)
    await broadcastMessageChange({
      workspacePath,
      tileId,
      mailbox: parsed.mailbox,
      filename: parsed.filename,
      event,
      message,
    })
  }

  watcher.on('add', path => void onChange('add', path))
  watcher.on('change', path => void onChange('change', path))
  watcher.on('unlink', path => void onChange('unlink', path))

  messageWatchers.set(key, { close: () => watcher.close() })
}

function stopMessageWatcher(workspacePath: string, tileId: string): void {
  const key = `${workspacePath}:${tileId}`
  const watcher = messageWatchers.get(key)
  if (!watcher) return
  watcher.close()
  messageWatchers.delete(key)
}

// ─── IPC Registration ───────────────────────────────────────────────────────

export function registerCollabIPC(): void {
  ipcMain.handle('collab:ensureDir', async (_, workspacePath: string, tileId: string) => {
    await ensureTileProtocolDirs(workspacePath, tileId)
    return true
  })

  // ── Objective ─────────────────────────────────────────────────────────────

  ipcMain.handle('collab:writeObjective', async (_, workspacePath: string, tileId: string, md: string) => {
    const dir = collabDir(workspacePath, tileId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'objective.md'), md)
    return true
  })

  ipcMain.handle('collab:readObjective', async (_, workspacePath: string, tileId: string) => {
    try {
      return await fs.readFile(join(collabDir(workspacePath, tileId), 'objective.md'), 'utf8')
    } catch {
      try {
        return await fs.readFile(join(legacyCollabDir(workspacePath, tileId), 'objective.md'), 'utf8')
      } catch {
        return null
      }
    }
  })

  // ── Skills ────────────────────────────────────────────────────────────────

  ipcMain.handle('collab:writeSkills', async (_, workspacePath: string, tileId: string, skills: CollabSkills) => {
    const dir = collabDir(workspacePath, tileId)
    await fs.mkdir(dir, { recursive: true })
    await writeJson(join(dir, 'skills.json'), skills)
    return true
  })

  ipcMain.handle('collab:readSkills', async (_, workspacePath: string, tileId: string) => {
    return readJsonFromEither<CollabSkills>(
      join(collabDir(workspacePath, tileId), 'skills.json'),
      join(legacyCollabDir(workspacePath, tileId), 'skills.json'),
      { enabled: [], disabled: [] },
    )
  })

  // ── State ─────────────────────────────────────────────────────────────────

  ipcMain.handle('collab:writeState', async (_, workspacePath: string, tileId: string, state: CollabState) => {
    const dir = collabDir(workspacePath, tileId)
    await fs.mkdir(dir, { recursive: true })
    await writeJson(join(dir, 'state.json'), state)
    return true
  })

  ipcMain.handle('collab:readState', async (_, workspacePath: string, tileId: string) => {
    return readJsonFromEither<CollabState>(
      join(collabDir(workspacePath, tileId), 'state.json'),
      join(legacyCollabDir(workspacePath, tileId), 'state.json'),
      { tasks: [], paused: false },
    )
  })

  // ── Context files ─────────────────────────────────────────────────────────

  ipcMain.handle('collab:addContext', async (_, workspacePath: string, tileId: string, filename: string, content: string) => {
    const dir = contextDir(workspacePath, tileId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(contextFilePath(workspacePath, tileId, filename), content)
    return true
  })

  ipcMain.handle('collab:removeContext', async (_, workspacePath: string, tileId: string, filename: string) => {
    try {
      await fs.unlink(contextFilePath(workspacePath, tileId, filename))
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('collab:listContext', async (_, workspacePath: string, tileId: string) => {
    try {
      const dir = contextDir(workspacePath, tileId)
      const entries = await fs.readdir(dir)
      return entries.filter(entry => !entry.startsWith('.'))
    } catch {
      try {
        const entries = await fs.readdir(legacyContextDir(workspacePath, tileId))
        return entries.filter(entry => !entry.startsWith('.'))
      } catch {
        return []
      }
    }
  })

  ipcMain.handle('collab:readContext', async (_, workspacePath: string, tileId: string, filename: string) => {
    try {
      return await fs.readFile(contextFilePath(workspacePath, tileId, filename), 'utf8')
    } catch {
      try {
        return await fs.readFile(legacyContextFilePath(workspacePath, tileId, filename), 'utf8')
      } catch {
        return null
      }
    }
  })

  // ── Messages ──────────────────────────────────────────────────────────────

  ipcMain.handle('collab:listMessages', async (_, workspacePath: string, tileId: string, mailbox: CollabMailbox) => {
    try {
      const dir = mailboxDir(workspacePath, tileId, mailbox)
      await fs.mkdir(dir, { recursive: true })
      const entries = (await fs.readdir(dir)).filter(entry => entry.endsWith('.md') && !entry.startsWith('.'))
      const messages = await Promise.all(entries.map(async filename => {
        const message = await readMessageFile(join(dir, filename), mailbox, filename)
        if (!message) return null
        const listItem: CollabMessageListItem = { mailbox, filename, meta: message.meta }
        return listItem
      }))
      return messages.filter(Boolean).sort((a, b) => (b?.meta.createdTs ?? 0) - (a?.meta.createdTs ?? 0))
    } catch {
      return []
    }
  })

  ipcMain.handle('collab:readMessage', async (_, workspacePath: string, tileId: string, mailbox: CollabMailbox, filename: string) => {
    return readMessageFile(messageFilePath(workspacePath, tileId, mailbox, filename), mailbox, assertSafePathSegment(filename, 'filename'))
  })

  ipcMain.handle('collab:sendMessage', async (_, workspacePath: string, fromTileId: string, draft: CollabMessageDraft) => {
    const safeFromTileId = assertSafePathSegment(fromTileId, 'tileId')
    const safeToTileId = assertSafePathSegment(draft.toTileId, 'toTileId')
    await ensureTileProtocolDirs(workspacePath, safeFromTileId)
    await ensureTileProtocolDirs(workspacePath, safeToTileId)

    const id = randomUUID()
    const threadId = draft.threadId ?? id
    const now = new Date()
    const iso = now.toISOString()
    const ts = now.getTime()
    const slug = sanitizeFilenamePart(draft.subject)
    const filename = `${iso.replace(/[:.]/g, '-')}-${slug}.md`

    const baseMeta: Omit<CollabMessageMeta, 'status'> = {
      protocol: MESSAGE_PROTOCOL,
      id,
      threadId,
      fromTileId: safeFromTileId,
      toTileId: safeToTileId,
      type: draft.type ?? (draft.replyToId ? 'reply' : 'request'),
      subject: draft.subject,
      createdAt: iso,
      createdTs: ts,
      updatedAt: iso,
      updatedTs: ts,
      replyToId: draft.replyToId,
    }

    const senderMeta: CollabMessageMeta = { ...baseMeta, status: 'sent' }
    const recipientMeta: CollabMessageMeta = { ...baseMeta, status: 'unread' }

    const senderPath = messageFilePath(workspacePath, safeFromTileId, 'sent', filename)
    const recipientPath = messageFilePath(workspacePath, safeToTileId, 'inbox', filename)

    await Promise.all([
      fs.writeFile(senderPath, renderMessageMarkdown(senderMeta, draft.body, draft.data)),
      fs.writeFile(recipientPath, renderMessageMarkdown(recipientMeta, draft.body, draft.data)),
    ])

    return {
      id,
      threadId,
      filename,
      fromTileId: safeFromTileId,
      toTileId: safeToTileId,
      senderPath,
      recipientPath,
    }
  })

  ipcMain.handle('collab:updateMessageStatus', async (_, workspacePath: string, tileId: string, mailbox: CollabMailbox, filename: string, status: CollabMessageStatus) => {
    const path = messageFilePath(workspacePath, tileId, mailbox, filename)
    const existing = await readMessageFile(path, mailbox, filename)
    if (!existing) return false

    const now = new Date()
    const next: CollabMessage = {
      ...existing,
      meta: {
        ...existing.meta,
        status,
        updatedAt: now.toISOString(),
        updatedTs: now.getTime(),
      },
    }

    await fs.writeFile(path, renderMessageMarkdown(next.meta, next.body, next.data))
    return true
  })

  ipcMain.handle('collab:moveMessage', async (_, workspacePath: string, tileId: string, fromMailbox: CollabMailbox, toMailbox: CollabMailbox, filename: string) => {
    const source = messageFilePath(workspacePath, tileId, fromMailbox, filename)
    const targetDir = mailboxDir(workspacePath, tileId, toMailbox)
    const target = resolveInside(targetDir, basename(assertSafePathSegment(filename, 'filename')))

    try {
      await fs.mkdir(targetDir, { recursive: true })
      await fs.rename(source, target)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('collab:watchMessages', async (event, workspacePath: string, tileId: string) => {
    await startMessageWatcher(workspacePath, tileId)
    trackCollabWatchSender(event.sender, `${workspacePath}\0${tileId}`, 'message')
    return true
  })

  ipcMain.handle('collab:unwatchMessages', (_, workspacePath: string, tileId: string) => {
    stopMessageWatcher(workspacePath, tileId)
    return true
  })

  // ── Watchers ──────────────────────────────────────────────────────────────

  ipcMain.handle('collab:watchState', async (event, workspacePath: string, tileId: string) => {
    await startStateWatcher(workspacePath, tileId)
    trackCollabWatchSender(event.sender, `${workspacePath}\0${tileId}`, 'state')
    return true
  })

  ipcMain.handle('collab:unwatchState', (_, workspacePath: string, tileId: string) => {
    stopStateWatcher(workspacePath, tileId)
    return true
  })

  ipcMain.handle('collab:removeTileDir', async (_, workspacePath: string, tileId: string) => {
    stopStateWatcher(workspacePath, tileId)
    stopMessageWatcher(workspacePath, tileId)
    await Promise.all([
      removeDirIfExists(collabDir(workspacePath, tileId)),
      removeDirIfExists(legacyCollabDir(workspacePath, tileId)),
    ])
    return true
  })

  ipcMain.handle('collab:pruneOrphanedTileDirs', async (_, workspacePath: string, tileIds: string[]) => {
    const workspaceRoot = assertSafeWorkspacePath(workspacePath)
    const validTileIds = new Set(tileIds.map(id => {
      try { return assertSafePathSegment(id, 'tileId') } catch { return '' }
    }).filter(Boolean))
    const removed = await Promise.all([
      pruneOrphanedTileDirs(join(workspaceRoot, '.codesurf'), validTileIds),
      pruneOrphanedTileDirs(join(workspaceRoot, '.collab'), validTileIds),
    ])
    return {
      removed: Array.from(new Set([...removed[0], ...removed[1]])).sort(),
    }
  })
}

/** Stop all watchers (call on app quit) */
export function stopAllCollabWatchers(): void {
  for (const watcher of stateWatchers.values()) watcher.close()
  for (const watcher of messageWatchers.values()) watcher.close()
  stateWatchers.clear()
  messageWatchers.clear()
}
