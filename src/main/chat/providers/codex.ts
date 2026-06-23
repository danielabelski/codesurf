/**
 * Codex provider — runs `codex exec --json` subprocess.
 */

import { spawn, execFile } from 'child_process'
import { promises as fs, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, relative, resolve, sep } from 'path'
import { promisify } from 'util'
import { getAgentPath, getShellEnvPath } from '../../agent-paths'
import { buildSafeSpawnEnv } from '../../ipc/terminal-helpers'
import { daemonClient } from '../../daemon/client'
import { writeMCPConfigToWorkspace, getTileToken } from '../../mcp-server'
import { CONTEX_HOME } from '../../paths'
import { buildPeerSystemPrompt } from '../prompt-builders'
import { sanitizeToolOutputText } from '../output-sanitizers'
import { buildCodexSpawnArgs } from './agent-mode-payloads'
import type { ChatRequest, RuntimeChatSessionState } from '../types'
import {
  log,
  sendStream,
  cloneChatMessages,
  getPreparedMessages,
  upsertRuntimeSessionState,
  activeProcesses,
  getCardSessionId,
  setCardSessionId,
} from '../runtime'

const execFileAsync = promisify(execFile)

export interface StreamToolFileChange {
  path: string
  previousPath?: string
  changeType: 'add' | 'update' | 'delete' | 'move'
  additions: number
  deletions: number
  diff: string
}

interface StreamToolCommandEntry {
  label: string
  command?: string
  output?: string
  kind?: 'search' | 'read' | 'command'
}

interface CodexFileSnapshot {
  displayPath: string
  changeType: StreamToolFileChange['changeType']
  existed: boolean
  content: string | null
}

function normalizeCodexShellCommand(command: string): string {
  const trimmed = command.trim()
  const quotedMatch = trimmed.match(/^\/bin\/zsh -lc '([\s\S]*)'$/)
  if (quotedMatch) return quotedMatch[1].replace(/'\\''/g, "'")
  const plainMatch = trimmed.match(/^\/bin\/zsh -lc (.+)$/)
  if (plainMatch) return plainMatch[1].trim()
  return trimmed
}

function classifyCodexCommand(command: string): StreamToolCommandEntry['kind'] {
  const normalized = command.trim()
  if (/(^|\s)(rg|grep|fd|findstr)\b/.test(normalized)) return 'search'
  if (/(^|\s)(cat|sed|head|tail|less|more|bat|ls)\b/.test(normalized)) return 'read'
  return 'command'
}

function buildExploreToolName(entries: StreamToolCommandEntry[]): string {
  const readCount = entries.filter(entry => entry.kind === 'read').length
  const searchCount = entries.filter(entry => entry.kind === 'search').length
  const labelParts: string[] = []
  if (readCount > 0) labelParts.push(`${readCount} file${readCount === 1 ? '' : 's'}`)
  if (searchCount > 0) labelParts.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`)
  return labelParts.length > 0 ? `Explored ${labelParts.join(', ')}` : 'Explored workspace'
}

function buildEditedToolName(fileChanges: StreamToolFileChange[]): string {
  return `Edited ${fileChanges.length} file${fileChanges.length === 1 ? '' : 's'}`
}

function countDiffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

function changeTypeFromCodexKind(kind: unknown): StreamToolFileChange['changeType'] {
  if (kind === 'add' || kind === 'delete' || kind === 'move') return kind
  return 'update'
}

function mergeFileChanges(fileChanges: StreamToolFileChange[]): StreamToolFileChange[] {
  const merged = new Map<string, StreamToolFileChange>()

  for (const change of fileChanges) {
    const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
    const existing = merged.get(key)
    if (!existing) {
      merged.set(key, { ...change })
      continue
    }
    existing.additions += change.additions
    existing.deletions += change.deletions
    existing.diff = `${existing.diff}\n\n${change.diff}`.trim()
  }

  return Array.from(merged.values())
}

async function readSnapshotContent(filePath: string): Promise<{ existed: boolean; content: string | null }> {
  try {
    const buffer = await fs.readFile(filePath)
    if (buffer.includes(0)) return { existed: true, content: null }
    return { existed: true, content: buffer.toString('utf8') }
  } catch {
    return { existed: false, content: null }
  }
}

// Synchronous variant used to capture a Codex pre-edit snapshot without
// yielding the event loop. The async version races against Codex's write:
// by the time `await fs.readFile` resolves, Codex has often already flushed
// bytes to disk, so `before.content` equals `after.content` and the
// resulting diff is empty (+0/-0). The fs.readFileSync call blocks the
// main process for a few ms, which is acceptable for source-file sizes.
function readSnapshotContentSync(filePath: string): { existed: boolean; content: string | null } {
  try {
    const buffer = readFileSync(filePath)
    if (buffer.includes(0)) return { existed: true, content: null }
    return { existed: true, content: buffer.toString('utf8') }
  } catch {
    return { existed: false, content: null }
  }
}

export function getDisplayPath(filePath: string, workspaceDir?: string): string {
  const resolvedPath = resolve(filePath)
  const resolvedWorkspace = workspaceDir ? resolve(workspaceDir) : ''
  if (resolvedWorkspace && (resolvedPath === resolvedWorkspace || resolvedPath.startsWith(`${resolvedWorkspace}${sep}`))) {
    const rel = relative(resolvedWorkspace, resolvedPath)
    return rel || resolvedPath.split(sep).pop() || resolvedPath
  }
  return resolvedPath
}

export function resolveCodexFilePath(filePath: string, workspaceDir?: string): string {
  if (workspaceDir && !filePath.startsWith('/')) return resolve(workspaceDir, filePath)
  return resolve(filePath)
}

function normalizeNoIndexDiffPaths(diff: string, beforePath: string | null, afterPath: string | null, displayPath: string): string {
  let normalized = diff
  if (beforePath) normalized = normalized.split(beforePath).join(`a/${displayPath}`)
  if (afterPath) normalized = normalized.split(afterPath).join(`b/${displayPath}`)
  return normalized.trim()
}

async function buildSnapshotDiff(before: CodexFileSnapshot, currentPath: string): Promise<Pick<StreamToolFileChange, 'diff' | 'additions' | 'deletions'>> {
  const after = await readSnapshotContent(currentPath)
  if (before.content == null || (after.existed && after.content == null)) {
    return { diff: '', additions: 0, deletions: 0 }
  }

  const tempRoot = await fs.mkdtemp(join(tmpdir(), 'codesurf-codex-diff-'))
  const beforeTempPath = before.existed ? join(tempRoot, 'before', before.displayPath) : null
  const afterTempPath = after.existed ? join(tempRoot, 'after', before.displayPath) : null

  try {
    if (beforeTempPath) {
      await fs.mkdir(dirname(beforeTempPath), { recursive: true })
      await fs.writeFile(beforeTempPath, before.content ?? '', 'utf8')
    }
    if (afterTempPath) {
      await fs.mkdir(dirname(afterTempPath), { recursive: true })
      await fs.writeFile(afterTempPath, after.content ?? '', 'utf8')
    }

    const args = ['diff', '--no-index', '--no-ext-diff', '--unified=3', '--']
    args.push(beforeTempPath ?? '/dev/null', afterTempPath ?? '/dev/null')

    let diff = ''
    try {
      const result = await execFileAsync('git', args, { maxBuffer: 1024 * 1024 * 4 })
      diff = result.stdout || result.stderr || ''
    } catch (error) {
      // execFile rejects with an Error augmented with code/stdout/stderr.
      const execErr = error as { code?: number; stdout?: string; stderr?: string }
      if (execErr?.code === 1) {
        diff = execErr.stdout || execErr.stderr || ''
      } else {
        throw error
      }
    }

    const normalizedDiff = normalizeNoIndexDiffPaths(diff, beforeTempPath, afterTempPath, before.displayPath)
    const { additions, deletions } = countDiffStats(normalizedDiff)
    return { diff: normalizedDiff, additions, deletions }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

async function summarizeCodexFileChanges(
  changes: Array<{ path?: unknown; kind?: unknown }>,
  snapshots: Map<string, CodexFileSnapshot>,
  workspaceDir?: string,
): Promise<StreamToolFileChange[]> {
  const fileChanges: StreamToolFileChange[] = []

  for (const change of changes) {
    if (typeof change?.path !== 'string') continue
    const resolvedPath = resolveCodexFilePath(change.path, workspaceDir)
    const snapshot = snapshots.get(resolvedPath) ?? {
      displayPath: getDisplayPath(resolvedPath, workspaceDir),
      changeType: changeTypeFromCodexKind(change.kind),
      existed: false,
      content: null,
    }

    const diffSummary = await buildSnapshotDiff(snapshot, resolvedPath).catch(() => ({
      diff: '',
      additions: 0,
      deletions: 0,
    }))

    fileChanges.push({
      path: snapshot.displayPath,
      changeType: snapshot.changeType,
      additions: diffSummary.additions,
      deletions: diffSummary.deletions,
      diff: diffSummary.diff,
    })

    snapshots.delete(resolvedPath)
  }

  return mergeFileChanges(fileChanges)
}

function buildRuntimeSessionEntryId(req: ChatRequest): string {
  return `codesurf-runtime:${req.cardId}`
}

function buildCheckpointLabel(toolName: string, filePaths: string[], workspaceDir?: string): string {
  if (filePaths.length === 0) return `Before ${toolName}`
  if (filePaths.length === 1) return `Before ${toolName} ${getDisplayPath(filePaths[0], workspaceDir)}`
  return `Before ${toolName} (${filePaths.length} files)`
}

function emitCheckpointSaved(
  req: ChatRequest,
  toolName: string,
  filePaths: string[],
  checkpointId: string,
): void {
  const displayPaths = filePaths.slice(0, 2).map(filePath => getDisplayPath(filePath, req.workspaceDir))
  const suffix = filePaths.length > 2 ? ` +${filePaths.length - 2} more` : ''
  const summary = `Saved checkpoint before ${toolName}${displayPaths.length > 0 ? ` for ${displayPaths.join(', ')}${suffix}` : ''}`
  const toolId = `codesurf-checkpoint-${checkpointId}`
  sendStream(req.cardId, { type: 'tool_start', toolId, toolName: 'Checkpoint saved' })
  sendStream(req.cardId, { type: 'tool_summary', toolId, toolName: 'Checkpoint saved', text: summary })
}

async function createRuntimeCheckpoint(
  req: ChatRequest,
  toolName: string,
  filePaths: string[],
  metadata: Record<string, unknown> = {},
): Promise<{ ok: boolean; checkpointId?: string; skipped?: boolean; error?: string }> {
  if (filePaths.length === 0) return { ok: true, skipped: true }
  if (!req.workspaceId) return { ok: true, skipped: true }

  try {
    const response = await daemonClient.createCheckpoint(req.workspaceId, buildRuntimeSessionEntryId(req), {
      label: buildCheckpointLabel(toolName, filePaths, req.workspaceDir),
      reason: `tool:${toolName}`,
      files: filePaths,
      metadata: {
        provider: req.provider,
        model: req.model,
        toolName,
        cardId: req.cardId,
        ...metadata,
      },
      source: 'main-ipc-chat',
    })
    if (!response.ok) {
      return { ok: false, error: response.error ?? `Failed to create checkpoint for ${toolName}` }
    }
    if (response.checkpoint?.id) {
      emitCheckpointSaved(req, toolName, filePaths, response.checkpoint.id)
    }
    return { ok: true, checkpointId: response.checkpoint?.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('createRuntimeCheckpoint error', req.cardId, toolName, message)
    return { ok: false, error: message }
  }
}

export function chatCodex(req: ChatRequest): void {
  const lastUserMsg = [...getPreparedMessages(req)].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(req.cardId, { type: 'error', error: 'No user message' })
    return
  }

  const codexBin = getAgentPath('codex') || 'codex'
  const shellPath = getShellEnvPath()
  const peerPrompt = buildPeerSystemPrompt(req.peers)
  const runtimeMessages = cloneChatMessages(req.messages)
  const resumeThreadId = req.sessionId ?? getCardSessionId(req.cardId, req.provider) ?? null
  const runtimeSession: RuntimeChatSessionState = {
    provider: req.provider,
    model: req.model,
    sessionId: resumeThreadId,
    jobId: req.jobId ?? null,
    jobSequence: typeof req.jobSequence === 'number' ? req.jobSequence : 0,
    executionTarget: req.executionTarget === 'cloud' ? 'cloud' : 'local',
    cloudHostId: req.cloudHostId ?? null,
    isStreaming: true,
    messages: runtimeMessages,
  }
  void upsertRuntimeSessionState(req, runtimeSession)

  // Build the `codex exec` argv from the shared, pure builder. It maps
  // AgentMode.tools onto the sandbox (Codex's only per-toolset lever), injects
  // the persona into the prompt, and FAILS CLOSED (throws) for both an
  // unenforceable deny-all tool list (A-PR1 #1b, CODEX_DENY_ALL_ERROR) and a
  // selected agent whose definition has not resolved (A-PR1 BLOCKING-1). When a
  // thread ID is present it emits `exec resume <threadId>` to preserve multi-turn
  // context; `--ignore-user-config` keeps the run isolated from ~/.codex.
  let args: string[]
  try {
    args = buildCodexSpawnArgs({
      agentId: req.agentId,
      agentMode: req.agentMode,
      mode: req.mode,
      model: req.model,
      userContent: lastUserMsg.content,
      resumeThreadId,
      workspaceDir: req.workspaceDir,
      peerPrompt,
      memoryPrompt: req.memoryPrompt,
      skillsPrompt: req.skillsPrompt,
      asyncExecution: req.asyncExecution,
    })
  } catch (err) {
    sendStream(req.cardId, { type: 'error', error: err instanceof Error ? err.message : String(err) })
    sendStream(req.cardId, { type: 'done' })
    return
  }

  if (req.workspaceDir) {
    void writeMCPConfigToWorkspace(req.workspaceDir).catch(() => {})
  }

  const spawnEnv: Record<string, string> = buildSafeSpawnEnv({ ...(shellPath && { PATH: shellPath }) })
  spawnEnv.CONTEX_MCP_CONFIG = join(CONTEX_HOME, 'mcp-server.json')
  spawnEnv.CONTEX_MCP_TILE_TOKEN = getTileToken(req.cardId)

  const proc = spawn(codexBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: spawnEnv,
  })

  activeProcesses.set(req.cardId, proc)
  const pendingSnapshots = new Map<string, CodexFileSnapshot>()
  const aggregatedFileChanges = new Map<string, StreamToolFileChange>()
  const exploreEntries: StreamToolCommandEntry[] = []
  let assistantText = ''
  let editsStarted = false
  let exploreStarted = false
  let commandSeq = 0
  let pendingStdout = ''
  let stdoutChain = Promise.resolve()
  // Set to true after a fatal event (checkpoint failure, turn.failed, error)
  // so buffered stdout chunks are not streamed after the error chip.
  let aborted = false

  const handleCodexJsonEvent = async (evt: any): Promise<void> => {
    if (!evt || typeof evt !== 'object') return
    if (aborted) return

    // Surface turn.failed / top-level error events as explicit error chips
    if (evt.type === 'turn.failed' || evt.type === 'error') {
      const msg = evt.error?.message ?? evt.message ?? `Codex event: ${evt.type}`
      aborted = true
      sendStream(req.cardId, { type: 'error', error: String(msg) })
      return
    }

    if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
      setCardSessionId(req.cardId, req.provider, evt.thread_id)
      runtimeSession.sessionId = evt.thread_id
      void upsertRuntimeSessionState(req, runtimeSession)
      sendStream(req.cardId, { type: 'session', sessionId: evt.thread_id })
      return
    }

    if (evt.type === 'item.started') {
      const item = evt.item
      if (item?.type === 'file_change' && Array.isArray(item.changes)) {
        // Snapshot pre-edit content SYNCHRONOUSLY before awaiting anything.
        // Codex writes the files very shortly after emitting `item.started`;
        // any `await` here yields the event loop long enough for the write
        // to land, which makes before == after and produces empty (+0/-0)
        // diffs in the chat tile. Must happen before createRuntimeCheckpoint.
        const checkpointPaths: string[] = []
        for (const change of item.changes) {
          if (typeof change?.path !== 'string') continue
          const resolvedPath = resolveCodexFilePath(change.path, req.workspaceDir)
          checkpointPaths.push(resolvedPath)
          const snapshot = readSnapshotContentSync(resolvedPath)
          pendingSnapshots.set(resolvedPath, {
            displayPath: getDisplayPath(resolvedPath, req.workspaceDir),
            changeType: changeTypeFromCodexKind(change.kind),
            existed: snapshot.existed,
            content: snapshot.content,
          })
        }
        const checkpoint = await createRuntimeCheckpoint(req, 'CodexFileChange', checkpointPaths, {
          changeKinds: item.changes.map((change: { kind?: unknown }) => String(change?.kind ?? 'update')),
        })
        if (!checkpoint.ok) {
          aborted = true
          proc.kill('SIGTERM')
          sendStream(req.cardId, { type: 'error', error: `Checkpoint creation failed before Codex file changes: ${checkpoint.error ?? 'unknown error'}` })
          return
        }
      }
      return
    }

    if (evt.type !== 'item.completed') return
    const item = evt.item
    if (!item || typeof item !== 'object') return

    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
      assistantText += item.text
      sendStream(req.cardId, { type: 'text', text: item.text })
      return
    }

    if (item.type === 'command_execution' && typeof item.command === 'string') {
      const command = normalizeCodexShellCommand(item.command)
      const kind = classifyCodexCommand(command)
      const output = sanitizeToolOutputText(typeof item.aggregated_output === 'string' ? item.aggregated_output : '')
      if (kind === 'search' || kind === 'read') {
        if (!exploreStarted) {
          sendStream(req.cardId, { type: 'tool_start', toolId: 'codex-explore', toolName: 'Exploring workspace' })
          exploreStarted = true
        }
        exploreEntries.push({ label: command, command, output, kind })
        sendStream(req.cardId, {
          type: 'tool_summary',
          toolId: 'codex-explore',
          toolName: buildExploreToolName(exploreEntries),
          commandEntries: [...exploreEntries],
        })
      } else {
        // kind === 'command' — surface as its own tool block instead of
        // dropping it, so build/test/publish/dev-server steps appear inline
        // between the assistant's narration text in chronological order.
        // Each command gets a unique toolId so blocks interleave with text
        // rather than collapsing into a single aggregate chip.
        const toolId = `codex-cmd-${commandSeq++}`
        sendStream(req.cardId, { type: 'tool_start', toolId, toolName: 'exec_command' })
        sendStream(req.cardId, {
          type: 'tool_summary',
          toolId,
          toolName: 'exec_command',
          commandEntries: [{ label: command, command, output, kind: 'command' }],
        })
      }
      return
    }

    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      const fileChanges = await summarizeCodexFileChanges(item.changes, pendingSnapshots, req.workspaceDir)
      if (fileChanges.length === 0) return
      for (const change of fileChanges) {
        const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
        aggregatedFileChanges.set(key, change)
      }
      const mergedFileChanges = Array.from(aggregatedFileChanges.values())
      if (!editsStarted) {
        sendStream(req.cardId, { type: 'tool_start', toolId: 'codex-file-changes', toolName: buildEditedToolName(mergedFileChanges) })
        editsStarted = true
      }
      sendStream(req.cardId, {
        type: 'tool_summary',
        toolId: 'codex-file-changes',
        toolName: buildEditedToolName(mergedFileChanges),
        fileChanges: mergedFileChanges,
      })
    }
  }

  const BACKPRESSURE_THRESHOLD = 1024 * 1024 // 1 MB of buffered unprocessed stdout
  proc.stdout?.on('data', (chunk: Buffer) => {
    pendingStdout += chunk.toString()
    const lines = pendingStdout.split(/\r?\n/)
    pendingStdout = lines.pop() ?? ''

    // Backpressure: pause stdout when the async chain has a large backlog
    if (pendingStdout.length > BACKPRESSURE_THRESHOLD) {
      proc.stdout?.pause()
    }

    stdoutChain = stdoutChain.then(async () => {
      for (const line of lines) {
        if (aborted) break
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const evt = JSON.parse(trimmed)
          await handleCodexJsonEvent(evt)
        } catch {
          if (!aborted) sendStream(req.cardId, { type: 'text', text: `${line}\n` })
        }
      }
    }).catch(() => {}).finally(() => {
      // Resume reading after the chain drains below threshold
      if (pendingStdout.length <= BACKPRESSURE_THRESHOLD) {
        proc.stdout?.resume()
      }
    })
  })

  const MAX_STDERR = 64 * 1024 // 64 KB cap
  let stderrBuf = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString()
    if (stderrBuf.length > MAX_STDERR) stderrBuf = stderrBuf.slice(-MAX_STDERR)
  })

  // H-9: identity-guard — only clean up and emit done/error if this proc is
  // still the active one. A rapid re-send replaces activeProcesses[cardId]
  // before the old proc's close handler fires; without this guard the old
  // handler would delete the new proc's entry and inject stale done/error
  // events into the new turn.
  const isCurrent = (): boolean => activeProcesses.get(req.cardId) === proc

  proc.on('close', (code) => {
    if (!isCurrent()) return // superseded — new turn owns the slot
    if (aborted) {
      activeProcesses.delete(req.cardId)
      return
    }
    activeProcesses.delete(req.cardId)
    stdoutChain = stdoutChain.then(async () => {
      if (pendingStdout.trim()) {
        try {
          await handleCodexJsonEvent(JSON.parse(pendingStdout.trim()))
        } catch {
          assistantText += pendingStdout
          sendStream(req.cardId, { type: 'text', text: pendingStdout })
        }
      }
      if (assistantText.trim()) {
        runtimeSession.messages = [
          ...runtimeMessages,
          { role: 'assistant', content: assistantText },
        ]
      }
      runtimeSession.sessionId = getCardSessionId(req.cardId, req.provider) ?? runtimeSession.sessionId
      runtimeSession.isStreaming = false
      void upsertRuntimeSessionState(req, runtimeSession)
      if (code !== 0 && stderrBuf.trim()) {
        sendStream(req.cardId, { type: 'error', error: stderrBuf.trim() })
      }
      sendStream(req.cardId, { type: 'done', sessionId: runtimeSession.sessionId ?? undefined })
    }).catch(() => {
      if (assistantText.trim()) {
        runtimeSession.messages = [
          ...runtimeMessages,
          { role: 'assistant', content: assistantText },
        ]
      }
      runtimeSession.sessionId = getCardSessionId(req.cardId, req.provider) ?? runtimeSession.sessionId
      runtimeSession.isStreaming = false
      void upsertRuntimeSessionState(req, runtimeSession)
      if (code !== 0 && stderrBuf.trim()) {
        sendStream(req.cardId, { type: 'error', error: stderrBuf.trim() })
      }
      sendStream(req.cardId, { type: 'done', sessionId: runtimeSession.sessionId ?? undefined })
    })
  })

  proc.on('error', (err) => {
    if (!isCurrent()) return // superseded — new turn owns the slot
    activeProcesses.delete(req.cardId)
    runtimeSession.isStreaming = false
    void upsertRuntimeSessionState(req, runtimeSession)
    sendStream(req.cardId, { type: 'error', error: err.message.includes('ENOENT')
      ? 'Codex CLI not found. Install: npm install -g @openai/codex'
      : err.message })
  })
}