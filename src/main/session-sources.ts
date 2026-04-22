import { createReadStream, promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, extname, join } from 'path'
import { createInterface } from 'readline'
import Database from 'better-sqlite3'
import type { AggregatedSessionEntry, SessionEntryHint, SessionScope } from '../shared/session-types'
import { buildChatMessageHistoryFingerprint } from '../shared/chat-history'
import { CONTEX_HOME } from './paths'

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ImportedChatMessage {
  id: string
  role: ChatRole
  content: string
  timestamp: number
  thinking?: ImportedThinkingBlock
  toolBlocks?: ImportedToolBlock[]
  contentBlocks?: ImportedContentBlock[]
}

export interface ImportedChatState {
  provider: string
  model: string
  sessionId: string | null
  messages: ImportedChatMessage[]
}

interface CachedExternalSessionState {
  mtimeMs: number
  size: number
  state: ImportedChatState | null
}

export interface ImportedThinkingBlock {
  content: string
  done: boolean
}

export interface ImportedToolFileChange {
  path: string
  previousPath?: string
  changeType: 'add' | 'update' | 'delete' | 'move'
  additions: number
  deletions: number
  diff: string
}

export interface ImportedToolCommandEntry {
  label: string
  command?: string
  output?: string
  kind?: 'search' | 'read' | 'command'
}

export interface ImportedToolBlock {
  id: string
  name: string
  input: string
  summary?: string
  elapsed?: number
  status: 'running' | 'done' | 'error'
  fileChanges?: ImportedToolFileChange[]
  commandEntries?: ImportedToolCommandEntry[]
}

export type ImportedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolId: string }

const STANDARD_CODESURF_SUBDIRS = ['sessions', 'agents', 'skills', 'tools', 'plugins', 'extensions'] as const
const EXTERNAL_SESSION_CACHE_MS = 30_000
const EXTERNAL_SESSION_STATE_CACHE_MAX_ENTRIES = 64
const EXTERNAL_SESSION_FULL_STATE_CACHE_MAX_ENTRIES = 8
const LARGE_EXTERNAL_SESSION_BYTES = 6 * 1024 * 1024
const EXTERNAL_SESSION_HEAD_SAMPLE_BYTES = 128 * 1024
const EXTERNAL_SESSION_TAIL_SAMPLE_BYTES = 4 * 1024 * 1024
const MAX_SESSION_LISTING_JSON_BYTES = 2 * 1024 * 1024
const MAX_SESSION_LISTING_TEXT_SAMPLE_BYTES = 16 * 1024
const CLAUDE_SESSION_LISTING_HEAD_BYTES = 24 * 1024
const CLAUDE_SESSION_LISTING_TAIL_BYTES = 96 * 1024
const CLAUDE_SESSION_EXACT_SCAN_MAX_BYTES = 256 * 1024
const CODEX_SESSION_LISTING_HEAD_BYTES = 24 * 1024
const CODEX_SESSION_LISTING_TAIL_BYTES = 96 * 1024
const CODEX_SESSION_EXACT_SCAN_MAX_BYTES = 256 * 1024
const externalSessionCache = new Map<string, { at: number; entries: AggregatedSessionEntry[] }>()
const externalSessionStateCache = new Map<string, CachedExternalSessionState>()
const externalSessionFullStateCache = new Map<string, CachedExternalSessionState>()
const GENERIC_OPENCLAW_LABELS = new Set(['openclaw studio', 'openclawstudio', 'openclaw-tui', 'vibeclaw', 'heartbeat'])

function getProjectCodeSurfDir(workspacePath: string): string {
  return join(workspacePath, '.codesurf')
}

async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true })
}

export async function ensureCodeSurfStructure(workspacePath?: string | null): Promise<void> {
  await ensureDir(CONTEX_HOME)
  await Promise.all(STANDARD_CODESURF_SUBDIRS.map(dir => ensureDir(join(CONTEX_HOME, dir))))

  if (!workspacePath) return
  const projectDir = getProjectCodeSurfDir(workspacePath)
  await ensureDir(projectDir)
  await Promise.all(STANDARD_CODESURF_SUBDIRS.map(dir => ensureDir(join(projectDir, dir))))
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function readJsonSafe(path: string, options?: { maxBytes?: number }): Promise<any | null> {
  try {
    if (options?.maxBytes != null) {
      const stat = await fs.stat(path)
      if (!stat.isFile() || stat.size > options.maxBytes) return null
    }
    const raw = await fs.readFile(path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function readTextSafe(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function readTextPreviewSafe(path: string, maxBytes = MAX_SESSION_LISTING_TEXT_SAMPLE_BYTES): Promise<string | null> {
  try {
    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function readTextTailSafe(path: string, maxBytes: number): Promise<string | null> {
  try {
    const stat = await fs.stat(path)
    if (!stat.isFile()) return null
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      let text = buffer.toString('utf8', 0, bytesRead)
      if (start > 0) {
        const firstNewline = text.indexOf('\n')
        text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
      }
      return text
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

async function statSafe(path: string): Promise<import('fs').Stats | null> {
  try {
    return await fs.stat(path)
  } catch {
    return null
  }
}

function touchCachedExternalSessionState(
  cache: Map<string, CachedExternalSessionState>,
  maxEntries: number,
  key: string,
  value: CachedExternalSessionState,
): ImportedChatState | null {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value
    if (!oldestKey) break
    cache.delete(oldestKey)
  }
  return value.state
}

async function getCachedExternalSessionChatState(
  cache: Map<string, CachedExternalSessionState>,
  maxEntries: number,
  cacheKey: string,
  filePath: string,
  load: () => Promise<ImportedChatState | null>,
): Promise<ImportedChatState | null> {
  const stat = await statSafe(filePath)
  if (!stat?.isFile()) {
    cache.delete(cacheKey)
    return null
  }

  const cached = cache.get(cacheKey)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return touchCachedExternalSessionState(cache, maxEntries, cacheKey, cached)
  }

  const state = await load()
  return touchCachedExternalSessionState(cache, maxEntries, cacheKey, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    state,
  })
}

async function getFreshCachedExternalSessionChatState(
  cache: Map<string, CachedExternalSessionState>,
  maxEntries: number,
  cacheKey: string,
  filePath: string,
): Promise<ImportedChatState | null> {
  const stat = await statSafe(filePath)
  if (!stat?.isFile()) {
    cache.delete(cacheKey)
    return null
  }

  const cached = cache.get(cacheKey)
  if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) return null
  return touchCachedExternalSessionState(cache, maxEntries, cacheKey, cached)
}

async function scanJsonlFile(
  filePath: string,
  onLine: (line: string, lineNumber: number) => void | Promise<void>,
): Promise<void> {
  const stream = createReadStream(filePath, { encoding: 'utf8' })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let lineNumber = 0

  try {
    for await (const line of lines) {
      if (!line) continue
      lineNumber += 1
      await onLine(line, lineNumber)
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

function truncate(text: string | null | undefined, length = 120): string | null {
  if (!text) return null
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > length ? normalized.slice(0, length) : normalized
}

function sessionTitleFromText(fallback: string, text: string | null | undefined): string {
  const trimmed = text?.trim()
  if (!trimmed) return fallback
  return trimmed.split(/\r?\n/, 1)[0].slice(0, 80)
}

function normalizeSessionPath(path: string | null | undefined): string {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function pathBelongsToWorkspace(workspacePath: string | null | undefined, sessionProjectPath: string | null | undefined): boolean {
  const workspace = normalizeSessionPath(workspacePath)
  const project = normalizeSessionPath(sessionProjectPath)
  if (!workspace || !project) return false
  return project === workspace || project.startsWith(`${workspace}/`)
}

function pathScope(workspacePath: string | null | undefined, sessionProjectPath: string | null | undefined, fallback: SessionScope = 'user'): SessionScope {
  if (pathBelongsToWorkspace(workspacePath, sessionProjectPath)) return 'project'
  return fallback
}

function compareSessions(a: AggregatedSessionEntry, b: AggregatedSessionEntry): number {
  return b.updatedAt - a.updatedAt
}

function humanizeSlug(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
}

function isGenericOpenClawLabel(value: string | null | undefined): boolean {
  if (!value) return true
  return GENERIC_OPENCLAW_LABELS.has(value.trim().toLowerCase())
}

function roleFromUnknown(value: unknown): ChatRole | null {
  return value === 'user' || value === 'assistant' || value === 'system' ? value : null
}

function makeImportedMessage(id: string, role: ChatRole, content: string, timestamp: number): ImportedChatMessage | null {
  const trimmed = content.trim()
  if (!trimmed) return null
  return { id, role, content: trimmed, timestamp }
}

function makeImportedRichMessage(params: {
  id: string
  role: ChatRole
  content: string
  timestamp: number
  thinking?: ImportedThinkingBlock
  toolBlocks?: ImportedToolBlock[]
}): ImportedChatMessage | null {
  const trimmedContent = params.content.trim()
  const toolBlocks = params.toolBlocks?.filter(block => {
    return Boolean(block.name.trim())
      && (Boolean(block.input.trim()) || Boolean(block.summary?.trim()) || (block.fileChanges?.length ?? 0) > 0 || (block.commandEntries?.length ?? 0) > 0)
  }) ?? []
  const thinking = params.thinking && params.thinking.content.trim()
    ? { ...params.thinking, content: params.thinking.content.trim() }
    : undefined

  if (!trimmedContent && !thinking && toolBlocks.length === 0) return null

  const contentBlocks: ImportedContentBlock[] = []
  for (const block of toolBlocks) contentBlocks.push({ type: 'tool', toolId: block.id })
  if (trimmedContent) contentBlocks.push({ type: 'text', text: trimmedContent })

  return {
    id: params.id,
    role: params.role,
    content: trimmedContent,
    timestamp: params.timestamp,
    thinking,
    toolBlocks: toolBlocks.length > 0 ? toolBlocks : undefined,
    contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
  }
}

/**
 * Strip Codex internal control markers that occasionally bleed into message
 * content (e.g. `<turn_aborted>…</turn_aborted>` written into the turn log
 * when the user interrupts mid-run). These are protocol-level annotations,
 * not user-authored text, and must not render as chat bubbles.
 */
function stripCodexSystemMarkers(text: string): string {
  if (!text) return text
  return text.replace(/<turn_aborted>[\s\S]*?<\/turn_aborted>/g, '').trim()
}

function extractTextParts(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part
      if (typeof part?.text === 'string') return part.text
      if (typeof part?.content === 'string') return part.content
      if (typeof part?.value === 'string') return part.value
      if (typeof part?.input_text === 'string') return part.input_text
      if (typeof part?.output_text === 'string') return part.output_text
      return ''
    }).filter(Boolean).join('\n\n')
  }
  if (content && typeof content === 'object') {
    if (typeof (content as any).text === 'string') return (content as any).text
    if (typeof (content as any).content === 'string') return (content as any).content
    if (typeof (content as any).value === 'string') return (content as any).value
  }
  return ''
}

function makeTranscriptTruncationMessage(provider: string, fileSizeBytes: number): ImportedChatMessage {
  const sizeMb = Math.max(1, Math.round(fileSizeBytes / (1024 * 1024)))
  const label = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude' : 'CLI'
  return {
    id: `${provider}-truncated-notice`,
    role: 'system',
    content: `${label} transcript trimmed for faster loading. Showing the start of the conversation and recent activity from a ${sizeMb} MB session.`,
    timestamp: Date.now(),
  }
}

function dedupeImportedMessages(messages: ImportedChatMessage[]): ImportedChatMessage[] {
  const out: ImportedChatMessage[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    const key = `${message.role}::${message.timestamp}::${message.content}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(message)
  }
  return out
}

function parseJsonlLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
}

function getClaudeProjectPathCandidate(evt: Record<string, any> | null): string | null {
  if (!evt) return null
  const candidate = typeof evt.cwd === 'string' ? evt.cwd
    : typeof evt.workingDirectory === 'string' ? evt.workingDirectory
    : typeof evt.projectPath === 'string' ? evt.projectPath
    : typeof evt.project?.path === 'string' ? evt.project.path
    : typeof evt.meta?.cwd === 'string' ? evt.meta.cwd
    : typeof evt.session?.cwd === 'string' ? evt.session.cwd
    : null
  return candidate && candidate.startsWith('/') ? candidate : null
}

function getClaudeRole(evt: Record<string, any> | null): ChatRole | null {
  if (!evt) return null
  return roleFromUnknown(evt.message?.role) ?? roleFromUnknown(evt.type) ?? roleFromUnknown(evt.role)
}

function extractClaudeContentText(
  content: unknown,
  options?: {
    includeThinking?: boolean
    includeToolResults?: boolean
  },
): string {
  if (!Array.isArray(content)) return extractTextParts(content)

  return content.map(part => {
    if (typeof part === 'string') return part
    const type = typeof part?.type === 'string' ? part.type : ''
    if (type === 'text') return typeof part.text === 'string' ? part.text : ''
    if (type === 'thinking') {
      if (!options?.includeThinking) return ''
      return typeof part.thinking === 'string' ? part.thinking : typeof part.text === 'string' ? part.text : ''
    }
    if (type === 'tool_result') {
      return options?.includeToolResults ? extractTextParts(part.content) : ''
    }
    if (type === 'input_text') return typeof part.text === 'string' ? part.text : typeof part.input_text === 'string' ? part.input_text : ''
    if (type === 'output_text') return typeof part.text === 'string' ? part.text : typeof part.output_text === 'string' ? part.output_text : ''
    if (type === 'tool_use') return ''
    return extractTextParts(part)
  }).filter(Boolean).join('\n\n').trim()
}

function getClaudeEventText(
  evt: Record<string, any> | null,
  options?: {
    includeThinking?: boolean
    includeToolResults?: boolean
  },
): string {
  if (!evt) return ''
  return extractClaudeContentText(evt.message?.content ?? evt.content, options).trim()
}

function isClaudeToolResultOnly(evt: Record<string, any> | null): boolean {
  const content = evt?.message?.content
  return Array.isArray(content) && content.length > 0 && content.every(part => part?.type === 'tool_result')
}

function shouldImportClaudeEvent(evt: Record<string, any> | null): boolean {
  const role = getClaudeRole(evt)
  if (!role || role === 'system') return false
  if (role === 'user' && isClaudeToolResultOnly(evt)) return false
  return true
}

function getClaudeModel(evt: Record<string, any> | null): string {
  if (!evt) return ''
  const candidate = typeof evt.message?.model === 'string' ? evt.message.model
    : typeof evt.advisorModel === 'string' ? evt.advisorModel
    : typeof evt.model === 'string' ? evt.model
    : ''
  return candidate.trim()
}

function encodeClaudeProjectDirName(workspacePath: string): string {
  return workspacePath.replace(/\\/g, '/').replace(/\//g, '-')
}

type ClaudeListingMeta = {
  sessionId: string | null
  title: string
  lastMessage: string | null
  messageCount: number
  projectPath: string | null
  model: string
  gitBranch: string | null
}

function scanClaudeListingLines(
  lines: string[],
  meta: {
    sessionId: string | null
    projectPath: string | null
    model: string
    gitBranch: string | null
    firstUserPrompt: string | null
    lastPrompt: string | null
    lastAssistantText: string | null
    messageCount: number
  },
  options?: { countMessages?: boolean },
): void {
  for (const line of lines) {
    const evt = parseJsonObject(line)
    if (!evt) continue

    if (!meta.projectPath) meta.projectPath = getClaudeProjectPathCandidate(evt)
    if (!meta.sessionId && typeof evt.sessionId === 'string' && evt.sessionId.trim()) meta.sessionId = evt.sessionId.trim()
    if (!meta.model) meta.model = getClaudeModel(evt)
    if (!meta.gitBranch && typeof evt.gitBranch === 'string' && evt.gitBranch.trim()) meta.gitBranch = evt.gitBranch.trim()

    if (!meta.lastPrompt && evt.type === 'last-prompt' && typeof evt.lastPrompt === 'string' && evt.lastPrompt.trim()) {
      meta.lastPrompt = truncate(evt.lastPrompt, 400)
    }

    if (!shouldImportClaudeEvent(evt)) continue

    const role = getClaudeRole(evt)
    const text = truncate(getClaudeEventText(evt), 400)
    if (!text) continue

    if (options?.countMessages) meta.messageCount += 1
    if (role === 'user' && !meta.firstUserPrompt) meta.firstUserPrompt = text
    if (role === 'assistant') meta.lastAssistantText = text
  }
}

async function readClaudeListingMeta(
  filePath: string,
  stat: import('fs').Stats,
  fallbackProjectPath?: string | null,
): Promise<ClaudeListingMeta> {
  const baseMeta = {
    sessionId: basename(filePath, '.jsonl'),
    projectPath: fallbackProjectPath ?? null,
    model: '',
    gitBranch: null as string | null,
    firstUserPrompt: null as string | null,
    lastPrompt: null as string | null,
    lastAssistantText: null as string | null,
    messageCount: 0,
  }

  if (stat.size <= CLAUDE_SESSION_EXACT_SCAN_MAX_BYTES) {
    const raw = await readTextSafe(filePath)
    scanClaudeListingLines(parseJsonlLines(raw ?? ''), baseMeta, { countMessages: true })
  } else {
    const [headRaw, tailRaw] = await Promise.all([
      readTextPreviewSafe(filePath, CLAUDE_SESSION_LISTING_HEAD_BYTES),
      readTextTailSafe(filePath, CLAUDE_SESSION_LISTING_TAIL_BYTES),
    ])
    scanClaudeListingLines(parseJsonlLines(headRaw ?? ''), baseMeta)
    scanClaudeListingLines(parseJsonlLines(tailRaw ?? ''), baseMeta)
  }

  const title = sessionTitleFromText('Claude session', baseMeta.lastPrompt ?? baseMeta.firstUserPrompt ?? baseMeta.lastAssistantText)
  return {
    sessionId: baseMeta.sessionId,
    title,
    lastMessage: baseMeta.lastAssistantText ?? baseMeta.lastPrompt ?? baseMeta.firstUserPrompt,
    messageCount: baseMeta.messageCount,
    projectPath: baseMeta.projectPath,
    model: baseMeta.model,
    gitBranch: baseMeta.gitBranch,
  }
}

function parseClaudeLine(line: string, index: number): ImportedChatMessage | null {
  try {
    const evt = JSON.parse(line)
    if (!shouldImportClaudeEvent(evt)) return null
    const role = getClaudeRole(evt)
    if (!role) return null
    const text = getClaudeEventText(evt)
    if (!text) return null
    return makeImportedMessage(
      `claude-${index}`,
      role,
      text,
      Date.parse(evt?.timestamp ?? '') || Date.now() + index,
    )
  } catch {
    return null
  }
}

function parseClaudeMessagesFromLines(lines: string[], offset = 0): ImportedChatMessage[] {
  return lines
    .map((line, index) => parseClaudeLine(line, offset + index))
    .filter(Boolean) as ImportedChatMessage[]
}

function truncateToolPreview(text: string | null | undefined, length = 800): string {
  if (!text) return ''
  return text.length > length ? `${text.slice(0, length)}\n…` : text
}

function sanitizeToolOutputText(text: string | null | undefined): string {
  if (!text) return ''

  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      return !(
        /^Chunk ID:/i.test(trimmed)
        || /^Wall time:/i.test(trimmed)
        || /^Process exited with code /i.test(trimmed)
        || /^Process running with session ID /i.test(trimmed)
        || /^Original token count:/i.test(trimmed)
        || /^Output:$/i.test(trimmed)
        || /^\[CodeSurf memory guard\] Older tool (output|summary) /i.test(trimmed)
      )
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractReasoningSummary(payload: any): string {
  if (!Array.isArray(payload?.summary)) return ''
  return payload.summary
    .map((entry: any) => typeof entry?.text === 'string' ? entry.text.trim() : '')
    .filter(Boolean)
    .join('\n\n')
}

function parseJsonObject(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null
  } catch {
    return null
  }
}

function extractCommandFromToolCall(name: string, rawInput: string): string {
  const parsed = parseJsonObject(rawInput)
  if (name === 'exec_command') return typeof parsed?.cmd === 'string' ? parsed.cmd : rawInput
  if (name === 'shell_command') return typeof parsed?.command === 'string' ? parsed.command : rawInput
  if (name === 'shell') {
    if (Array.isArray(parsed?.command)) return parsed.command.map((part: unknown) => String(part)).join(' ')
    if (typeof parsed?.command === 'string') return parsed.command
  }
  return rawInput
}

function extractApplyPatchText(rawInput: string): string | null {
  const beginIndex = rawInput.indexOf('*** Begin Patch')
  const endIndex = rawInput.lastIndexOf('*** End Patch')
  if (beginIndex === -1 || endIndex === -1 || endIndex < beginIndex) return null
  return rawInput.slice(beginIndex, endIndex + '*** End Patch'.length)
}

function parseApplyPatchFileChanges(patchText: string): ImportedToolFileChange[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n')
  const changes: ImportedToolFileChange[] = []
  let current: (ImportedToolFileChange & { lines: string[] }) | null = null

  const flush = () => {
    if (!current) return
    current.diff = current.lines.join('\n').trim()
    current.additions = current.lines.filter(line => line.startsWith('+')).length
    current.deletions = current.lines.filter(line => line.startsWith('-')).length
    changes.push({
      path: current.path,
      previousPath: current.previousPath,
      changeType: current.changeType,
      additions: current.additions,
      deletions: current.deletions,
      diff: current.diff,
    })
    current = null
  }

  for (const line of lines) {
    if (line.startsWith('*** Add File: ')) {
      flush()
      current = {
        path: line.slice('*** Add File: '.length).trim(),
        changeType: 'add',
        additions: 0,
        deletions: 0,
        diff: '',
        lines: [line],
      }
      continue
    }
    if (line.startsWith('*** Update File: ')) {
      flush()
      current = {
        path: line.slice('*** Update File: '.length).trim(),
        changeType: 'update',
        additions: 0,
        deletions: 0,
        diff: '',
        lines: [line],
      }
      continue
    }
    if (line.startsWith('*** Delete File: ')) {
      flush()
      current = {
        path: line.slice('*** Delete File: '.length).trim(),
        changeType: 'delete',
        additions: 0,
        deletions: 0,
        diff: '',
        lines: [line],
      }
      continue
    }
    if (line.startsWith('*** Move to: ')) {
      if (current) {
        current.previousPath = current.path
        current.path = line.slice('*** Move to: '.length).trim()
        current.changeType = 'move'
        current.lines.push(line)
      }
      continue
    }
    if (line === '*** End Patch') {
      if (current) current.lines.push(line)
      flush()
      continue
    }
    if (current) current.lines.push(line)
  }

  flush()
  return changes
}

type ImportedCommandKind = 'search' | 'read' | 'command'

function classifyCommand(command: string): ImportedCommandKind {
  const normalized = command.trim()
  if (/(^|\s)(rg|grep|fd|findstr)\b/.test(normalized)) return 'search'
  if (/(^|\s)(cat|sed|head|tail|less|more|bat)\b/.test(normalized)) return 'read'
  if (/(^|\s)ls\b/.test(normalized)) return 'read'
  return 'command'
}

interface PendingImportedToolCall {
  id: string
  name: string
  input: string
  output?: string
  status: 'done' | 'error'
  fileChanges?: ImportedToolFileChange[]
  commandEntry?: ImportedToolCommandEntry
}

function buildImportedToolBlocks(calls: PendingImportedToolCall[]): ImportedToolBlock[] {
  const blocks: ImportedToolBlock[] = []
  const handledIds = new Set<string>()

  const fileChangeMap = new Map<string, ImportedToolFileChange>()
  for (const change of calls.flatMap(call => call.fileChanges ?? [])) {
    const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
    const existing = fileChangeMap.get(key)
    if (!existing) {
      fileChangeMap.set(key, { ...change })
      continue
    }
    existing.additions += change.additions
    existing.deletions += change.deletions
    existing.diff = `${existing.diff}\n\n${change.diff}`.trim()
  }
  const fileChanges = Array.from(fileChangeMap.values())
  if (fileChanges.length > 0) {
    blocks.push({
      id: 'tool-edits',
      name: `Edited ${fileChanges.length} file${fileChanges.length === 1 ? '' : 's'}`,
      input: calls.filter(call => (call.fileChanges?.length ?? 0) > 0).map(call => call.input).join('\n\n'),
      status: 'done',
      fileChanges,
    })
    for (const call of calls) {
      if ((call.fileChanges?.length ?? 0) > 0) handledIds.add(call.id)
    }
  }

  const exploreEntries = calls
    .filter(call => call.commandEntry && (call.commandEntry.kind === 'search' || call.commandEntry.kind === 'read'))
    .map(call => call.commandEntry!) 

  if (exploreEntries.length > 0) {
    const readCount = exploreEntries.filter(entry => entry.kind === 'read').length
    const searchCount = exploreEntries.filter(entry => entry.kind === 'search').length
    const labelParts: string[] = []
    if (readCount > 0) labelParts.push(`${readCount} file${readCount === 1 ? '' : 's'}`)
    if (searchCount > 0) labelParts.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`)

    blocks.push({
      id: 'tool-explore',
      name: `Explored ${labelParts.join(', ')}`,
      input: exploreEntries.map(entry => entry.command ?? entry.label).join('\n'),
      status: 'done',
      commandEntries: exploreEntries,
    })
    for (const call of calls) {
      if (call.commandEntry && (call.commandEntry.kind === 'search' || call.commandEntry.kind === 'read')) handledIds.add(call.id)
    }
  }

  for (const call of calls) {
    if (handledIds.has(call.id)) continue
    blocks.push({
      id: call.id,
      name: call.name,
      input: call.input,
      summary: truncateToolPreview(sanitizeToolOutputText(call.output), 240) || undefined,
      status: call.status,
      commandEntries: call.commandEntry ? [call.commandEntry] : undefined,
    })
  }

  return blocks
}

function parseCodexToolCall(payload: any): PendingImportedToolCall | null {
  const callId = typeof payload?.call_id === 'string' ? payload.call_id : null
  const toolName = typeof payload?.name === 'string' ? payload.name : null
  if (!callId || !toolName) return null

  const rawInput = typeof payload?.arguments === 'string'
    ? payload.arguments
    : typeof payload?.input === 'string'
      ? payload.input
      : ''
  const command = extractCommandFromToolCall(toolName, rawInput)
  const patchText = toolName === 'apply_patch'
    ? extractApplyPatchText(rawInput) ?? rawInput
    : toolName === 'shell'
      ? extractApplyPatchText(command)
      : null

  const fileChanges = patchText ? parseApplyPatchFileChanges(patchText) : undefined
  const normalizedName = fileChanges && fileChanges.length > 0 ? 'apply_patch' : toolName
  const commandEntry = !fileChanges && command.trim()
    ? {
      label: command.trim(),
      command: command.trim(),
      kind: classifyCommand(command.trim()),
    }
    : undefined

  return {
    id: callId,
    name: normalizedName,
    input: fileChanges && fileChanges.length > 0 ? patchText ?? rawInput : rawInput,
    status: payload?.status === 'errored' ? 'error' : 'done',
    fileChanges,
    commandEntry,
  }
}

async function listFilesRecursive(root: string, predicate: (path: string) => boolean, maxDepth = 4): Promise<string[]> {
  const out: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    let entries: Array<import('fs').Dirent> = []
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'deleted') continue
        await walk(fullPath, depth + 1)
      } else if (predicate(fullPath)) {
        out.push(fullPath)
      }
    }
  }

  await walk(root, 0)
  return out
}

function parseOpenClawKey(sessionKey: string): { agentId: string; route: string; groupId: string; isSubagent: boolean } {
  const parts = sessionKey.split(':')
  const agentId = parts[1] || 'main'
  const route = parts[2] || 'main'
  return {
    agentId,
    route,
    groupId: `openclaw:${agentId}`,
    isSubagent: route === 'subagent',
  }
}

function formatOpenClawTitle(agentId: string, sessionKey: string, meta: any): { title: string; detail: string; relatedGroupId: string; nestingLevel: number } {
  const parsed = parseOpenClawKey(sessionKey)
  const agentLabel = humanizeSlug(agentId)
  const preferred = typeof meta?.label === 'string' && meta.label.trim()
    ? meta.label.trim()
    : typeof meta?.origin?.label === 'string' && meta.origin.label.trim()
      ? meta.origin.label.trim()
      : ''

  let title = preferred
  if (isGenericOpenClawLabel(title)) {
    if (parsed.isSubagent) title = `Subagent ${meta?.sessionId ? String(meta.sessionId).slice(0, 8) : ''}`.trim()
    else if (parsed.route === 'cron') title = 'Scheduled task'
    else if (parsed.route === 'webchat') title = 'Web chat'
    else if (parsed.route === 'main') title = `${agentLabel} chat`
    else title = humanizeSlug(parsed.route)
  }

  const detailParts = ['OpenClaw', agentLabel]
  if (parsed.route !== 'main' && parsed.route !== 'subagent') detailParts.push(humanizeSlug(parsed.route))
  if (parsed.isSubagent) detailParts.push('Subagent')

  return {
    title,
    detail: detailParts.join(' · '),
    relatedGroupId: parsed.groupId,
    nestingLevel: parsed.isSubagent ? 1 : 0,
  }
}

async function listCodeSurfSessionFiles(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const roots: Array<{ dir: string; scope: SessionScope }> = []
  if (workspacePath) roots.push({ dir: join(getProjectCodeSurfDir(workspacePath), 'sessions'), scope: 'project' })
  roots.push({ dir: join(CONTEX_HOME, 'sessions'), scope: 'user' })

  const entries: AggregatedSessionEntry[] = []

  for (const root of roots) {
    if (!(await fileExists(root.dir))) continue
    const files = await listFilesRecursive(root.dir, path => ['.json', '.jsonl', '.md', '.txt'].includes(extname(path).toLowerCase()), 3)

    for (const filePath of files) {
      const stat = await statSafe(filePath)
      if (!stat?.isFile()) continue

      let title = basename(filePath)
      let lastMessage: string | null = null
      let messageCount = 0
      let sessionId: string | null = basename(filePath, extname(filePath))
      let provider = 'codesurf'
      let model = ''
      const ext = extname(filePath).toLowerCase()

      if (ext === '.json') {
        const parsed = await readJsonSafe(filePath, { maxBytes: MAX_SESSION_LISTING_JSON_BYTES })
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.messages)) {
            messageCount = parsed.messages.length
            const last = parsed.messages[parsed.messages.length - 1]
            lastMessage = truncate(typeof last?.content === 'string' ? last.content : extractTextParts(last?.content))
            title = sessionTitleFromText(title, lastMessage)
          } else if (Array.isArray(parsed.entries)) {
            messageCount = parsed.entries.length
          }
          if (typeof parsed.sessionId === 'string') sessionId = parsed.sessionId
          if (typeof parsed.provider === 'string') provider = parsed.provider
          if (typeof parsed.model === 'string') model = parsed.model
          if (typeof parsed.title === 'string' && parsed.title.trim()) title = parsed.title.trim()
        }
      } else if (ext === '.md' || ext === '.txt') {
        const raw = await readTextPreviewSafe(filePath)
        lastMessage = truncate(raw)
        title = sessionTitleFromText(title, raw)
      }

      entries.push({
        id: `codesurf-file:${filePath}`,
        source: 'codesurf',
        scope: root.scope,
        tileId: null,
        sessionId,
        provider,
        model,
        messageCount,
        lastMessage,
        updatedAt: stat.mtimeMs,
        filePath,
        title,
        projectPath: root.scope === 'project' ? workspacePath : null,
        sourceLabel: 'CodeSurf',
        sourceDetail: root.scope === 'project' ? 'Project session' : 'User session',
        canOpenInChat: true,
        canOpenInApp: false,
      })
    }
  }

  return entries
}

async function listClaudeSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const projectRoot = join(homedir(), '.claude', 'projects')
  const transcriptRoot = join(homedir(), '.claude', 'transcripts')
  const candidateFiles = new Map<string, string | null>()

  if (workspacePath) {
    const exactProjectDir = join(projectRoot, encodeClaudeProjectDirName(workspacePath))
    if (await fileExists(exactProjectDir)) {
      try {
        const names = await fs.readdir(exactProjectDir)
        for (const name of names) {
          if (!name.endsWith('.jsonl')) continue
          candidateFiles.set(join(exactProjectDir, name), workspacePath)
        }
      } catch {
        // ignore unreadable Claude project dir
      }
    }
  }

  if (candidateFiles.size === 0 && await fileExists(projectRoot)) {
    const files = await listFilesRecursive(projectRoot, path => extname(path).toLowerCase() === '.jsonl', 2)
    for (const filePath of files) candidateFiles.set(filePath, null)
  }

  if (await fileExists(transcriptRoot)) {
    try {
      const names = await fs.readdir(transcriptRoot)
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const filePath = join(transcriptRoot, name)
        if (!candidateFiles.has(filePath)) candidateFiles.set(filePath, null)
      }
    } catch {
      // ignore unreadable transcript dir
    }
  }

  const withStat = await Promise.all(
    [...candidateFiles.entries()].map(async ([filePath, projectPathHint]) => ({
      filePath,
      projectPathHint,
      stat: await statSafe(filePath),
    })),
  )
  const recent = withStat
    .filter(item => item.stat?.isFile())
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, 500)

  const entries = await Promise.all(recent.map(async ({ filePath, projectPathHint, stat }) => {
    const listing = await readClaudeListingMeta(filePath, stat!, projectPathHint)

    return {
      id: `claude:${filePath}`,
      source: 'claude' as const,
      scope: pathScope(workspacePath, listing.projectPath, 'user'),
      tileId: null,
      sessionId: listing.sessionId,
      provider: 'claude',
      model: listing.model,
      messageCount: listing.messageCount,
      lastMessage: listing.lastMessage,
      updatedAt: stat?.mtimeMs ?? 0,
      sizeBytes: stat?.size ?? 0,
      filePath,
      title: listing.title,
      projectPath: listing.projectPath,
      sourceLabel: 'Claude',
      sourceDetail: listing.gitBranch ?? undefined,
      canOpenInChat: true,
      canOpenInApp: true,
      resumeBin: 'claude',
      resumeArgs: listing.sessionId ? ['--resume', listing.sessionId] : ['--resume'],
    }
  }))

  return entries
}

type CodexListingMeta = {
  sessionId: string | null
  title: string
  lastMessage: string | null
  messageCount: number
  projectPath: string | null
  model: string
  gitBranch: string | null
  createdAt: number
}

function parseCodexCreatedTimestamp(filePath: string): number {
  const base = basename(filePath)
  const match = base.match(/rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!match) return 0
  const [, y, m, d, hh, mm, ss] = match
  return Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}Z`) || 0
}

function scanCodexListingLines(
  lines: string[],
  meta: {
    sessionId: string | null
    projectPath: string | null
    model: string
    gitBranch: string | null
    threadName: string | null
    firstUserPrompt: string | null
    lastAssistantText: string | null
    lastConversationText: string | null
    messageCount: number
    createdAt: number
  },
  options?: { countMessages?: boolean },
): void {
  for (const line of lines) {
    const evt = parseJsonObject(line)
    if (!evt) continue
    const payload = evt.payload

    if (evt.type === 'session_meta') {
      if (!meta.sessionId && typeof payload?.id === 'string' && payload.id.trim()) meta.sessionId = payload.id.trim()
      if (!meta.projectPath && typeof payload?.cwd === 'string' && payload.cwd.trim()) meta.projectPath = payload.cwd.trim()
      if (!meta.model && typeof payload?.model === 'string' && payload.model.trim()) meta.model = payload.model.trim()
      if (!meta.gitBranch && typeof payload?.git?.branch === 'string' && payload.git.branch.trim()) meta.gitBranch = payload.git.branch.trim()
      if (!meta.createdAt) {
        const createdAt = Date.parse(typeof payload?.timestamp === 'string' ? payload.timestamp : '')
        if (Number.isFinite(createdAt) && createdAt > 0) meta.createdAt = createdAt
      }
      continue
    }

    if (evt.type === 'turn_context') {
      if (!meta.projectPath && typeof payload?.cwd === 'string' && payload.cwd.trim()) meta.projectPath = payload.cwd.trim()
      if (!meta.model && typeof payload?.model === 'string' && payload.model.trim()) meta.model = payload.model.trim()
      continue
    }

    if (evt.type === 'event_msg') {
      if (!meta.threadName && payload?.type === 'thread_name_updated' && typeof payload?.thread_name === 'string' && payload.thread_name.trim()) {
        meta.threadName = truncate(payload.thread_name, 200)
      }
      if (!meta.firstUserPrompt && payload?.type === 'user_message' && typeof payload?.message === 'string') {
        meta.firstUserPrompt = truncate(stripCodexSystemMarkers(payload.message), 400)
      }
      continue
    }

    if (evt.type !== 'response_item' || payload?.type !== 'message') continue
    const role = roleFromUnknown(payload?.role)
    if (!role || role === 'system') continue

    const text = truncate(stripCodexSystemMarkers(extractTextParts(payload.content)), 400)
    if (!text) continue

    if (options?.countMessages) meta.messageCount += 1
    if (role === 'user' && !meta.firstUserPrompt) meta.firstUserPrompt = text
    if (role === 'assistant') meta.lastAssistantText = text
    meta.lastConversationText = text
  }
}

async function readCodexListingMeta(
  filePath: string,
  stat: import('fs').Stats,
): Promise<CodexListingMeta> {
  const baseMeta = {
    sessionId: basename(filePath, '.jsonl'),
    projectPath: null as string | null,
    model: '',
    gitBranch: null as string | null,
    threadName: null as string | null,
    firstUserPrompt: null as string | null,
    lastAssistantText: null as string | null,
    lastConversationText: null as string | null,
    messageCount: 0,
    createdAt: parseCodexCreatedTimestamp(filePath),
  }

  if (stat.size <= CODEX_SESSION_EXACT_SCAN_MAX_BYTES) {
    const raw = await readTextSafe(filePath)
    scanCodexListingLines(parseJsonlLines(raw ?? ''), baseMeta, { countMessages: true })
  } else {
    const [headRaw, tailRaw] = await Promise.all([
      readTextPreviewSafe(filePath, CODEX_SESSION_LISTING_HEAD_BYTES),
      readTextTailSafe(filePath, CODEX_SESSION_LISTING_TAIL_BYTES),
    ])
    scanCodexListingLines(parseJsonlLines(headRaw ?? ''), baseMeta)
    scanCodexListingLines(parseJsonlLines(tailRaw ?? ''), baseMeta)
  }

  const title = sessionTitleFromText('Codex session', baseMeta.threadName ?? baseMeta.firstUserPrompt ?? baseMeta.lastAssistantText ?? baseMeta.lastConversationText)
  return {
    sessionId: baseMeta.sessionId,
    title,
    lastMessage: baseMeta.lastAssistantText ?? baseMeta.lastConversationText ?? baseMeta.firstUserPrompt,
    messageCount: baseMeta.messageCount,
    projectPath: baseMeta.projectPath,
    model: baseMeta.model,
    gitBranch: baseMeta.gitBranch,
    createdAt: baseMeta.createdAt,
  }
}

async function listCodexSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.codex', 'sessions')
  if (!(await fileExists(root))) return []

  const withStat = await Promise.all((await listFilesRecursive(root, path => {
    const ext = extname(path).toLowerCase()
    return ext === '.jsonl' || ext === '.json'
  }, 4)).map(async filePath => ({
    filePath,
    stat: await statSafe(filePath),
  })))

  const recent = withStat
    .filter(item => item.stat?.isFile())
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, 500)

  const entries = await Promise.all(recent.map(async ({ filePath, stat }) => {
    const ext = extname(filePath).toLowerCase()
    let listing: CodexListingMeta = {
      sessionId: basename(filePath, ext),
      title: 'Codex session',
      lastMessage: null,
      messageCount: 0,
      projectPath: null,
      model: '',
      gitBranch: null,
      createdAt: parseCodexCreatedTimestamp(filePath),
    }

    if (ext === '.jsonl') {
      listing = await readCodexListingMeta(filePath, stat!)
    } else {
      const parsed = await readJsonSafe(filePath, { maxBytes: MAX_SESSION_LISTING_JSON_BYTES })
      if (parsed && typeof parsed === 'object') {
        const messages = Array.isArray(parsed.items) ? parsed.items.filter(item => item?.type === 'message') : []
        const meaningfulMessages = messages
          .map(item => ({
            role: roleFromUnknown(item?.role),
            text: truncate(stripCodexSystemMarkers(extractTextParts(item?.content)), 400),
          }))
          .filter(item => item.role && item.role !== 'system' && item.text) as Array<{ role: ChatRole; text: string }>
        const firstUserPrompt = meaningfulMessages.find(item => item.role === 'user')?.text ?? null
        const lastAssistantText = [...meaningfulMessages].reverse().find(item => item.role === 'assistant')?.text ?? null
        const lastConversationText = meaningfulMessages[meaningfulMessages.length - 1]?.text ?? null
        const sessionId = typeof parsed.session?.id === 'string' && parsed.session.id.trim()
          ? parsed.session.id.trim()
          : basename(filePath, ext)
        const createdAt = Date.parse(typeof parsed.session?.timestamp === 'string' ? parsed.session.timestamp : '') || parseCodexCreatedTimestamp(filePath)
        const title = sessionTitleFromText('Codex session', firstUserPrompt ?? lastAssistantText ?? lastConversationText)
        listing = {
          sessionId,
          title,
          lastMessage: lastAssistantText ?? lastConversationText ?? firstUserPrompt,
          messageCount: meaningfulMessages.length,
          projectPath: null,
          model: typeof parsed.session?.model === 'string' ? parsed.session.model.trim() : '',
          gitBranch: typeof parsed.session?.git?.branch === 'string' ? parsed.session.git.branch.trim() : null,
          createdAt,
        }
      }
    }

    return {
      id: `codex:${filePath}`,
      source: 'codex' as const,
      scope: pathScope(workspacePath, listing.projectPath, 'user'),
      tileId: null,
      sessionId: listing.sessionId,
      provider: 'codex',
      model: listing.model,
      messageCount: listing.messageCount,
      lastMessage: listing.lastMessage,
      updatedAt: stat?.mtimeMs ?? listing.createdAt,
      sizeBytes: stat?.size ?? 0,
      filePath,
      title: listing.title,
      projectPath: listing.projectPath,
      sourceLabel: 'Codex',
      sourceDetail: listing.gitBranch ?? undefined,
      canOpenInChat: true,
      canOpenInApp: true,
      resumeBin: 'codex',
      resumeArgs: listing.sessionId ? ['resume', listing.sessionId] : ['resume'],
    }
  }))

  return entries
}

function decodeCursorMeta(hex: string): Record<string, any> | null {
  try {
    return JSON.parse(Buffer.from(hex.trim(), 'hex').toString('utf8'))
  } catch {
    return null
  }
}

async function listCursorSessions(_workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.cursor', 'chats')
  if (!(await fileExists(root))) return []

  const dbFiles = await listFilesRecursive(root, path => basename(path) === 'store.db', 3)
  const withStat = await Promise.all(dbFiles.map(async filePath => ({ filePath, stat: await statSafe(filePath) })))
  const recent = withStat
    .filter(item => item.stat?.isFile())
    .sort((a, b) => (b.stat?.mtimeMs ?? 0) - (a.stat?.mtimeMs ?? 0))
    .slice(0, 60)

  return recent.map(({ filePath, stat }) => {
    let title = 'Cursor chat'
    let sessionId = basename(filePath)

    try {
      const db = new Database(filePath, { readonly: true })
      const row = db.prepare("select value from meta where key='0'").get() as { value?: string } | undefined
      const meta = row?.value ? decodeCursorMeta(row.value) : null
      if (typeof meta?.name === 'string' && meta.name.trim()) title = meta.name.trim()
      if (typeof meta?.agentId === 'string') sessionId = meta.agentId
      db.close()
    } catch {
      // ignore cursor db parse issues
    }

    return {
      id: `cursor:${filePath}`,
      source: 'cursor' as const,
      scope: 'user' as const,
      tileId: null,
      sessionId,
      provider: 'cursor',
      model: '',
      messageCount: 0,
      lastMessage: null,
      updatedAt: stat?.mtimeMs ?? 0,
      filePath,
      title,
      projectPath: null,
      sourceLabel: 'Cursor',
      sourceDetail: 'Local chat store',
      canOpenInChat: false,
      canOpenInApp: false,
    }
  })
}

async function listOpenClawSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.openclaw', 'agents')
  if (!(await fileExists(root))) return []

  let agentDirs: Array<import('fs').Dirent> = []
  try {
    agentDirs = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  const entries: AggregatedSessionEntry[] = []

  for (const dirent of agentDirs) {
    if (!dirent.isDirectory()) continue
    const agentId = dirent.name
    const sessionsIndexPath = join(root, agentId, 'sessions', 'sessions.json')
    const parsed = await readJsonSafe(sessionsIndexPath)
    if (!parsed || typeof parsed !== 'object') continue

    for (const [key, value] of Object.entries(parsed)) {
      const meta = value as any
      if (typeof meta?.deletedAt === 'number') continue
      const updatedAt = typeof meta?.updatedAt === 'number' ? meta.updatedAt : 0
      const sessionFile = typeof meta?.sessionFile === 'string' ? meta.sessionFile : undefined
      const label = formatOpenClawTitle(agentId, key, meta)
      const projectPath = typeof meta?.cwd === 'string' && meta.cwd.startsWith('/') ? meta.cwd
        : typeof meta?.projectPath === 'string' && meta.projectPath.startsWith('/') ? meta.projectPath
        : typeof meta?.workingDirectory === 'string' && meta.workingDirectory.startsWith('/') ? meta.workingDirectory
        : null
      entries.push({
        id: `openclaw:${agentId}:${key}`,
        source: 'openclaw',
        scope: pathScope(workspacePath, projectPath, 'user'),
        tileId: null,
        sessionId: typeof meta?.sessionId === 'string' ? meta.sessionId : null,
        provider: 'openclaw',
        model: agentId,
        messageCount: 0,
        lastMessage: null,
        updatedAt,
        filePath: sessionFile,
        title: label.title,
        projectPath,
        sourceLabel: 'OpenClaw',
        sourceDetail: label.detail,
        canOpenInChat: Boolean(sessionFile),
        canOpenInApp: true,
        resumeBin: 'openclaw',
        resumeArgs: ['tui', '--session', key],
        relatedGroupId: label.relatedGroupId,
        nestingLevel: label.nestingLevel,
      })
    }
  }

  return entries.sort(compareSessions).slice(0, 500)
}

function parseOpenCodeTimestamp(filePath: string): number {
  const base = basename(filePath)
  const match = base.match(/_(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/)
  if (!match) return 0
  const [, date, hh, mm, ss, ms] = match
  return Date.parse(`${date}T${hh}:${mm}:${ss}.${ms}Z`) || 0
}

async function listOpenCodeSessions(workspacePath: string | null): Promise<AggregatedSessionEntry[]> {
  const root = join(homedir(), '.opencode', 'conversations')
  if (!(await fileExists(root))) return []

  const files = await listFilesRecursive(root, path => extname(path).toLowerCase() === '.json', 3)
  const recent = files
    .map(filePath => ({ filePath, ts: parseOpenCodeTimestamp(filePath) }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 500)

  const entries = await Promise.all(recent.map(async ({ filePath, ts }) => {
    const parsed = await readJsonSafe(filePath, { maxBytes: MAX_SESSION_LISTING_JSON_BYTES })
    const projectPath = typeof parsed?.projectPath === 'string' ? parsed.projectPath : null
    const lastMessage = Array.isArray(parsed?.messages)
      ? truncate(parsed.messages.filter((m: any) => typeof m?.content === 'string' && m.role !== 'system').slice(-1)[0]?.content)
      : null
    const sessionId = typeof parsed?.id === 'string' ? parsed.id : basename(filePath, '.json')

    return {
      id: `opencode:${filePath}`,
      source: 'opencode' as const,
      scope: pathScope(workspacePath, projectPath, 'user'),
      tileId: null,
      sessionId,
      provider: 'opencode',
      model: typeof parsed?.model === 'string' ? parsed.model : '',
      messageCount: Array.isArray(parsed?.messages) ? parsed.messages.length : 0,
      lastMessage,
      updatedAt: ts || Date.parse(parsed?.startTime ?? '') || 0,
      filePath,
      title: sessionTitleFromText('OpenCode session', lastMessage),
      projectPath,
      sourceLabel: 'OpenCode',
      sourceDetail: typeof parsed?.model === 'string' ? parsed.model : 'Conversation',
      canOpenInChat: true,
      canOpenInApp: true,
      resumeBin: 'opencode',
      resumeArgs: sessionId ? ['--session', sessionId] : [],
    }
  }))

  return entries
}

export async function listExternalSessionEntries(
  workspacePath: string | null,
  options?: { force?: boolean },
): Promise<AggregatedSessionEntry[]> {
  const cacheKey = workspacePath ?? '__no_workspace__'
  const cached = externalSessionCache.get(cacheKey)
  if (!options?.force && cached && (Date.now() - cached.at) < EXTERNAL_SESSION_CACHE_MS) {
    return cached.entries
  }

  await ensureCodeSurfStructure(workspacePath)

  const entries = [
    ...(await listCodeSurfSessionFiles(workspacePath)),
    ...(await listClaudeSessions(workspacePath)),
    ...(await listCodexSessions(workspacePath)),
    ...(await listCursorSessions(workspacePath)),
    ...(await listOpenClawSessions(workspacePath)),
    ...(await listOpenCodeSessions(workspacePath)),
  ].sort(compareSessions)

  externalSessionCache.set(cacheKey, { at: Date.now(), entries })
  return entries
}

function buildEntryFromHint(workspacePath: string | null, hint: SessionEntryHint): AggregatedSessionEntry {
  return {
    id: hint.id,
    source: hint.source,
    scope: pathScope(workspacePath, hint.projectPath ?? null, 'user'),
    tileId: null,
    sessionId: hint.sessionId,
    provider: hint.provider,
    model: hint.model,
    messageCount: hint.messageCount,
    lastMessage: null,
    updatedAt: 0,
    filePath: hint.filePath,
    title: hint.title,
    projectPath: hint.projectPath ?? null,
    sourceLabel: hint.provider || hint.source,
    canOpenInChat: true,
    canOpenInApp: false,
  }
}

async function resolveSessionEntry(
  workspacePath: string | null,
  id: string,
  entryHint?: SessionEntryHint | null,
): Promise<AggregatedSessionEntry | null> {
  if (entryHint && entryHint.id === id && entryHint.filePath) {
    const stat = await statSafe(entryHint.filePath)
    if (stat?.isFile()) return buildEntryFromHint(workspacePath, entryHint)
  }
  return findSessionEntryById(workspacePath, id)
}

export async function findSessionEntryById(workspacePath: string | null, id: string): Promise<AggregatedSessionEntry | null> {
  // First try the workspace-scoped list — fast path for the common case.
  const scoped = await listExternalSessionEntries(workspacePath)
  const scopedHit = scoped.find(entry => entry.id === id)
  if (scopedHit) return scopedHit

  // Sidebar listings go through the daemon indexer which sees globally; the
  // main-process scoped index occasionally misses sessions whose cwd doesn't
  // exactly match the workspace path (symlinks, alt paths, or user-scope
  // global sessions). Fall back to the unscoped list so clicking one of
  // those rows still loads its chat state instead of silently failing.
  if (workspacePath) {
    const global = await listExternalSessionEntries(null)
    const globalHit = global.find(entry => entry.id === id)
    if (globalHit) return globalHit
  }

  // Last-resort: force-refresh the scoped cache in case the session was just
  // created and the prior entry is stale.
  const refreshed = await listExternalSessionEntries(workspacePath, { force: true })
  const refreshedHit = refreshed.find(entry => entry.id === id)
  if (refreshedHit) return refreshedHit

  // The sidebar list comes from the daemon's global view, so a user-scoped
  // transcript can still be visible even when the workspace-scoped cache and
  // its forced refresh don't contain it yet.
  if (workspacePath) {
    const refreshedGlobal = await listExternalSessionEntries(null, { force: true })
    return refreshedGlobal.find(entry => entry.id === id) ?? null
  }

  return null
}

async function parseCodeSurfChatState(filePath: string): Promise<ImportedChatState | null> {
  const parsed = await readJsonSafe(filePath)
  if (parsed && Array.isArray(parsed.messages)) {
    const messages = parsed.messages
      .map((message: any, index: number) => {
        const role = roleFromUnknown(message?.role) ?? 'assistant'
        return makeImportedRichMessage({
          id: `codesurf-${index}`,
          role,
          content: typeof message?.content === 'string' ? message.content : extractTextParts(message?.content),
          timestamp: Number(message?.timestamp) || Date.now() + index,
          thinking: typeof message?.thinking?.content === 'string'
            ? { content: message.thinking.content, done: message.thinking.done !== false }
            : undefined,
          toolBlocks: Array.isArray(message?.toolBlocks) ? message.toolBlocks : undefined,
        })
      })
      .filter(Boolean) as ImportedChatMessage[]

    return {
      provider: typeof parsed.provider === 'string' ? parsed.provider : 'claude',
      model: typeof parsed.model === 'string' ? parsed.model : '',
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      messages,
    }
  }

  const raw = await readTextSafe(filePath)
  if (!raw) return null
  return {
    provider: 'claude',
    model: '',
    sessionId: null,
    messages: [
      {
        id: 'codesurf-import-0',
        role: 'system',
        content: raw,
        timestamp: Date.now(),
      },
    ],
  }
}

async function parseClaudeChatState(
  filePath: string,
  entry: AggregatedSessionEntry,
  options?: { full?: boolean },
): Promise<ImportedChatState | null> {
  const stat = await statSafe(filePath)
  if (!stat?.isFile()) return null

  if (!options?.full && stat.size > LARGE_EXTERNAL_SESSION_BYTES) {
    const [headRaw, tailRaw] = await Promise.all([
      readTextPreviewSafe(filePath, EXTERNAL_SESSION_HEAD_SAMPLE_BYTES),
      readTextTailSafe(filePath, EXTERNAL_SESSION_TAIL_SAMPLE_BYTES),
    ])

    const headMessages = parseClaudeMessagesFromLines(parseJsonlLines(headRaw ?? ''), 0)
    const tailLines = parseJsonlLines(tailRaw ?? '')
    const tailMessages = parseClaudeMessagesFromLines(tailLines, Math.max(0, tailLines.length * -1))
    const firstMessage = headMessages.find(message => message.role !== 'system') ?? headMessages[0] ?? null
    const messages = dedupeImportedMessages([
      ...(firstMessage ? [firstMessage] : []),
      makeTranscriptTruncationMessage('claude', stat.size),
      ...tailMessages,
    ])

    return {
      provider: 'claude',
      model: entry.model,
      sessionId: entry.sessionId,
      messages,
    }
  }

  const messages: ImportedChatMessage[] = []

  try {
    await scanJsonlFile(filePath, (line, lineNumber) => {
      try {
        const evt = JSON.parse(line)
        const role = roleFromUnknown(evt?.type) ?? roleFromUnknown(evt?.role)
        if (!role || typeof evt?.content !== 'string') return
        const message = makeImportedMessage(
          `claude-${lineNumber - 1}`,
          role,
          evt.content,
          Date.parse(evt?.timestamp ?? '') || Date.now() + lineNumber,
        )
        if (message) messages.push(message)
      } catch {
        // ignore malformed transcript lines
      }
    })
  } catch {
    return null
  }

  return {
    provider: 'claude',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}

function parseCodexChatStateFromLines(lines: string[], entry: AggregatedSessionEntry, offset = 0): ImportedChatState {
  const messages: ImportedChatMessage[] = []
  const pendingToolCalls = new Map<string, PendingImportedToolCall>()
  let pendingThinking: string[] = []
  let pendingCalls: PendingImportedToolCall[] = []
  let model = entry.model
  let sessionId = entry.sessionId

  const flushAssistantArtifacts = (index: number, timestamp: number, content = '') => {
    const next = makeImportedRichMessage({
      id: `codex-${index}`,
      role: 'assistant',
      content,
      timestamp,
      thinking: pendingThinking.length > 0 ? { content: pendingThinking.join('\n\n'), done: true } : undefined,
      toolBlocks: buildImportedToolBlocks(pendingCalls),
    })
    if (next) messages.push(next)
    pendingThinking = []
    pendingCalls = []
    pendingToolCalls.clear()
  }

  let lastIndex = offset
  lines.forEach((line, index) => {
    const absoluteIndex = offset + index
    lastIndex = absoluteIndex
    try {
      const evt = JSON.parse(line)
      const timestamp = Date.parse(evt?.timestamp ?? '') || Date.now() + absoluteIndex
      const payload = evt?.payload

      if (!model && typeof payload?.model === 'string') model = payload.model
      if (!sessionId && typeof payload?.id === 'string') sessionId = payload.id

      if (evt?.type !== 'response_item') return

      if (payload?.type === 'reasoning') {
        const summary = extractReasoningSummary(payload)
        if (summary) pendingThinking.push(summary)
        return
      }

      if (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') {
        const call = parseCodexToolCall(payload)
        if (!call) return
        pendingToolCalls.set(call.id, call)
        pendingCalls.push(call)
        return
      }

      if (payload?.type === 'function_call_output') {
        const callId = typeof payload?.call_id === 'string' ? payload.call_id : null
        if (!callId) return
        const existing = pendingToolCalls.get(callId)
        if (!existing) return
        existing.output = sanitizeToolOutputText(typeof payload?.output === 'string' ? payload.output : '')
        if (existing.commandEntry) existing.commandEntry.output = existing.output
        return
      }

      if (payload?.type !== 'message') return
      const role = roleFromUnknown(payload?.role)
      if (!role) return

      const content = stripCodexSystemMarkers(extractTextParts(payload.content))
      if (role === 'assistant') {
        flushAssistantArtifacts(absoluteIndex, timestamp, content)
        return
      }

      if (pendingThinking.length > 0 || pendingCalls.length > 0) {
        flushAssistantArtifacts(absoluteIndex, timestamp, '')
      }

      const message = makeImportedMessage(`codex-${absoluteIndex}`, role, content, timestamp)
      if (message) messages.push(message)
    } catch {
      // ignore malformed session lines
    }
  })

  if (pendingThinking.length > 0 || pendingCalls.length > 0) {
    flushAssistantArtifacts(lastIndex + 1, Date.now())
  }

  return {
    provider: 'codex',
    model,
    sessionId,
    messages,
  }
}

async function parseCodexChatState(
  filePath: string,
  entry: AggregatedSessionEntry,
  options?: { full?: boolean },
): Promise<ImportedChatState | null> {
  const stat = await statSafe(filePath)
  if (!stat?.isFile()) return null

  if (!options?.full && stat.size > LARGE_EXTERNAL_SESSION_BYTES) {
    const [headRaw, tailRaw] = await Promise.all([
      readTextPreviewSafe(filePath, EXTERNAL_SESSION_HEAD_SAMPLE_BYTES),
      readTextTailSafe(filePath, EXTERNAL_SESSION_TAIL_SAMPLE_BYTES),
    ])
    const headLines = parseJsonlLines(headRaw ?? '')
    const tailLines = parseJsonlLines(tailRaw ?? '')
    const firstChunk = parseCodexChatStateFromLines(headLines, entry, 0)
    const recentChunk = parseCodexChatStateFromLines(tailLines, entry, Math.max(10_000, tailLines.length))
    const firstMessage = firstChunk.messages.find(message => message.role === 'user') ?? firstChunk.messages[0] ?? null
    const messages = dedupeImportedMessages([
      ...(firstMessage ? [firstMessage] : []),
      makeTranscriptTruncationMessage('codex', stat.size),
      ...recentChunk.messages,
    ])
    return {
      provider: 'codex',
      model: recentChunk.model || firstChunk.model,
      sessionId: recentChunk.sessionId ?? firstChunk.sessionId,
      messages,
    }
  }

  const lines: string[] = []
  try {
    await scanJsonlFile(filePath, line => {
      lines.push(line)
    })
  } catch {
    return null
  }
  return parseCodexChatStateFromLines(lines, entry, 0)
}

async function parseOpenClawChatState(filePath: string, entry: AggregatedSessionEntry): Promise<ImportedChatState | null> {
  const raw = await readTextSafe(filePath)
  if (!raw) return null
  const messages = raw.split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        const evt = JSON.parse(line)
        if (evt?.type !== 'message') return null
        const role = roleFromUnknown(evt?.message?.role)
        if (!role) return null
        return makeImportedMessage(`openclaw-${index}`, role, extractTextParts(evt?.message?.content), Date.parse(evt?.timestamp ?? '') || Number(evt?.message?.timestamp) || Date.now() + index)
      } catch {
        return null
      }
    })
    .filter(Boolean) as ImportedChatMessage[]

  return {
    provider: 'openclaw',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}

async function parseOpenCodeChatState(filePath: string, entry: AggregatedSessionEntry): Promise<ImportedChatState | null> {
  const parsed = await readJsonSafe(filePath)
  if (!parsed || !Array.isArray(parsed.messages)) return null
  const messages = parsed.messages
    .map((message: any, index: number) => {
      const role = roleFromUnknown(message?.role)
      if (!role) return null
      return makeImportedMessage(`opencode-${index}`, role, extractTextParts(message?.content), Number(message?.timestamp) || Date.now() + index)
    })
    .filter(Boolean) as ImportedChatMessage[]

  return {
    provider: 'opencode',
    model: entry.model,
    sessionId: entry.sessionId,
    messages,
  }
}

export function invalidateExternalSessionCache(workspacePath?: string | null): void {
  if (workspacePath) {
    externalSessionCache.delete(workspacePath)
    for (const key of externalSessionStateCache.keys()) {
      if (key.startsWith(`${workspacePath}::`)) externalSessionStateCache.delete(key)
    }
    for (const key of externalSessionFullStateCache.keys()) {
      if (key.startsWith(`${workspacePath}::`)) externalSessionFullStateCache.delete(key)
    }
    return
  }
  externalSessionCache.clear()
  externalSessionStateCache.clear()
  externalSessionFullStateCache.clear()
}

async function loadCachedExternalSessionState(entry: AggregatedSessionEntry, cacheKey: string): Promise<ImportedChatState | null> {
  if (!entry.filePath) return null

  return await getCachedExternalSessionChatState(
    externalSessionStateCache,
    EXTERNAL_SESSION_STATE_CACHE_MAX_ENTRIES,
    cacheKey,
    entry.filePath,
    async () => {
      if (entry.source === 'codesurf') return parseCodeSurfChatState(entry.filePath!)
      if (entry.source === 'claude') return parseClaudeChatState(entry.filePath!, entry)
      if (entry.source === 'codex') return parseCodexChatState(entry.filePath!, entry)
      if (entry.source === 'openclaw') return parseOpenClawChatState(entry.filePath!, entry)
      if (entry.source === 'opencode') return parseOpenCodeChatState(entry.filePath!, entry)
      return null
    },
  )
}

async function loadCachedFullExternalSessionState(entry: AggregatedSessionEntry, cacheKey: string): Promise<ImportedChatState | null> {
  if (!entry.filePath) return null

  return await getCachedExternalSessionChatState(
    externalSessionFullStateCache,
    EXTERNAL_SESSION_FULL_STATE_CACHE_MAX_ENTRIES,
    `${cacheKey}::full`,
    entry.filePath,
    async () => {
      if (entry.source === 'codesurf') return parseCodeSurfChatState(entry.filePath!)
      if (entry.source === 'claude') return parseClaudeChatState(entry.filePath!, entry, { full: true })
      if (entry.source === 'codex') return parseCodexChatState(entry.filePath!, entry, { full: true })
      if (entry.source === 'openclaw') return parseOpenClawChatState(entry.filePath!, entry)
      if (entry.source === 'opencode') return parseOpenCodeChatState(entry.filePath!, entry)
      return null
    },
  )
}

function inferHasEarlierMessages(entry: AggregatedSessionEntry, loadedCount: number, tailLimit?: number): boolean {
  if (tailLimit == null) return false
  if (loadedCount > tailLimit) return true
  return Number.isFinite(entry.messageCount) && entry.messageCount > Math.max(loadedCount, tailLimit)
}

export async function getExternalSessionChatState(
  workspacePath: string | null,
  id: string,
  options?: { entryHint?: SessionEntryHint | null; tailLimit?: number },
): Promise<(ImportedChatState & { hasEarlierMessages?: boolean }) | null> {
  const entry = await resolveSessionEntry(workspacePath, id, options?.entryHint)
  if (!entry?.filePath || !entry.canOpenInChat) return null
  const cacheKey = `${workspacePath ?? '__no_workspace__'}::${entry.source}::${entry.filePath}`
  const tailLimit = typeof options?.tailLimit === 'number' && options.tailLimit > 0
    ? Math.max(1, Math.floor(options.tailLimit))
    : null

  const cachedFullState = tailLimit == null
    ? null
    : await getFreshCachedExternalSessionChatState(
        externalSessionFullStateCache,
        EXTERNAL_SESSION_FULL_STATE_CACHE_MAX_ENTRIES,
        `${cacheKey}::full`,
        entry.filePath,
      )

  const state = cachedFullState ?? await loadCachedExternalSessionState(entry, cacheKey)
  if (!state) return null

  if (tailLimit == null || state.messages.length <= tailLimit) {
    return {
      ...state,
      hasEarlierMessages: inferHasEarlierMessages(entry, state.messages.length, tailLimit ?? undefined),
    }
  }

  return {
    ...state,
    messages: state.messages.slice(-tailLimit),
    hasEarlierMessages: true,
  }
}

export async function loadExternalSessionMessagesPage(
  workspacePath: string | null,
  id: string,
  options: {
    entryHint?: SessionEntryHint | null
    beforeFingerprint?: string | null
    limit?: number
  },
): Promise<{
  provider: string
  model: string
  sessionId: string | null
  total: number
  hasMore: boolean
  messages: ImportedChatMessage[]
} | null> {
  const entry = await resolveSessionEntry(workspacePath, id, options.entryHint)
  if (!entry?.filePath || !entry.canOpenInChat) return null

  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)))
  const cacheKey = `${workspacePath ?? '__no_workspace__'}::${entry.source}::${entry.filePath}`
  const state = await loadCachedFullExternalSessionState(entry, cacheKey)
  if (!state) return null

  const beforeFingerprint = String(options.beforeFingerprint ?? '').trim()
  let endIndex = state.messages.length
  if (beforeFingerprint) {
    const matchIndex = state.messages.findIndex(message => buildChatMessageHistoryFingerprint(message as any) === beforeFingerprint)
    if (matchIndex < 0) {
      return {
        provider: state.provider,
        model: state.model,
        sessionId: state.sessionId,
        total: state.messages.length,
        hasMore: false,
        messages: [],
      }
    }
    endIndex = matchIndex
  }

  const startIndex = Math.max(0, endIndex - limit)
  return {
    provider: state.provider,
    model: state.model,
    sessionId: state.sessionId,
    total: state.messages.length,
    hasMore: startIndex > 0,
    messages: state.messages.slice(startIndex, endIndex),
  }
}
