import { query } from '@anthropic-ai/claude-agent-sdk'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { buildMemoryPrompt, loadMemoryContext } from './memory-loader.mjs'
import { buildContextBucketBundle, describeContextBucketsForTool } from './context-buckets.mjs'
import { applyProjectContextPolicy } from './project-context.mjs'

const execFileAsync = promisify(execFile)

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true })
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
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
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

function summarizeMemoryContext(contextBuckets, instructionPrompt) {
  return describeContextBucketsForTool(contextBuckets, instructionPrompt).summary
}

function buildMemoryContextInput(contextBuckets, instructionPrompt) {
  return describeContextBucketsForTool(contextBuckets, instructionPrompt).input
}

function buildClaudeAgentPrompt(peers, asyncExecution, instructionPrompt, skillsPrompt) {
  const peerPrompt = buildClaudeSystemPrompt(peers)
  const asyncPrompt = buildAsyncExecutionPrompt(asyncExecution)
  return joinPromptSections(peerPrompt, instructionPrompt, skillsPrompt, asyncPrompt)
}

function buildCodexPrompt(userText, asyncExecution, instructionPrompt, skillsPrompt) {
  const asyncPrompt = buildAsyncExecutionPrompt(asyncExecution)
  const preamble = joinPromptSections(instructionPrompt, skillsPrompt, asyncPrompt)
  return preamble ? `${preamble}\n\n## User Request\n${userText}` : userText
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
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

export function createChatJobManager({ homeDir, checkpointStore = null, claudeQuery = query }) {
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  ensureDir(jobsDir)
  ensureDir(timelinesDir)

  const liveJobs = new Map()
  const subscribers = new Map()
  const sessionPermissionGrants = new Map()
  const pendingToolPermissions = new Map()

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
    await fs.writeFile(jobMetaPath(job.id), `${JSON.stringify(job, null, 2)}\n`, 'utf8')
  }

  async function appendEvent(jobId, event) {
    const live = liveJobs.get(jobId)
    const metadata = live?.metadata ?? await readJobMetadata(jobId)
    if (!metadata) return null

    metadata.lastSequence = Number(metadata.lastSequence ?? 0) + 1
    metadata.updatedAt = new Date().toISOString()
    if (event.sessionId) metadata.sessionId = event.sessionId
    if (event.type === 'error') {
      metadata.error = event.error ?? 'Unknown error'
    } else if (event.type === 'done') {
      metadata.status = metadata.error ? 'failed' : 'completed'
      metadata.completedAt = new Date().toISOString()
    }

    const payload = {
      jobId,
      sequence: metadata.lastSequence,
      timestamp: Date.now(),
      ...event,
    }

    await fs.appendFile(jobTimelinePath(jobId), `${JSON.stringify(payload)}\n`, 'utf8')
    await writeJobMetadata(metadata)

    if (live) {
      live.metadata = metadata
    }

    const listeners = subscribers.get(jobId)
    if (listeners) {
      for (const res of listeners) {
        writeSseEvent(res, payload)
      }
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
      ...(request.sessionId ? { resume: request.sessionId } : {}),
    }

    const systemPrompt = buildClaudeAgentPrompt(request.peers, request.asyncExecution, instructionPrompt, request.skillsPrompt)
    if (systemPrompt) {
      options.agent = 'contex'
      options.agents = {
        contex: {
          description: 'CodeSurf canvas AI agent with peer context',
          prompt: systemPrompt,
        },
      }
    }

    try {
      const q = claudeQuery({ prompt: lastUserMsg.content, options })
      job.query = q
      let emittedDone = false

      for await (const msg of q) {
        const sid = msg?.session_id
        if (sid) {
          await appendEvent(job.id, { type: 'session', sessionId: sid })
        }

        if (msg.type === 'stream_event') {
          const evt = msg.event
          if (evt?.type === 'content_block_delta') {
            if (evt.delta?.type === 'text_delta' && evt.delta.text) {
              await appendEvent(job.id, { type: 'text', text: evt.delta.text })
            } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
              await appendEvent(job.id, { type: 'thinking', text: evt.delta.thinking })
            } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
              await appendEvent(job.id, { type: 'tool_input', text: evt.delta.partial_json })
            }
          } else if (evt?.type === 'content_block_start') {
            if (evt.content_block?.type === 'tool_use') {
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
            for (const block of message.content) {
              if (block.type === 'tool_use') {
                await appendEvent(job.id, {
                  type: 'tool_use',
                  toolName: block.name,
                  toolId: block.id,
                  toolInput: JSON.stringify(block.input, null, 2),
                })
              }
            }
          }
        } else if (msg.type === 'tool_use_summary') {
          await appendEvent(job.id, {
            type: 'tool_summary',
            text: msg.summary,
          })
        } else if (msg.type === 'tool_progress') {
          await appendEvent(job.id, {
            type: 'tool_progress',
            toolName: msg.tool_name,
            elapsed: msg.elapsed_time_seconds,
          })
        } else if (msg.type === 'result') {
          emittedDone = true
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
        await appendEvent(job.id, { type: 'done' })
      }
    } catch (error) {
      await appendEvent(job.id, {
        type: 'error',
        error: formatClaudeSdkError(error, claudeStderr),
      })
      await appendEvent(job.id, { type: 'done' })
    }
  }

  async function runCodexJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const codexMode = ['default', 'auto', 'read-only', 'full-access'].includes(request.mode)
      ? request.mode
      : 'default'
    const codexArgs = [
      'exec',
      '--json',
      '--model',
      request.model,
      '--skip-git-repo-check',
      ...(workspaceDir ? ['-C', workspaceDir] : []),
    ]
    if (codexMode === 'full-access') {
      codexArgs.push('--dangerously-bypass-approvals-and-sandbox')
    } else if (codexMode === 'auto') {
      codexArgs.push('--full-auto')
    } else if (codexMode === 'read-only') {
      codexArgs.push('--sandbox', 'read-only')
    } else {
      codexArgs.push('--sandbox', 'workspace-write')
    }
    codexArgs.push(buildCodexPrompt(lastUserMsg.content, request.asyncExecution, instructionPrompt, request.skillsPrompt))

    const proc = spawn('codex', codexArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    job.proc = proc
    job.cancel = () => proc.kill('SIGTERM')

    const pendingSnapshots = new Map()
    const aggregatedFileChanges = new Map()
    const exploreEntries = []
    let editsStarted = false
    let exploreStarted = false
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
        if (kind === 'search' || kind === 'read') {
          if (!exploreStarted) {
            await appendEvent(job.id, { type: 'tool_start', toolId: 'codex-explore', toolName: 'Exploring workspace' })
            exploreStarted = true
          }
          exploreEntries.push({
            label: command,
            command,
            output: sanitizeToolOutputText(typeof item.aggregated_output === 'string' ? item.aggregated_output : ''),
            kind,
          })
          await appendEvent(job.id, {
            type: 'tool_summary',
            toolId: 'codex-explore',
            toolName: buildExploreToolName(exploreEntries),
            commandEntries: [...exploreEntries],
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

  function hermesToolsetsForRequest(request) {
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

  async function runHermesJob(job, request, workspaceDir, instructionPrompt) {
    const lastUserMsg = [...(request.messages ?? [])].reverse().find(message => message.role === 'user')
    if (!lastUserMsg) {
      await appendEvent(job.id, { type: 'error', error: 'No user message' })
      await appendEvent(job.id, { type: 'done' })
      return
    }

    const prompt = buildCodexPrompt(lastUserMsg.content, request.asyncExecution, instructionPrompt, request.skillsPrompt)
    const proc = spawn('hermes', buildHermesChatArgs({
      prompt,
      model: request.model,
      provider: request.providerId ?? request.modelProvider ?? request.providerName,
      toolsets: hermesToolsetsForRequest(request),
      resumeSessionId: request.sessionId,
      ignoreRules: Boolean(instructionPrompt || request.skillsPrompt || request.contextBuckets || request.memoryPrompt),
      bypassPermissions: request.mode === 'bypassPermissions',
    }), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      ...(workspaceDir ? { cwd: workspaceDir } : {}),
    })

    job.proc = proc
    job.cancel = () => proc.kill('SIGTERM')

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

    const prompt = buildCodexPrompt(lastUserMsg.content, request.asyncExecution, instructionPrompt, request.skillsPrompt)
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
    })

    job.proc = proc
    job.cancel = () => proc.kill('SIGTERM')

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

  async function runJob(job, request, workspaceDir) {
    try {
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

      if (request.provider === 'claude') {
        await runClaudeJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'codex') {
        await runCodexJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'opencode') {
        await runOpenCodeJob(job, request, workspaceDir, instructionPrompt)
      } else if (request.provider === 'hermes') {
        await runHermesJob(job, request, workspaceDir, instructionPrompt)
      } else {
        await appendEvent(job.id, { type: 'error', error: `Daemon execution is only implemented for Claude, Codex, OpenCode, and Hermes right now. Requested: ${request.provider}` })
        await appendEvent(job.id, { type: 'done' })
      }
    } finally {
      liveJobs.delete(job.id)
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
    const metadata = {
      id,
      taskLabel: initialPrompt,
      status: 'running',
      provider: request.provider,
      model: request.model,
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
    void runJob(live, request, workspaceDir)
    return metadata
  }

  async function cancelJob(jobId) {
    const live = liveJobs.get(jobId)
    cancelPendingToolPermissionsForJob(jobId, 'Job cancelled')
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

    if (metadata.status === 'running') {
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

  return {
    startJob,
    cancelJob,
    answerToolPermission,
    getJobState,
    streamJob,
    listLiveJobIds() {
      return Array.from(liveJobs.keys())
    },
  }
}
