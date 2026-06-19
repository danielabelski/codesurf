/**
 * Chat IPC — uses @anthropic-ai/claude-agent-sdk for Claude sessions.
 * No API keys needed — the SDK uses the Claude CLI's own auth.
 * Codex uses codex CLI, OpenCode uses @opencode-ai/sdk via local server.
 *
 * Multi-turn: stores sessionId per card, uses `resume` on subsequent turns.
 */

import { ipcMain, BrowserWindow, dialog } from 'electron'

import { execFileSync, execFile } from 'child_process'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import { promisify } from 'util'
import {
  stopCsagent,
  steerCsagent,
  disposeCsagent,
  clearCsagentSession,
  listCsagentModels,
} from '../chat/pi-runtime'
import { getShellEnvPath } from '../agent-paths'
import { updateLinks } from '../peer-state'
import { CONTEX_HOME } from '../paths'

import {
  applyProjectContextPolicy,
  buildProviderContextPolicy,
  describeProjectContextEnvelope,
} from '../privacy/provider-context-policy'
import { loadExternalSessionMessagesPage } from '../session-sources'
import type { SessionEntryHint } from '../../shared/session-types'
import type { ExecutionHostRecord } from '../../shared/types'
import { daemonClient } from '../daemon/client'
import { ensureDaemonRunning } from '../daemon/manager'
import { parseSseJsonBuffer } from '@codesurf/daemon/sse'
import { getBuiltinExecutionHosts, resolveExecutionTarget } from '../execution/targets'
import { getWorkspacePathById, readSettingsSync } from './workspace'

import type { ToolPermissionRequest } from '../permissions'
import { chatHermes, clearHermesSession } from '../chat/providers/hermes'
import { chatOpenclaw, clearOpenclawSession, listOpenclawAgents } from '../chat/providers/openclaw'
import {
  abortOpenCodeSession,
  chatOpencode,
  clearOpenCodeSession,
  getOpenCodeModelsSnapshot,
  shutdownOpenCodeServer,
} from '../chat/providers/opencode'
import {
  buildClaudeTextInput,
  cancelPendingAskUserQuestionsForCard,
  cardAbortControllers,
  cardPermissionModes,
  chatClaude,
  markClaudeQueryIntentionallyClosed,
  resolvePendingAskUserQuestion,
} from '../chat/providers/claude'
import { chatCodex } from '../chat/providers/codex'
import { agentModeUnresolved, AGENT_MODE_UNRESOLVED_ERROR } from '../chat/agent-mode-tools'
import { resolveAuthoritativeAgentMode } from '../chat/agent-mode-resolver'
import { chatCsagent } from '../chat/providers/csagent'
import { chatLocalProxy } from '../chat/providers/local-proxy'
import type {
  ChatRequest,
  ChatImageAttachment,
  ChatContextBucketBundle,
} from '../chat/types'
import {
  log,
  sendStream,
  cloneChatMessages,
  getPreparedMessages,
  activeQueries,
  activeProcesses,
  activeHttpRequests,
  sessionIds,
  persistSessionIds,
  deleteCardSessionIds,
} from '../chat/runtime'

export { warmOpenCodeModelsOnStartup } from '../chat/providers/opencode'

export type {
  ChatMessage,
  ChatRequest,
  ChatImageAttachment,
  ChatContextBucketBundle,
  RuntimeChatSessionState,
} from '../chat/types'
export {
  log,
  sendStream,
  cloneChatMessages,
  getPreparedMessages,
  upsertRuntimeSessionState,
  activeQueries,
  activeProcesses,
  activeHttpRequests,
  sessionIds,
  persistSessionIds,
  SESSION_IDS_PATH,
} from '../chat/runtime'

type LoadedMemoryContext = Awaited<ReturnType<typeof daemonClient.loadMemoryContext>>

function mayContainFileReferences(text: string): boolean {
  return text.includes('@') || text.includes('Attached file paths:')
}

async function expandLatestUserFileReferences(req: ChatRequest): Promise<{
  request: ChatRequest
  expansion: Awaited<ReturnType<typeof daemonClient.expandFileReferences>> | null
}> {
  if (!req.workspaceId && !req.workspaceDir) {
    return { request: req, expansion: null }
  }

  const preparedMessages = getPreparedMessages(req)
  let lastUserIndex = -1
  for (let index = preparedMessages.length - 1; index >= 0; index -= 1) {
    if (preparedMessages[index]?.role === 'user') {
      lastUserIndex = index
      break
    }
  }

  if (lastUserIndex < 0) {
    return { request: req, expansion: null }
  }

  const lastUserMessage = preparedMessages[lastUserIndex]
  if (!mayContainFileReferences(String(lastUserMessage?.content ?? ''))) {
    return { request: req, expansion: null }
  }

  const expansion = await daemonClient.expandFileReferences({
    message: lastUserMessage.content,
    workspaceId: req.workspaceId ?? null,
    workspaceDir: req.workspaceDir ?? null,
    executionTarget: req.executionTarget === 'cloud' ? 'cloud' : 'local',
  })

  if (!expansion.changed) {
    return { request: req, expansion: null }
  }

  const expandedMessages = cloneChatMessages(preparedMessages)
  expandedMessages[lastUserIndex] = {
    ...expandedMessages[lastUserIndex],
    content: expansion.message,
  }

  // Pull out binary image attachments so we can send them to Claude as real
  // multimodal image blocks (the text expansion only has a `(binary attachment
  // — content not inlined)` placeholder — the model can't see the pixels from
  // that alone).
  const imageAttachments: ChatImageAttachment[] = []
  for (const reference of expansion.references ?? []) {
    if (!reference.binary) continue
    const mediaType = String(reference.mediaType ?? '')
    const resolvedPath = String(reference.resolvedPath ?? '').trim()
    if (!resolvedPath) continue
    if (isSupportedVisionMediaType(mediaType)) {
      imageAttachments.push({
        path: resolvedPath,
        mediaType,
        displayPath: reference.displayPath,
        byteCount: reference.byteCount,
      })
      continue
    }
    const converted = await convertVisionImageToPng(resolvedPath, reference.displayPath, mediaType)
    if (converted) imageAttachments.push(converted)
  }

  return {
    request: {
      ...req,
      expandedMessages,
      ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
    },
    expansion,
  }
}

const ANTHROPIC_SUPPORTED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

function isSupportedVisionMediaType(mediaType: string): boolean {
  return ANTHROPIC_SUPPORTED_IMAGE_TYPES.has(mediaType.toLowerCase())
}

function isConvertibleVisionImage(path: string, mediaType: string): boolean {
  const normalized = mediaType.toLowerCase()
  if (normalized === 'image/heic' || normalized === 'image/heif' || normalized === 'image/tiff' || normalized === 'image/bmp') return true
  return /\.(heic|heif|tiff?|bmp)$/i.test(path)
}

async function convertVisionImageToPng(
  sourcePath: string,
  displayPath: string,
  mediaType: string,
): Promise<ChatImageAttachment | null> {
  if (!isConvertibleVisionImage(sourcePath, mediaType)) return null
  try {
    // Use ~/.codesurf/chat-vision rather than os.tmpdir() so the path is
    // stable across reboots AND inside a permission scope the CodeSurf
    // daemon can access without per-job grants. (os.tmpdir() lives under
    // /private/var/folders/... on macOS, which is not in the daemon's
    // allowlist by default — Reads from agent jobs would fail.)
    const dir = join(CONTEX_HOME, 'chat-vision')
    await fs.mkdir(dir, { recursive: true })
    const safeBase = basename(displayPath || sourcePath)
      .replace(/\.[^.]+$/, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 80) || 'image'
    const dest = join(dir, `${safeBase}-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}.png`)
    await execFileAsync('sips', ['-s', 'format', 'png', sourcePath, '--out', dest], { maxBuffer: 1024 * 1024 * 4 })
    const stat = await fs.stat(dest)
    return {
      path: dest,
      mediaType: 'image/png',
      displayPath: `${displayPath || sourcePath} (converted to PNG)`,
      byteCount: stat.size,
    }
  } catch (error) {
    log('failed to convert image attachment for vision', sourcePath, mediaType, error instanceof Error ? error.message : String(error))
    return null
  }
}

/**
 * Kill every live chat subprocess (Codex/OpenClaw/Hermes/OpenCode CLI children)
 * and stop the OpenCode server. Called from app `before-quit` so a hard quit
 * does not leave orphaned agent processes running and billing. Terminals are
 * intentionally left alone — tmux-backed sessions are designed to survive
 * restarts (see terminal.ts), and the direct-PTY fallback receives SIGHUP when
 * the PTY master closes on parent death.
 */
export function killAllChatProcesses(): void {
  for (const [cardId, proc] of activeProcesses) {
    try {
      proc.kill('SIGTERM')
      // Best-effort escalation if the child ignores SIGTERM; unref'd so it
      // never keeps the quitting process alive.
      const t = setTimeout(() => {
        try { if (!proc.killed) proc.kill('SIGKILL') } catch { /* already gone */ }
      }, 2000)
      t.unref?.()
    } catch { /* already exited */ }
    activeProcesses.delete(cardId)
  }
  try {
    shutdownOpenCodeServer()
  } catch { /* not running */ }
}
const activeDaemonStreams = new Map<string, {
  abortController: AbortController
  host: ExecutionHostRecord
  jobId: string
}>()

const execFileAsync = promisify(execFile)

// --- Tool permission prompts (inline UI, mirrors AskUserQuestion pattern) -----

export type ToolPermissionDecision = 'deny' | 'never' | 'once' | 'session' | 'today' | 'forever'

interface PendingToolPermission {
  resolve: (decision: ToolPermissionDecision) => void
  reject: (err: Error) => void
}

// Keyed by `${cardId}::${toolUseID}` so we can address the exact tool_use.
const pendingToolPermissions = new Map<string, PendingToolPermission>()

function toolPermissionKey(cardId: string, toolUseID: string | null | undefined): string {
  return `${cardId}::${toolUseID ?? ''}`
}

export function awaitToolPermissionAnswer(
  cardId: string,
  toolUseID: string | null,
  request: ToolPermissionRequest,
): Promise<ToolPermissionDecision> {
  const key = toolPermissionKey(cardId, toolUseID)
  const prior = pendingToolPermissions.get(key)
  if (prior) {
    try { prior.reject(new Error('Tool permission superseded')) } catch { /* noop */ }
    pendingToolPermissions.delete(key)
  }
  return new Promise<ToolPermissionDecision>((resolve, reject) => {
    pendingToolPermissions.set(key, { resolve, reject })
    sendStream(cardId, {
      type: 'tool_permission_request',
      toolId: toolUseID,
      provider: request.provider,
      toolName: request.toolName,
      title: request.title ?? null,
      description: request.description ?? null,
      blockedPath: request.blockedPath ?? null,
      workspaceDir: request.workspaceDir ?? null,
    })
  })
}

function resolvePendingToolPermission(
  cardId: string,
  toolUseID: string | null | undefined,
  decision: ToolPermissionDecision,
): boolean {
  const key = toolPermissionKey(cardId, toolUseID)
  const pending = pendingToolPermissions.get(key)
  if (!pending) return false
  pendingToolPermissions.delete(key)
  pending.resolve(decision)
  return true
}

function cancelPendingToolPermissionsForCard(cardId: string, reason: string = 'Cancelled'): void {
  const prefix = `${cardId}::`
  for (const [key, pending] of pendingToolPermissions.entries()) {
    if (key.startsWith(prefix)) {
      pendingToolPermissions.delete(key)
      try { pending.reject(new Error(reason)) } catch { /* noop */ }
    }
  }
}

function stopDaemonStream(cardId: string): void {
  const active = activeDaemonStreams.get(cardId)
  if (!active) return
  active.abortController.abort()
  activeDaemonStreams.delete(cardId)
}

async function resolveHostEndpoint(host: ExecutionHostRecord): Promise<{ baseUrl: string; token: string | null }> {
  if (host.type === 'local-daemon') {
    const info = await ensureDaemonRunning()
    return {
      baseUrl: `http://127.0.0.1:${info.port}`,
      token: info.token,
    }
  }

  if (host.type === 'remote-daemon') {
    const baseUrl = String(host.url ?? '').trim().replace(/\/+$/, '')
    if (!baseUrl) throw new Error(`Remote host ${host.label} is missing a URL`)
    return {
      baseUrl,
      token: host.authToken ?? null,
    }
  }

  throw new Error(`Host ${host.label} does not expose a daemon endpoint`)
}

async function hostRequest<T>(host: ExecutionHostRecord, path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  const endpoint = await resolveHostEndpoint(host)
  const response = await fetch(`${endpoint.baseUrl}${path}`, {
    method: options?.method ?? (options?.body == null ? 'GET' : 'POST'),
    headers: {
      ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
      ...(options?.body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options?.body == null ? undefined : JSON.stringify(options.body),
    signal: options?.signal ?? AbortSignal.timeout(20_000),
  })

  const text = await response.text()
  const payload = text.trim() ? JSON.parse(text) as T : null
  if (!response.ok) {
    const errorMessage = typeof payload === 'object' && payload && 'error' in payload
      ? String((payload as { error?: unknown }).error ?? `Daemon request failed (${response.status})`)
      : (text.trim() || `Daemon request failed (${response.status})`)
    throw new Error(errorMessage)
  }
  return payload as T
}

async function getExecutionRoutingState(): Promise<{
  hosts: ExecutionHostRecord[]
  localDaemonAvailable: boolean
}> {
  try {
    await ensureDaemonRunning()
    const hosts = await daemonClient.listHosts()
    return {
      hosts,
      localDaemonAvailable: true,
    }
  } catch {
    return {
      hosts: getBuiltinExecutionHosts(),
      localDaemonAvailable: false,
    }
  }
}

function supportsDaemonChatProvider(provider: string | null | undefined): boolean {
  return provider === 'claude' || provider === 'codex' || provider === 'opencode' || provider === 'hermes' || provider === 'omnigent'
}

function requiresDaemonChatProvider(provider: string | null | undefined): boolean {
  return provider === 'omnigent'
}

function supportsProviderNativeBackground(provider: string | null | undefined): boolean {
  return provider === 'claude' || provider === 'codex'
}

function buildAsyncExecutionContext(params: {
  request: ChatRequest
  daemonHost: ExecutionHostRecord | null
  localDaemonAvailable: boolean
}): NonNullable<ChatRequest['asyncExecution']> {
  const requestedRunMode = params.request.runMode === 'background' ? 'background' : 'foreground'
  const backend = params.daemonHost ? 'daemon' : 'runtime'
  const hostType = params.daemonHost?.type ?? 'runtime'
  const hostLabel = params.daemonHost?.label ?? 'Electron runtime'
  const providerNativeBackground = supportsProviderNativeBackground(params.request.provider)
  const detachedDaemonAvailable = Boolean(params.daemonHost) || params.localDaemonAvailable

  return {
    requestedRunMode,
    backend,
    hostType,
    hostLabel,
    providerNativeBackground,
    detachedDaemonAvailable,
    detachedDaemonPreferred: detachedDaemonAvailable && !providerNativeBackground,
  }
}

// Prompt conventions live in ./prompt-conventions (pure, unit-testable). They
// are imported at the top of this file.

function syncPeerLinks(req: ChatRequest): void {
  updateLinks(req.cardId, req.peers?.map(peer => peer.peerId) ?? [])
}

function normalizeContextBucketBundle(context: LoadedMemoryContext | null | undefined): ChatContextBucketBundle | undefined {
  if (context?.contextBuckets && Array.isArray(context.contextBuckets.buckets)) {
    return context.contextBuckets
  }
  if (!context) return undefined

  const includedBuckets = Array.isArray(context.includedBuckets)
    ? context.includedBuckets.filter((bucket): bucket is string => typeof bucket === 'string' && bucket.trim().length > 0)
    : []
  const sections = Array.isArray(context.sections)
    ? context.sections.filter(section => includedBuckets.includes(section.bucket))
    : []
  const bucketOrder = Array.from(new Set(['local-only', 'remote-safe', ...includedBuckets, ...sections.map(section => section.bucket)]))

  return {
    version: 1,
    includedBuckets,
    buckets: bucketOrder.map(bucket => {
      const bucketSections = sections
        .filter(section => section.bucket === bucket)
        .map(section => ({
          scope: section.scope,
          displayPath: section.displayPath,
          importedFrom: section.importedFrom ?? null,
        }))
      return {
        bucket,
        included: includedBuckets.includes(bucket),
        sectionCount: bucketSections.length,
        sections: bucketSections,
      }
    }),
  }
}

function summarizeContextBucketBundle(bundle: ChatContextBucketBundle | undefined): string | undefined {
  const inspectSummary = String(bundle?.inspect?.summary ?? '').trim()
  if (inspectSummary) return inspectSummary
  if (!bundle) return undefined

  const sections = bundle.buckets
    .filter(bucket => bucket.included)
    .flatMap(bucket => bucket.sections)
  if (sections.length === 0) return undefined

  const paths = sections.slice(0, 3).map(section => section.displayPath)
  const suffix = sections.length > 3 ? ` +${sections.length - 3} more` : ''
  const bucketSummary = bundle.buckets
    .filter(bucket => bucket.included)
    .map(bucket => `${bucket.bucket}: ${bucket.sectionCount}`)
    .join(', ')
  return `Loaded ${sections.length} instruction section${sections.length === 1 ? '' : 's'} [${bucketSummary}]: ${paths.join(', ')}${suffix}`
}

function buildContextBucketInput(bundle: ChatContextBucketBundle | undefined, prompt: string | undefined): string | undefined {
  const inspectInput = String(bundle?.inspect?.input ?? '').trim()
  if (inspectInput) return inspectInput

  const promptText = String(prompt ?? '').trim() || undefined
  if (!bundle) return promptText

  const lines = [
    '## Outbound Context Buckets',
    `Included buckets: ${bundle.includedBuckets.length > 0 ? bundle.includedBuckets.join(', ') : 'none'}`,
    '',
  ]

  for (const bucket of bundle.buckets) {
    if (bucket.included) {
      lines.push(`### ${bucket.bucket}`)
      if (bucket.sections.length === 0) {
        lines.push('- no sections')
      } else {
        for (const section of bucket.sections) {
          lines.push(`- ${section.displayPath}${section.importedFrom ? ` (imported from ${section.importedFrom})` : ''}`)
        }
      }
    } else {
      lines.push(`### ${bucket.bucket} (omitted from outbound bundle)`)
      lines.push('- omitted from outbound bundle')
    }
    lines.push('')
  }

  if (promptText) {
    lines.push('## Injected Prompt')
    lines.push(promptText)
  }

  return lines.join('\n').trim() || undefined
}

function summarizeMemoryContext(context: LoadedMemoryContext | null | undefined): string | undefined {
  return summarizeContextBucketBundle(normalizeContextBucketBundle(context))
}

function buildMemoryContextInput(context: LoadedMemoryContext | null | undefined): string | undefined {
  return buildContextBucketInput(
    normalizeContextBucketBundle(context),
    String(context?.prompt ?? '').trim() || undefined,
  )
}

function emitMemoryContextLoaded(cardId: string, context: LoadedMemoryContext | null | undefined): void {
  const summary = summarizeMemoryContext(context)
  if (!summary) return
  const toolId = `codesurf-memory-${Date.now()}`
  sendStream(cardId, { type: 'tool_start', toolId, toolName: 'Workspace Instructions' })
  const input = buildMemoryContextInput(context)
  if (input) {
    sendStream(cardId, { type: 'tool_input', toolId, text: input })
  }
  sendStream(cardId, { type: 'tool_summary', toolId, toolName: 'Workspace Instructions', text: summary })
}

function summarizeSelectedSkills(index: Awaited<ReturnType<typeof daemonClient.listSkills>> | null | undefined): string | undefined {
  return String(index?.selection?.summary ?? '').trim() || undefined
}

function buildSelectedSkillsPrompt(index: Awaited<ReturnType<typeof daemonClient.listSkills>> | null | undefined): string | undefined {
  return String(index?.selection?.prompt ?? '').trim() || undefined
}

function emitSelectedSkillsLoaded(cardId: string, index: Awaited<ReturnType<typeof daemonClient.listSkills>> | null | undefined): void {
  const summary = summarizeSelectedSkills(index)
  if (!summary) return
  const toolId = `codesurf-skills-${Date.now()}`
  sendStream(cardId, { type: 'tool_start', toolId, toolName: 'Included Skills' })
  const input = buildSelectedSkillsPrompt(index)
  if (input) {
    sendStream(cardId, { type: 'tool_input', toolId, text: input })
  }
  sendStream(cardId, { type: 'tool_summary', toolId, toolName: 'Included Skills', text: summary })
}

function emitSkippedSkillLocations(cardId: string, index: Awaited<ReturnType<typeof daemonClient.listSkills>> | null | undefined): void {
  const skipped = index?.skippedLocations ?? []
  if (skipped.length === 0) return
  const toolId = `codesurf-skills-skipped-${Date.now()}`
  const lines = skipped.map(entry => `${entry.path} (${entry.code})`).join('\n')
  const summary = `${skipped.length} skill location${skipped.length === 1 ? '' : 's'} could not be read. Skills from those paths were skipped.`
  sendStream(cardId, { type: 'tool_start', toolId, toolName: 'Skill Scan Warning' })
  if (lines) {
    sendStream(cardId, { type: 'tool_input', toolId, text: lines })
  }
  sendStream(cardId, { type: 'tool_summary', toolId, toolName: 'Skill Scan Warning', text: summary })
}

function emitFileReferenceExpansion(
  cardId: string,
  expansion: Awaited<ReturnType<typeof daemonClient.expandFileReferences>> | null | undefined,
): void {
  const summary = String(expansion?.summaryText ?? '').trim()
  if (!summary) return
  const toolId = `codesurf-file-refs-${Date.now()}`
  sendStream(cardId, { type: 'tool_start', toolId, toolName: 'Workspace File References' })
  const input = String(expansion?.inputText ?? '').trim()
  if (input) {
    sendStream(cardId, { type: 'tool_input', toolId, text: input })
  }
  sendStream(cardId, { type: 'tool_summary', toolId, toolName: 'Workspace File References', text: summary })
}

async function loadRuntimeMemoryContext(req: ChatRequest): Promise<LoadedMemoryContext | null> {
  if (!req.workspaceId) return null
  return await daemonClient.loadMemoryContext(
    req.workspaceId,
    req.executionTarget === 'cloud' ? 'cloud' : 'local',
  )
}

async function loadRuntimeSkillsContext(req: ChatRequest): Promise<Awaited<ReturnType<typeof daemonClient.listSkills>> | null> {
  const workspaceId = String(req.workspaceId ?? '').trim()
  const workspaceDir = String(req.workspaceDir ?? '').trim()
  if (!workspaceId && !workspaceDir) return null
  return await daemonClient.listSkills({
    workspaceId: workspaceId || null,
    workspaceDir: workspaceDir || null,
    cardId: req.cardId,
  })
}

async function selectChatExecutionHost(req: ChatRequest): Promise<ExecutionHostRecord | null> {
  const { hosts, localDaemonAvailable } = await getExecutionRoutingState()
  const settings = readSettingsSync()
  const executionPreference = req.executionPreference ?? settings.execution
  const provider = String(req.provider ?? '').trim()

  if (!supportsDaemonChatProvider(provider)) {
    const providerLabel = provider || 'This provider'
    if (req.executionTarget === 'cloud') {
      throw new Error(`${providerLabel} does not support remote daemon execution yet. Daemon-backed chat currently supports Claude, Codex, OpenCode, Hermes, and Omnigent only.`)
    }
    if (executionPreference.mode === 'daemon-only' || executionPreference.mode === 'specific-host') {
      throw new Error(`${providerLabel} does not support daemon-backed chat yet. Supported daemon providers: Claude, Codex, OpenCode, Hermes, and Omnigent.`)
    }
    return null
  }

  if (req.executionTarget === 'cloud') {
    const remoteHosts = hosts.filter(host => host.type === 'remote-daemon' && host.enabled !== false)
    const chosen = remoteHosts.find(host => host.id === req.cloudHostId)
      ?? remoteHosts.find(host => host.id === executionPreference.hostId)
      ?? remoteHosts[0]
    if (!chosen) {
      throw new Error('No remote daemon is registered for cloud execution')
    }
    return chosen
  }

  const resolution = resolveExecutionTarget({
    hosts,
    preference: executionPreference,
    localDaemonAvailable,
  })
  if (executionPreference.mode === 'daemon-only' && resolution.host.type === 'runtime') {
    throw new Error('Execution requires the local daemon, but it is unavailable.')
  }
  if (resolution.host.type !== 'runtime') return resolution.host

  if (requiresDaemonChatProvider(provider)) {
    if (!localDaemonAvailable) {
      throw new Error(`${provider || 'This provider'} requires daemon-backed chat, but the local daemon is unavailable.`)
    }
    const localDaemonHost = hosts.find(host => host.type === 'local-daemon' && host.enabled !== false)
      ?? getBuiltinExecutionHosts().find(host => host.type === 'local-daemon')
    if (!localDaemonHost) {
      throw new Error(`${provider || 'This provider'} requires daemon-backed chat, but no local daemon host is registered.`)
    }
    return localDaemonHost
  }

  return null
}

async function buildProjectContext(workspaceDir: string | undefined): Promise<{
  workspaceDir: string | null
  gitRemoteUrl: string | null
  gitBranch: string | null
  repoName: string | null
}> {
  const normalizedWorkspace = String(workspaceDir ?? '').trim()
  if (!normalizedWorkspace) {
    return { workspaceDir: null, gitRemoteUrl: null, gitBranch: null, repoName: null }
  }

  const shellPath = getShellEnvPath()
  const env = { ...process.env, ...(shellPath && { PATH: shellPath }) }
  let repoRoot = normalizedWorkspace
  let gitRemoteUrl: string | null = null
  let gitBranch: string | null = null

  try {
    repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: normalizedWorkspace,
      encoding: 'utf8',
      env,
    }).trim() || normalizedWorkspace
    gitRemoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    }).trim() || null
    gitBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
    }).trim() || null
  } catch {
    repoRoot = normalizedWorkspace
  }

  return {
    workspaceDir: repoRoot,
    gitRemoteUrl,
    gitBranch,
    repoName: basename(repoRoot) || null,
  }
}

async function attachDaemonJobStream(cardId: string, host: ExecutionHostRecord, jobId: string, sinceSequence = 0): Promise<void> {
  stopDaemonStream(cardId)

  const endpoint = await resolveHostEndpoint(host)
  const abortController = new AbortController()
  activeDaemonStreams.set(cardId, { abortController, host, jobId })

  try {
    const response = await fetch(`${endpoint.baseUrl}/chat/job/events?jobId=${encodeURIComponent(jobId)}&since=${encodeURIComponent(String(sinceSequence))}`, {
      headers: {
        Accept: 'text/event-stream',
        ...(endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {}),
      },
      signal: abortController.signal,
    })

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => '')
      throw new Error(text || `Failed to stream daemon job (${response.status})`)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseSseJsonBuffer<Record<string, unknown>>(buffer)
      buffer = parsed.remaining
      for (const error of parsed.errors) {
        log('daemon stream parse error', error)
      }
      for (const payload of parsed.events) {
        sendStream(cardId, payload)
      }
    }
  } catch (error) {
    if (abortController.signal.aborted) return
    if (error instanceof Error && error.name === 'AbortError') return
    throw error
  } finally {
    const active = activeDaemonStreams.get(cardId)
    if (active?.jobId === jobId) {
      activeDaemonStreams.delete(cardId)
    }
  }
}

async function sendChatToDaemon(req: ChatRequest, host: ExecutionHostRecord): Promise<{ ok: boolean; jobId: string; detached?: boolean }> {
  const rawProjectContext = await buildProjectContext(req.workspaceDir)
  const contextPolicy = buildProviderContextPolicy({
    executionTarget: req.executionTarget,
    hostType: host.type,
  })
  const projectContext = applyProjectContextPolicy(rawProjectContext, contextPolicy)

  log('daemon projectContext policy', {
    hostType: host.type,
    executionTarget: req.executionTarget ?? 'local',
    reason: contextPolicy.reason,
    raw: describeProjectContextEnvelope(rawProjectContext),
    effective: describeProjectContextEnvelope(projectContext),
  })

  const requestWithProviderSettings: ChatRequest = req.provider === 'omnigent'
    ? {
      ...req,
      omnigent: req.omnigent ?? readSettingsSync().omnigent,
    }
    : req

  let job: { id: string; status: string }
  try {
    job = await hostRequest<{
      id: string
      status: string
    }>(host, '/chat/job/start', {
      body: {
        request: {
          ...requestWithProviderSettings,
          messages: getPreparedMessages(requestWithProviderSettings),
          projectContext,
        },
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    sendStream(req.cardId, { type: 'error', error: message })
    sendStream(req.cardId, { type: 'done' })
    return { ok: false, jobId: '' }
  }

  if (req.runMode !== 'background') {
    void attachDaemonJobStream(req.cardId, host, job.id, 0).catch((error: Error) => {
      sendStream(req.cardId, { type: 'error', error: error.message, jobId: job.id })
      sendStream(req.cardId, { type: 'done', jobId: job.id })
    })
  }

  return { ok: true, jobId: job.id, detached: req.runMode === 'background' }
}

async function resumeChatDaemonJob(req: ChatRequest): Promise<{ ok: boolean; resumed: boolean; jobId: string | null }> {
  if (!req.jobId) return { ok: false, resumed: false, jobId: null }
  const host = await selectChatExecutionHost(req)
  if (!host) return { ok: false, resumed: false, jobId: req.jobId }

  const state = await hostRequest<{
    id: string
    status: string
    lastSequence: number
    error?: string | null
    sessionId?: string | null
  }>(host, `/chat/job/state?jobId=${encodeURIComponent(req.jobId)}`)

  const sinceSequence = Number(req.jobSequence ?? 0)
  if (state.status !== 'running' && sinceSequence >= Number(state.lastSequence ?? 0)) {
    if (state.error) {
      sendStream(req.cardId, { type: 'error', error: state.error, jobId: req.jobId, sequence: state.lastSequence })
    }
    sendStream(req.cardId, { type: 'done', jobId: req.jobId, sequence: state.lastSequence, sessionId: state.sessionId ?? undefined })
    return { ok: true, resumed: false, jobId: req.jobId }
  }

  void attachDaemonJobStream(req.cardId, host, req.jobId, sinceSequence).catch((error: Error) => {
    sendStream(req.cardId, { type: 'error', error: error.message, jobId: req.jobId })
    sendStream(req.cardId, { type: 'done', jobId: req.jobId })
  })

  return { ok: true, resumed: true, jobId: req.jobId }
}

async function cancelChatDaemonJob(cardId: string): Promise<void> {
  const active = activeDaemonStreams.get(cardId)
  if (!active) return

  try {
    await hostRequest(active.host, '/chat/job/cancel', {
      body: { jobId: active.jobId },
    })
  } catch (error) {
    log('daemon cancel error', error)
  } finally {
    stopDaemonStream(cardId)
  }
}

export function registerChatIPC(): void {
  log('registerChatIPC: handlers registered')
  ipcMain.handle('chat:send', async (_, req: ChatRequest) => {
    log('chat:send received', { provider: req.provider, model: req.model, msgCount: req.messages.length })
    const requestedRunMode = req.runMode === 'background' ? 'background' : 'foreground'
    if (requestedRunMode === 'foreground') {
      // Foreground turns replace the current foreground execution for this card.
      const existingQuery = activeQueries.get(req.cardId)
      if (existingQuery) {
        markClaudeQueryIntentionallyClosed(existingQuery)
        existingQuery.close()
        activeQueries.delete(req.cardId)
      }
      const existingProc = activeProcesses.get(req.cardId)
      if (existingProc) {
        existingProc.kill('SIGTERM')
        activeProcesses.delete(req.cardId)
      }
      const existingHttpRequest = activeHttpRequests.get(req.cardId)
      if (existingHttpRequest) {
        existingHttpRequest.destroy()
        activeHttpRequests.delete(req.cardId)
      }

      await cancelChatDaemonJob(req.cardId)

      // Medium: abort any live OpenCode SSE session so the old turn's stream
      // does not keep running on the server and interleave events into the new
      // turn's stream. Must happen before chatOpencode() establishes the next
      // session subscription.
      await abortOpenCodeSession(req.cardId)
    }

    // ROOT FIX (server-side authoritative agent resolution). The renderer sends
    // both `agentId` and a renderer-resolved `agentMode`; a race or a compromised
    // renderer can ship a NON-null but LOOSER mode than the workspace's agents.json
    // actually defines, and every downstream guard only rejects a NULL mode — so a
    // wrong-but-non-null mode slips through. Re-resolve the agentId AUTHORITATIVELY
    // here from the TRUSTED workspace root (NOT req.workspaceDir, which is renderer
    // supplied) and OVERRIDE whatever the renderer sent. This is the single
    // chokepoint above the runtime-vs-daemon split, so the authoritative mode flows
    // into both the runtime switch and sendChatToDaemon (incl. remote/cloud, which
    // cannot re-resolve). Fail closed: an unverifiable selected agent is denied.
    const authoritativeResolution = await resolveAuthoritativeAgentMode({
      agentId: req.agentId ?? null,
      resolveWorkspaceRoot: () =>
        req.workspaceId ? getWorkspacePathById(req.workspaceId).catch(() => null) : null,
    })
    if (!authoritativeResolution.ok) {
      sendStream(req.cardId, { type: 'error', error: authoritativeResolution.error })
      sendStream(req.cardId, { type: 'done' })
      return { ok: false }
    }
    const authoritativeAgentMode = authoritativeResolution.agentMode

    let daemonHost: ExecutionHostRecord | null = null
    let localDaemonAvailable = false
    try {
      localDaemonAvailable = (await getExecutionRoutingState()).localDaemonAvailable
      daemonHost = await selectChatExecutionHost(req)
    } catch (error) {
      sendStream(req.cardId, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      sendStream(req.cardId, { type: 'done' })
      return { ok: false }
    }

    const effectiveRequest: ChatRequest = {
      ...req,
      // Authoritative override: whatever main resolved replaces the renderer's
      // agentMode for EVERY downstream path (runtime switch + sendChatToDaemon).
      agentMode: authoritativeAgentMode,
      runMode: requestedRunMode,
      asyncExecution: buildAsyncExecutionContext({
        request: { ...req, runMode: requestedRunMode },
        daemonHost,
        localDaemonAvailable,
      }),
    }

    let memoryPrompt: string | undefined
    let memoryContext: Awaited<ReturnType<typeof daemonClient.loadMemoryContext>> | null = null
    try {
      memoryContext = await loadRuntimeMemoryContext(effectiveRequest)
      memoryPrompt = String(memoryContext?.prompt ?? '').trim() || undefined
    } catch (error) {
      sendStream(req.cardId, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      sendStream(req.cardId, { type: 'done' })
      return { ok: false }
    }

    let skillsPrompt: string | undefined
    let skillsSummary: string | null = null
    let skillsContext: Awaited<ReturnType<typeof daemonClient.listSkills>> | null = null
    try {
      skillsContext = await loadRuntimeSkillsContext(effectiveRequest)
      skillsPrompt = buildSelectedSkillsPrompt(skillsContext)
      skillsSummary = summarizeSelectedSkills(skillsContext) ?? null
    } catch (error) {
      console.warn(
        '[chat] Skills index unavailable; continuing without skill context:',
        error instanceof Error ? error.message : String(error),
      )
    }

    const requestWithContext: ChatRequest = {
      ...effectiveRequest,
      ...(memoryPrompt ? { memoryPrompt } : {}),
      ...(memoryContext?.contextBuckets ? { contextBuckets: memoryContext.contextBuckets } : {}),
      ...(skillsPrompt ? { skillsPrompt, skillsSummary } : {}),
    }

    let requestWithFileReferences: ChatRequest = requestWithContext
    let fileReferenceExpansion: Awaited<ReturnType<typeof daemonClient.expandFileReferences>> | null = null
    try {
      const expanded = await expandLatestUserFileReferences(requestWithContext)
      requestWithFileReferences = expanded.request
      fileReferenceExpansion = expanded.expansion
    } catch (error) {
      sendStream(req.cardId, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      sendStream(req.cardId, { type: 'done' })
      return { ok: false }
    }

    emitFileReferenceExpansion(req.cardId, fileReferenceExpansion)

    if (daemonHost) {
      log('chat execution route', {
        cardId: req.cardId,
        provider: req.provider,
        model: req.model,
        runMode: requestedRunMode,
        executionTarget: req.executionTarget ?? 'local',
        executionPreference: req.executionPreference ?? null,
        backend: 'daemon',
        hostId: daemonHost.id,
        hostType: daemonHost.type,
      })
      return await sendChatToDaemon(requestWithFileReferences, daemonHost)
    }

    emitMemoryContextLoaded(req.cardId, memoryContext)
    emitSelectedSkillsLoaded(req.cardId, skillsContext)
    emitSkippedSkillLocations(req.cardId, skillsContext)
    syncPeerLinks(requestWithFileReferences)

    if (requestedRunMode === 'background') {
      sendStream(req.cardId, {
        type: 'error',
        error: 'Detached background chat execution currently requires a daemon-backed Claude or Codex host.',
      })
      sendStream(req.cardId, { type: 'done' })
      return { ok: false }
    }

    log('chat execution route', {
      cardId: req.cardId,
      provider: req.provider,
      model: req.model,
      runMode: requestedRunMode,
      executionTarget: req.executionTarget ?? 'local',
      executionPreference: req.executionPreference ?? null,
      backend: 'runtime',
    })

    // A-PR1 BLOCKING-1 (security chokepoint): a selected agent whose definition
    // has not resolved must not launch unrestricted on ANY runtime provider.
    // chatClaude/chatCodex/chatHermes each also fail closed via their builders
    // (defense-in-depth), but opencode/openclaw/csagent/local-proxy ignore
    // agentMode entirely — so this switch-level guard is the non-bypassable net
    // that covers every provider in one place.
    if (agentModeUnresolved(requestWithFileReferences)) {
      sendStream(requestWithFileReferences.cardId, { type: 'error', error: AGENT_MODE_UNRESOLVED_ERROR })
      sendStream(requestWithFileReferences.cardId, { type: 'done' })
      return { ok: false }
    }

    switch (requestWithFileReferences.provider) {
      case 'claude': chatClaude(requestWithFileReferences); break
      case 'codex': chatCodex(requestWithFileReferences); break
      case 'opencode': chatOpencode(requestWithFileReferences); break
      case 'openclaw': chatOpenclaw(requestWithFileReferences); break
      case 'hermes': chatHermes(requestWithFileReferences); break
      case 'csagent': chatCsagent(requestWithFileReferences); break
      default:
        if (requestWithFileReferences.providerTransport?.type === 'local-proxy') {
          chatLocalProxy(requestWithFileReferences)
        } else {
          sendStream(requestWithFileReferences.cardId, { type: 'error', error: `Unsupported provider: ${requestWithFileReferences.provider}` })
          sendStream(requestWithFileReferences.cardId, { type: 'done' })
        }
    }

    return { ok: true }
  })

  ipcMain.handle('chat:resumeJob', async (_, req: ChatRequest) => {
    return await resumeChatDaemonJob(req)
  })

  ipcMain.handle('chat:steer', async (_, payload: { cardId?: string; message?: string }) => {
    const cardId = String(payload?.cardId ?? '').trim()
    const message = String(payload?.message ?? '').trim()
    if (!cardId || !message) return { ok: false, error: 'missing cardId or message' }
    try {
      if (await steerCsagent(cardId, message)) {
        sendStream(cardId, { type: 'steer_sent', text: message })
        return { ok: true }
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const q = activeQueries.get(cardId)
    if (!q) return { ok: false, error: 'no active steerable Claude stream' }
    try {
      await q.streamInput(buildClaudeTextInput(message, 'now'))
      sendStream(cardId, { type: 'steer_sent', text: message })
      return { ok: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      log('chat:steer failed:', msg)
      return { ok: false, error: msg }
    }
  })

  ipcMain.handle('chat:stop', async (_, cardId: string) => {
    // Abort the in-flight SDK HTTP request (claude.ts) before closing the query
    const ac = cardAbortControllers.get(cardId)
    if (ac) {
      ac.abort()
      cardAbortControllers.delete(cardId)
    }
    const q = activeQueries.get(cardId)
    if (q) {
      markClaudeQueryIntentionallyClosed(q)
      q.close()
      activeQueries.delete(cardId)
    }
    const proc = activeProcesses.get(cardId)
    if (proc) {
      proc.kill('SIGTERM')
      activeProcesses.delete(cardId)
    }
    const httpRequest = activeHttpRequests.get(cardId)
    if (httpRequest) {
      httpRequest.destroy()
      activeHttpRequests.delete(cardId)
    }
    await cancelChatDaemonJob(cardId)
    cancelPendingAskUserQuestionsForCard(cardId, 'Chat stopped')
    cancelPendingToolPermissionsForCard(cardId, 'Chat stopped')
    cardPermissionModes.delete(cardId)
    await abortOpenCodeSession(cardId)
    try { await stopCsagent(cardId) } catch { /* best-effort */ }
    disposeCsagent(cardId)
    sendStream(cardId, { type: 'done' })
  })

  // Permanently dispose a card's chat state when its tile is deleted. Unlike
  // clearSession (same tile, fresh conversation) this also prunes the persisted
  // session-ids.json so neither the in-memory maps nor the on-disk file grow
  // unbounded across the install lifetime.
  ipcMain.handle('chat:disposeCard', async (_, cardId: string) => {
    if (!cardId || typeof cardId !== 'string') return { ok: false }
    deleteCardSessionIds(cardId)
    clearOpenCodeSession(cardId)
    clearOpenclawSession(cardId)
    clearHermesSession(cardId)
    disposeCsagent(cardId)
    cardPermissionModes.delete(cardId)
    // Schedule a rewrite of session-ids.json from the (now-pruned) map.
    persistSessionIds()
    return { ok: true }
  })

  // Clear session for a card (start fresh conversation)
  ipcMain.handle('chat:clearSession', async (_, cardId: string) => {
    deleteCardSessionIds(cardId)
    clearOpenCodeSession(cardId)
    clearOpenclawSession(cardId)
    clearHermesSession(cardId)
    clearCsagentSession(cardId)
    cancelPendingAskUserQuestionsForCard(cardId, 'Session cleared')
    cancelPendingToolPermissionsForCard(cardId, 'Session cleared')
    cardPermissionModes.delete(cardId)
    // Persist the eviction so the cleared session does not reappear on restart.
    persistSessionIds()
    log('session cleared for card', cardId)
    return { ok: true }
  })

  // Change the Claude SDK permission mode mid-thread. This lets the user flip
  // from Default -> Bypass (or vice versa) without ending the current turn.
  // If switching TO bypass, any pending permission prompts auto-resolve as
  // "once" (allow) so the agent stops waiting on the UI.
  ipcMain.handle('chat:setPermissionMode', async (_, payload: {
    cardId: string
    mode: string
  }) => {
    if (!payload || typeof payload.cardId !== 'string') {
      return { ok: false, error: 'invalid payload' }
    }
    const sdkModeMap: Record<string, string> = {
      default: 'default',
      acceptEdits: 'acceptEdits',
      plan: 'plan',
      bypassPermissions: 'bypassPermissions',
    }
    const sdkMode = sdkModeMap[payload.mode ?? '']
    if (!sdkMode) {
      return { ok: false, error: `unknown mode: ${payload.mode}` }
    }

    const previous = cardPermissionModes.get(payload.cardId) ?? 'default'
    cardPermissionModes.set(payload.cardId, sdkMode)

    // Tell the SDK too, so any internal gating (hooks, agents) uses the new
    // mode. Swallow errors — the query may have already closed.
    const activeQuery = activeQueries.get(payload.cardId)
    if (activeQuery) {
      try {
        await activeQuery.setPermissionMode(sdkMode as any)
      } catch (err) {
        log('setPermissionMode SDK call failed:', (err as Error).message)
      }
    }

    // Auto-resolve pending prompts when flipping to bypass so the agent
    // unblocks immediately.
    if (sdkMode === 'bypassPermissions') {
      const prefix = `${payload.cardId}::`
      for (const [key, pending] of pendingToolPermissions.entries()) {
        if (key.startsWith(prefix)) {
          pendingToolPermissions.delete(key)
          try { pending.resolve('once') } catch { /* noop */ }
          // Tell the UI the pending chip is gone.
          const toolUseID = key.slice(prefix.length) || null
          sendStream(payload.cardId, {
            type: 'tool_permission_resolved',
            toolId: toolUseID,
            decision: 'once',
            reason: 'mode_change',
          })
        }
      }
    }

    sendStream(payload.cardId, {
      type: 'permission_mode_changed',
      mode: sdkMode,
      previous,
    })

    return { ok: true }
  })

  // Tool permission — receive the user's decision from the renderer and resolve
  // the pending canUseTool promise so the agent can continue (or halt).
  ipcMain.handle('chat:answerToolPermission', async (_, payload: {
    cardId: string
    toolId: string | null
    decision: ToolPermissionDecision
  }) => {
    if (!payload || typeof payload.cardId !== 'string') {
      return { ok: false, error: 'invalid payload' }
    }
    const validDecisions: ToolPermissionDecision[] = ['deny', 'never', 'once', 'session', 'today', 'forever']
    if (!validDecisions.includes(payload.decision)) {
      return { ok: false, error: 'invalid decision' }
    }
    const delivered = resolvePendingToolPermission(payload.cardId, payload.toolId ?? null, payload.decision)
    if (!delivered) {
      const activeDaemon = activeDaemonStreams.get(payload.cardId)
      if (activeDaemon) {
        try {
          return await hostRequest(activeDaemon.host, '/chat/job/permission/answer', {
            body: {
              jobId: activeDaemon.jobId,
              toolId: payload.toolId ?? '',
              decision: payload.decision,
            },
          })
        } catch (error) {
          log('chat:answerToolPermission daemon reply failed:', error instanceof Error ? error.message : String(error))
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      log('chat:answerToolPermission: no pending request for', payload.cardId, payload.toolId)
      return { ok: false, error: 'no pending request' }
    }
    return { ok: true }
  })

  // AskUserQuestion — receive the user's form submission from the renderer and
  // resolve the pending canUseTool promise so the agent can continue.
  ipcMain.handle('chat:answerUserQuestion', async (_, payload: {
    cardId: string
    toolId: string | null
    answers: Record<string, string>
    annotations?: Record<string, { notes?: string; preview?: string }>
  }) => {
    if (!payload || typeof payload.cardId !== 'string') {
      return { ok: false, error: 'invalid payload' }
    }
    const answers = (payload.answers && typeof payload.answers === 'object') ? payload.answers : {}
    const annotations = (payload.annotations && typeof payload.annotations === 'object') ? payload.annotations : undefined
    const delivered = resolvePendingAskUserQuestion(payload.cardId, payload.toolId ?? null, { answers, annotations })
    if (!delivered) {
      log('chat:answerUserQuestion: no pending question for', payload.cardId, payload.toolId)
      return { ok: false, error: 'no pending question' }
    }
    // Emit a tool_summary so the form is replaced by a permanent summary of the
    // user's selections (persists across re-renders and session rehydration).
    const summaryLines = Object.entries(answers).map(([q, a]) => `• ${q} — ${a}`)
    if (summaryLines.length > 0) {
      sendStream(payload.cardId, {
        type: 'tool_summary',
        toolId: payload.toolId,
        toolName: 'AskUserQuestion',
        text: summaryLines.join('\n'),
      })
    }
    return { ok: true }
  })

  // Open a file picker dialog for attachments
  ipcMain.handle('chat:selectFiles', async () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return []
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: 'Attach Files',
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return result.filePaths
  })

  ipcMain.handle('chat:openclawAgents', async () => listOpenclawAgents())

  // Write a renderer-supplied payload (e.g. a sketch image produced by a chat-surface extension)
  // to a temp file and return its absolute path so the standard path-based attachment pipeline
  // can pick it up.
  ipcMain.handle('chat:writeTempAttachment', async (_, payload: {
    data: string            // base64 (no data-URL prefix)
    mime?: string           // e.g. 'image/png'
    ext?: string            // e.g. 'png'
    filenameHint?: string   // optional, no path components
  }) => {
    try {
      if (!payload || typeof payload.data !== 'string' || !payload.data) {
        return { ok: false, error: 'missing data' }
      }
      const ext = (payload.ext || (payload.mime?.split('/')[1]) || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png'
      const safeHint = (payload.filenameHint || 'sketch')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, '-')
        .slice(0, 40) || 'sketch'
      // ~/.codesurf/chat-attachments — see chat-vision comment above for
      // the rationale: stable, user-owned path inside the daemon's
      // permission scope so agent jobs can Read attachments back.
      const dir = join(CONTEX_HOME, 'chat-attachments')
      await fs.mkdir(dir, { recursive: true })
      const filename = `${safeHint}-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}.${ext}`
      const dest = join(dir, filename)
      const buf = Buffer.from(payload.data, 'base64')
      await fs.writeFile(dest, buf)
      return { ok: true, path: dest }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * Loads one older transcript page for a linked external session. The
   * renderer prepends these pages into the same chat list so upward scrolling
   * feels like a normal continuous transcript rather than a separate archive.
   */
  ipcMain.handle('chat:loadSessionHistory', async (
    _,
    payload: {
      workspaceId?: string
      sessionEntryId?: string
      entryHint?: SessionEntryHint | null
      beforeFingerprint?: string | null
      limit?: number
    },
  ) => {
    const workspaceId = String(payload?.workspaceId || '').trim()
    const sessionEntryId = String(payload?.sessionEntryId || '').trim()
    if (!sessionEntryId) return { ok: false, error: 'sessionEntryId required', messages: [], total: 0, hasMore: false }

    const rawHint = payload?.entryHint
    const entryHint: SessionEntryHint | null = rawHint && typeof rawHint === 'object' && typeof rawHint.id === 'string' && typeof rawHint.source === 'string'
      ? {
          id: rawHint.id,
          source: rawHint.source as SessionEntryHint['source'],
          filePath: typeof rawHint.filePath === 'string' ? rawHint.filePath : undefined,
          sessionId: typeof rawHint.sessionId === 'string' || rawHint.sessionId === null ? rawHint.sessionId : null,
          provider: typeof rawHint.provider === 'string' ? rawHint.provider : '',
          model: typeof rawHint.model === 'string' ? rawHint.model : '',
          messageCount: typeof rawHint.messageCount === 'number' ? rawHint.messageCount : 0,
          title: typeof rawHint.title === 'string' ? rawHint.title : '',
          projectPath: typeof rawHint.projectPath === 'string' || rawHint.projectPath === null ? rawHint.projectPath : null,
        }
      : null

    const workspacePath = workspaceId
      ? await getWorkspacePathById(workspaceId).catch(() => null)
      : null

    const page = await loadExternalSessionMessagesPage(workspacePath, sessionEntryId, {
      entryHint,
      beforeFingerprint: typeof payload?.beforeFingerprint === 'string' ? payload.beforeFingerprint : null,
      limit: typeof payload?.limit === 'number' ? payload.limit : undefined,
    }).catch(error => {
      return {
        error: error instanceof Error ? error.message : String(error),
      }
    })

    if (!page || 'error' in page) {
      return {
        ok: false,
        error: (page && 'error' in page) ? page.error : 'Could not load earlier messages',
        messages: [],
        total: 0,
        hasMore: false,
      }
    }

    return {
      ok: true,
      messages: page.messages,
      total: page.total,
      hasMore: page.hasMore,
      provider: page.provider,
      model: page.model,
      sessionId: page.sessionId,
    }
  })

  ipcMain.handle('chat:opencodeModels', async () => getOpenCodeModelsSnapshot())

  // Pi (csagent) models from the user's installed pi ModelRegistry (auth-configured).
  // Best-effort: returns [] if pi isn't installed/authed — the tile keeps its defaults.
  ipcMain.handle('chat:csagentModels', async () => {
    return { models: await listCsagentModels() }
  })
}
