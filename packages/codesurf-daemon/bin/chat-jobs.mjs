import { query } from '@anthropic-ai/claude-agent-sdk'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { buildMemoryPrompt, loadMemoryContext } from './memory-loader.mjs'
import { buildContextBucketBundle, describeContextBucketsForTool } from './context-buckets.mjs'
import { applyProjectContextPolicy } from './project-context.mjs'
import {
  CODEX_SDK_UNAVAILABLE_CODE,
  buildCodexSdkThreadOptions,
  createCodexSdkClient,
  shouldUseCodexSdkProvider,
  startCodexSdkThread,
} from './codex-sdk-provider.mjs'
import {
  resolveAgentToolAllowList,
  codexSandboxApprovalFlags,
  hermesToolsetsFromAllowList,
  agentModeUnresolved,
  AGENT_MODE_UNRESOLVED_ERROR,
} from './agent-mode-tools.mjs'
import { resolveAuthoritativeAgentMode } from './agent-mode-resolver.mjs'
import {
  OMNIGENT_DEFAULT_BASE_URL,
  OMNIGENT_DEFAULT_CLI,
  buildOmnigentSessionBody,
  chooseOmnigentHost,
  decodeOmnigentModelId,
  extractOmnigentSessionId,
  mapOmnigentStreamEvent,
  normalizeOmnigentServerRoot,
  omnigentAuthHeaders,
  omnigentEndpointUrl,
  parseOmnigentHosts,
  parseOmnigentServerUrl,
  parseOmnigentSseChunk,
  parseOmnigentStatusJson,
} from './omnigent-provider.mjs'

const execFileAsync = promisify(execFile)

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
}

// The Claude Agent SDK persists each session's transcript at
//   <CLAUDE_CONFIG_DIR|~/.claude>/projects/<encoded-cwd>/<sessionId>.jsonl
// where <encoded-cwd> is the realpath-resolved cwd with every non-alphanumeric
// char replaced by '-' (long paths get a hash suffix). Resuming with a
// sessionId that has NO such transcript — e.g. a foreign codex/UUIDv7 thread id
// handed over after a provider switch, or a stale id — makes the SDK return
// num_turns:0 with zero assistant content, surfacing as an empty reply.
//
// Defense-in-depth guard: confirm a real transcript exists before we set the
// SDK `resume` option. We scan every project dir for `<sessionId>.jsonl`
// (size > 0) rather than reconstruct the encoded-cwd key, which sidesteps the
// SDK's realpath + NFC + hash-suffix encoding entirely. Foreign ids have no
// transcript anywhere → returns null → caller starts a fresh turn (model runs
// normally) instead of resuming a non-existent session. A valid same-provider
// Claude id always has its transcript on disk → resume is preserved.
function claudeProjectsDir() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return join(configDir, 'projects')
}

function findClaudeResumeTranscript(sessionId) {
  if (typeof sessionId !== 'string') return null
  const id = sessionId.trim()
  if (!id) return null
  // Reject anything that could escape the projects tree; real Claude session
  // ids are UUIDs and never contain path separators.
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return null

  const projectsDir = claudeProjectsDir()
  const fileName = `${id}.jsonl`
  let entries
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const candidate = join(projectsDir, entry.name, fileName)
    try {
      if (statSync(candidate).size > 0) return candidate
    } catch {
      // not in this project dir — keep scanning
    }
  }
  return null
}

function readPermissionGrants(homeDir) {
  try {
    const raw = JSON.parse(readFileSync(join(homeDir, 'permissions.json'), 'utf8'))
    const grants = Array.isArray(raw?.grants) ? raw.grants : []
    const now = Date.now()
    return grants.map(grant => {
      if (!grant || typeof grant !== 'object') return false
      if (grant.action !== 'allow' && grant.action !== 'deny') return false
      if (typeof grant.provider !== 'string' || typeof grant.toolName !== 'string') return false
      if (!['session', 'today', 'forever', 'never'].includes(grant.scope)) return false
      if (grant.expiresAt) {
        const expiry = Date.parse(grant.expiresAt)
        if (Number.isFinite(expiry) && expiry <= now) return false
      }
      return {
        ...grant,
        workspaceDir: normalizeWorkspaceDir(grant.workspaceDir),
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

function writePermissionGrants(homeDir, grants) {
  ensureDir(homeDir)
  const filePath = join(homeDir, 'permissions.json')
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`, 'utf8')
  renameSync(tempPath, filePath)
}

function normalizeWorkspaceDir(workspaceDir) {
  const trimmed = String(workspaceDir ?? '').trim()
  if (!trimmed) return null
  try {
    return resolve(trimmed)
  } catch {
    return trimmed
  }
}

function endOfTodayIso() {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return end.toISOString()
}

function makePermissionGrantId() {
  return `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function samePermissionTarget(grant, { provider, toolName, workspaceDir }) {
  const normalizedWorkspace = normalizeWorkspaceDir(workspaceDir)
  return grant.provider === provider
    && grant.toolName === toolName
    && (grant.workspaceDir ?? null) === normalizedWorkspace
}

function permissionAppliesToRequest(grant, { provider, toolName, workspaceDir }) {
  if (grant.provider !== provider || grant.toolName !== toolName) return false
  const grantWorkspace = normalizeWorkspaceDir(grant.workspaceDir)
  if (grantWorkspace === null) return true
  return grantWorkspace === normalizeWorkspaceDir(workspaceDir)
}

function resolvePersistedPermissionGrant(homeDir, request) {
  const grant = readPermissionGrants(homeDir).find(candidate => permissionAppliesToRequest(candidate, request))
  return grant?.action === 'allow' || grant?.action === 'deny' ? grant.action : null
}

function buildPermissionGrant(request, scope) {
  return {
    id: makePermissionGrantId(),
    provider: request.provider,
    toolName: request.toolName,
    action: scope === 'never' ? 'deny' : 'allow',
    scope,
    workspaceDir: normalizeWorkspaceDir(request.workspaceDir),
    title: request.title ?? null,
    description: request.description ?? null,
    blockedPath: request.blockedPath ?? null,
    createdAt: new Date().toISOString(),
    expiresAt: scope === 'today' ? endOfTodayIso() : null,
  }
}

function persistPermissionGrant(homeDir, request, scope) {
  const grant = buildPermissionGrant(request, scope)
  const grants = readPermissionGrants(homeDir).filter(existing => !samePermissionTarget(existing, request))
  writePermissionGrants(homeDir, [grant, ...grants])
  return grant
}

function normalizePath(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

function sanitizeToolOutputText(text) {
  if (!text) return ''
  return String(text)
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

function sanitizeCodexStderrText(text) {
  const cleaned = sanitizeToolOutputText(text)
  if (!cleaned) return ''

  return cleaned
    .split('\n')
    .filter(line => {
      const trimmed = line.trim()
      return trimmed.length > 0 && trimmed !== 'Reading additional input from stdin...'
    })
    .join('\n')
    .trim()
}

function sanitizeClaudeStderrText(text) {
  if (!text) return ''
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0)
    .join('\n')
    .trim()
}

function sanitizeAgentCliDiagnostic(message) {
  const secretName = String.raw`[A-Z0-9_./-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_./-]*`
  const quotedOrBareValue = String.raw`(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)`
  return String(message ?? '')
    .replace(new RegExp(`\\b(${secretName})\\s*=\\s*${quotedOrBareValue}`, 'gi'), '$1=[REDACTED]')
    .replace(/\b(authorization\s*:\s*(?:bearer|token)\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi, '$1[REDACTED]')
    .replace(/\b(api\s*key|api[_-]?key|token|secret|password)\s*:\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi, '$1: [REDACTED]')
}

function formatClaudeSdkError(error, stderrText) {
  const message = error instanceof Error ? error.message : String(error)
  const stderr = sanitizeClaudeStderrText(stderrText)
  if (!stderr) return message
  if (message && stderr.includes(message)) return stderr.slice(-6000)
  return `${message}\n\nClaude Code stderr:\n${stderr}`.slice(-6000)
}

function normalizeCodexShellCommand(command) {
  const trimmed = String(command ?? '').trim()
  const quotedMatch = trimmed.match(/^\/bin\/zsh -lc '([\s\S]*)'$/)
  if (quotedMatch) return quotedMatch[1].replace(/'\\''/g, "'")
  const plainMatch = trimmed.match(/^\/bin\/zsh -lc (.+)$/)
  if (plainMatch) return plainMatch[1].trim()
  return trimmed
}

function classifyCodexCommand(command) {
  const normalized = command.trim()
  if (/(^|\s)(rg|grep|fd|findstr)\b/.test(normalized)) return 'search'
  if (/(^|\s)(cat|sed|head|tail|less|more|bat|ls)\b/.test(normalized)) return 'read'
  return 'command'
}

function buildExploreToolName(entries) {
  const readCount = entries.filter(entry => entry.kind === 'read').length
  const searchCount = entries.filter(entry => entry.kind === 'search').length
  const labelParts = []
  if (readCount > 0) labelParts.push(`${readCount} file${readCount === 1 ? '' : 's'}`)
  if (searchCount > 0) labelParts.push(`${searchCount} search${searchCount === 1 ? '' : 'es'}`)
  return labelParts.length > 0 ? `Explored ${labelParts.join(', ')}` : 'Explored workspace'
}

function buildEditedToolName(fileChanges) {
  return `Edited ${fileChanges.length} file${fileChanges.length === 1 ? '' : 's'}`
}

const CLAUDE_CHECKPOINT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function isClaudeCheckpointTool(toolName) {
  return CLAUDE_CHECKPOINT_TOOLS.has(String(toolName ?? ''))
}

function buildCheckpointLabel(toolName, filePaths, workspaceDir) {
  if (filePaths.length === 0) return `Before ${toolName}`
  if (filePaths.length === 1) return `Before ${toolName} ${getDisplayPath(filePaths[0], workspaceDir)}`
  return `Before ${toolName} (${filePaths.length} files)`
}

function buildCheckpointSummary(toolName, filePaths, workspaceDir) {
  const displayPaths = filePaths.slice(0, 2).map(filePath => getDisplayPath(filePath, workspaceDir))
  const suffix = filePaths.length > 2 ? ` +${filePaths.length - 2} more` : ''
  return `Saved checkpoint before ${toolName}${displayPaths.length > 0 ? ` for ${displayPaths.join(', ')}${suffix}` : ''}`
}

function buildRuntimeSessionEntryId(request, job) {
  const cardId = String(request?.cardId ?? '').trim()
  if (cardId) return `codesurf-runtime:${cardId}`
  return `codesurf-job:${job.id}`
}

function extractAnthropicCheckpointPaths(toolName, input, workspaceDir) {
  const source = input && typeof input === 'object' ? input : {}
  const resolveFile = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null
    return resolveCodexFilePath(value, workspaceDir)
  }

  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    const filePath = resolveFile(source.file_path)
    return filePath ? [filePath] : []
  }

  if (toolName === 'NotebookEdit') {
    const filePath = resolveFile(source.notebook_path) ?? resolveFile(source.file_path)
    return filePath ? [filePath] : []
  }

  return []
}

function extractCodexCheckpointPaths(changes, workspaceDir) {
  const paths = []
  const seen = new Set()
  const pathFields = [
    'path',
    'previousPath',
    'previous_path',
    'oldPath',
    'old_path',
    'from',
    'sourcePath',
    'source_path',
  ]
  for (const change of Array.isArray(changes) ? changes : []) {
    for (const field of pathFields) {
      if (typeof change?.[field] !== 'string') continue
      const resolvedPath = resolveCodexFilePath(change[field], workspaceDir)
      if (seen.has(resolvedPath)) continue
      seen.add(resolvedPath)
      paths.push(resolvedPath)
    }
  }
  return paths
}

function countDiffStats(diff) {
  let additions = 0
  let deletions = 0
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) additions += 1
    if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions }
}

function changeTypeFromCodexKind(kind) {
  if (kind === 'add' || kind === 'delete' || kind === 'move') return kind
  return 'update'
}

function mergeFileChanges(fileChanges) {
  const merged = new Map()
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

function normalizeTaskLabel(value, maxLength = 88) {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return null
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized
}

function extractTaskLabelFromContent(content) {
  if (typeof content === 'string') return normalizeTaskLabel(content)
  if (Array.isArray(content)) {
    for (const entry of content) {
      const nested = extractTaskLabelFromContent(entry)
      if (nested) return nested
    }
    return null
  }
  if (content && typeof content === 'object') {
    if (typeof content.text === 'string') return normalizeTaskLabel(content.text)
    if (typeof content.content === 'string') return normalizeTaskLabel(content.content)
    if (Array.isArray(content.content)) return extractTaskLabelFromContent(content.content)
  }
  return null
}

function extractTaskLabelFromRequest(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  for (const message of messages) {
    if (String(message?.role ?? '').trim() !== 'user') continue
    const label = extractTaskLabelFromContent(message?.content)
    if (label) return label
  }
  return `${String(request?.provider ?? 'agent').trim() || 'Agent'} task`
}

async function readSnapshotContent(filePath) {
  try {
    const buffer = await fs.readFile(filePath)
    if (buffer.includes(0)) return { existed: true, content: null }
    return { existed: true, content: buffer.toString('utf8') }
  } catch {
    return { existed: false, content: null }
  }
}

function getDisplayPath(filePath, workspaceDir) {
  const resolvedPath = resolve(filePath)
  const resolvedWorkspace = workspaceDir ? resolve(workspaceDir) : ''
  if (resolvedWorkspace && (resolvedPath === resolvedWorkspace || resolvedPath.startsWith(`${resolvedWorkspace}${sep}`))) {
    const rel = relative(resolvedWorkspace, resolvedPath)
    return rel || resolvedPath.split(sep).pop() || resolvedPath
  }
  return resolvedPath
}

function resolveCodexFilePath(filePath, workspaceDir) {
  if (workspaceDir && !String(filePath).startsWith('/')) return resolve(workspaceDir, filePath)
  return resolve(String(filePath))
}

function normalizeNoIndexDiffPaths(diff, beforePath, afterPath, displayPath) {
  let normalized = String(diff ?? '')
  if (beforePath) normalized = normalized.split(beforePath).join(`a/${displayPath}`)
  if (afterPath) normalized = normalized.split(afterPath).join(`b/${displayPath}`)
  return normalized.trim()
}

async function buildSnapshotDiff(before, currentPath) {
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
      if (error?.code === 1) {
        diff = error.stdout || error.stderr || ''
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

async function summarizeCodexFileChanges(changes, snapshots, workspaceDir) {
  const fileChanges = []
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

async function runGit(args, cwd) {
  const result = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 1024 * 1024 * 8,
  })
  return (result.stdout || '').trim()
}

async function ensureProvisionedWorkspace(homeDir, projectContext) {
  const explicitWorkspace = normalizePath(projectContext?.workspaceDir)
  if (explicitWorkspace && existsSync(explicitWorkspace)) {
    return explicitWorkspace
  }

  const gitRemoteUrl = String(projectContext?.gitRemoteUrl ?? '').trim()
  if (!gitRemoteUrl) {
    throw new Error('Workspace path is unavailable on this host and no git remote was provided')
  }

  const repoNameRaw = String(projectContext?.repoName ?? basename(gitRemoteUrl.replace(/\.git$/i, '')) ?? 'project').trim()
  const repoName = repoNameRaw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  const slug = `${repoName}-${createHash('sha1').update(gitRemoteUrl).digest('hex').slice(0, 10)}`
  const workspaceDir = join(homeDir, 'remote-projects', slug)
  const branch = String(projectContext?.gitBranch ?? '').trim()

  ensureDir(join(homeDir, 'remote-projects'))

  if (!existsSync(join(workspaceDir, '.git'))) {
    await execFileAsync('git', ['clone', gitRemoteUrl, workspaceDir], { maxBuffer: 1024 * 1024 * 8 })
  } else {
    await runGit(['remote', 'set-url', 'origin', gitRemoteUrl], workspaceDir).catch(() => {})
    await runGit(['fetch', 'origin', '--prune'], workspaceDir).catch(() => {})
  }

  if (branch) {
    await runGit(['fetch', 'origin', branch, '--prune'], workspaceDir).catch(() => {})
    const localBranches = await runGit(['branch', '--list', branch], workspaceDir).catch(() => '')
    if (localBranches.trim()) {
      await runGit(['checkout', branch], workspaceDir)
    } else {
      await runGit(['checkout', '-B', branch, `origin/${branch}`], workspaceDir).catch(async () => {
        await runGit(['checkout', '-B', branch], workspaceDir)
      })
    }
  }

  return workspaceDir
}

function buildClaudeSystemPrompt(peers) {
  if (!Array.isArray(peers) || peers.length === 0) return undefined
  const peerLines = peers.map(peer => {
    const lines = []
    if (Array.isArray(peer.tools) && peer.tools.length > 0) {
      lines.push(`  Tools: ${peer.tools.join(', ')}`)
    }
    if (peer.context && typeof peer.context === 'object') {
      lines.push('  Context:')
      for (const [key, value] of Object.entries(peer.context)) {
        const display = value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value)
        lines.push(`    ${key}: ${display}`)
      }
    }
    if (lines.length === 0) lines.push('  (no additional peer context)')
    return `- Block "${peer.peerId}" (${peer.peerType}):\n${lines.join('\n')}`
  }).join('\n')

  return [
    'You are an AI agent running inside CodeSurf.',
    '',
    'The following peer blocks are directly connected to you on the canvas:',
    peerLines,
  ].join('\n')
}

function buildAsyncExecutionPrompt(asyncExecution) {
  if (!asyncExecution || typeof asyncExecution !== 'object') return undefined

  const lines = [
    '## Async Execution',
    `- Active execution backend: ${String(asyncExecution.backend ?? 'unknown')} (${String(asyncExecution.hostLabel ?? 'unknown host')}).`,
  ]

  if (asyncExecution.providerNativeBackground) {
    lines.push('- Provider-native background agents may be available. Prefer them for subagents or delegated work when that keeps the main conversation responsive.')
  }

  if (asyncExecution.detachedDaemonAvailable) {
    lines.push('- CodeSurf also supports daemon-backed detached jobs that can continue outside the foreground chat.')
  }

  if (asyncExecution.requestedRunMode === 'background') {
    lines.push('- This turn is running as a detached background orchestration job. Continue autonomously and do not wait for interactive clarification from the foreground chat unless blocked.')
  } else if (asyncExecution.detachedDaemonAvailable) {
    lines.push('- If the user wants the main conversation to stay free while work continues, prefer detached daemon orchestration for the main task thread.')
  }

  return lines.join('\n')
}

function joinPromptSections(...sections) {
  const normalized = sections
    .map(section => String(section ?? '').trim())
    .filter(Boolean)
  return normalized.length > 0 ? normalized.join('\n\n') : undefined
}

const CODESURF_INSIGHT_CONVENTION = [
  '## CodeSurf Insight Convention',
  '',
  'Use an Insight block when you notice a non-obvious constraint, risk, hidden dependency, or design implication that the user should understand before trusting the answer.',
  'Do not emit an Insight block for routine summaries, obvious statements, or tiny mechanical edits.',
  '',
  'When you emit one, use this exact wrapper:',
  '`★ Insight ─────────────────────────────────────`',
  '- [point 1]',
  '- [point 2]',
  '`─────────────────────────────────────────────────`',
  '',
  'Keep it to 1–2 bullets. It must explain non-obvious reasoning, not summarize the work.',
].join('\n')

function buildCodeSurfInsightConvention() {
  return CODESURF_INSIGHT_CONVENTION
}

const CODESURF_ACTIVITY_CONVENTION = [
  '## CodeSurf Activity Convention',
  '',
  'Keep your native agent instructions, tools, and strengths. This convention only standardizes what CodeSurf can show to the user.',
  '',
  'For non-trivial multi-step work, keep a visible task plan current using your native todo/plan tool when one is available.',
  'If the native environment does not expose a todo/plan tool, use concise natural-language progress updates instead of inventing unavailable tools.',
  '',
  'Use neutral tool/action language. Avoid provider-specific status phrasing when a plain action name is enough.',
  'Prefer short completion wording unless the task needs a structured handoff.',
].join('\n')

function buildCodeSurfActivityConvention() {
  return CODESURF_ACTIVITY_CONVENTION
}

function summarizeMemoryContext(contextBuckets, instructionPrompt) {
  return describeContextBucketsForTool(contextBuckets, instructionPrompt).summary
}

function buildMemoryContextInput(contextBuckets, instructionPrompt) {
  return describeContextBucketsForTool(contextBuckets, instructionPrompt).input
}

// The selected agent definition's persona prompt (AgentMode.systemPrompt). Sits
// at the front of the assembled system prompt — ahead of memory/skills/async —
// so the persona frames the turn the same way for every provider. Empty/missing
// systemPrompt contributes nothing (joinPromptSections drops blank sections).
function agentPersonaPrompt(request) {
  return String(request?.agentMode?.systemPrompt ?? '').trim() || undefined
}

function buildClaudeAgentPrompt(peers, asyncExecution, instructionPrompt, skillsPrompt, agentPrompt) {
  const peerPrompt = buildClaudeSystemPrompt(peers)
  const asyncPrompt = buildAsyncExecutionPrompt(asyncExecution)
  const insightConvention = buildCodeSurfInsightConvention()
  const activityConvention = buildCodeSurfActivityConvention()
  return joinPromptSections(peerPrompt, agentPrompt, instructionPrompt, skillsPrompt, asyncPrompt, insightConvention, activityConvention)
}

function buildCodexPrompt(userText, asyncExecution, instructionPrompt, skillsPrompt, agentPrompt) {
  const asyncPrompt = buildAsyncExecutionPrompt(asyncExecution)
  const insightConvention = buildCodeSurfInsightConvention()
  const activityConvention = buildCodeSurfActivityConvention()
  const preamble = joinPromptSections(agentPrompt, instructionPrompt, skillsPrompt, asyncPrompt, insightConvention, activityConvention)
  return preamble ? `${preamble}\n\n## User Request\n${userText}` : userText
}

// --- Omnigent wire helpers (used by runOmnigentJob) ----------------------
// Side-effecting fetch/CLI glue lives here at module scope; the pure parsing
// lives in omnigent-provider.mjs so it can be unit tested without this file's
// Claude-SDK import. Mirrors how runCodexSdkJob leans on codex-sdk-provider.mjs.

// Per-turn upper bound on a stalled stream/fetch (mirrors the CLI provider's
// DEFAULT_TIMEOUT_MS). The live SSE tail never closes per turn, so without this
// a stalled backend would hang the job forever.
const OMNIGENT_TURN_TIMEOUT_MS = 30 * 60 * 1000

async function omnigentFetchJson(baseUrl, path, apiKey, init = {}) {
  const response = await fetch(omnigentEndpointUrl(baseUrl, path), {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...omnigentAuthHeaders(apiKey),
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `${path} returned HTTP ${response.status}`)
  }
  return response.json()
}

// Best-effort `omni server start`. Idempotent in practice: when a server is
// already running the CLI reports the live URL rather than erroring. The abort
// signal is wired into execFile so cancelling the job (or the turn timeout)
// kills the spawned start child instead of leaking it until its own timeout.
async function startLocalOmnigentServer(cli, signal) {
  const command = String(cli ?? '').trim() || OMNIGENT_DEFAULT_CLI
  const { stdout = '', stderr = '' } = await execFileAsync(command, ['server', 'start'], {
    encoding: 'utf8',
    timeout: 60_000,
    ...(signal ? { signal } : {}),
  })
  const combined = `${stdout}${stderr ? `\n${stderr}` : ''}`
  const fromStart = parseOmnigentServerUrl(combined)
  if (fromStart) return fromStart
  const status = parseOmnigentStatusJson(combined)
  if (status?.running && status.url) return normalizeOmnigentServerRoot(status.url)
  return null
}

async function resolveOmnigentAgentId(modelId, settings, baseUrl, apiKey, signal) {
  const fromModel = decodeOmnigentModelId(modelId)
  if (fromModel) return fromModel
  const configured = String(settings?.agentId ?? '').trim()
  if (configured) return configured
  const payload = await omnigentFetchJson(baseUrl, '/v1/agents?limit=100&order=asc', apiKey, signal ? { signal } : {})
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.agents)
        ? payload.agents
        : []
  const first = rows.find(row => typeof row?.id === 'string' && row.id.trim())
  if (!first) throw new Error('Omnigent returned no agents from /v1/agents; configure settings.omnigent.agentId.')
  return first.id.trim()
}

// Resolve the runner host_id to bind a new Omnigent session to. Without it the
// backend never launches a runner and every turn fails with runner_unavailable
// ("No runner bound for session"). settings.hostId wins (operator pin); else GET
// /v1/hosts and auto-pick the first online host (first host if none report
// status), mirroring the CLI provider. FAIL CLOSED on zero hosts: throw a clear
// error rather than create a session that is guaranteed to fail at turn time.
async function resolveOmnigentHostId(settings, baseUrl, apiKey, signal) {
  const configured = String(settings?.hostId ?? '').trim()
  if (configured) return configured
  const payload = await omnigentFetchJson(baseUrl, '/v1/hosts', apiKey, signal ? { signal } : {})
  const hosts = parseOmnigentHosts(payload)
  if (hosts.length === 0) {
    throw new Error('Omnigent returned no runner hosts from /v1/hosts; no runner host is registered. Start a runner host (or set settings.omnigent.hostId) before creating a session.')
  }
  const chosen = chooseOmnigentHost(hosts)
  if (!chosen?.id) throw new Error('Omnigent /v1/hosts returned hosts without a usable id.')
  return chosen.id
}

/** Claude SDK sessions are UUID v4; Codex/Omnigent thread ids are v7. Reject foreign ids. */
function isValidClaudeResumeSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return false
  const match = sessionId.trim().match(
    /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])([0-9a-f]{3})-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  if (!match) return false
  return parseInt(match[1], 16) === 4
}

function resolveClaudeResumeSessionId(sessionId) {
  return isValidClaudeResumeSessionId(sessionId) ? sessionId : undefined
}

function omnigentTitleFromPrompt(text) {
  const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!oneLine) return 'CodeSurf session'
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine
}

// Build the `codex exec` argv for a request. Pure + exported so the daemon test
// can assert AgentMode.tools constrains the constructed command. Codex's CLI has
// no per-tool allow-list, so the allow-list maps onto the sandbox (the only real
// toolset lever): when it grants no write-capable tool, force read-only.
export function buildCodexExecArgs(request, workspaceDir, instructionPrompt = '') {
  const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
  const codexMode = ['default', 'auto', 'read-only', 'full-access'].includes(request.mode)
    ? request.mode
    : 'default'
  // Per-mode sandbox + approval policy (and write-free allow-list → read-only).
  // THROWS CODEX_DENY_ALL_ERROR for an explicit deny-all ([]) — runCodexJob
  // catches it and surfaces the error instead of spawning Codex (fail closed).
  const sandboxApprovalFlags = codexSandboxApprovalFlags(codexMode, resolveAgentToolAllowList(request.agentMode))
  // Multi-turn continuity: when the request carries the Codex thread id from a
  // prior turn (emitted as a `thread.started` session event and echoed back by
  // the client as request.sessionId), resume that thread so the model keeps the
  // full conversation — `codex exec [OPTIONS] resume <threadId> [PROMPT]`.
  // Codex's CLI grammar requires every exec-level OPTION (--json, --model,
  // --skip-git-repo-check, -C <dir>, sandbox/approval flags) to precede the
  // `resume` subcommand; only SESSION_ID and PROMPT follow it. Placing `resume`
  // before the options makes codex reject the trailing flags (e.g.
  // `error: unexpected argument '-C' found`). Mirrors the runtime builder
  // (src/main/chat/providers/agent-mode-payloads.ts buildCodexSpawnArgs).
  // First turn (no sessionId) starts a fresh thread (unchanged behavior).
  const resumeArgs = request.sessionId ? ['resume', request.sessionId] : []
  const codexArgs = [
    'exec',
    '--json',
    '--model',
    request.model,
    '--skip-git-repo-check',
    ...(workspaceDir ? ['-C', workspaceDir] : []),
    ...sandboxApprovalFlags,
    ...resumeArgs,
  ]
  codexArgs.push(buildCodexPrompt(
    lastUserMsg?.content ?? '',
    request.asyncExecution,
    instructionPrompt,
    request.skillsPrompt,
    agentPersonaPrompt(request),
  ))
  return codexArgs
}

// Providers the @ai-sdk/harness backend can host. Module-level mirror of the
// closure-local set, so shouldUseHarness() stays a pure, exported predicate.
const HARNESS_CAPABLE_PROVIDERS = new Set(['claude', 'codex', 'pi'])

// Decide whether a request routes through the harness backend vs a native
// provider path. Pure + exported so the daemon test can assert the routing
// decision without spawning a job. Three exclusions, in order:
//   1. Codex NEVER uses the harness — its adapter can't honor CodeSurf's 4
//      permission modes (it hardcodes danger-full-access). Native `codex exec`
//      honors them; runJob routes Codex to runCodexJob. (Pre-existing.)
//   2. CONTINUITY STOPGAP: foreground (interactive, multi-turn) Claude chat
//      must NOT use the harness. The harness createSession()s without a
//      resumeFrom payload and destroy()s after each turn (discarding
//      resumability), and emits its OWN session id — not the Claude SDK
//      conversation id — so a later turn can't resume the prior context from
//      either side. Result: turn 2 loses all history. The native runClaudeJob
//      path resumes correctly via { resume: request.sessionId } and persists a
//      resumable SDK session, so foreground Claude falls back to it. Gated on
//      runMode so BACKGROUND dispatched Claude runs keep the harness's worktree
//      isolation (single-shot autonomous tasks, not interactive multi-turn).
//      runMode is stable per-conversation (absent ⇒ foreground, matching the
//      existing canUseTool gate). Tradeoff: foreground Claude forgoes harness
//      worktree isolation — runClaudeJob still enforces agentMode.tools (SDK
//      `tools`), permissions (canUseTool), and checkpoints.
export function shouldUseHarness(request) {
  if (request?.useHarness !== true) return false
  if (!HARNESS_CAPABLE_PROVIDERS.has(request.provider)) return false
  if (request.provider === 'codex') return false
  if (request.provider === 'claude' && request.runMode !== 'background') return false
  return true
}

// Resolve the Hermes `--toolsets` value for a request. AgentMode.tools (when
// present) maps onto Hermes' coarse toolset categories and takes precedence over
// the explicit toolsets / mode mapping. Pure + exported for the daemon test.
export function hermesToolsetsForRequest(request) {
  const fromAllowList = hermesToolsetsFromAllowList(resolveAgentToolAllowList(request.agentMode))
  if (fromAllowList != null) return fromAllowList

  const explicitToolsets = Array.isArray(request.toolsets)
    ? request.toolsets.filter(Boolean).join(',')
    : String(request.toolsets ?? '').trim()
  if (explicitToolsets) return explicitToolsets

  const modeMap = {
    full: 'terminal,file,web,browser',
    terminal: 'terminal,file',
    web: 'web,browser',
    query: '',
  }
  return modeMap[request.mode ?? ''] ?? 'terminal,file,web'
}

function pushOpenCodeFlag(args, flag, value) {
  const str = String(value ?? '').trim()
  if (!str) return
  args.push(flag, str)
}

function buildOpenCodeRunArgs(request) {
  const args = ['run', '--format', 'json']
  pushOpenCodeFlag(args, '--model', request.model)
  pushOpenCodeFlag(args, '--agent', request.agent)
  pushOpenCodeFlag(args, '--session', request.sessionId)
  pushOpenCodeFlag(args, '--dir', request.cwd)
  if (request.bypassPermissions) args.push('--dangerously-skip-permissions')
  args.push(request.prompt)
  return args
}

const HERMES_MODEL_PROVIDER_PREFIXES = {
  anthropic: 'anthropic',
  arcee: 'arcee',
  'arcee-ai': 'arcee',
  copilot: 'copilot',
  'copilot-acp': 'copilot-acp',
  gemini: 'gemini',
  google: 'gemini',
  huggingface: 'huggingface',
  'kimi-coding': 'kimi-coding',
  'kimi-coding-cn': 'kimi-coding-cn',
  kilocode: 'kilocode',
  minimax: 'minimax',
  'minimax-cn': 'minimax-cn',
  nous: 'nous',
  nvidia: 'nvidia',
  'ollama-cloud': 'ollama-cloud',
  openai: 'openai',
  'openai-codex': 'openai-codex',
  openrouter: 'openrouter',
  stepfun: 'stepfun',
  'x-ai': 'xai',
  xai: 'xai',
  xiaomi: 'xiaomi',
  'z-ai': 'zai',
  zai: 'zai',
}

function resolveHermesModelSelection(model, provider) {
  const rawModel = String(model ?? '').trim()
  const explicitProvider = String(provider ?? '').trim()
  if (!rawModel) return { model: null, provider: explicitProvider || null }
  if (explicitProvider) return { model: rawModel, provider: explicitProvider }

  const slashIndex = rawModel.indexOf('/')
  if (slashIndex <= 0) return { model: rawModel, provider: null }

  const prefix = rawModel.slice(0, slashIndex).trim().toLowerCase()
  const remainder = rawModel.slice(slashIndex + 1).trim()
  const inferredProvider = HERMES_MODEL_PROVIDER_PREFIXES[prefix]
  if (!inferredProvider || !remainder) return { model: rawModel, provider: null }
  return { model: remainder, provider: inferredProvider }
}

function buildHermesChatArgs(request) {
  const args = ['chat', '--query', request.prompt, '--quiet', '--source', 'tool']
  const selection = resolveHermesModelSelection(request.model, request.provider)
  pushOpenCodeFlag(args, '--model', selection.model)
  pushOpenCodeFlag(args, '--provider', selection.provider)
  pushOpenCodeFlag(args, '--toolsets', Array.isArray(request.toolsets) ? request.toolsets.join(',') : request.toolsets)
  pushOpenCodeFlag(args, '--resume', request.resumeSessionId)
  if (request.ignoreRules) args.push('--ignore-rules')
  if (request.bypassPermissions) args.push('--yolo')
  return args
}

function parseHermesOutput(stdout) {
  let sessionId = null
  const textLines = []
  for (const line of String(stdout ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^\s*(?:session_id|session)\s*:\s*(.+?)\s*$/i)
    if (match) {
      if (!sessionId) sessionId = match[1].trim()
      continue
    }
    textLines.push(line)
  }
  return {
    sessionId,
    text: textLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  }
}

function extractAgentSessionId(value) {
  if (!value || typeof value !== 'object') return null
  const candidates = [
    value.sessionId,
    value.session_id,
    value.sessionID,
    value.thread_id,
    value.result?.sessionId,
    value.result?.session_id,
    value.result?.sessionID,
  ]
  if (value.type === 'session' || value.type === 'thread.started') {
    candidates.push(value.id)
  }
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
  }
  return null
}

function extractAgentContentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      return typeof part.text === 'string'
        ? part.text
        : typeof part.content === 'string'
          ? part.content
          : ''
    })
    .filter(Boolean)
    .join('')
}

function extractOpenCodeTextPayload(event) {
  if (!event || typeof event !== 'object') return ''
  if (typeof event.result === 'string') return event.result
  if (typeof event.text === 'string' && (event.role === 'assistant' || event.type === 'assistant')) return event.text
  if (typeof event.message === 'string' && (event.role === 'assistant' || event.type === 'assistant')) return event.message
  if (event.type === 'message' && event.role === 'assistant') return extractAgentContentText(event.content)
  if (event.role === 'assistant') return extractAgentContentText(event.content)
  if (event.type === 'assistant') return extractAgentContentText(event.message?.content ?? event.content)
  return ''
}

function writeSseEvent(res, payload) {
  // Isolate per-subscriber failures: a throwing/closed socket must not starve
  // sibling subscribers of the same event. Returns the write() backpressure
  // signal (false = buffer full) so callers can react if needed.
  try {
    return res.write(`data: ${JSON.stringify(payload)}\n\n`)
  } catch {
    return false
  }
}

export function createChatJobManager({ homeDir, checkpointStore = null, claudeQuery = query, codexSdkFactory = null, maxConcurrentJobs = 4 }) {
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  ensureDir(jobsDir)
  ensureDir(timelinesDir)

  // daemon-01: bound how many jobs actually execute at once. The daemon is a
  // single process shared by every host; an unthrottled burst of chat:send
  // (e.g. a kanban board auto-running many cards) would otherwise spawn N
  // concurrent SDK queries / CLI children and exhaust CPU/memory/FDs/rate
  // limits. Jobs over the cap sit in status 'queued' (already a recognized
  // status) and start FIFO as slots free in runJob's finally.
  const MAX_CONCURRENT_JOBS = Math.max(1, Number(maxConcurrentJobs) || 4)
  let activeJobCount = 0
  const jobQueue = [] // { live, request, workspaceDir }

  // Harness backend (@ai-sdk/harness) is opt-in per request and loaded lazily so
  // its ai@7-canary dependency graph never enters the daemon process unless a
  // harness job is actually requested. Existing provider paths are unaffected.
  // Routing decision lives in the module-level shouldUseHarness() predicate.
  let harnessRunnerPromise = null
  function getHarnessRunner() {
    if (!harnessRunnerPromise) {
      harnessRunnerPromise = import('./harness-runtime.mjs').then(m => m.createHarnessRunner({ homeDir }))
    }
    return harnessRunnerPromise
  }

  const liveJobs = new Map()
  const subscribers = new Map()
  const sessionPermissionGrants = new Map()
  const pendingToolPermissions = new Map()

  // daemon-07: debounce the full metadata rewrite. The timeline jsonl is still
  // appended on every event (cheap, append-only), but the whole-object
  // metadata file is only rewritten at most every METADATA_FLUSH_MS during a
  // streaming turn. Terminal/session events flush immediately so the final
  // status + sessionId are always durable; lastSequence is recoverable from the
  // timeline if a crash loses the last sub-flush window.
  const METADATA_FLUSH_MS = 250
  const metadataFlushTimers = new Map() // jobId -> timeout
  const timelineWriteChains = new Map() // jobId -> Promise<void>

  function enqueueTimelineWrite(jobId, payload) {
    const previous = timelineWriteChains.get(jobId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => fs.appendFile(jobTimelinePath(jobId), `${JSON.stringify(payload)}\n`, 'utf8'))
    timelineWriteChains.set(jobId, next)
    next.finally(() => {
      if (timelineWriteChains.get(jobId) === next) timelineWriteChains.delete(jobId)
    }).catch(() => {})
    return next
  }

  // Periodic SSE heartbeat so clients can detect a silently-dead stream (e.g. a
  // half-open socket, or the post-crash wedge that streamJob's liveness guard
  // also defends against). One unref'd timer for the manager's lifetime.
  const SSE_HEARTBEAT_MS = 15000
  const heartbeatTimer = setInterval(() => {
    for (const listeners of subscribers.values()) {
      for (const res of listeners) {
        try { res.write(': ping\n\n') } catch { /* dropped; close handler cleans up */ }
      }
    }
  }, SSE_HEARTBEAT_MS)
  heartbeatTimer.unref?.()

  function jobMetaPath(jobId) {
    return join(jobsDir, `${jobId}.json`)
  }

  function jobTimelinePath(jobId) {
    return join(timelinesDir, `${jobId}.jsonl`)
  }

  async function readJobMetadata(jobId) {
    try {
      return JSON.parse(await fs.readFile(jobMetaPath(jobId), 'utf8'))
    } catch {
      return null
    }
  }

  async function writeJobMetadata(job) {
    // Atomic write: a crash/SIGKILL mid-write must not leave a truncated
    // {jobId}.json — a corrupt record is invisible to the dashboard AND
    // un-prunable by retention sweep (it skips on parse error), leaking the
    // file and its timeline forever. Write to a unique temp file then rename.
    const finalPath = jobMetaPath(job.id)
    const tmpPath = `${finalPath}.tmp-${randomUUID()}`
    try {
      await fs.writeFile(tmpPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8')
      await fs.rename(tmpPath, finalPath)
    } catch (err) {
      try { await fs.unlink(tmpPath) } catch {}
      throw err
    }
  }

  function clearMetadataFlush(jobId) {
    const timer = metadataFlushTimers.get(jobId)
    if (timer) {
      clearTimeout(timer)
      metadataFlushTimers.delete(jobId)
    }
  }

  function scheduleMetadataFlush(jobId) {
    if (metadataFlushTimers.has(jobId)) return
    const timer = setTimeout(() => {
      metadataFlushTimers.delete(jobId)
      const live = liveJobs.get(jobId)
      if (live?.metadata) void writeJobMetadata(live.metadata).catch(() => {})
    }, METADATA_FLUSH_MS)
    timer.unref?.()
    metadataFlushTimers.set(jobId, timer)
  }

  async function appendEvent(jobId, event) {
    const live = liveJobs.get(jobId)
    const metadata = live?.metadata ?? await readJobMetadata(jobId)
    if (!metadata) return null

    // Idempotent terminals: once a 'done' has fired for a job, ignore further
    // terminal appends. Prevents the duplicate error+done pair when cancelJob
    // and the runner's own catch both emit terminals (the second pair would
    // otherwise write a confusing duplicate timeline + re-run status logic).
    if ((event.type === 'done' || event.type === 'error') && live?.terminalEmitted) {
      return null
    }

    metadata.lastSequence = Number(metadata.lastSequence ?? 0) + 1
    metadata.updatedAt = new Date().toISOString()
    if (event.sessionId) metadata.sessionId = event.sessionId
    if (event.type === 'error') {
      metadata.error = event.error ?? 'Unknown error'
    } else if (event.type === 'done') {
      metadata.status = metadata.error ? 'failed' : 'completed'
      metadata.completedAt = new Date().toISOString()
      if (live) live.terminalEmitted = true
    }

    const payload = {
      jobId,
      sequence: metadata.lastSequence,
      timestamp: Date.now(),
      ...event,
    }

    if (live) {
      live.metadata = metadata
    }

    // Fast path: deliver provider deltas to subscribers before touching disk.
    // Timeline persistence is still ordered per job, but it runs behind the SSE
    // fanout so token rendering latency is provider/network-bound, not fs-bound.
    const timelineWrite = enqueueTimelineWrite(jobId, payload)

    const listeners = subscribers.get(jobId)
    if (listeners) {
      for (const res of listeners) {
        writeSseEvent(res, payload)
      }
    }

    // daemon-07: flush metadata immediately on terminal/session events (status,
    // completedAt, sessionId must be durable right away) or when the job has no
    // live record to debounce against; otherwise coalesce rapid delta writes.
    const isTerminalEvent = event.type === 'done' || event.type === 'error'
    if (isTerminalEvent || event.sessionId || !live) {
      clearMetadataFlush(jobId)
      await timelineWrite.catch(() => {})
      await writeJobMetadata(metadata)
    } else {
      scheduleMetadataFlush(jobId)
    }

    if (event.type === 'done' || event.type === 'error') {
      cancelPendingToolPermissionsForJob(jobId, event.type === 'done' ? 'Job completed' : 'Job failed')
      if (event.type === 'done') {
        const listeners = subscribers.get(jobId)
        if (listeners) {
          for (const res of listeners) res.end()
        }
        subscribers.delete(jobId)
      }
    }

    return payload
  }

  function permissionKey(request) {
    return `${request.provider}::${request.toolName}::${normalizeWorkspaceDir(request.workspaceDir) ?? ''}`
  }

  function resolveStoredPermission(request) {
    const sessionGrant = sessionPermissionGrants.get(permissionKey(request))
    if (sessionGrant?.action === 'allow' || sessionGrant?.action === 'deny') return sessionGrant.action
    return resolvePersistedPermissionGrant(homeDir, request)
  }

  function storeSessionPermissionGrant(request) {
    const grant = buildPermissionGrant(request, 'session')
    sessionPermissionGrants.set(permissionKey(request), grant)
    return grant
  }

  function toolPermissionKey(jobId, toolUseID) {
    return `${jobId}::${toolUseID ?? ''}`
  }

  async function awaitToolPermissionAnswer(job, toolUseID, permissionRequest) {
    const key = toolPermissionKey(job.id, toolUseID)
    const prior = pendingToolPermissions.get(key)
    if (prior) {
      try { prior.reject(new Error('Tool permission superseded')) } catch {}
      pendingToolPermissions.delete(key)
    }

    return await new Promise((resolve, reject) => {
      pendingToolPermissions.set(key, { resolve, reject })
      void appendEvent(job.id, {
        type: 'tool_permission_request',
        toolId: toolUseID,
        provider: permissionRequest.provider,
        toolName: permissionRequest.toolName,
        title: permissionRequest.title ?? null,
        description: permissionRequest.description ?? null,
        blockedPath: permissionRequest.blockedPath ?? null,
        workspaceDir: permissionRequest.workspaceDir ?? null,
      }).catch(error => {
        pendingToolPermissions.delete(key)
        reject(error)
      })
    })
  }

  function answerToolPermission(jobId, toolUseID, decision) {
    const validDecisions = new Set(['deny', 'never', 'once', 'session', 'today', 'forever'])
    if (!validDecisions.has(decision)) {
      return { ok: false, error: 'invalid decision' }
    }
    const pending = pendingToolPermissions.get(toolPermissionKey(jobId, toolUseID))
    if (!pending) {
      return { ok: false, error: 'no pending request' }
    }
    pendingToolPermissions.delete(toolPermissionKey(jobId, toolUseID))
    pending.resolve(decision)
    return { ok: true }
  }

  function cancelPendingToolPermissionsForJob(jobId, reason = 'Job cancelled') {
    const prefix = `${jobId}::`
    for (const [key, pending] of pendingToolPermissions.entries()) {
      if (!key.startsWith(prefix)) continue
      pendingToolPermissions.delete(key)
      try { pending.reject(new Error(reason)) } catch {}
    }
  }

  async function createDaemonCheckpoint(job, request, toolName, filePaths, metadata = {}) {
    const workspaceId = String(request?.workspaceId ?? '').trim()
    if (!checkpointStore || typeof checkpointStore.createCheckpoint !== 'function') return { ok: true, skipped: true }
    if (!workspaceId) return { ok: true, skipped: true }
    if (!Array.isArray(filePaths) || filePaths.length === 0) return { ok: true, skipped: true }

    try {
      const checkpointWorkspaceDir = workspaceDirFromJob(job)
      const response = checkpointStore.createCheckpoint(workspaceId, buildRuntimeSessionEntryId(request, job), {
        label: buildCheckpointLabel(toolName, filePaths, checkpointWorkspaceDir),
        reason: `tool:${toolName}`,
        files: filePaths,
        workspaceRoots: checkpointWorkspaceDir ? [checkpointWorkspaceDir] : [],
        source: 'daemon-chat-job',
        metadata: {
          provider: request?.provider ?? null,
          model: request?.model ?? null,
          toolName,
          cardId: request?.cardId ?? null,
          jobId: job.id,
          ...metadata,
        },
      })
      if (!response?.ok) {
        return { ok: false, error: response?.error ?? `Failed to create checkpoint for ${toolName}` }
      }
      const checkpointId = response.checkpoint?.id
      if (checkpointId) {
        const toolId = `codesurf-checkpoint-${checkpointId}`
        await appendEvent(job.id, { type: 'tool_start', toolId, toolName: 'Checkpoint saved' })
        await appendEvent(job.id, {
          type: 'tool_summary',
          toolId,
          toolName: 'Checkpoint saved',
          text: buildCheckpointSummary(toolName, filePaths, checkpointWorkspaceDir),
        })
      }
      return { ok: true, checkpointId }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  }

  function workspaceDirFromJob(job) {
    return typeof job?.metadata?.workspaceDir === 'string' ? job.metadata.workspaceDir : undefined
  }

  async function runClaudeJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const abortController = new AbortController()
    job.cancel = () => abortController.abort()
    let claudeStderr = ''

    // Defense-in-depth: only resume when the sessionId maps to a real on-disk
    // Claude transcript. A foreign/stale id (e.g. a codex thread id handed over
    // after a provider switch) would otherwise make the SDK return num_turns:0
    // with no assistant content — an empty reply. When there's no transcript we
    // omit `resume` so the model runs a fresh turn instead.
    const resumeTranscriptPath = findClaudeResumeTranscript(request.sessionId)
    const willResume = Boolean(resumeTranscriptPath)
    if (request.sessionId && !willResume) {
      console.warn(`[chat-jobs] claude job ${job.id}: no transcript for session ${request.sessionId}; starting fresh instead of resuming`)
    }

    const modeMap = {
      default: 'default',
      acceptEdits: 'acceptEdits',
      plan: 'plan',
      bypassPermissions: 'bypassPermissions',
    }
    const grantOnlyMode = request.mode === 'dontAsk' || request.mode === 'grant'
    const permMode = modeMap[request.mode ?? ''] ?? 'default'
    const thinkingMap = {
      adaptive: { type: 'adaptive' },
      none: { type: 'disabled' },
      low: { type: 'enabled', budget_tokens: 2048 },
      medium: { type: 'enabled', budget_tokens: 8192 },
      high: { type: 'enabled', budget_tokens: 32768 },
      max: { type: 'enabled', budget_tokens: 131072 },
    }
    const claudeResumeSessionId = resolveClaudeResumeSessionId(request.sessionId)
    const options = {
      model: request.model,
      abortController,
      persistSession: true,
      includePartialMessages: true,
      permissionMode: permMode,
      ...(permMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: async (toolName, input, toolOptions) => {
        if (permMode !== 'bypassPermissions') {
          const permissionRequest = {
            provider: 'claude',
            toolName,
            title: typeof toolOptions?.title === 'string' ? toolOptions.title : null,
            description: typeof toolOptions?.description === 'string' ? toolOptions.description : null,
            blockedPath: typeof toolOptions?.blockedPath === 'string' ? toolOptions.blockedPath : null,
            workspaceDir,
          }
          const storedDecision = resolveStoredPermission(permissionRequest)
          if (storedDecision === 'deny') {
            return {
              behavior: 'deny',
              message: `Permission for ${toolName} is set to Never. Clear it in Settings -> Permissions or with \`codesurf permissions clear <grant-id>\` to re-enable prompts.`,
              toolUseID: toolOptions?.toolUseID,
            }
          }
          if (storedDecision !== 'allow') {
            const canAsk = !grantOnlyMode && request.runMode !== 'background' && typeof request.cardId === 'string' && request.cardId.trim()
            if (!canAsk) {
              return {
                behavior: 'deny',
                message: `Permission required for ${toolName}. Save an all-day or all-time grant from an interactive chat, or run \`codesurf permissions allow claude ${toolName} --workspace ${workspaceDir || process.cwd()}\` before starting this daemon job.`,
                toolUseID: toolOptions?.toolUseID,
              }
            }

            const sdkToolUseID = typeof toolOptions?.toolUseID === 'string'
              ? toolOptions.toolUseID
              : null
            const toolUseID = sdkToolUseID ?? `claude-permission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
            let decision = 'deny'
            try {
              decision = await awaitToolPermissionAnswer(job, toolUseID, permissionRequest)
            } catch {
              return {
                behavior: 'deny',
                message: 'Tool permission request was cancelled.',
                toolUseID: sdkToolUseID ?? toolOptions?.toolUseID,
              }
            }

            await appendEvent(job.id, {
              type: 'tool_permission_resolved',
              toolId: toolUseID,
              toolName,
              decision,
            })

            if (decision === 'deny' || decision === 'never') {
              if (decision === 'never') persistPermissionGrant(homeDir, permissionRequest, 'never')
              return {
                behavior: 'deny',
                message: decision === 'never'
                  ? 'Tool permission permanently denied. Future calls will be auto-rejected.'
                  : 'Tool permission denied by the user.',
                toolUseID: sdkToolUseID ?? toolOptions?.toolUseID,
              }
            }

            if (decision === 'session') storeSessionPermissionGrant(permissionRequest)
            else if (decision === 'today' || decision === 'forever') persistPermissionGrant(homeDir, permissionRequest, decision)
          }
        }

        const checkpointPaths = extractAnthropicCheckpointPaths(toolName, input, workspaceDir)
        if (isClaudeCheckpointTool(toolName) && checkpointPaths.length === 0) {
          const message = `Checkpoint creation failed before ${toolName}: no checkpointable file path was provided`
          await appendEvent(job.id, { type: 'error', error: message })
          return {
            behavior: 'deny',
            message,
            toolUseID: toolOptions?.toolUseID,
          }
        }

        const checkpoint = await createDaemonCheckpoint(
          job,
          request,
          toolName,
          checkpointPaths,
          { toolUseID: typeof toolOptions?.toolUseID === 'string' ? toolOptions.toolUseID : null },
        )
        if (!checkpoint.ok) {
          const message = `Checkpoint creation failed before ${toolName}: ${checkpoint.error ?? 'unknown error'}`
          await appendEvent(job.id, { type: 'error', error: message })
          return {
            behavior: 'deny',
            message,
            toolUseID: toolOptions?.toolUseID,
          }
        }
        return { behavior: 'allow', toolUseID: toolOptions?.toolUseID }
      },
      thinking: thinkingMap[request.thinking ?? ''] ?? { type: 'adaptive' },
      cwd: workspaceDir || undefined,
      stderr: data => { claudeStderr += data },
      ...(willResume ? { resume: claudeResumeSessionId ?? request.sessionId } : {}),
    }

    // Agent-definition tools allow-list → restrict the built-in tools the model
    // may use (null/absent = all default tools). AgentMode.tools names are
    // already Claude-style (Read/Glob/Grep/…), so they pass through verbatim.
    // Set it BOTH at the top level (governs when no custom agent is active) AND
    // on the custom agent definition below — when `options.agent` is set, the
    // active agent's own `tools` field governs its toolset (SDK AgentDefinition),
    // so the allow-list must be applied there too or it would be a no-op for any
    // agent definition that also carries a systemPrompt.
    const agentToolAllowList = Array.isArray(request.agentMode?.tools) ? request.agentMode.tools : null
    if (agentToolAllowList) {
      options.tools = agentToolAllowList
    }

    const systemPrompt = buildClaudeAgentPrompt(request.peers, request.asyncExecution, instructionPrompt, request.skillsPrompt, agentPersonaPrompt(request))
    if (systemPrompt) {
      options.agent = 'codesurf'
      options.agents = {
        codesurf: {
          description: 'CodeSurf canvas AI agent with peer context',
          prompt: systemPrompt,
          ...(agentToolAllowList ? { tools: agentToolAllowList } : {}),
        },
      }
    }

    try {
      const q = claudeQuery({ prompt: lastUserMsg.content, options })
      job.query = q
      let emittedDone = false
      let assistantText = ''
      let sawAssistantOutput = false
      const streamedTextByIndex = new Map()
      let streamTurn = 0

      for await (const msg of q) {
        const sid = msg?.session_id
        if (sid) {
          await appendEvent(job.id, { type: 'session', sessionId: sid })
        }

        if (msg.type === 'stream_event') {
          const evt = msg.event
          if (evt?.type === 'content_block_delta') {
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              const key = `${streamTurn}:${evt.index ?? 0}`
              streamedTextByIndex.set(key, (streamedTextByIndex.get(key) ?? '') + evt.delta.text)
              assistantText += evt.delta.text
              sawAssistantOutput = true
              await appendEvent(job.id, { type: 'text', text: evt.delta.text })
            } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
              sawAssistantOutput = true
              await appendEvent(job.id, { type: 'thinking', text: evt.delta.thinking })
            } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
              await appendEvent(job.id, { type: 'tool_input', text: evt.delta.partial_json })
            }
          } else if (evt?.type === 'content_block_start') {
            if (evt.content_block?.type === 'tool_use') {
              sawAssistantOutput = true
              await appendEvent(job.id, {
                type: 'tool_start',
                toolName: evt.content_block.name,
                toolId: evt.content_block.id,
              })
            } else if (evt.content_block?.type === 'thinking') {
              await appendEvent(job.id, { type: 'thinking_start' })
            }
          } else if (evt?.type === 'content_block_stop') {
            await appendEvent(job.id, { type: 'block_stop', index: evt.index })
          }
        } else if (msg.type === 'assistant') {
          const message = msg.message
          if (message?.content) {
            for (let idx = 0; idx < message.content.length; idx += 1) {
              const block = message.content[idx]
              if (block.type === 'tool_use') {
                sawAssistantOutput = true
                await appendEvent(job.id, {
                  type: 'tool_use',
                  toolName: block.name,
                  toolId: block.id,
                  toolInput: JSON.stringify(block.input, null, 2),
                })
              } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
                const key = `${streamTurn}:${idx}`
                const alreadyStreamed = streamedTextByIndex.get(key) ?? ''
                if (block.text !== alreadyStreamed) {
                  const tail = block.text.startsWith(alreadyStreamed)
                    ? block.text.slice(alreadyStreamed.length)
                    : block.text
                  if (tail.length > 0) {
                    assistantText += tail
                    sawAssistantOutput = true
                    await appendEvent(job.id, { type: 'text', text: tail })
                    streamedTextByIndex.set(key, block.text)
                  }
                }
              }
            }
          }
          streamTurn += 1
        } else if (msg.type === 'tool_use_summary') {
          if (typeof msg.summary === 'string' && msg.summary.trim()) sawAssistantOutput = true
          await appendEvent(job.id, {
            type: 'tool_summary',
            text: msg.summary,
          })
        } else if (msg.type === 'tool_progress') {
          sawAssistantOutput = true
          await appendEvent(job.id, {
            type: 'tool_progress',
            toolName: msg.tool_name,
            elapsed: msg.elapsed_time_seconds,
          })
        } else if (msg.type === 'result') {
          emittedDone = true
          const resultText = typeof msg.result === 'string' ? msg.result.trim() : ''
          if (!assistantText.trim() && resultText) {
            assistantText = resultText
            sawAssistantOutput = true
            await appendEvent(job.id, { type: 'text', text: resultText })
          }
          if (!sawAssistantOutput && !resultText) {
            await appendEvent(job.id, {
              type: 'error',
              error: 'Claude finished without assistant output. Only preflight/context events were emitted, so the turn was not saved as a blank reply. Please resend the message.',
            })
            await appendEvent(job.id, {
              type: 'done',
              cost: msg.total_cost_usd,
              turns: msg.num_turns,
              sessionId: msg.session_id,
            })
            continue
          }
          await appendEvent(job.id, {
            type: 'done',
            cost: msg.total_cost_usd,
            turns: msg.num_turns,
            resultText: msg.result,
            sessionId: msg.session_id,
          })
        }
      }

      if (!emittedDone) {
        if (!sawAssistantOutput && !assistantText.trim()) {
          await appendEvent(job.id, {
            type: 'error',
            error: 'Claude stream ended before producing assistant output. Only preflight/context events were emitted, so the turn was not saved as a blank reply. Please resend the message.',
          })
          await appendEvent(job.id, { type: 'done' })
        } else {
          await appendEvent(job.id, { type: 'done' })
        }
      }
    } catch (error) {
      await appendEvent(job.id, {
        type: 'error',
        error: formatClaudeSdkError(error, claudeStderr),
      })
      await appendEvent(job.id, { type: 'done' })
    }
  }

  async function runCodexSdkJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return true
    }

    let threadOptions
    try {
      threadOptions = buildCodexSdkThreadOptions(request, workspaceDir)
    } catch (err) {
      await appendEvent(job.id, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      await appendEvent(job.id, { type: 'done' })
      return true
    }

    let codex
    try {
      codex = await createCodexSdkClient({ codexSdkFactory })
    } catch (err) {
      if (err?.code === CODEX_SDK_UNAVAILABLE_CODE) {
        console.warn(`[chat-jobs] Codex SDK unavailable; falling back to CLI: ${err.message}`)
        return false
      }
      await appendEvent(job.id, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      await appendEvent(job.id, { type: 'done' })
      return true
    }

    const abortController = new AbortController()
    job.cancel = () => abortController.abort()

    const prompt = buildCodexPrompt(
      lastUserMsg.content ?? '',
      request.asyncExecution,
      instructionPrompt,
      request.skillsPrompt,
      agentPersonaPrompt(request),
    )

    const pendingSnapshots = new Map()
    const aggregatedFileChanges = new Map()
    const exploreEntries = []
    const emittedSessionIds = new Set()
    let editsStarted = false
    let exploreStarted = false
    let commandSeq = 0
    let fatalFailure = null

    const emitSession = async (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return
      const normalized = sessionId.trim()
      if (emittedSessionIds.has(normalized)) return
      emittedSessionIds.add(normalized)
      await appendEvent(job.id, { type: 'session', sessionId: normalized })
    }

    const abortSdkTurn = () => {
      try { abortController.abort() } catch {}
    }

    const handleCodexJsonEvent = async (evt) => {
      if (!evt || typeof evt !== 'object') return
      if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
        await emitSession(evt.thread_id)
        return
      }
      if (fatalFailure) return

      if (evt.type === 'turn.failed' || evt.type === 'error') {
        fatalFailure = evt.error?.message ?? evt.message ?? `Codex SDK event: ${evt.type}`
        await appendEvent(job.id, { type: 'error', error: String(fatalFailure) })
        abortSdkTurn()
        return
      }

      if (evt.type === 'item.started') {
        const item = evt.item
        if (item?.type === 'file_change' && Array.isArray(item.changes)) {
          const checkpointPaths = extractCodexCheckpointPaths(item.changes, workspaceDir)
          if (item.changes.length > 0 && checkpointPaths.length === 0) {
            fatalFailure = 'no checkpointable file paths were provided by Codex SDK file_change'
            await appendEvent(job.id, {
              type: 'error',
              error: `Checkpoint creation failed before Codex SDK file change: ${fatalFailure}`,
            })
            abortSdkTurn()
            return
          }
          const checkpoint = await createDaemonCheckpoint(job, request, 'Codex file change', checkpointPaths, {
            itemType: 'file_change',
            provider: 'codex-sdk',
          })
          if (!checkpoint.ok) {
            fatalFailure = checkpoint.error ?? 'unknown error'
            await appendEvent(job.id, {
              type: 'error',
              error: `Checkpoint creation failed before Codex SDK file change: ${fatalFailure}`,
            })
            abortSdkTurn()
            return
          }

          for (const change of item.changes) {
            if (typeof change?.path !== 'string') continue
            const resolvedPath = resolveCodexFilePath(change.path, workspaceDir)
            const snapshot = await readSnapshotContent(resolvedPath)
            pendingSnapshots.set(resolvedPath, {
              displayPath: getDisplayPath(resolvedPath, workspaceDir),
              changeType: changeTypeFromCodexKind(change.kind),
              existed: snapshot.existed,
              content: snapshot.content,
            })
          }
        }
        return
      }

      if (evt.type !== 'item.completed') return
      const item = evt.item
      if (!item || typeof item !== 'object') return

      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        await appendEvent(job.id, { type: 'text', text: item.text })
        return
      }

      if (item.type === 'command_execution' && typeof item.command === 'string') {
        const command = normalizeCodexShellCommand(item.command)
        const kind = classifyCodexCommand(command)
        const MAX_CMD_OUTPUT = 64 * 1024
        const rawOutput = sanitizeToolOutputText(typeof item.aggregated_output === 'string' ? item.aggregated_output : '')
        const output = rawOutput.length > MAX_CMD_OUTPUT
          ? rawOutput.slice(0, MAX_CMD_OUTPUT) + '\n…[truncated]'
          : rawOutput
        if (kind === 'search' || kind === 'read') {
          if (!exploreStarted) {
            await appendEvent(job.id, { type: 'tool_start', toolId: 'codex-explore', toolName: 'Exploring workspace' })
            exploreStarted = true
          }
          exploreEntries.push({ label: command, command, output, kind })
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId: 'codex-explore',
            toolName: buildExploreToolName(exploreEntries),
            commandEntries: [...exploreEntries],
          })
        } else {
          const toolId = `codex-cmd-${commandSeq++}`
          await appendEvent(job.id, { type: 'tool_start', toolId, toolName: 'exec_command' })
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId,
            toolName: 'exec_command',
            commandEntries: [{ label: command, command, output, kind: 'command' }],
          })
        }
        return
      }

      if (item.type === 'file_change' && Array.isArray(item.changes)) {
        const fileChanges = await summarizeCodexFileChanges(item.changes, pendingSnapshots, workspaceDir)
        if (fileChanges.length === 0) return
        for (const change of fileChanges) {
          const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
          aggregatedFileChanges.set(key, change)
        }
        const merged = Array.from(aggregatedFileChanges.values())
        if (!editsStarted) {
          await appendEvent(job.id, {
            type: 'tool_start',
            toolId: 'codex-file-changes',
            toolName: buildEditedToolName(merged),
          })
          editsStarted = true
        }
        await appendEvent(job.id, {
          type: 'tool_summary',
          toolId: 'codex-file-changes',
          toolName: buildEditedToolName(merged),
          fileChanges: merged,
        })
      }
    }

    try {
      const { thread, resumed, sessionId } = startCodexSdkThread(codex, request, threadOptions)
      if (resumed) await emitSession(sessionId)
      const { events } = await thread.runStreamed(prompt, { signal: abortController.signal })
      for await (const evt of events) {
        await handleCodexJsonEvent(evt)
      }
    } catch (err) {
      if (!fatalFailure) {
        const message = err instanceof Error ? err.message : String(err)
        await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(message) })
      }
    }

    await appendEvent(job.id, { type: 'done' })
    return true
  }

  async function runCodexJob(job, request, workspaceDir, instructionPrompt) {
    if (shouldUseCodexSdkProvider(request)) {
      const handledBySdk = await runCodexSdkJob(job, request, workspaceDir, instructionPrompt)
      if (handledBySdk) return
    }

    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    let codexArgs
    try {
      codexArgs = buildCodexExecArgs(request, workspaceDir, instructionPrompt)
    } catch (err) {
      // Fail closed: e.g. an unenforceable deny-all tool list on Codex. Surface
      // the specific reason instead of spawning Codex with weaker enforcement.
      await appendEvent(job.id, { type: 'error', error: err instanceof Error ? err.message : String(err) })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const proc = spawn('codex', codexArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    })

    job.proc = proc
    job.cancel = () => {
      try { process.kill(-proc.pid, 'SIGTERM') } catch { proc.kill('SIGTERM') }
    }

    const pendingSnapshots = new Map()
    const aggregatedFileChanges = new Map()
    const exploreEntries = []
    let editsStarted = false
    let exploreStarted = false
    let commandSeq = 0
    let checkpointFailure = null
    let pendingStdout = ''
    let stdoutChain = Promise.resolve()
    let stderrBuf = ''
    let exitCode = null
    let procError = null

    const handleCodexJsonEvent = async (evt) => {
      if (!evt || typeof evt !== 'object') return
      if (evt.type === 'thread.started' && typeof evt.thread_id === 'string') {
        await appendEvent(job.id, { type: 'session', sessionId: evt.thread_id })
        return
      }
      if (checkpointFailure) return

      if (evt.type === 'item.started') {
        const item = evt.item
        if (item?.type === 'file_change' && Array.isArray(item.changes)) {
          const checkpointPaths = extractCodexCheckpointPaths(item.changes, workspaceDir)
          if (item.changes.length > 0 && checkpointPaths.length === 0) {
            checkpointFailure = 'no checkpointable file paths were provided by Codex file_change'
            await appendEvent(job.id, {
              type: 'error',
              error: `Checkpoint creation failed before Codex file change: ${checkpointFailure}`,
            })
            if (!proc.killed) proc.kill('SIGTERM')
            return
          }
          const checkpoint = await createDaemonCheckpoint(job, request, 'Codex file change', checkpointPaths, {
            itemType: 'file_change',
          })
          if (!checkpoint.ok) {
            checkpointFailure = checkpoint.error ?? 'unknown error'
            await appendEvent(job.id, {
              type: 'error',
              error: `Checkpoint creation failed before Codex file change: ${checkpointFailure}`,
            })
            if (!proc.killed) proc.kill('SIGTERM')
            return
          }

          for (const change of item.changes) {
            if (typeof change?.path !== 'string') continue
            const resolvedPath = resolveCodexFilePath(change.path, workspaceDir)
            const snapshot = await readSnapshotContent(resolvedPath)
            pendingSnapshots.set(resolvedPath, {
              displayPath: getDisplayPath(resolvedPath, workspaceDir),
              changeType: changeTypeFromCodexKind(change.kind),
              existed: snapshot.existed,
              content: snapshot.content,
            })
          }
        }
        return
      }

      if (evt.type !== 'item.completed') return
      const item = evt.item
      if (!item || typeof item !== 'object') return

      if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        await appendEvent(job.id, { type: 'text', text: item.text })
        return
      }

      if (item.type === 'command_execution' && typeof item.command === 'string') {
        const command = normalizeCodexShellCommand(item.command)
        const kind = classifyCodexCommand(command)
        const MAX_CMD_OUTPUT = 64 * 1024
        const rawOutput = sanitizeToolOutputText(typeof item.aggregated_output === 'string' ? item.aggregated_output : '')
        const output = rawOutput.length > MAX_CMD_OUTPUT
          ? rawOutput.slice(0, MAX_CMD_OUTPUT) + '\n…[truncated]'
          : rawOutput
        if (kind === 'search' || kind === 'read') {
          if (!exploreStarted) {
            await appendEvent(job.id, { type: 'tool_start', toolId: 'codex-explore', toolName: 'Exploring workspace' })
            exploreStarted = true
          }
          exploreEntries.push({ label: command, command, output, kind })
          await appendEvent(job.id, {
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
          await appendEvent(job.id, { type: 'tool_start', toolId, toolName: 'exec_command' })
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId,
            toolName: 'exec_command',
            commandEntries: [{ label: command, command, output, kind: 'command' }],
          })
        }
        return
      }

      if (item.type === 'file_change' && Array.isArray(item.changes)) {
        const fileChanges = await summarizeCodexFileChanges(item.changes, pendingSnapshots, workspaceDir)
        if (fileChanges.length === 0) return
        for (const change of fileChanges) {
          const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
          aggregatedFileChanges.set(key, change)
        }
        const merged = Array.from(aggregatedFileChanges.values())
        if (!editsStarted) {
          await appendEvent(job.id, {
            type: 'tool_start',
            toolId: 'codex-file-changes',
            toolName: buildEditedToolName(merged),
          })
          editsStarted = true
        }
        await appendEvent(job.id, {
          type: 'tool_summary',
          toolId: 'codex-file-changes',
          toolName: buildEditedToolName(merged),
          fileChanges: merged,
        })
      }
    }

    proc.stdout?.on('data', (chunk) => {
      pendingStdout += chunk.toString()
      const lines = pendingStdout.split(/\r?\n/)
      pendingStdout = lines.pop() ?? ''
      stdoutChain = stdoutChain.then(async () => {
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            await handleCodexJsonEvent(JSON.parse(trimmed))
          } catch {
            await appendEvent(job.id, { type: 'text', text: `${line}\n` })
          }
        }
      }).catch(() => {})
    })

    proc.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString()
    })

    await new Promise((resolveJob) => {
      proc.on('close', (code) => {
        exitCode = code
        resolveJob()
      })
      proc.on('error', (error) => {
        procError = error
        resolveJob()
      })
    })

    await stdoutChain.catch(() => {})
    if (pendingStdout.trim()) {
      try {
        await handleCodexJsonEvent(JSON.parse(pendingStdout.trim()))
      } catch {
        await appendEvent(job.id, { type: 'text', text: pendingStdout })
      }
    }
    const stderrText = sanitizeCodexStderrText(stderrBuf)
    if (procError instanceof Error) {
      await appendEvent(job.id, { type: 'error', error: procError.message })
    } else if (stderrText) {
      await appendEvent(job.id, { type: 'error', error: stderrText })
    } else if (typeof exitCode === 'number' && exitCode !== 0) {
      await appendEvent(job.id, { type: 'error', error: `Codex exited with code ${exitCode}` })
    }
    await appendEvent(job.id, { type: 'done' })
  }

  async function runHermesJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const prompt = buildCodexPrompt(lastUserMsg.content, request.asyncExecution, instructionPrompt, request.skillsPrompt, agentPersonaPrompt(request))
    const proc = spawn('hermes', buildHermesChatArgs({
      prompt,
      model: request.model,
      provider: request.providerId ?? request.modelProvider ?? request.providerName,
      toolsets: hermesToolsetsForRequest(request),
      resumeSessionId: request.sessionId,
      ignoreRules: Boolean(instructionPrompt || request.skillsPrompt || request.contextBuckets || request.memoryPrompt || agentPersonaPrompt(request)),
      bypassPermissions: request.mode === 'bypassPermissions',
    }), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
      ...(workspaceDir ? { cwd: workspaceDir } : {}),
    })

    job.proc = proc
    job.cancel = () => {
      try { process.kill(-proc.pid, 'SIGTERM') } catch { proc.kill('SIGTERM') }
    }

    let stdoutBuf = ''
    let stderrBuf = ''
    let exitCode = null
    let procError = null

    proc.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk.toString()
    })
    proc.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString()
    })

    await new Promise((resolveJob) => {
      proc.on('close', (code) => {
        exitCode = code
        resolveJob()
      })
      proc.on('error', (error) => {
        procError = error
        resolveJob()
      })
    })

    if (procError instanceof Error) {
      await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(procError.message) })
    } else if (typeof exitCode === 'number' && exitCode !== 0) {
      const diagnostic = stderrBuf.trim() || stdoutBuf.trim() || `Hermes exited with code ${exitCode}`
      await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(diagnostic) })
    } else {
      const parsed = parseHermesOutput(stdoutBuf)
      if (parsed.sessionId) await appendEvent(job.id, { type: 'session', sessionId: parsed.sessionId })
      if (parsed.text) await appendEvent(job.id, { type: 'text', text: parsed.text })
    }

    await appendEvent(job.id, { type: 'done' })
  }

  async function runOpenCodeJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const prompt = buildCodexPrompt(lastUserMsg.content, request.asyncExecution, instructionPrompt, request.skillsPrompt, agentPersonaPrompt(request))
    const agent = typeof request.agent === 'string'
      ? request.agent
      : typeof request.agentName === 'string'
        ? request.agentName
        : typeof request.metadata?.agent === 'string'
          ? request.metadata.agent
          : null
    const proc = spawn('opencode', buildOpenCodeRunArgs({
      prompt,
      model: request.model,
      agent,
      sessionId: request.sessionId,
      cwd: workspaceDir,
      bypassPermissions: request.mode === 'bypassPermissions',
    }), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    })

    job.proc = proc
    job.cancel = () => {
      try { process.kill(-proc.pid, 'SIGTERM') } catch { proc.kill('SIGTERM') }
    }

    const emittedSessionIds = new Set()
    const fallbackTextParts = []
    let pendingStdout = ''
    let stdoutChain = Promise.resolve()
    let stderrBuf = ''
    let exitCode = null
    let procError = null

    const handleOpenCodeJsonEvent = async (evt) => {
      if (!evt || typeof evt !== 'object') return
      const sessionId = extractAgentSessionId(evt)
      if (sessionId && !emittedSessionIds.has(sessionId)) {
        emittedSessionIds.add(sessionId)
        await appendEvent(job.id, { type: 'session', sessionId })
      }

      const text = extractOpenCodeTextPayload(evt)
      if (text) await appendEvent(job.id, { type: 'text', text })
    }

    const processOpenCodeLine = async (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        await handleOpenCodeJsonEvent(JSON.parse(trimmed))
      } catch {
        fallbackTextParts.push(line)
      }
    }

    proc.stdout?.on('data', (chunk) => {
      pendingStdout += chunk.toString()
      const lines = pendingStdout.split(/\r?\n/)
      pendingStdout = lines.pop() ?? ''
      stdoutChain = stdoutChain.then(async () => {
        for (const line of lines) await processOpenCodeLine(line)
      }).catch(() => {})
    })

    proc.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString()
    })

    await new Promise((resolveJob) => {
      proc.on('close', (code) => {
        exitCode = code
        resolveJob()
      })
      proc.on('error', (error) => {
        procError = error
        resolveJob()
      })
    })

    await stdoutChain.catch(() => {})
    if (pendingStdout.trim()) {
      await processOpenCodeLine(pendingStdout)
    }

    if (procError instanceof Error) {
      await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(procError.message) })
    } else if (typeof exitCode === 'number' && exitCode !== 0) {
      const diagnostic = stderrBuf.trim() || fallbackTextParts.join('\n').trim() || `OpenCode exited with code ${exitCode}`
      await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(diagnostic) })
    } else if (fallbackTextParts.length > 0) {
      await appendEvent(job.id, { type: 'text', text: fallbackTextParts.join('\n').trim() })
    }

    await appendEvent(job.id, { type: 'done' })
  }

  async function runOmnigentJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    // Daemon-resolved settings (codesurfd folds settings.json + env overrides
    // into request.omnigent). Fall back to defaults so the cloud clone — which
    // has no settings.json — still works against a local backend.
    const settings = request.omnigent && typeof request.omnigent === 'object' ? request.omnigent : {}
    if (settings.enabled === false) {
      await appendEvent(job.id, { type: 'error', error: 'Omnigent provider is disabled in daemon settings (settings.omnigent.enabled = false).' })
      await appendEvent(job.id, { type: 'done' })
      return
    }
    const apiKey = typeof settings.apiKey === 'string' ? settings.apiKey : ''
    let baseUrl = normalizeOmnigentServerRoot(
      typeof settings.baseUrl === 'string' && settings.baseUrl.trim() ? settings.baseUrl : OMNIGENT_DEFAULT_BASE_URL,
    )

    const prompt = buildCodexPrompt(
      lastUserMsg.content ?? '',
      request.asyncExecution,
      instructionPrompt,
      request.skillsPrompt,
      agentPersonaPrompt(request),
    )

    const abortController = new AbortController()
    job.cancel = () => { try { abortController.abort() } catch {} }

    // Bound the whole turn: the live SSE tail never closes per turn, so a stalled
    // backend would otherwise hang here forever. A timeout aborts the stream and
    // every in-flight fetch via the shared controller; timedOut distinguishes it
    // from a user cancel (cancel is silent, timeout surfaces an error).
    let timedOut = false
    const turnTimeout = setTimeout(() => {
      timedOut = true
      try { abortController.abort() } catch {}
    }, OMNIGENT_TURN_TIMEOUT_MS)

    // Lazy tool_start: the typed-event table only guarantees output_item.done,
    // so we may first see a tool on .done — emit its start then, keyed (like the
    // result) on call_id so the result block attaches to the call block.
    const startedToolIds = new Set()
    const emittedSessionIds = new Set()

    const emitSession = async (sessionId) => {
      if (typeof sessionId !== 'string' || !sessionId.trim()) return
      const normalized = sessionId.trim()
      if (emittedSessionIds.has(normalized)) return
      emittedSessionIds.add(normalized)
      await appendEvent(job.id, { type: 'session', sessionId: normalized })
    }

    const ensureToolStart = async (toolId, toolName) => {
      if (startedToolIds.has(toolId)) return
      startedToolIds.add(toolId)
      await appendEvent(job.id, { type: 'tool_start', toolId, toolName })
    }

    // Pair thinking_start with a block_stop. The client's reducer leaves a
    // thinking block open until block_stop (it is never closed by `done`), so an
    // unpaired thinking_start renders a perpetually-open reasoning indicator. We
    // close it on the first non-reasoning event — and ALWAYS before starting any
    // tool, because block_stop also marks the last running tool block done.
    let thinkingOpen = false
    const closeThinking = async () => {
      if (!thinkingOpen) return
      thinkingOpen = false
      await appendEvent(job.id, { type: 'block_stop' })
    }

    // Apply a mapped descriptor; returns 'done' | 'error' for terminals.
    const applyDescriptor = async (descriptor) => {
      if (!descriptor) return null
      switch (descriptor.kind) {
        case 'text':
          await closeThinking()
          await appendEvent(job.id, { type: 'text', text: descriptor.text })
          return null
        case 'thinking':
          await appendEvent(job.id, { type: 'thinking', text: descriptor.text })
          return null
        case 'thinking_start':
          thinkingOpen = true
          await appendEvent(job.id, { type: 'thinking_start' })
          return null
        case 'tool_call':
          await closeThinking()
          await ensureToolStart(descriptor.toolId, descriptor.toolName)
          if (descriptor.toolInput != null) {
            await appendEvent(job.id, {
              type: 'tool_use',
              toolName: descriptor.toolName,
              toolId: descriptor.toolId,
              toolInput: descriptor.toolInput,
            })
          }
          return null
        case 'tool_result':
          await closeThinking()
          await ensureToolStart(descriptor.toolId, 'tool')
          await appendEvent(job.id, { type: 'tool_summary', toolId: descriptor.toolId, text: descriptor.output })
          return null
        case 'terminal':
          await closeThinking()
          if (descriptor.stop === 'error') {
            await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(descriptor.error ?? 'Omnigent turn failed.') })
            return 'error'
          }
          return 'done'
        default:
          return null
      }
    }

    try {
      // Auto-start the local omni server when enabled. Idempotent: a running
      // server reports its live URL. Best effort — fall through to the
      // configured base URL and let the stream fetch surface a clear error.
      // Only autostart when the base URL is still the local default — a
      // configured remote endpoint always wins (mirrors the CLI's ensureBaseUrl,
      // which only starts the local server when no base URL is set).
      if (settings.autoStart !== false && baseUrl === OMNIGENT_DEFAULT_BASE_URL) {
        try {
          const started = await startLocalOmnigentServer(OMNIGENT_DEFAULT_CLI, abortController.signal)
          if (started) baseUrl = started
        } catch {}
      }

      // Resume reuses the prior Omnigent session id (echoed back as
      // request.sessionId); a fresh turn creates a new persistent session.
      let sessionId = typeof request.sessionId === 'string' && request.sessionId.trim() ? request.sessionId.trim() : null
      if (!sessionId) {
        const agentId = await resolveOmnigentAgentId(request.model, settings, baseUrl, apiKey, abortController.signal)
        // Bind the session to a runner host. Required: a session created without
        // host_id never gets a runner bound, so its turns fail with
        // runner_unavailable. Resolved before create so a missing host fails the
        // job cleanly here instead of mid-turn.
        const hostId = await resolveOmnigentHostId(settings, baseUrl, apiKey, abortController.signal)
        const body = buildOmnigentSessionBody({
          agentId,
          hostId,
          title: omnigentTitleFromPrompt(lastUserMsg.content ?? ''),
          workspace: workspaceDir,
        })
        const created = await omnigentFetchJson(baseUrl, '/v1/sessions', apiKey, {
          method: 'POST',
          body: JSON.stringify(body),
          signal: abortController.signal,
        })
        sessionId = extractOmnigentSessionId(created)
        if (!sessionId) throw new Error('Omnigent session create response did not include an id.')
      }
      await emitSession(sessionId)

      // Live-tail SSE: no replay, stays open across turns. Subscribe FIRST, then
      // POST the user turn so no events fire in the gap (API.md Reconnect Contract).
      const streamResponse = await fetch(
        omnigentEndpointUrl(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/stream`),
        {
          method: 'GET',
          headers: { Accept: 'text/event-stream', ...omnigentAuthHeaders(apiKey) },
          signal: abortController.signal,
        },
      )
      if (!streamResponse.ok || !streamResponse.body) {
        const text = await streamResponse.text().catch(() => '')
        throw new Error(text || `Omnigent stream returned HTTP ${streamResponse.status}`)
      }

      await omnigentFetchJson(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/events`, apiKey, {
        method: 'POST',
        body: JSON.stringify({ type: 'message', data: { role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
        signal: abortController.signal,
      })

      // Read the tail and STOP only on a terminal response.* event — the stream
      // does not close or emit [DONE] when a single turn completes, so EOF and
      // [DONE] are NOT success: if either arrives before a terminal event the
      // turn was truncated, which we surface as an error (not a silent done).
      // This is the load-bearing difference from the codex/hermes runners.
      const reader = streamResponse.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let sawTerminal = false
      try {
        while (!sawTerminal) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          let streamEnded = false
          while (boundary >= 0) {
            const chunk = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const { eventName, data } = parseOmnigentSseChunk(chunk)
            if (data === '[DONE]') { streamEnded = true; break }
            if (data) {
              let parsed
              try {
                parsed = JSON.parse(data)
              } catch {
                parsed = null
              }
              if (parsed && typeof parsed === 'object') {
                if (eventName && typeof parsed.type !== 'string') parsed.type = eventName
                const result = await applyDescriptor(mapOmnigentStreamEvent(parsed))
                if (result === 'done' || result === 'error') { sawTerminal = true; break }
              }
            }
            boundary = buffer.indexOf('\n\n')
          }
          if (streamEnded) break
        }
      } finally {
        try { await reader.cancel() } catch {}
      }

      // EOF / [DONE] reached without a terminal response.* event => truncated.
      if (!sawTerminal && !abortController.signal.aborted) {
        await appendEvent(job.id, { type: 'error', error: 'Omnigent stream ended before the turn completed (truncated stream).' })
      }
    } catch (err) {
      if (timedOut) {
        await appendEvent(job.id, { type: 'error', error: `Omnigent turn timed out after ${Math.round(OMNIGENT_TURN_TIMEOUT_MS / 1000)}s.` })
      } else if (!abortController.signal.aborted) {
        const message = err instanceof Error ? err.message : String(err)
        await appendEvent(job.id, { type: 'error', error: sanitizeAgentCliDiagnostic(message) })
      }
    } finally {
      clearTimeout(turnTimeout)
      // Best-effort remote interrupt when the turn was aborted locally (user
      // cancel or the turn timeout) — the turn is still running server-side.
      if (abortController.signal.aborted) {
        const cancelledSessionId = emittedSessionIds.values().next().value
        if (cancelledSessionId) {
          try {
            await fetch(omnigentEndpointUrl(baseUrl, `/v1/sessions/${encodeURIComponent(cancelledSessionId)}/events`), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...omnigentAuthHeaders(apiKey) },
              body: JSON.stringify({ type: 'interrupt', data: {} }),
              signal: AbortSignal.timeout(2_000),
            })
          } catch {}
        }
      }
    }

    await appendEvent(job.id, { type: 'done' })
  }

  async function runJob(job, request, workspaceDir) {
    try {
      // PRE-START authoritative resolution (#cli-persona). A caller may supply only
      // an `agentId` and NO `agentMode` — the `codesurf chat --persona` CLI does
      // exactly this on purpose: it NEVER constructs a trusted agentMode, it sends
      // the persona id and lets the daemon resolve tools/permissions from trusted
      // local sources. When agentMode is ABSENT we resolve it here, BEFORE the
      // fail-closed unresolved check below, so an agentId-only request works instead
      // of always failing closed. Resolution is fail-closed itself: ENOENT (no
      // agents.json) → BUILT-INS authoritative; present file → agents.json overlay;
      // corrupt/unknown id → refuse. Crucially the tools/permissions come ONLY from
      // these trusted sources, never from any caller-supplied payload.
      //
      // This does NOT touch the agentMode-PRESENT paths: the GUI ships a re-resolved
      // agentMode (overridden below when a local agents.json exists), and the cloud
      // clone (no `.codesurf`) trusts the caller's shipped agentMode. The CLI sends no
      // agentMode, so it can only reach THIS branch — the trust path stays intact.
      if (request.agentId && request.agentMode == null) {
        const preStart = await resolveAuthoritativeAgentMode({
          agentId: request.agentId,
          resolveWorkspaceRoot: () => workspaceDir,
        })
        if (!preStart.ok) {
          await appendEvent(job.id, { type: 'error', error: preStart.error })
          await appendEvent(job.id, { type: 'done' })
          return
        }
        request = { ...request, agentMode: preStart.agentMode }
      }

      // A-PR1 BLOCKING-1 (security chokepoint): a selected agent whose definition
      // has not resolved must not launch unrestricted. This guard covers EVERY
      // daemon provider (claude SDK / codex / hermes / opencode / harness) in one
      // place — providers downstream enforce persona + tools from request.agentMode,
      // so a dangling agentId without agentMode would silently bypass them.
      if (agentModeUnresolved(request)) {
        await appendEvent(job.id, { type: 'error', error: AGENT_MODE_UNRESOLVED_ERROR })
        await appendEvent(job.id, { type: 'done' })
        return
      }

      // Defense-in-depth (ROOT FIX). Main already resolved the agentId
      // authoritatively and shipped the agentMode, but the LOCAL daemon shares the
      // filesystem with main, so when a real agents.json is present we RE-RESOLVE
      // from the trusted workspaceDir and override — a second, independent
      // enforcement of the same source of truth. The remote/cloud daemon has no
      // `.codesurf` (the gitignored dir is excluded from the clone) → the file is
      // absent → we trust the agentMode main resolved and shipped (the only
      // authority the cloud has). Gating on file existence is what keeps cloud
      // working: re-resolving a custom agentId with no local file would otherwise
      // fail closed and clobber main's correct value.
      if (request.agentId && workspaceDir &&
          existsSync(join(workspaceDir, '.codesurf', 'customisation', 'agents.json'))) {
        const authoritative = await resolveAuthoritativeAgentMode({
          agentId: request.agentId,
          resolveWorkspaceRoot: () => workspaceDir,
        })
        if (!authoritative.ok) {
          await appendEvent(job.id, { type: 'error', error: authoritative.error })
          await appendEvent(job.id, { type: 'done' })
          return
        }
        request = { ...request, agentMode: authoritative.agentMode }
      }

      const memoryContext = await loadMemoryContext({
        homeDir,
        workspaceDir,
        projectPaths: [workspaceDir],
        executionTarget: request.executionTarget ?? 'local',
      })
      const instructionPrompt = String(request.memoryPrompt ?? '').trim() || buildMemoryPrompt(memoryContext)
      const contextBuckets = buildContextBucketBundle(request.contextBuckets ?? memoryContext, instructionPrompt)
      const memorySummary = summarizeMemoryContext(contextBuckets, instructionPrompt)
      const memoryInput = buildMemoryContextInput(contextBuckets, instructionPrompt)
      if (memorySummary) {
        await appendEvent(job.id, {
          type: 'tool_start',
          toolId: 'codesurf-memory-context',
          toolName: 'Workspace Instructions',
        })
        if (memoryInput) {
          await appendEvent(job.id, {
            type: 'tool_input',
            toolId: 'codesurf-memory-context',
            text: memoryInput,
          })
        }
        await appendEvent(job.id, {
          type: 'tool_summary',
          toolId: 'codesurf-memory-context',
          toolName: 'Workspace Instructions',
          text: memorySummary,
        })
      }

      const skillsSummary = String(request.skillsSummary ?? '').trim()
      const skillsPrompt = String(request.skillsPrompt ?? '').trim()
      if (skillsSummary) {
        await appendEvent(job.id, {
          type: 'tool_start',
          toolId: 'codesurf-skills-context',
          toolName: 'Included Skills',
        })
        if (skillsPrompt) {
          await appendEvent(job.id, {
            type: 'tool_input',
            toolId: 'codesurf-skills-context',
            text: skillsPrompt,
          })
        }
        await appendEvent(job.id, {
          type: 'tool_summary',
          toolId: 'codesurf-skills-context',
          toolName: 'Included Skills',
          text: skillsSummary,
        })
      }

      // Codex is deliberately EXCLUDED from the harness path even when the
      // harness is enabled (A-PR1 #2c / honest-notes): the @ai-sdk/harness-codex
      // adapter cannot honor CodeSurf's 4 permission modes — it throws on any
      // non-'allow-all' permissionMode and its bridge hardcodes
      // sandboxMode:'danger-full-access' + approvalPolicy:'never'. Routing Codex
      // through it would either crash or silently grant full access regardless
      // of the user's chosen mode. The native `codex exec` CLI (runCodexJob)
      // honors all 4 modes via -s/--sandbox + -c approval_policy=, so Codex
      // always uses it. Tradeoff: Codex forgoes the harness's worktree isolation.
      //
      // shouldUseHarness() also excludes FOREGROUND Claude chat (continuity
      // stopgap) so those turns fall through to runClaudeJob, which resumes the
      // conversation — see the predicate's comment for the full rationale.
      if (shouldUseHarness(request)) {
        const { runHarnessJob } = await getHarnessRunner()
        await runHarnessJob(job, request, workspaceDir, instructionPrompt, {
          appendEvent,
          createCheckpoint: (toolName, filePaths) => createDaemonCheckpoint(job, request, toolName, filePaths),
          awaitToolPermission: (toolUseID, permissionRequest) => awaitToolPermissionAnswer(job, toolUseID, permissionRequest),
        })
      } else if (request.provider === 'claude') {
        await runClaudeJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'codex') {
        await runCodexJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'opencode') {
        await runOpenCodeJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'hermes') {
        await runHermesJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'omnigent') {
        await runOmnigentJob(job, request, workspaceDir, instructionPrompt)
      } else {
        await appendEvent(job.id, { type: 'error', error: `Daemon execution is only implemented for Claude, Codex, OpenCode, Hermes, and Omnigent right now. Requested: ${request.provider}` })
        await appendEvent(job.id, { type: 'done' })
      }
    } catch (err) {
      // Contain the failure to this job: emit terminal events so the client is
      // not left hanging, then let the finally block free the concurrency slot.
      console.error(`[chat-jobs] runJob error for job ${job.id}:`, err)
      try {
        await appendEvent(job.id, { type: 'error', error: err instanceof Error ? err.message : String(err) })
        await appendEvent(job.id, { type: 'done' })
      } catch (appendErr) {
        console.error(`[chat-jobs] failed to emit terminal events for job ${job.id}:`, appendErr)
      }
    } finally {
      liveJobs.delete(job.id)
      clearMetadataFlush(job.id)
      activeJobCount = Math.max(0, activeJobCount - 1)
      pumpJobQueue()
    }
  }

  // daemon-01: dispatch queued jobs while a concurrency slot is free. Called
  // after every enqueue (startJob) and every job completion (runJob finally).
  function pumpJobQueue() {
    while (activeJobCount < MAX_CONCURRENT_JOBS && jobQueue.length > 0) {
      const next = jobQueue.shift()
      if (!next?.live || !liveJobs.has(next.live.id)) continue // cancelled while queued
      activeJobCount += 1
      if (next.live.metadata?.status === 'queued') {
        next.live.metadata.status = 'running'
        next.live.metadata.updatedAt = new Date().toISOString()
        void writeJobMetadata(next.live.metadata).catch(() => {})
      }
      void runJob(next.live, next.request, next.workspaceDir)
    }
  }

  async function startJob(request) {
    const id = randomUUID()
    const effectiveProjectContext = applyProjectContextPolicy({
      executionTarget: request?.executionTarget,
      projectContext: request?.projectContext ?? { workspaceDir: request?.workspaceDir },
    })
    const workspaceDir = await ensureProvisionedWorkspace(homeDir, effectiveProjectContext)
    const initialPrompt = extractTaskLabelFromRequest(request)
    // daemon-01: if every slot is busy, persist as 'queued' from the start so
    // the dashboard/getJobState reflect reality; pumpJobQueue flips it to
    // 'running' the moment a slot frees.
    const startStatus = activeJobCount >= MAX_CONCURRENT_JOBS ? 'queued' : 'running'
    const metadata = {
      id,
      taskLabel: initialPrompt,
      status: startStatus,
      provider: request.provider,
      model: request.model,
      // A-PR1 #2b: persist the chosen permission mode so reopening a session
      // restores it (read back in codesurfd.mjs reconstructSessionState).
      mode: typeof request.mode === 'string' ? request.mode : null,
      runMode: request.runMode === 'background' ? 'background' : 'foreground',
      workspaceId: typeof request.workspaceId === 'string' ? request.workspaceId : null,
      cardId: typeof request.cardId === 'string' ? request.cardId : null,
      workspaceDir,
      initialPrompt,
      requestedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      lastSequence: 0,
      sessionId: typeof request.sessionId === 'string' ? request.sessionId : null,
      error: null,
    }
    await writeJobMetadata(metadata)
    await fs.writeFile(jobTimelinePath(id), '', 'utf8')
    const live = { id, metadata, cancel: null, proc: null, query: null }
    liveJobs.set(id, live)
    jobQueue.push({ live, request, workspaceDir })
    pumpJobQueue()
    return metadata
  }

  async function cancelJob(jobId) {
    const live = liveJobs.get(jobId)
    cancelPendingToolPermissionsForJob(jobId, 'Job cancelled')
    // daemon-01: a job still waiting in the queue has no live.cancel yet —
    // remove it from the queue and terminate it cleanly so it never starts.
    const queueIdx = jobQueue.findIndex(item => item.live?.id === jobId)
    if (queueIdx !== -1) {
      jobQueue.splice(queueIdx, 1)
      liveJobs.delete(jobId)
      await appendEvent(jobId, { type: 'error', error: 'Job cancelled' })
      await appendEvent(jobId, { type: 'done' })
      return { ok: true }
    }
    if (live?.cancel) {
      live.cancel()
      await appendEvent(jobId, { type: 'error', error: 'Job cancelled' })
      await appendEvent(jobId, { type: 'done' })
      return { ok: true }
    }
    return { ok: false, error: 'Job not running' }
  }

  async function getJobState(jobId) {
    return await readJobMetadata(jobId)
  }

  async function streamJob(jobId, sinceSequence, res) {
    const metadata = await readJobMetadata(jobId)
    if (!metadata) return false

    const raw = existsSync(jobTimelinePath(jobId))
      ? readFileSync(jobTimelinePath(jobId), 'utf8')
      : ''
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const payload = JSON.parse(trimmed)
        if (Number(payload.sequence ?? 0) > sinceSequence) {
          writeSseEvent(res, payload)
        }
      } catch {
        // ignore corrupt lines
      }
    }

    // Post-crash wedge guard: metadata may say 'running'/'queued' for a job
    // that is no longer live (daemon crashed/restarted). Registering a
    // subscriber would hang the client forever on a stream that never fires.
    // Emit a terminal pair and close instead.
    const statusActive = metadata.status === 'running' || metadata.status === 'queued'
    if (statusActive && !liveJobs.has(jobId)) {
      // Derive baseSeq from the actual max sequence in the timeline file to avoid
      // duplicate sequence numbers when metadata.lastSequence is stale after a crash.
      let baseSeq = Number(metadata.lastSequence ?? 0)
      for (const line of raw.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const seq = Number(JSON.parse(t).sequence ?? 0)
          if (seq > baseSeq) baseSeq = seq
        } catch { /* ignore */ }
      }
      writeSseEvent(res, { jobId, sequence: baseSeq + 1, timestamp: Date.now(), type: 'error', error: 'Job was interrupted (the daemon restarted)' })
      writeSseEvent(res, { jobId, sequence: baseSeq + 2, timestamp: Date.now(), type: 'done' })
      return false
    }

    // Hold the stream open for live jobs that are running OR still queued
    // (daemon-01): a queued job has no events yet, but it is live and will emit
    // once a concurrency slot frees, so the subscriber must wait, not close.
    if (metadata.status === 'running' || metadata.status === 'queued') {
      const listeners = subscribers.get(jobId) ?? new Set()
      listeners.add(res)
      subscribers.set(jobId, listeners)
      const cleanup = () => {
        const current = subscribers.get(jobId)
        if (!current) return
        current.delete(res)
        if (current.size === 0) subscribers.delete(jobId)
      }
      res.on('close', cleanup)
      res.on('error', cleanup)
      return true
    }

    return false
  }

  // daemon-05 (core): prune terminal job metadata + timeline jsonl past a TTL
  // so ~/.codesurf/jobs and /timelines do not grow without bound. Keeps the
  // newest `keepRecent` terminal jobs regardless of age, then deletes terminal
  // jobs older than `maxAgeMs`. Never touches live or active-status
  // (running/queued) jobs. Checkpoint-record retention is deliberately out of
  // scope here — it crosses into checkpoints.mjs + per-workspace dirs.
  async function sweepJobRetention({ maxAgeMs = 30 * 24 * 60 * 60 * 1000, keepRecent = 200 } = {}) {
    let entries
    try {
      entries = await fs.readdir(jobsDir)
    } catch {
      return { pruned: 0 }
    }
    const now = Date.now()
    const terminal = []
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (liveJobs.has(id)) continue
      let meta
      try {
        meta = JSON.parse(await fs.readFile(join(jobsDir, name), 'utf8'))
      } catch {
        continue
      }
      // Only genuinely terminal jobs are prunable; running/queued (and any
      // crashed-but-still-'running' record daemon-04 will reconcile) are left.
      if (meta?.status !== 'completed' && meta?.status !== 'failed') continue
      terminal.push({ id, completedAt: Date.parse(meta?.completedAt ?? '') || 0 })
    }
    terminal.sort((a, b) => b.completedAt - a.completedAt)
    let pruned = 0
    for (const { id, completedAt } of terminal.slice(keepRecent)) {
      if (completedAt && now - completedAt < maxAgeMs) continue
      try {
        await fs.rm(jobMetaPath(id), { force: true })
        await fs.rm(jobTimelinePath(id), { force: true })
        pruned += 1
      } catch { /* best effort */ }
    }
    return { pruned }
  }

  // Cancel every in-flight job and stop the heartbeat. Called from the daemon's
  // shutdown() so SIGTERM/SIGINT/uncaught errors do not orphan Claude SDK
  // queries or spawned codex/opencode/hermes CLI children (which run with
  // file-write access and would otherwise keep running, reparented to init).
  async function shutdown() {
    clearInterval(heartbeatTimer)
    for (const timer of metadataFlushTimers.values()) clearTimeout(timer)
    metadataFlushTimers.clear()
    const jobs = Array.from(liveJobs.values())
    const procsWithPid = []
    for (const live of jobs) {
      try { live.cancel?.() } catch { /* already gone */ }
      const proc = live.proc
      if (!proc) continue
      // Attempt to kill the entire process group (detached spawn)
      try { process.kill(-proc.pid, 'SIGTERM') } catch {
        try { proc.kill('SIGTERM') } catch { /* already gone */ }
      }
      procsWithPid.push(proc)
    }
    if (procsWithPid.length > 0) {
      // Wait for each process to exit (up to 3s total) before escalating to SIGKILL
      const exitPromises = procsWithPid.map(proc =>
        new Promise((resolve) => {
          if (proc.exitCode !== null) { resolve(undefined); return }
          proc.once('exit', resolve)
          proc.once('error', resolve)
        })
      )
      await Promise.race([
        Promise.all(exitPromises),
        new Promise((r) => setTimeout(r, 3000)),
      ])
      for (const proc of procsWithPid) {
        if (proc.exitCode !== null || proc.killed) continue
        try { process.kill(-proc.pid, 'SIGKILL') } catch {
          try { proc.kill('SIGKILL') } catch { /* already gone */ }
        }
      }
    }
  }

  return {
    startJob,
    cancelJob,
    answerToolPermission,
    getJobState,
    streamJob,
    shutdown,
    sweepJobRetention,
    listLiveJobIds() {
      return Array.from(liveJobs.keys())
    },
  }
}
