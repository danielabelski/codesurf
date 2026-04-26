import { randomUUID } from 'node:crypto'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { ApplicationMenu, BrowserView, BrowserWindow, Utils } from 'electrobun/bun'
import type { CodeSurfElectrobunRPC } from '../../src/shared/electrobun-rpc.ts'
import type { ExecutionHostRecord, ExecutionPreference, ProjectRecord, Workspace, WorkspaceRecord } from '../../src/shared/types.ts'
import { DEFAULT_SETTINGS, withDefaultSettings } from '../../src/shared/types.ts'
import { buildHermesChatArgs, buildOpenClawAgentArgs, buildOpenCodeRunArgs, sanitizeAgentCliDiagnostic } from '../../src/main/agents/agent-cli-contracts.ts'
import { CONTEX_HOME, WORKSPACES_DIR } from '../../src/main/paths.ts'
import { getDefaultElectrobunInvokeResponse } from '../../src/electrobun/browser/electron-facade.ts'
import { createElectrobunDbRuntime } from './runtime-db.ts'
import { builtInDaemonHosts, createElectrobunDaemonRuntime, sanitizeDaemonStatusError, summarizeDaemonDashboard } from './runtime-daemon.ts'
import { parseClaudeStreamJsonLine, parseCodexJsonLine, parseOpenClawOutput, parseOpenCodeJsonLine, type ElectrobunStreamEvent } from './chat-streams.ts'

type WorkspacesDocument = {
  version?: number
  activeWorkspaceId?: string | null
  workspaces?: WorkspaceRecord[]
}

type ProjectsDocument = {
  version?: number
  projects?: ProjectRecord[]
}

type ElectrobunRPCInstance = typeof rpc

type LiveWindow = {
  win: BrowserWindow<ElectrobunRPCInstance>
  title: string
  fresh: boolean
}

type TerminalSession = {
  shell: string
  buffer: string
  cwd: string
}

type PtyHostMessage = {
  type?: string
  tileId?: string
  data?: string
  error?: string
  exitCode?: number
  cols?: number
  rows?: number
  buffer?: string
}

type ChatRequest = {
  cardId: string
  workspaceId?: string | null
  provider?: string | null
  model?: string | null
  mode?: string | null
  thinking?: string | null
  workspaceDir?: string | null
  sessionId?: string | null
  jobId?: string | null
  jobSequence?: number | null
  messages?: Array<{ role?: string, content?: string }>
}

type BusEvent = {
  channel: string
  type: string
  source: string
  payload?: unknown
  at: number
}

const RENDERER_DEV_URL = process.env.CODESURF_ELECTROBUN_RENDERER_URL ?? 'http://localhost:5173'
const RENDERER_BUNDLED_URL = 'views://mainview/index.html'
const BRIDGE_PRELOAD_URL = 'views://codesurf-electrobun/index.js'
const PROJECTS_PATH = join(CONTEX_HOME, 'projects', 'projects.json')
const WORKSPACES_PATH = join(CONTEX_HOME, 'workspaces', 'workspaces.json')
const SETTINGS_PATH = join(CONTEX_HOME, 'settings.json')
const MCP_CONFIG_PATH = join(CONTEX_HOME, 'mcp-server.json')
const MAX_BUS_HISTORY = 500
const MAX_TERMINAL_BUFFER = 200_000
const dbRuntime = createElectrobunDbRuntime(CONTEX_HOME)
const daemonRuntime = createElectrobunDaemonRuntime(CONTEX_HOME)
const OPEN_CODE_FALLBACK_MODELS = [
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
  { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
  { id: 'openai/o4-mini', label: 'o4-mini' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
]
const SMOKE_FILE = process.env.CODESURF_ELECTROBUN_SMOKE_FILE ?? ''
const SMOKE_EXIT_AFTER_MS = Number(
  process.env.CODESURF_ELECTROBUN_SMOKE_EXIT_AFTER_MS
  ?? (process.env.CODESURF_ELECTROBUN_SMOKE === '1' ? '2500' : '0'),
)
const smokeStatusState: Record<string, unknown> = {}

const runtimeHost: ExecutionHostRecord = {
  id: 'electrobun-runtime',
  type: 'runtime',
  label: 'Electrobun Runtime',
  enabled: true,
}

async function listExecutionHostsFromDaemon(): Promise<ExecutionHostRecord[]> {
  try {
    await daemonRuntime.ensureRunning()
    const hosts = await daemonRuntime.request<ExecutionHostRecord[]>('/host/list')
    return Array.isArray(hosts) && hosts.length > 0 ? hosts : builtInDaemonHosts() as unknown as ExecutionHostRecord[]
  } catch {
    return builtInDaemonHosts() as unknown as ExecutionHostRecord[]
  }
}

async function resolveElectrobunExecutionTarget(preference: ExecutionPreference): Promise<{ host: ExecutionHostRecord, fallback: boolean, reason: string }> {
  const hosts = await listExecutionHostsFromDaemon()
  const daemonStatus = await daemonRuntime.status()
  const enabledHosts = hosts.filter(host => host.enabled !== false)
  const runtime = enabledHosts.find(host => host.type === 'runtime') ?? runtimeHost
  const localDaemon = enabledHosts.find(host => host.id === 'local-daemon' || host.type === 'local-daemon') ?? null
  const byId = new Map(enabledHosts.map(host => [host.id, host]))

  switch (preference?.mode) {
    case 'runtime-only':
      return { host: runtime, fallback: false, reason: 'Execution is pinned to the in-process runtime.' }
    case 'daemon-only':
      if (daemonStatus.running && localDaemon) return { host: localDaemon, fallback: false, reason: 'Execution requires the local daemon and it is available.' }
      return { host: runtime, fallback: true, reason: 'Local daemon is unavailable, so Electrobun fell back to the runtime.' }
    case 'specific-host': {
      const selected = preference.hostId ? byId.get(preference.hostId) : null
      if (selected) return { host: selected, fallback: false, reason: `Execution is pinned to ${selected.label}.` }
      if (daemonStatus.running && localDaemon) return { host: localDaemon, fallback: true, reason: 'Pinned host is missing or disabled, so execution fell back to the local daemon.' }
      return { host: runtime, fallback: true, reason: 'Pinned host is missing or disabled, so execution fell back to the runtime.' }
    }
    case 'prefer-local-daemon':
    case 'auto':
    default:
      if (daemonStatus.running && localDaemon) return { host: localDaemon, fallback: false, reason: 'Electrobun selected the live local daemon.' }
      return { host: runtime, fallback: true, reason: 'Local daemon is unavailable, so Electrobun fell back to the runtime.' }
  }
}

async function getDaemonSummaryForStatusBar() {
  try {
    const dashboard = await daemonRuntime.request<any>('/dashboard/api/jobs')
    const status = await daemonRuntime.status()
    return summarizeDaemonDashboard(dashboard, status)
  } catch (error) {
    const status = sanitizeDaemonStatusError(error)
    return {
      ...status,
      jobs: dbRuntime.getJobSummary(),
      dreaming: null,
    }
  }
}

const liveWindows = new Map<number, LiveWindow>()
const terminalSessions = new Map<string, TerminalSession>()
const chatProcesses = new Map<string, ChildProcess>()
const chatSessionIds = new Map<string, string>()
const busHistory = new Map<string, BusEvent[]>()
const tileContext = new Map<string, unknown>()
const activityRecords = new Map<string, Record<string, unknown>>()
let focusedWindowId = 1
let shellPathCache: string | null | undefined
let ptyHostProcess: ChildProcess | null = null
let ptyHostStdoutBuffer = ''

function defaultWorkspace(): Workspace {
  const cwd = process.cwd()
  return {
    id: 'electrobun-local',
    name: basename(cwd) || 'CodeSurf',
    path: cwd,
    projectPaths: [cwd],
  }
}

function safeId(prefix: string): string {
  return `${prefix}-${randomUUID()}`
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(data, null, 2))
}

async function writeSmokeStatus(phase: string, payload: Record<string, unknown> = {}): Promise<void> {
  if (!SMOKE_FILE) return
  Object.assign(smokeStatusState, payload)
  try {
    await writeJson(SMOKE_FILE, {
      ...smokeStatusState,
      phase,
      runtime: 'electrobun',
      pid: process.pid,
      platform: process.platform,
      at: new Date().toISOString(),
    })
  } catch (error) {
    console.warn('[Electrobun] smoke status write failed:', error)
  }
}

async function readProjectsDoc(): Promise<ProjectsDocument> {
  const doc = await readJson<ProjectsDocument>(PROJECTS_PATH, { version: 1, projects: [] })
  return { version: doc.version ?? 1, projects: Array.isArray(doc.projects) ? doc.projects : [] }
}

async function writeProjectsDoc(doc: ProjectsDocument): Promise<void> {
  await writeJson(PROJECTS_PATH, { version: doc.version ?? 1, projects: doc.projects ?? [] })
}

async function readWorkspacesDoc(): Promise<WorkspacesDocument> {
  const doc = await readJson<WorkspacesDocument>(WORKSPACES_PATH, { version: 1, activeWorkspaceId: null, workspaces: [] })
  return {
    version: doc.version ?? 1,
    activeWorkspaceId: doc.activeWorkspaceId ?? null,
    workspaces: Array.isArray(doc.workspaces) ? doc.workspaces : [],
  }
}

async function writeWorkspacesDoc(doc: WorkspacesDocument): Promise<void> {
  await writeJson(WORKSPACES_PATH, {
    version: doc.version ?? 1,
    activeWorkspaceId: doc.activeWorkspaceId ?? null,
    workspaces: doc.workspaces ?? [],
  })
}

async function listProjects(): Promise<ProjectRecord[]> {
  const doc = await readProjectsDoc()
  return doc.projects ?? []
}

function workspaceFromRecord(record: WorkspaceRecord, projectById: Map<string, ProjectRecord>): Workspace {
  const projectPaths = (record.projectIds ?? [])
    .map(id => projectById.get(id)?.path)
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
  const primaryPath = record.primaryProjectId ? projectById.get(record.primaryProjectId)?.path : null
  return {
    id: record.id,
    name: record.name,
    path: primaryPath ?? projectPaths[0] ?? '',
    projectPaths,
  }
}

async function listWorkspaces(): Promise<Workspace[]> {
  const [workspaceDoc, projects] = await Promise.all([readWorkspacesDoc(), listProjects()])
  const projectById = new Map(projects.map(project => [project.id, project]))
  const records = Array.isArray(workspaceDoc.workspaces) ? workspaceDoc.workspaces : []
  const mapped = records.map(record => workspaceFromRecord(record, projectById))
  return mapped.length > 0 ? mapped : [defaultWorkspace()]
}

async function getActiveWorkspace(): Promise<Workspace | null> {
  const [workspaceDoc, workspaces] = await Promise.all([readWorkspacesDoc(), listWorkspaces()])
  if (workspaceDoc.activeWorkspaceId) {
    const active = workspaces.find(workspace => workspace.id === workspaceDoc.activeWorkspaceId)
    if (active) return active
  }
  return workspaces[0] ?? null
}

async function setActiveWorkspace(id: string): Promise<boolean> {
  const doc = await readWorkspacesDoc()
  doc.activeWorkspaceId = id
  await writeWorkspacesDoc(doc)
  broadcast('workspace:changed', { activeWorkspaceId: id })
  return true
}

async function upsertProjectForPath(projectPath: string): Promise<ProjectRecord> {
  const normalizedPath = projectPath.trim()
  const doc = await readProjectsDoc()
  const existing = (doc.projects ?? []).find(project => project.path === normalizedPath)
  if (existing) return existing

  const project: ProjectRecord = {
    id: safeId('project'),
    name: basename(normalizedPath) || 'Project',
    path: normalizedPath,
  }
  doc.projects = [...(doc.projects ?? []), project]
  await writeProjectsDoc(doc)
  return project
}

async function createWorkspace(name: string, projectPath?: string | null): Promise<Workspace> {
  const trimmedName = name.trim() || (projectPath ? basename(projectPath) : 'Workspace') || 'Workspace'
  const project = projectPath ? await upsertProjectForPath(projectPath) : null
  const record: WorkspaceRecord = {
    id: safeId('workspace'),
    name: trimmedName,
    projectIds: project ? [project.id] : [],
    primaryProjectId: project?.id ?? null,
  }
  const doc = await readWorkspacesDoc()
  doc.workspaces = [...(doc.workspaces ?? []), record]
  doc.activeWorkspaceId = record.id
  await writeWorkspacesDoc(doc)
  const workspace = workspaceFromRecord(record, new Map(project ? [[project.id, project]] : []))
  broadcast('workspace:changed', { workspace })
  return workspace
}

async function addProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
  const project = await upsertProjectForPath(folderPath)
  const projects = await listProjects()
  const projectById = new Map(projects.map(item => [item.id, item]))
  projectById.set(project.id, project)
  const doc = await readWorkspacesDoc()
  const record = (doc.workspaces ?? []).find(item => item.id === workspaceId)
  if (!record) return null
  record.projectIds = unique([...(record.projectIds ?? []), project.id])
  record.primaryProjectId = record.primaryProjectId ?? project.id
  await writeWorkspacesDoc(doc)
  const workspace = workspaceFromRecord(record, projectById)
  broadcast('workspace:changed', { workspace })
  return workspace
}

async function removeProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
  const projects = await listProjects()
  const project = projects.find(item => item.path === folderPath || item.id === folderPath)
  const doc = await readWorkspacesDoc()
  const record = (doc.workspaces ?? []).find(item => item.id === workspaceId)
  if (!record || !project) return record ? workspaceFromRecord(record, new Map(projects.map(item => [item.id, item]))) : null
  record.projectIds = (record.projectIds ?? []).filter(id => id !== project.id)
  if (record.primaryProjectId === project.id) record.primaryProjectId = record.projectIds[0] ?? null
  await writeWorkspacesDoc(doc)
  const workspace = workspaceFromRecord(record, new Map(projects.map(item => [item.id, item])))
  broadcast('workspace:changed', { workspace })
  return workspace
}

async function deleteWorkspace(id: string): Promise<boolean> {
  const doc = await readWorkspacesDoc()
  doc.workspaces = (doc.workspaces ?? []).filter(item => item.id !== id)
  if (doc.activeWorkspaceId === id) doc.activeWorkspaceId = doc.workspaces[0]?.id ?? null
  await writeWorkspacesDoc(doc)
  await rm(workspaceStorageDir(id), { recursive: true, force: true })
  broadcast('workspace:changed', { deletedWorkspaceId: id, activeWorkspaceId: doc.activeWorkspaceId ?? null })
  return true
}

async function renameProject(args: { projectId?: string, projectPath?: string, name?: string }): Promise<{ ok: boolean, project?: ProjectRecord, error?: string }> {
  const name = String(args.name ?? '').trim()
  if (!name) return { ok: false, error: 'Project name is required' }
  const doc = await readProjectsDoc()
  const project = (doc.projects ?? []).find(item => item.id === args.projectId || item.path === args.projectPath)
  if (!project) return { ok: false, error: 'Project not found' }
  project.name = name
  await writeProjectsDoc(doc)
  broadcast('workspace:changed', { project })
  return { ok: true, project }
}

function workspaceStorageDir(workspaceId: string): string {
  return join(WORKSPACES_DIR, workspaceId || 'default')
}

async function loadCanvas(workspaceId: string): Promise<unknown | null> {
  return await readJson(join(workspaceStorageDir(workspaceId), 'canvas.json'), null)
}

async function saveCanvas(workspaceId: string, state: unknown): Promise<boolean> {
  await mkdir(workspaceStorageDir(workspaceId), { recursive: true })
  await writeFile(join(workspaceStorageDir(workspaceId), 'canvas.json'), JSON.stringify(state, null, 2))
  broadcast('canvas:saved', { workspaceId })
  return true
}

async function loadTileState(workspaceId: string, tileId: string): Promise<unknown | null> {
  return await readJson(join(workspaceStorageDir(workspaceId), 'tiles', `${tileId}.json`), null)
}

async function saveTileState(workspaceId: string, tileId: string, state: unknown): Promise<boolean> {
  const dir = join(workspaceStorageDir(workspaceId), 'tiles')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${tileId}.json`), JSON.stringify(state, null, 2))
  broadcast('canvas:sessionsChanged', { workspaceId, tileId })
  return true
}

function sessionTitleFromState(state: any): string {
  const explicit = typeof state?.title === 'string' ? state.title.trim() : ''
  if (explicit) return explicit.slice(0, 80)
  const messages = Array.isArray(state?.messages) ? state.messages : []
  const firstUser = messages.find((msg: any) => msg?.role === 'user' && typeof msg.content === 'string')
  const text = String(firstUser?.content ?? '').replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, 80) : 'CodeSurf session'
}

async function listSessions(workspaceId: string): Promise<unknown[]> {
  const tilesDir = join(workspaceStorageDir(workspaceId), 'tiles')
  let entries: Array<{ name: string, path: string, isFile: boolean }> = []
  try {
    entries = (await readdir(tilesDir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
      .map(entry => ({ name: entry.name, path: join(tilesDir, entry.name), isFile: true }))
  } catch {
    return []
  }

  const sessions: unknown[] = []
  for (const entry of entries) {
    const tileId = entry.name.replace(/\.json$/, '')
    const state = await readJson<any>(entry.path, null)
    const messages = Array.isArray(state?.messages) ? state.messages : []
    if (messages.length === 0) continue
    const fileInfo = await stat(entry.path).catch(() => null)
    const lastMessage = [...messages].reverse().find((msg: any) => typeof msg?.content === 'string' && msg.content.trim())
    sessions.push({
      id: `codesurf-tile:${workspaceId}:${tileId}`,
      source: 'codesurf',
      scope: 'workspace',
      tileId,
      sessionId: typeof state?.sessionId === 'string' ? state.sessionId : null,
      provider: typeof state?.provider === 'string' ? state.provider : 'codesurf',
      model: typeof state?.model === 'string' ? state.model : '',
      messageCount: messages.length,
      lastMessage: typeof lastMessage?.content === 'string' ? lastMessage.content.slice(0, 160) : null,
      updatedAt: fileInfo?.mtimeMs ?? Date.now(),
      sizeBytes: fileInfo?.size ?? 0,
      filePath: entry.path,
      title: sessionTitleFromState(state),
      projectPath: null,
      sourceLabel: 'CodeSurf',
      sourceDetail: 'Electrobun local tile state',
      canOpenInChat: true,
      canOpenInApp: true,
    })
  }

  return sessions.sort((a: any, b: any) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0))
}

async function getSessionState(workspaceId: string, entryId: string): Promise<unknown | null> {
  const direct = await loadTileState(workspaceId, entryId)
  if (direct) return direct
  const parts = String(entryId).split(':')
  const tileId = parts.length >= 3 ? parts[parts.length - 1] : entryId
  return await loadTileState(workspaceId, tileId)
}

async function appendQueuedMessageEvent(payload: any): Promise<boolean> {
  const workspaceId = String(payload?.workspaceId ?? 'default')
  const dir = workspaceStorageDir(workspaceId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'queued-messages.jsonl'), `${JSON.stringify({ ...payload, at: payload?.at ?? Date.now() })}\n`, { flag: 'a' })
  return true
}

async function readSettings(): Promise<unknown> {
  const raw = await readJson<{ settings?: Partial<typeof DEFAULT_SETTINGS> } | Partial<typeof DEFAULT_SETTINGS>>(SETTINGS_PATH, DEFAULT_SETTINGS)
  if (raw && typeof raw === 'object' && 'settings' in raw) {
    return withDefaultSettings(raw.settings ?? {})
  }
  return withDefaultSettings(raw as Partial<typeof DEFAULT_SETTINGS>)
}

async function writeSettings(settings: unknown): Promise<unknown> {
  const next = withDefaultSettings((settings ?? {}) as Partial<typeof DEFAULT_SETTINGS>)
  await writeJson(SETTINGS_PATH, { version: 1, settings: next })
  broadcast('appearance:updated', { shouldUseDark: true })
  return next
}

async function readDirEntries(dirPath: string): Promise<Array<{ name: string, path: string, isDirectory: boolean, isFile: boolean }>> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries.map(entry => ({
      name: entry.name,
      path: join(dirPath, entry.name),
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    }))
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

async function statPath(filePath: string): Promise<{ isFile: boolean, isDirectory: boolean, size: number, mtimeMs: number } | null> {
  try {
    const info = await stat(filePath)
    return {
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      size: info.size,
      mtimeMs: info.mtimeMs,
    }
  } catch {
    return null
  }
}

function broadcast(channel: string, payload?: unknown): void {
  for (const live of liveWindows.values()) {
    live.win.webview?.rpc?.send.event({ channel, payload })
  }
}

function publishBus(channel: string, type: string, source: string, payload?: unknown): void {
  const event: BusEvent = { channel, type, source, payload, at: Date.now() }
  const history = busHistory.get(channel) ?? []
  history.push(event)
  if (history.length > MAX_BUS_HISTORY) history.splice(0, history.length - MAX_BUS_HISTORY)
  busHistory.set(channel, history)
  broadcast('bus:event', event)
}

function windowList(): Array<{ id: number, title: string, focused: boolean }> {
  return [...liveWindows.entries()].map(([id, live]) => ({
    id,
    title: live.title,
    focused: id === focusedWindowId,
  }))
}

function broadcastWindowList(): void {
  broadcast('window:list-changed', windowList())
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec || 'cmd.exe'
  return process.env.SHELL || (existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash')
}

function getShellEnvPath(): string | null {
  if (shellPathCache !== undefined) return shellPathCache
  const shell = defaultShell()
  try {
    shellPathCache = execFileSync(shell, ['-lc', 'printf %s "$PATH"'], { encoding: 'utf8', timeout: 3000 }).trim() || null
  } catch {
    shellPathCache = null
  }
  return shellPathCache
}

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const shellPath = getShellEnvPath()
  return { ...process.env, ...(shellPath ? { PATH: shellPath } : {}), ...extra }
}

async function safeCwd(value: unknown): Promise<string> {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : process.cwd()
  const info = await stat(candidate).catch(() => null)
  return info?.isDirectory() ? candidate : process.cwd()
}

function resolvePtyHostPath(): string | null {
  const candidates = [
    join(process.cwd(), 'electrobun', 'helpers', 'pty-host.cjs'),
    join(process.cwd(), 'helpers', 'pty-host.cjs'),
    join(dirname(new URL(import.meta.url).pathname), '..', 'helpers', 'pty-host.cjs'),
    join(dirname(new URL(import.meta.url).pathname), 'helpers', 'pty-host.cjs'),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

function handlePtyHostMessage(message: PtyHostMessage): void {
  const tileId = String(message.tileId ?? '')
  if (message.type === 'data' && tileId) {
    const session = terminalSessions.get(tileId)
    const data = String(message.data ?? '')
    if (session) session.buffer = (session.buffer + data).slice(-MAX_TERMINAL_BUFFER)
    broadcast(`terminal:data:${tileId}`, data)
    return
  }
  if (message.type === 'active' && tileId) {
    broadcast(`terminal:active:${tileId}`)
    return
  }
  if (message.type === 'exit' && tileId) {
    terminalSessions.delete(tileId)
    const exitCode = Number(message.exitCode ?? 0)
    broadcast(`terminal:data:${tileId}`, `\r\n[process exited ${exitCode}]\r\n`)
    publishBus(`tile:${tileId}`, 'system', `terminal:${tileId}`, { action: 'exited', exitCode })
    return
  }
  if (message.type === 'error') {
    const error = String(message.error ?? 'PTY host error')
    if (tileId) broadcast(`terminal:data:${tileId}`, `\r\n\x1b[31m${error}\x1b[0m\r\n`)
    else console.warn('[Electrobun PTY host]', error)
  }
}

function ensurePtyHost(): ChildProcess | null {
  if (ptyHostProcess && !ptyHostProcess.killed) return ptyHostProcess
  const helperPath = resolvePtyHostPath()
  const nodeBin = resolveCommand('node', 'NODE_BIN')
  if (!helperPath || !nodeBin) {
    console.warn('[Electrobun] PTY host unavailable', { helperPath, nodeBin })
    return null
  }

  const proc = spawn(nodeBin, [helperPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv(),
  })
  ptyHostProcess = proc
  ptyHostStdoutBuffer = ''

  proc.stdout?.on('data', (chunk: Buffer) => {
    ptyHostStdoutBuffer += chunk.toString()
    const lines = ptyHostStdoutBuffer.split(/\r?\n/)
    ptyHostStdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try { handlePtyHostMessage(JSON.parse(line) as PtyHostMessage) }
      catch { console.warn('[Electrobun] Ignoring malformed PTY host line:', line) }
    }
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString().trim()
    if (text) console.warn('[Electrobun PTY host stderr]', text)
  })
  proc.on('close', () => {
    ptyHostProcess = null
    for (const tileId of terminalSessions.keys()) {
      broadcast(`terminal:data:${tileId}`, '\r\n\x1b[31mPTY host stopped\x1b[0m\r\n')
    }
    terminalSessions.clear()
  })
  return proc
}

function sendPtyHost(message: Record<string, unknown>): boolean {
  const host = ensurePtyHost()
  if (!host?.stdin?.writable) return false
  host.stdin.write(`${JSON.stringify(message)}\n`)
  return true
}

function stopPtyHost(): void {
  const host = ptyHostProcess
  ptyHostProcess = null
  ptyHostStdoutBuffer = ''
  terminalSessions.clear()
  if (!host || host.killed) return
  try { host.stdin?.end() } catch { /* ignore */ }
  try { host.kill('SIGTERM') } catch { /* ignore */ }
}

function stopAllChatProcesses(): void {
  for (const [cardId, proc] of chatProcesses.entries()) {
    try { proc.kill('SIGTERM') } catch { /* ignore */ }
    chatProcesses.delete(cardId)
  }
}

function shutdownRuntimeChildren(): void {
  stopPtyHost()
  stopAllChatProcesses()
}

function createTerminal(tileId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]): { cols: number, rows: number, buffer: string } {
  const existing = terminalSessions.get(tileId)
  if (existing) return { cols: 80, rows: 24, buffer: existing.buffer }

  const shell = launchBin || defaultShell()
  const args = Array.isArray(launchArgs) ? launchArgs : []
  const session: TerminalSession = { shell, buffer: '', cwd: workspaceDir }
  terminalSessions.set(tileId, session)
  publishBus(`tile:${tileId}`, 'system', `terminal:${tileId}`, { action: 'created', workspaceDir, runtime: 'electrobun-node-pty-host' })

  const ok = sendPtyHost({ type: 'create', tileId, cwd: workspaceDir, shell, args, env: { PATH: childEnv().PATH ?? '' } })
  if (!ok) {
    const error = 'PTY host is unavailable. Node or electrobun/helpers/pty-host.cjs could not be found.'
    broadcast(`terminal:data:${tileId}`, `\r\n\x1b[31m${error}\x1b[0m\r\n`)
  }

  return { cols: 80, rows: 24, buffer: '' }
}

function cdCommand(shell: string, dirPath: string): string {
  const shellBase = shell.split(/[/\\]/).pop()?.toLowerCase() ?? ''
  if (shellBase === 'cmd.exe') return `cd /d "${dirPath.replace(/"/g, '""')}"`
  if (shellBase === 'powershell.exe' || shellBase === 'pwsh.exe') return `Set-Location -LiteralPath '${dirPath.replace(/'/g, "''")}'`
  return `cd '${dirPath.replace(/'/g, "'\\''")}'`
}

function stopChat(cardId: string): void {
  const proc = chatProcesses.get(cardId)
  if (proc) {
    try { proc.kill('SIGTERM') } catch { /* ignore */ }
    chatProcesses.delete(cardId)
  }
}

function sendStream(cardId: string, event: Record<string, unknown>): void {
  broadcast('agent:stream', { cardId, ...event })
}

function sendParsedStreamEvents(cardId: string, events: ElectrobunStreamEvent[]): void {
  for (const event of events) {
    if (event.type === 'session') chatSessionIds.set(cardId, event.sessionId)
    sendStream(cardId, event)
  }
}

function lastUserMessage(req: ChatRequest): string | null {
  const messages = Array.isArray(req.messages) ? req.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === 'user' && typeof message.content === 'string' && message.content.trim()) return message.content
  }
  return null
}

function resolveCommand(command: string, envName?: string): string | null {
  const fromEnv = envName ? process.env[envName] : null
  if (fromEnv && existsSync(fromEnv)) return fromEnv
  if (command.includes('/') && existsSync(command)) return command
  try {
    const shell = defaultShell()
    const resolved = execFileSync(shell, ['-lc', `command -v ${JSON.stringify(command)}`], {
      env: childEnv(),
      encoding: 'utf8',
      timeout: 3000,
    }).trim()
    return resolved || null
  } catch {
    return null
  }
}

function streamProcessText(cardId: string, proc: ChildProcess, options: {
  onStdoutText?: (text: string) => void
  onStdoutLine?: (line: string) => void
  onClose?: (code: number | null, stderr: string) => void
  missingBinaryMessage: string
}): void {
  let stdoutBuffer = ''
  let stderrBuffer = ''

  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    if (options.onStdoutText) {
      options.onStdoutText(text)
      return
    }
    stdoutBuffer += text
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) options.onStdoutLine?.(line)
  })

  proc.stderr?.on('data', (chunk: Buffer) => { stderrBuffer += chunk.toString() })

  proc.on('close', (code) => {
    if (!options.onStdoutText && stdoutBuffer) options.onStdoutLine?.(stdoutBuffer)
    chatProcesses.delete(cardId)
    options.onClose?.(code, stderrBuffer)
    sendStream(cardId, { type: 'done' })
  })

  proc.on('error', (error) => {
    chatProcesses.delete(cardId)
    const message = error.message.includes('ENOENT') ? options.missingBinaryMessage : error.message
    sendStream(cardId, { type: 'error', error: message })
    sendStream(cardId, { type: 'done' })
  })
}

async function runHermesChat(req: ChatRequest, prompt: string): Promise<{ ok: boolean, error?: string }> {
  const cardId = req.cardId
  const hermesBin = resolveCommand('hermes', 'HERMES_BIN')
  if (!hermesBin) {
    const error = 'Hermes CLI not found. Install: pip install hermes-agent, or set HERMES_BIN.'
    sendStream(cardId, { type: 'error', error })
    sendStream(cardId, { type: 'done' })
    return { ok: false, error }
  }

  const modeMap: Record<string, string> = {
    full: 'terminal,file,web,browser',
    terminal: 'terminal,file',
    web: 'web,browser',
    query: '',
  }
  const args = buildHermesChatArgs({
    prompt,
    model: req.model,
    resumeSessionId: req.sessionId ?? chatSessionIds.get(cardId) ?? null,
    toolsets: modeMap[String(req.mode ?? '')] ?? 'terminal,file,web',
    bypassPermissions: req.mode === 'bypassPermissions' || req.mode === 'full-access',
  })
  const cwd = await safeCwd(req.workspaceDir)
  const proc = spawn(hermesBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), cwd })
  chatProcesses.set(cardId, proc)

  let partial = ''
  streamProcessText(cardId, proc, {
    missingBinaryMessage: 'Hermes CLI not found. Install: pip install hermes-agent, or set HERMES_BIN.',
    onStdoutText: (text) => {
      partial += text
      const lines = partial.split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const line of lines) {
        const match = line.trim().match(/^(?:session_id|session)\s*:\s*(\S+)$/i)
        if (match?.[1]) {
          chatSessionIds.set(cardId, match[1])
          sendStream(cardId, { type: 'session', sessionId: match[1] })
          continue
        }
        if (line) sendStream(cardId, { type: 'text', text: `${line}\n` })
      }
    },
    onClose: (_code, stderr) => {
      if (partial.trim()) sendStream(cardId, { type: 'text', text: partial })
      if (stderr.trim()) sendStream(cardId, { type: 'error', error: sanitizeAgentCliDiagnostic(stderr.trim()) })
    },
  })

  return { ok: true }
}

async function runClaudeChat(req: ChatRequest, prompt: string): Promise<{ ok: boolean, error?: string }> {
  const cardId = req.cardId
  const claudeBin = resolveCommand('claude', 'CLAUDE_BIN')
  if (!claudeBin) {
    const error = 'Claude CLI not found. Install Claude Code, or set CLAUDE_BIN.'
    sendStream(cardId, { type: 'error', error })
    sendStream(cardId, { type: 'done' })
    return { ok: false, error }
  }

  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages']
  if (req.model) args.push('--model', req.model)
  const permissionMode = typeof req.mode === 'string' && ['bypassPermissions', 'acceptEdits', 'default', 'plan', 'auto', 'dontAsk'].includes(req.mode)
    ? req.mode
    : 'default'
  args.push('--permission-mode', permissionMode)
  const resumeSessionId = req.sessionId ?? chatSessionIds.get(cardId) ?? null
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  args.push(prompt)

  const cwd = await safeCwd(req.workspaceDir)
  const proc = spawn(claudeBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), cwd })
  chatProcesses.set(cardId, proc)

  streamProcessText(cardId, proc, {
    missingBinaryMessage: 'Claude CLI not found. Install Claude Code, or set CLAUDE_BIN.',
    onStdoutLine: (line) => sendParsedStreamEvents(cardId, parseClaudeStreamJsonLine(line)),
    onClose: (code, stderr) => {
      if (code !== 0 && stderr.trim()) sendStream(cardId, { type: 'error', error: sanitizeAgentCliDiagnostic(stderr.trim()) })
    },
  })

  return { ok: true }
}

async function runOpenCodeChat(req: ChatRequest, prompt: string): Promise<{ ok: boolean, error?: string }> {
  const cardId = req.cardId
  const opencodeBin = resolveCommand('opencode', 'OPENCODE_BIN')
  if (!opencodeBin) {
    const error = 'OpenCode CLI not found. Install opencode, or set OPENCODE_BIN.'
    sendStream(cardId, { type: 'error', error })
    sendStream(cardId, { type: 'done' })
    return { ok: false, error }
  }

  const args = buildOpenCodeRunArgs({
    prompt,
    model: req.model,
    sessionId: req.sessionId ?? chatSessionIds.get(cardId) ?? null,
    cwd: req.workspaceDir ?? null,
    bypassPermissions: req.mode === 'full-access' || req.mode === 'bypassPermissions',
  })

  const cwd = await safeCwd(req.workspaceDir)
  const proc = spawn(opencodeBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), cwd })
  chatProcesses.set(cardId, proc)

  streamProcessText(cardId, proc, {
    missingBinaryMessage: 'OpenCode CLI not found. Install opencode, or set OPENCODE_BIN.',
    onStdoutLine: (line) => sendParsedStreamEvents(cardId, parseOpenCodeJsonLine(line)),
    onClose: (code, stderr) => {
      if (code !== 0 && stderr.trim()) sendStream(cardId, { type: 'error', error: sanitizeAgentCliDiagnostic(stderr.trim()) })
    },
  })

  return { ok: true }
}

function normalizeModelRef(model?: string | null): string {
  return (model ?? '').trim().toLowerCase()
}

function parseOpenClawAgents(openclawBin: string): Array<{ id: string, name?: string, model?: string, isDefault?: boolean }> {
  try {
    const raw = execFileSync(openclawBin, ['agents', 'list', '--json'], {
      encoding: 'utf8',
      env: childEnv(),
      timeout: 10_000,
    }).trim()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function listOpenClawAgentOptions(): { agents: Array<{ id: string, label: string, description?: string }>, source: string } {
  const openclawBin = resolveCommand('openclaw', 'OPENCLAW_BIN')
  if (!openclawBin) return { agents: [], source: 'missing-openclaw-cli' }
  const agents = parseOpenClawAgents(openclawBin).map(agent => ({
    id: agent.id,
    label: agent.name ? `${agent.name}${agent.isDefault ? ' (default)' : ''}` : `${agent.id}${agent.isDefault ? ' (default)' : ''}`,
    description: agent.model ?? agent.id,
  }))
  return { agents, source: 'openclaw-cli' }
}

function selectOpenClawAgentId(openclawBin: string, preferredModel?: string | null): string | null {
  const agents = parseOpenClawAgents(openclawBin)
  if (agents.length === 0) return 'main'

  const requested = normalizeModelRef(preferredModel)
  const isStable = (id: string): boolean => !id.startsWith('mc-gateway-') && !/^lead-[0-9a-f-]+$/i.test(id)

  if (requested) {
    const directStable = agents.find(agent => isStable(agent.id) && normalizeModelRef(agent.id) === requested)
    if (directStable) return directStable.id

    const directAny = agents.find(agent => normalizeModelRef(agent.id) === requested)
    if (directAny) return directAny.id

    const exactStable = agents.find(agent => isStable(agent.id) && normalizeModelRef(agent.model) === requested)
    if (exactStable) return exactStable.id

    const exactAny = agents.find(agent => normalizeModelRef(agent.model) === requested)
    if (exactAny) return exactAny.id

    return null
  }

  return agents.find(agent => agent.isDefault)?.id ?? agents[0]?.id ?? 'main'
}

async function runOpenClawChat(req: ChatRequest, prompt: string): Promise<{ ok: boolean, error?: string }> {
  const cardId = req.cardId
  const openclawBin = resolveCommand('openclaw', 'OPENCLAW_BIN')
  if (!openclawBin) {
    const error = 'OpenClaw CLI not found. Install: npm install -g openclaw, or set OPENCLAW_BIN.'
    sendStream(cardId, { type: 'error', error })
    sendStream(cardId, { type: 'done' })
    return { ok: false, error }
  }

  const existingSessionId = req.sessionId ?? chatSessionIds.get(cardId) ?? null
  const selectedAgentId = existingSessionId ? null : selectOpenClawAgentId(openclawBin, req.model)
  if (!existingSessionId && req.model && !selectedAgentId) {
    const available = parseOpenClawAgents(openclawBin)
      .map(agent => agent.model || agent.id)
      .filter((value, index, all): value is string => typeof value === 'string' && value.trim().length > 0 && all.indexOf(value) === index)
    const details = available.length > 0 ? ` Available: ${available.join(', ')}` : ''
    const error = `OpenClaw model must match exactly: ${req.model}.${details}`
    sendStream(cardId, { type: 'error', error })
    sendStream(cardId, { type: 'done' })
    return { ok: false, error }
  }

  const thinkingMap: Record<string, string> = {
    none: 'off',
    low: 'minimal',
    medium: 'medium',
    high: 'high',
    max: 'xhigh',
    adaptive: 'medium',
  }
  const args = buildOpenClawAgentArgs({
    prompt,
    agentId: selectedAgentId ?? 'main',
    sessionId: existingSessionId,
    thinking: thinkingMap[req.thinking ?? ''] ?? null,
    local: true,
  })

  const cwd = await safeCwd(req.workspaceDir)
  const proc = spawn(openclawBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), cwd })
  chatProcesses.set(cardId, proc)

  let stdout = ''
  streamProcessText(cardId, proc, {
    missingBinaryMessage: 'OpenClaw CLI not found. Install: npm install -g openclaw, or set OPENCLAW_BIN.',
    onStdoutText: text => { stdout += text },
    onClose: (code, stderr) => {
      if (code !== 0) {
        sendStream(cardId, { type: 'error', error: sanitizeAgentCliDiagnostic(stderr.trim() || stdout.trim() || `OpenClaw exited with ${code}`) })
        return
      }
      sendParsedStreamEvents(cardId, parseOpenClawOutput(stdout))
    },
  })

  return { ok: true }
}

function handleCodexEvent(cardId: string, event: any): void {
  if (!event || typeof event !== 'object') return
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    chatSessionIds.set(cardId, event.thread_id)
    sendStream(cardId, { type: 'session', sessionId: event.thread_id })
    return
  }

  const item = event.item && typeof event.item === 'object' ? event.item : null
  if (event.type === 'item.completed' && item) {
    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
      sendStream(cardId, { type: 'text', text: item.text })
      return
    }
    if (item.type === 'command_execution' && typeof item.command === 'string') {
      sendStream(cardId, {
        type: 'tool_summary',
        toolId: `codex-command-${Math.abs(item.command.length)}`,
        toolName: 'Command',
        commandEntries: [{ label: item.command, command: item.command, output: String(item.aggregated_output ?? ''), kind: 'command' }],
      })
      return
    }
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      sendStream(cardId, {
        type: 'tool_summary',
        toolId: 'codex-file-changes',
        toolName: `Edited ${item.changes.length} file${item.changes.length === 1 ? '' : 's'}`,
      })
      return
    }
  }

  if (typeof event.delta === 'string') sendStream(cardId, { type: 'text', text: event.delta })
  else if (typeof event.text === 'string' && event.text) sendStream(cardId, { type: 'text', text: event.text })
}

async function runCodexChat(req: ChatRequest, prompt: string): Promise<{ ok: boolean, error?: string }> {
  const cardId = req.cardId
  const codexBin = resolveCommand('codex', 'CODEX_BIN')
  if (!codexBin) {
    const error = 'Codex CLI not found. Install: npm install -g @openai/codex, or set CODEX_BIN.'
    sendStream(cardId, { type: 'error', error })
    sendStream(cardId, { type: 'done' })
    return { ok: false, error }
  }

  const args = ['exec', '--json', '--model', req.model || 'gpt-5.5']
  const mode = req.mode === 'auto' || req.mode === 'read-only' || req.mode === 'full-access' ? req.mode : 'full-access'
  if (mode === 'full-access') args.push('--dangerously-bypass-approvals-and-sandbox')
  else if (mode === 'auto') args.push('--full-auto')
  else args.push('--sandbox', 'read-only')
  args.push('-c', 'mcp_servers={}', '--skip-git-repo-check')
  if (req.workspaceDir) args.push('-C', req.workspaceDir)
  args.push(prompt)

  const cwd = await safeCwd(req.workspaceDir)
  const proc = spawn(codexBin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), cwd })
  chatProcesses.set(cardId, proc)

  streamProcessText(cardId, proc, {
    missingBinaryMessage: 'Codex CLI not found. Install: npm install -g @openai/codex, or set CODEX_BIN.',
    onStdoutLine: (line) => sendParsedStreamEvents(cardId, parseCodexJsonLine(line)),
    onClose: (code, stderr) => {
      if (code !== 0 && stderr.trim()) sendStream(cardId, { type: 'error', error: sanitizeAgentCliDiagnostic(stderr.trim()) })
    },
  })

  return { ok: true }
}

async function sendChat(req: ChatRequest): Promise<{ ok: boolean, error?: string, jobId?: string }> {
  const cardId = String(req.cardId ?? '')
  if (!cardId) return { ok: false, error: 'missing cardId' }
  stopChat(cardId)
  const prompt = lastUserMessage(req)
  if (!prompt) {
    sendStream(cardId, { type: 'error', error: 'No user message' })
    sendStream(cardId, { type: 'done' })
    return { ok: false, error: 'No user message' }
  }

  const provider = String(req.provider ?? 'claude').toLowerCase()
  if (provider === 'claude') return await runClaudeChat(req, prompt)
  if (provider === 'hermes') return await runHermesChat(req, prompt)
  if (provider === 'codex') return await runCodexChat(req, prompt)
  if (provider === 'opencode') return await runOpenCodeChat(req, prompt)
  if (provider === 'openclaw') return await runOpenClawChat(req, prompt)

  const error = `Provider "${provider}" is not supported by the Electrobun runtime. Use Claude, Codex, Hermes, OpenCode, or OpenClaw for Electrobun local chat.`
  sendStream(cardId, { type: 'error', error })
  sendStream(cardId, { type: 'done' })
  return { ok: false, error }
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000, env: childEnv() }).trim()
}

function gitRoot(cwd: string): string | null {
  try { return runGit(cwd, ['rev-parse', '--show-toplevel']) } catch { return null }
}

function gitStatus(cwd: string): unknown {
  const root = gitRoot(cwd)
  if (!root) return { isRepo: false, root: cwd, files: [] }
  const output = runGit(root, ['status', '--porcelain=v1'])
  const files = output ? output.split(/\r?\n/).map(line => ({ status: line.slice(0, 2).trim(), path: line.slice(3) })) : []
  return { isRepo: true, root, files }
}

function gitBranches(cwd: string): unknown {
  const root = gitRoot(cwd)
  if (!root) return { isRepo: false, root: cwd, current: null, branches: [] }
  const current = runGit(root, ['branch', '--show-current']) || null
  const output = runGit(root, ['branch', '--format=%(refname:short)'])
  const branches = output ? output.split(/\r?\n/).filter(Boolean) : []
  return { isRepo: true, root, current, branches }
}

async function handleInvoke(channel: string, args: unknown[] = []): Promise<unknown> {
  try {
    switch (channel) {
      case 'appearance:shouldUseDark':
        return true
      case 'appearance:setThemeSource':
        broadcast('appearance:updated', { shouldUseDark: true })
        return true

      case 'workspace:list':
        return await listWorkspaces()
      case 'workspace:listProjects':
        return await listProjects()
      case 'workspace:getActive':
        return await getActiveWorkspace()
      case 'workspace:setActive':
        return await setActiveWorkspace(String(args[0] ?? ''))
      case 'workspace:create':
        return await createWorkspace(String(args[0] ?? 'Workspace'))
      case 'workspace:createWithPath':
        return await createWorkspace(String(args[0] ?? basename(String(args[1] ?? 'Workspace'))), String(args[1] ?? process.cwd()))
      case 'workspace:createFromFolder':
        return await createWorkspace(basename(String(args[0] ?? process.cwd())) || 'Workspace', String(args[0] ?? process.cwd()))
      case 'workspace:addProjectFolder':
        return await addProjectFolder(String(args[0] ?? ''), String(args[1] ?? ''))
      case 'workspace:removeProjectFolder':
        return await removeProjectFolder(String(args[0] ?? ''), String(args[1] ?? ''))
      case 'workspace:renameProject':
        return await renameProject((args[0] ?? {}) as { projectId?: string, projectPath?: string, name?: string })
      case 'workspace:createProjectWorktree':
        return { ok: false, error: 'Electrobun runtime will not create git worktrees until that side-effect is explicitly routed through the daemon.' }
      case 'workspace:delete':
        return await deleteWorkspace(String(args[0] ?? ''))
      case 'workspace:openFolder': {
        const paths = await Utils.openFileDialog({ canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false })
        return paths[0] || null
      }

      case 'settings:get':
        return await readSettings()
      case 'settings:set':
        return await writeSettings(args[0])
      case 'settings:getRawJson':
        return JSON.stringify({ version: 1, settings: await readSettings() }, null, 2)
      case 'settings:setRawJson': {
        try {
          const parsed = JSON.parse(String(args[0] ?? '{}')) as { settings?: unknown }
          return { ok: true, settings: await writeSettings(parsed.settings ?? parsed) }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      case 'settings:validateGenerationProvider':
        return { ok: false, message: 'Provider validation is Electron-daemon backed; Electrobun runtime can still save settings.', models: [], imageModels: [], videoModels: [] }

      case 'db:status':
        return { ok: true, runtime: 'electrobun-bun-sqlite', status: dbRuntime.getStatus() }
      case 'db:reset': {
        const result = dbRuntime.reset()
        return { ok: true, runtime: 'electrobun-bun-sqlite', backupPath: result.backupPath, status: dbRuntime.getStatus() }
      }

      case 'canvas:load':
        return await loadCanvas(String(args[0] ?? ''))
      case 'canvas:save':
        return await saveCanvas(String(args[0] ?? ''), args[1])
      case 'canvas:loadTileState':
        return await loadTileState(String(args[0] ?? ''), String(args[1] ?? ''))
      case 'canvas:saveTileState':
        return await saveTileState(String(args[0] ?? ''), String(args[1] ?? ''), args[2])
      case 'canvas:clearTileState':
      case 'canvas:deleteTileArtifacts': {
        await rm(join(workspaceStorageDir(String(args[0] ?? '')), 'tiles', `${String(args[1] ?? '')}.json`), { force: true })
        broadcast('canvas:sessionsChanged', { workspaceId: args[0], tileId: args[1] })
        return true
      }
      case 'canvas:listSessions':
        return await listSessions(String(args[0] ?? ''))
      case 'canvas:getSessionState':
        return await getSessionState(String(args[0] ?? ''), String(args[1] ?? ''))
      case 'canvas:renameSession':
        return { ok: true }
      case 'canvas:setSessionArchived':
        return { ok: true }
      case 'canvas:generateSessionTitle':
        return { ok: true, title: 'CodeSurf session' }
      case 'canvas:listCheckpoints':
        return await daemonRuntime.request('/checkpoint/list', {
          body: { workspaceId: String(args[0] ?? ''), sessionEntryId: String(args[1] ?? '') },
        }).catch(() => [])
      case 'canvas:restoreCheckpoint':
        return await daemonRuntime.request('/checkpoint/restore', {
          body: {
            workspaceId: String(args[0] ?? ''),
            checkpointId: String(args[1] ?? ''),
            sessionEntryId: typeof args[2] === 'string' ? args[2] : null,
          },
        }).catch(error => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      case 'canvas:queuedMessages:append':
        return await appendQueuedMessageEvent(args[0])
      case 'canvas:queuedMessages:listActive':
        return []

      case 'fs:readDir':
        return await readDirEntries(String(args[0] ?? process.cwd()))
      case 'fs:readFile':
        return await readFile(String(args[0] ?? ''), 'utf8').catch(() => '')
      case 'fs:writeFile': {
        const filePath = String(args[0] ?? '')
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, String(args[1] ?? ''))
        return true
      }
      case 'fs:createFile': {
        const filePath = String(args[0] ?? '')
        await mkdir(dirname(filePath), { recursive: true })
        if (!existsSync(filePath)) await writeFile(filePath, '')
        return true
      }
      case 'fs:createDir':
        await mkdir(String(args[0] ?? ''), { recursive: true })
        return true
      case 'fs:deleteFile':
        await rm(String(args[0] ?? ''), { recursive: true, force: true })
        return true
      case 'fs:renameFile':
        await rename(String(args[0] ?? ''), String(args[1] ?? ''))
        return true
      case 'fs:stat':
        return await statPath(String(args[0] ?? ''))
      case 'fs:isProbablyTextFile': {
        const info = await statPath(String(args[0] ?? ''))
        if (!info?.isFile) return false
        const sample = await readFile(String(args[0] ?? '')).catch(() => null)
        return sample ? !sample.subarray(0, Math.min(sample.length, 8192)).includes(0) : false
      }
      case 'fs:revealInFinder':
        return Utils.showItemInFolder(String(args[0] ?? ''))
      case 'fs:copyIntoDir': {
        const sourcePath = String(args[0] ?? '')
        const destDir = String(args[1] ?? '')
        const destPath = join(destDir, basename(sourcePath))
        await mkdir(destDir, { recursive: true })
        await cp(sourcePath, destPath, { recursive: true })
        return { path: destPath }
      }
      case 'fs:writeBrief': {
        const filePath = join(String(args[0] ?? process.cwd()), '.codesurf', 'BRIEF.md')
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, String(args[1] ?? ''))
        return { ok: true, path: filePath }
      }

      case 'terminal:create':
        return createTerminal(String(args[0] ?? ''), await safeCwd(args[1]), typeof args[2] === 'string' ? args[2] : undefined, Array.isArray(args[3]) ? args[3] as string[] : undefined)
      case 'terminal:write':
        sendPtyHost({ type: 'write', tileId: String(args[0] ?? ''), data: String(args[1] ?? '') })
        return true
      case 'terminal:cd': {
        const tileId = String(args[0] ?? '')
        const session = terminalSessions.get(tileId)
        if (session) sendPtyHost({ type: 'write', tileId, data: `\x15${cdCommand(session.shell, String(args[1] ?? session.cwd))}\r` })
        return true
      }
      case 'terminal:resize': {
        const tileId = String(args[0] ?? '')
        const cols = Math.max(1, Math.floor(Number(args[1]) || 80))
        const rows = Math.max(1, Math.floor(Number(args[2]) || 24))
        sendPtyHost({ type: 'resize', tileId, cols, rows })
        return true
      }
      case 'terminal:destroy': {
        const tileId = String(args[0] ?? '')
        sendPtyHost({ type: 'destroy', tileId })
        terminalSessions.delete(tileId)
        publishBus(`tile:${tileId}`, 'system', `terminal:${tileId}`, { action: 'destroyed' })
        return true
      }
      case 'terminal:detach': {
        const tileId = String(args[0] ?? '')
        sendPtyHost({ type: 'detach', tileId })
        terminalSessions.delete(tileId)
        return true
      }
      case 'terminal:update-peers':
        return true

      case 'chat:send':
        return await sendChat((args[0] ?? {}) as ChatRequest)
      case 'chat:resumeJob':
        return await sendChat((args[0] ?? {}) as ChatRequest)
      case 'chat:stop':
        stopChat(String(args[0] ?? ''))
        sendStream(String(args[0] ?? ''), { type: 'done' })
        return { ok: true }
      case 'chat:clearSession':
        chatSessionIds.delete(String(args[0] ?? ''))
        return { ok: true }
      case 'chat:steer':
        return { ok: false, error: 'Electrobun CLI subprocess providers cannot accept mid-stream steering events.' }
      case 'chat:setPermissionMode':
      case 'chat:answerUserQuestion':
      case 'chat:answerToolPermission':
        return { ok: true }
      case 'chat:selectFiles':
        return await Utils.openFileDialog({ canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: true })
      case 'chat:writeTempAttachment': {
        const dir = join(CONTEX_HOME, 'tmp', 'attachments')
        await mkdir(dir, { recursive: true })
        const filePath = join(dir, `${Date.now()}-${basename(String((args[0] as any)?.name ?? 'attachment.txt'))}`)
        await writeFile(filePath, String((args[0] as any)?.content ?? ''))
        return { ok: true, path: filePath }
      }
      case 'chat:loadSessionHistory':
        return { ok: true, messages: [], hasMore: false, nextCursor: null }
      case 'chat:opencodeModels':
        return { models: OPEN_CODE_FALLBACK_MODELS, source: 'electrobun-fallback' }
      case 'chat:openclawAgents':
        return listOpenClawAgentOptions()

      case 'jobs:recent':
        return dbRuntime.listRecentJobs((args[0] ?? {}) as { workspaceId?: string | null, limit?: number, offset?: number, includeArchived?: boolean })

      case 'git:status':
        return gitStatus(String(args[0] ?? process.cwd()))
      case 'git:branches':
        return gitBranches(String(args[0] ?? process.cwd()))
      case 'git:checkoutBranch': {
        const root = gitRoot(String(args[0] ?? process.cwd()))
        if (!root) return { ok: false, error: 'Not a git repository' }
        runGit(root, ['checkout', String(args[1] ?? '')])
        return { ok: true, ...(gitBranches(root) as object) }
      }
      case 'git:createBranch': {
        const root = gitRoot(String(args[0] ?? process.cwd()))
        if (!root) return { ok: false, error: 'Not a git repository' }
        runGit(root, ['checkout', '-b', String(args[1] ?? '')])
        return { ok: true, ...(gitBranches(root) as object) }
      }

      case 'shell:openExternal':
        return Utils.openExternal(String(args[0] ?? ''))
      case 'window:new':
      case 'window:newTab':
        await createWindow({ fresh: true })
        return true
      case 'window:list':
        return windowList()
      case 'window:getCurrentId':
        return focusedWindowId
      case 'window:setTitle': {
        const live = liveWindows.get(focusedWindowId)
        if (live) {
          live.title = String(args[0] ?? 'CodeSurf')
          live.win.setTitle(live.title)
          broadcastWindowList()
        }
        return true
      }
      case 'window:focusById': {
        const id = Number(args[0])
        liveWindows.get(id)?.win.focus()
        focusedWindowId = id
        broadcastWindowList()
        return true
      }
      case 'window:closeById': {
        const id = Number(args[0])
        liveWindows.get(id)?.win.close()
        return true
      }
      case 'window:isFresh': {
        const live = liveWindows.get(focusedWindowId)
        const fresh = Boolean(live?.fresh)
        if (live) live.fresh = false
        return fresh
      }
      case 'window:setSidebarCollapsed':
        return true
      case 'app:relaunch':
        shutdownRuntimeChildren()
        Utils.quit()
        return true

      case 'bus:publish': {
        const [eventChannel, type, source, payload] = args
        publishBus(String(eventChannel ?? ''), String(type ?? 'event'), String(source ?? 'renderer'), payload)
        return true
      }
      case 'bus:subscribe':
      case 'bus:unsubscribeAll':
      case 'bus:markRead':
        return true
      case 'bus:history': {
        const channelName = String(args[0] ?? '')
        return channelName ? (busHistory.get(channelName) ?? []) : [...busHistory.values()].flat()
      }
      case 'bus:channelInfo':
        return [...busHistory.entries()].map(([name, events]) => ({ name, eventCount: events.length }))
      case 'bus:unreadCount':
        return 0

      case 'tileContext:get':
        return tileContext.get(String(args[0] ?? '')) ?? null
      case 'tileContext:getAll':
        return Object.fromEntries(tileContext.entries())
      case 'tileContext:set':
        tileContext.set(String(args[0] ?? ''), args[1])
        broadcast('tileContext:changed', { tileId: String(args[0] ?? ''), value: args[1] })
        return true
      case 'tileContext:delete':
        tileContext.delete(String(args[0] ?? ''))
        broadcast('tileContext:changed', { tileId: String(args[0] ?? ''), value: null })
        return true

      case 'activity:upsert': {
        const record = (args[0] ?? {}) as Record<string, unknown>
        const id = String(record.id ?? record.tileId ?? safeId('activity'))
        activityRecords.set(id, { ...record, id, updatedAt: Date.now() })
        return activityRecords.get(id)
      }
      case 'activity:query':
        return [...activityRecords.values()]
      case 'activity:byTile':
        return [...activityRecords.values()].filter(record => record.tileId === args[0])
      case 'activity:byAgent':
        return [...activityRecords.values()].filter(record => record.agentId === args[0])
      case 'activity:delete':
        return activityRecords.delete(String(args[0] ?? ''))
      case 'activity:clearTile':
        for (const [id, record] of activityRecords) if (record.tileId === args[0]) activityRecords.delete(id)
        return true

      case 'execution:listHosts':
        return await listExecutionHostsFromDaemon()
      case 'execution:resolveTarget':
        return await resolveElectrobunExecutionTarget((args[0] ?? { mode: 'auto', hostId: null }) as ExecutionPreference)
      case 'execution:upsertHost':
        return await daemonRuntime.request('/host/upsert', { body: { host: args[0] } })
      case 'execution:deleteHost':
        return await daemonRuntime.request(`/host/${encodeURIComponent(String(args[0] ?? ''))}`, { method: 'DELETE' })

      case 'mcp:getConfig':
      case 'mcp:getMergedConfig':
        return await readJson(MCP_CONFIG_PATH, null)
      case 'mcp:getPort': {
        const config = await readJson<any>(MCP_CONFIG_PATH, null)
        return config?.port ?? null
      }
      case 'mcp:getWorkspaceServers':
        return {}
      case 'mcp:saveServers':
      case 'mcp:saveWorkspaceServers':
        return { ok: true }

      case 'system:memStats':
        return process.memoryUsage()
      case 'system:gc':
        broadcast('system:gc-requested')
        return true
      case 'system:daemonStatus': {
        try {
          await daemonRuntime.ensureRunning()
          return await daemonRuntime.status()
        } catch (error) {
          return sanitizeDaemonStatusError(error)
        }
      }
      case 'system:daemonSummary':
        return await getDaemonSummaryForStatusBar()
      case 'system:restartDaemon': {
        await daemonRuntime.restart()
        return await daemonRuntime.status()
      }
      case 'system:cleanupTile':
        return true
      case 'homedir:get':
        return homedir()
      case 'ui:setZoomLevel': {
        const level = typeof args[0] === 'number' ? args[0] : 0
        liveWindows.get(focusedWindowId)?.win.setPageZoom(1 + (level * 0.2))
        return true
      }

      case 'browserTile:sync':
      case 'browserTile:command':
      case 'browserTile:destroy':
        return { ok: true, supported: true, runtime: 'electrobun-webview-tag' }
      case 'chromeSync:listProfiles':
        return []
      case 'chromeSync:getStatus':
        return { enabled: false, supported: false, runtime: 'electrobun' }
      case 'chromeSync:syncCookies':
        return { ok: false, supported: false, error: 'Chrome cookie sync depends on Electron session partitions; Electrobun browser tiles run with their own isolated partitions.' }
      case 'chromeSync:getBookmarks':
      case 'chromeSync:searchHistory':
        return []

      case 'localProxy:getStatus':
        return { running: false }
      case 'localProxy:probeBackends':
        return []
      case 'localProxy:start':
      case 'localProxy:stop':
        return { ok: false, error: 'Local proxy control remains on the Electron main-process path.' }
      case 'updater:check':
        return { ok: true, status: 'disabled-electrobun-runtime', updateAvailable: false }
      case 'updater:download':
      case 'updater:quitAndInstall':
        return { ok: false, error: 'Electrobun packaging does not use electron-updater.' }

      case 'ext:list':
      case 'ext:list-sidebar':
      case 'ext:list-tiles':
      case 'ext:list-chat-surfaces':
      case 'ext:context-menu-items':
      case 'extensions:list':
        return []
      case 'ext:enable':
      case 'ext:disable':
      case 'ext:refresh':
        return { ok: true }

      case 'permissions:list':
        return []
      case 'permissions:clear':
      case 'permissions:clearAll':
        return true
      default:
        return getDefaultElectrobunInvokeResponse(channel)
    }
  } catch (error) {
    console.warn(`[Electrobun] ${channel} failed:`, error)
    return getDefaultElectrobunInvokeResponse(channel)
  }
}

async function runCoreIpcSelfCheck(): Promise<{ ok: boolean, checks: Array<{ name: string, ok: boolean, detail?: unknown, error?: string }> }> {
  const checks: Array<{ name: string, ok: boolean, detail?: unknown, error?: string }> = []

  async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      const detail = await fn()
      checks.push({ name, ok: true, detail })
    } catch (error) {
      checks.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const assert = (condition: unknown, message: string, detail?: unknown): unknown => {
    if (!condition) throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`)
    return detail ?? true
  }

  await check('workspace:list', async () => {
    const result = await handleInvoke('workspace:list', [])
    return assert(Array.isArray(result), 'workspace:list did not return an array', result)
  })

  await check('settings:get', async () => {
    const result = await handleInvoke('settings:get', []) as Record<string, unknown>
    return assert(result && typeof result === 'object' && typeof result.appearance === 'string', 'settings:get did not return app settings', result)
  })

  await check('db:status', async () => {
    const result = await handleInvoke('db:status', []) as { ok?: boolean, status?: { schemaVersion?: number } }
    return assert(result?.ok === true && result.status?.schemaVersion === 4, 'db:status did not report migrated schema v4', result)
  })

  await check('system:daemonStatus', async () => {
    const result = await handleInvoke('system:daemonStatus', []) as { running?: boolean, info?: unknown }
    return assert(result?.running === true && result.info, 'system:daemonStatus did not report a live daemon', result)
  })

  await check('system:daemonSummary', async () => {
    const result = await handleInvoke('system:daemonSummary', []) as { running?: boolean, jobs?: unknown }
    return assert(result?.running === true && result.jobs && typeof result.jobs === 'object', 'system:daemonSummary did not return daemon job summary', result)
  })

  await check('execution:listHosts', async () => {
    const result = await handleInvoke('execution:listHosts', []) as ExecutionHostRecord[]
    return assert(Array.isArray(result) && result.some(host => host.id === 'local-daemon' || host.type === 'local-daemon'), 'execution:listHosts did not return daemon-backed hosts', result)
  })

  await check('execution:resolveTarget', async () => {
    const result = await handleInvoke('execution:resolveTarget', [{ mode: 'auto', hostId: null } satisfies ExecutionPreference]) as { host?: ExecutionHostRecord }
    return assert(result?.host && (result.host.id === 'local-daemon' || result.host.type === 'local-daemon'), 'execution:resolveTarget did not select the live local daemon', result)
  })

  await check('execution:upsertHost/deleteHost', async () => {
    const hostId = `electrobun-self-check-${process.pid}-${Date.now()}`
    const host: ExecutionHostRecord = {
      id: hostId,
      type: 'remote-daemon',
      label: 'Electrobun self-check host',
      enabled: true,
      url: 'http://127.0.0.1:9',
      authToken: null,
    }
    const upserted = await handleInvoke('execution:upsertHost', [host]) as ExecutionHostRecord[]
    assert(Array.isArray(upserted) && upserted.some(entry => entry.id === hostId), 'execution:upsertHost did not persist the self-check host', upserted)
    const deleted = await handleInvoke('execution:deleteHost', [hostId]) as { ok?: boolean, hosts?: ExecutionHostRecord[] }
    return assert(deleted?.ok === true && Array.isArray(deleted.hosts) && !deleted.hosts.some(entry => entry.id === hostId), 'execution:deleteHost did not remove the self-check host', deleted)
  })

  await check('canvas:listCheckpoints', async () => {
    const result = await handleInvoke('canvas:listCheckpoints', ['electrobun-self-check', 'codesurf-runtime:self-check'])
    return assert(Array.isArray(result), 'canvas:listCheckpoints did not return an array', result)
  })

  return { ok: checks.every(entry => entry.ok), checks }
}

const rpc = BrowserView.defineRPC<CodeSurfElectrobunRPC>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {
      invoke: ({ channel, args }) => handleInvoke(channel, args ?? []),
    },
    messages: {
      log: ({ level = 'info', message, detail }) => {
        const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
        logger(`[renderer] ${message}`, detail ?? '')
      },
      bridgeReady: payload => {
        void writeSmokeStatus('renderer-bridge-ready', { bridge: payload })
        console.log('[Electrobun] renderer bridge ready', payload)
      },
    },
  },
})

async function resolveRendererUrl(): Promise<string> {
  if (process.env.CODESURF_ELECTROBUN_FORCE_BUNDLED === '1') return RENDERER_BUNDLED_URL
  try {
    const response = await fetch(RENDERER_DEV_URL, { method: 'HEAD', signal: AbortSignal.timeout(500) })
    if (response.ok) return RENDERER_DEV_URL
  } catch {
    // use bundled renderer below
  }
  return RENDERER_BUNDLED_URL
}

function installMenu(): void {
  ApplicationMenu.setApplicationMenu([
    {
      label: 'CodeSurf',
      submenu: [
        { role: 'about' },
        { type: 'divider' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', action: 'window:new' },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', action: 'window:new-tab' },
        { type: 'divider' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'divider' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'divider' },
        { role: 'togglefullscreen' },
      ],
    },
  ])
}

async function createWindow(options: { fresh?: boolean, url?: string } = {}): Promise<BrowserWindow<ElectrobunRPCInstance>> {
  const url = options.url ?? await resolveRendererUrl()
  const win = new BrowserWindow<ElectrobunRPCInstance>({
    title: 'CodeSurf',
    url,
    preload: BRIDGE_PRELOAD_URL,
    rpc,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: {
      width: 1400,
      height: 900,
      x: 80,
      y: 80,
    },
    renderer: process.env.CODESURF_ELECTROBUN_RENDERER === 'cef' ? 'cef' : 'native',
  })

  focusedWindowId = win.id
  liveWindows.set(win.id, { win, title: 'CodeSurf', fresh: Boolean(options.fresh) })

  win.on('focus', () => {
    focusedWindowId = win.id
    broadcastWindowList()
  })
  win.on('close', () => {
    liveWindows.delete(win.id)
    broadcastWindowList()
    if (liveWindows.size === 0) {
      shutdownRuntimeChildren()
      Utils.quit()
    }
  })

  broadcastWindowList()
  return win
}

function installProcessCleanupHandlers(): void {
  process.once('exit', shutdownRuntimeChildren)
  process.once('SIGTERM', () => {
    shutdownRuntimeChildren()
    process.exit(0)
  })
  process.once('SIGINT', () => {
    shutdownRuntimeChildren()
    process.exit(0)
  })
}

installProcessCleanupHandlers()
installMenu()
const initialRendererUrl = await resolveRendererUrl()
const initialDaemonStatus = await (async () => {
  try {
    await daemonRuntime.ensureRunning()
    return await daemonRuntime.status()
  } catch (error) {
    return sanitizeDaemonStatusError(error)
  }
})()
const initialCoreIpcStatus = process.env.CODESURF_ELECTROBUN_SELF_CHECK === '1'
  || process.env.CODESURF_ELECTROBUN_SMOKE === '1'
  ? await runCoreIpcSelfCheck()
  : null
await writeSmokeStatus('starting', {
  rendererUrl: initialRendererUrl,
  bridgePreload: BRIDGE_PRELOAD_URL,
  bundledRenderer: RENDERER_BUNDLED_URL,
  daemonStatus: initialDaemonStatus,
  coreIpcStatus: initialCoreIpcStatus,
})
const initialWindow = await createWindow({ url: initialRendererUrl })
await writeSmokeStatus('started', {
  rendererUrl: initialRendererUrl,
  bridgePreload: BRIDGE_PRELOAD_URL,
  bundledRenderer: RENDERER_BUNDLED_URL,
  windowId: initialWindow.id,
  dbStatus: dbRuntime.getStatus(),
  daemonStatus: initialDaemonStatus,
  coreIpcStatus: initialCoreIpcStatus,
})

console.log('CodeSurf Electrobun runtime started')
console.log(`Renderer: ${initialRendererUrl}`)
console.log(`Bridge preload: ${BRIDGE_PRELOAD_URL}`)
console.log(`Fallback bundled renderer: ${RENDERER_BUNDLED_URL}`)

if (Number.isFinite(SMOKE_EXIT_AFTER_MS) && SMOKE_EXIT_AFTER_MS > 0) {
  setTimeout(() => {
    void (async () => {
      const daemonStatus = await daemonRuntime.status().catch(sanitizeDaemonStatusError)
      shutdownRuntimeChildren()
      await writeSmokeStatus('exiting', {
        rendererUrl: initialRendererUrl,
        windowCount: liveWindows.size,
        daemonStatus,
      })
    })().finally(() => Utils.quit())
  }, SMOKE_EXIT_AFTER_MS)
}
