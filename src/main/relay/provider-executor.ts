import { execFileSync, spawn } from 'child_process'
import { tmpdir } from 'os'
import { sep, resolve as resolvePath } from 'path'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { RelayAgentExecutor, RelaySpawnRequest, RelayTurnInput } from '../../../packages/contex-relay/src'
import { getAgentPath, getShellEnvPath } from '../agent-paths'
import {
  buildHermesChatArgs,
  buildOpenClawAgentArgs,
  buildOpenCodeRunArgs,
  parseHermesOutput,
  parseOpenClawOutput,
  parseOpenCodeRunOutput,
  sanitizeAgentCliDiagnostic,
} from '../agents/agent-cli-contracts'
import { resolveStoredPermission } from '../permissions'
import { CONTEX_HOME } from '../paths'

// Daemon-produced paths that should be intrinsically Read-allowed without
// requiring a workspace-level grant. These directories exist solely because
// the user attached, dropped, or sketched an image inside the chat tile —
// auto-allowing Reads from them matches user intent ("show this to the agent")
// and prevents the maddening per-attachment permission prompts.
//
// Scope: Read only. Write/Edit on these paths still go through the normal
// grant flow — the daemon shouldn't mutate user attachments without consent.
//
// Trust model: the producer (Contex itself) is trusted. The consumer (the
// agent) is gated by the user's intent ("I attached this image"). Same
// pattern as ~/.fieldtheory/librarian/ in the Claude Code hook chain.
const DAEMON_AUTOREAD_PREFIXES: string[] = [
  resolvePath(CONTEX_HOME, 'chat-attachments') + sep,
  resolvePath(CONTEX_HOME, 'chat-vision') + sep,
  // Legacy compat: the pre-fix build wrote sketches under
  // os.tmpdir()/contex-chat-attach. Keep this in the allowlist until all
  // dist-electron bundles in the wild have been rebuilt with the fix that
  // moved sketches into CONTEX_HOME.
  resolvePath(tmpdir(), 'contex-chat-attach') + sep,
]

function isDaemonAutoReadablePath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0) return false
  let resolved: string
  try { resolved = resolvePath(filePath) } catch { return false }
  return DAEMON_AUTOREAD_PREFIXES.some(prefix => resolved.startsWith(prefix))
}

const claudeSessions = new Map<string, string>()
const hermesSessions = new Map<string, string>()
const openClawSessions = new Map<string, string>()
const openCodeSessions = new Map<string, string>()
const OPENCLAW_AGENT_LIST_TIMEOUT_MS = 15_000

function workspaceDirFromSpawnRequest(spawnRequest: RelaySpawnRequest): string | null {
  return typeof spawnRequest.metadata?.workspaceDir === 'string'
    ? spawnRequest.metadata.workspaceDir
    : typeof spawnRequest.metadata?.projectPath === 'string'
      ? spawnRequest.metadata.projectPath
      : typeof spawnRequest.metadata?.cwd === 'string'
        ? spawnRequest.metadata.cwd
        : null
}

function modeForClaude(mode?: string): string {
  const modeMap: Record<string, string> = {
    default: 'default',
    acceptEdits: 'acceptEdits',
    plan: 'plan',
    bypassPermissions: 'bypassPermissions',
  }
  return modeMap[mode ?? 'plan'] ?? 'plan'
}

function thinkingForClaude(thinking?: string): { type: string; budget_tokens?: number } {
  const thinkingMap: Record<string, { type: string; budget_tokens?: number }> = {
    adaptive: { type: 'adaptive' },
    none: { type: 'disabled' },
    low: { type: 'enabled', budget_tokens: 2048 },
    medium: { type: 'enabled', budget_tokens: 8192 },
    high: { type: 'enabled', budget_tokens: 32768 },
    max: { type: 'enabled', budget_tokens: 131072 },
  }
  return thinkingMap[thinking ?? 'adaptive'] ?? { type: 'adaptive' }
}

async function runClaudeTurn(participantId: string, spawnRequest: RelaySpawnRequest, input: RelayTurnInput, timeoutMs = 300_000): Promise<string> {
  const claudePermissionMode = modeForClaude(spawnRequest.mode)
  const workspaceDir = workspaceDirFromSpawnRequest(spawnRequest)
  const options: Options = {
    model: spawnRequest.model ?? 'claude-sonnet-4-6',
    permissionMode: claudePermissionMode as any,
    thinking: thinkingForClaude(spawnRequest.thinking) as any,
    persistSession: true,
    includePartialMessages: false,
    ...(claudePermissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    ...(claudePermissionMode !== 'bypassPermissions' ? {
      // Background relay has no UI, so we can only consult the persisted
      // permission store — any tool without a standing allow-grant is
      // rejected. A `never` (persistent deny) grant now produces a
      // distinct, clearer message so the user knows why calls keep
      // failing and where to clear it.
      canUseTool: async (toolName: string, input: Record<string, unknown>, toolOptions: any) => {
        // ── Path-based auto-allow for daemon-produced attachments ──────
        // Read calls against ~/.codesurf/chat-attachments/ and chat-vision/
        // (and the legacy tmpdir path) bypass the stored-grant check.
        // These directories are produced exclusively by Contex IPC
        // handlers in response to user actions (attaching / sketching),
        // so a Read against them is implicitly user-consented.
        if (toolName === 'Read' && typeof input?.file_path === 'string' && isDaemonAutoReadablePath(input.file_path)) {
          return { behavior: 'allow', toolUseID: toolOptions?.toolUseID }
        }

        const decision = resolveStoredPermission({
          provider: 'claude',
          toolName,
          title: typeof toolOptions?.title === 'string' ? toolOptions.title : null,
          description: typeof toolOptions?.description === 'string' ? toolOptions.description : null,
          blockedPath: typeof toolOptions?.blockedPath === 'string' ? toolOptions.blockedPath : null,
          workspaceDir,
        })

        if (decision === 'allow') {
          return { behavior: 'allow', toolUseID: toolOptions?.toolUseID }
        }
        if (decision === 'deny') {
          return {
            behavior: 'deny',
            message: `Permission for ${toolName} is set to Never. Clear it in Settings → Permissions to re-enable prompts.`,
            toolUseID: toolOptions?.toolUseID,
          }
        }

        return {
          behavior: 'deny',
          message: `Permission required for ${toolName}. Save a session, all-day, or all-time grant from an interactive chat before using this relay agent.`,
          toolUseID: toolOptions?.toolUseID,
        }
      },
    } : {}),
  }

  const existingSessionId = claudeSessions.get(participantId)
  if (existingSessionId) {
    options.resume = existingSessionId
  }

  const claudePath = getAgentPath('claude')
  if (claudePath) {
    ;(options as any).pathToClaudeCodeExecutable = claudePath
  }

  const q = query({ prompt: input.prompt, options })
  let text = ''

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`Claude turn timed out after ${timeoutMs}ms`)), timeoutMs)
  })

  const queryPromise = (async () => {
    for await (const msg of q) {
      const sid = (msg as any).session_id
      if (sid) claudeSessions.set(participantId, sid)

      if (msg.type === 'assistant') {
        const blocks = (msg as any).message?.content ?? []
        const blockText = blocks
          .filter((block: any) => block.type === 'text' && typeof block.text === 'string')
          .map((block: any) => block.text)
          .join('')
        if (blockText) text += blockText
      }

      if (msg.type === 'result') {
        const result = (msg as any).result
        if (typeof result === 'string' && result.trim()) return result
      }
    }
    return text
  })()

  return Promise.race([queryPromise, timeoutPromise])
}

async function runCodexTurn(spawnRequest: RelaySpawnRequest, input: RelayTurnInput, timeoutMs = 300_000): Promise<string> {
  const codexBin = getAgentPath('codex') || 'codex'
  const shellPath = getShellEnvPath()
  const workspaceDir = workspaceDirFromSpawnRequest(spawnRequest)
  const mode = spawnRequest.mode ?? 'default'
  const modeArgs = mode === 'bypassPermissions' || mode === 'full-access'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : mode === 'auto' || mode === 'full-auto'
      ? ['--full-auto']
      : mode === 'read-only' || mode === 'plan'
        ? ['--sandbox', 'read-only']
        : ['--sandbox', 'workspace-write']
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(codexBin, [
      'exec',
      '--model', spawnRequest.model ?? 'gpt-5.3-codex',
      ...modeArgs,
      '--skip-git-repo-check',
      ...(workspaceDir ? ['-C', workspaceDir] : []),
      input.prompt,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
      reject(new Error(`Codex turn timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stdout?.on('data', chunk => { stdout += chunk.toString() })
    proc.stderr?.on('data', chunk => { stderr += chunk.toString() })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    proc.on('close', code => {
      clearTimeout(timer)
      if (timedOut) return
      if (code !== 0) {
        reject(new Error(sanitizeAgentCliDiagnostic(stderr.trim() || `Codex exited with ${code}`)))
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function runOpenCodeTurn(participantId: string, spawnRequest: RelaySpawnRequest, input: RelayTurnInput, timeoutMs = 300_000): Promise<string> {
  const opencodeBin = getAgentPath('opencode') || 'opencode'
  const shellPath = getShellEnvPath()
  const workspaceDir = workspaceDirFromSpawnRequest(spawnRequest)
  const existingSessionId = openCodeSessions.get(participantId) ?? null
  const agent = typeof spawnRequest.metadata?.agent === 'string'
    ? spawnRequest.metadata.agent
    : typeof spawnRequest.metadata?.agentName === 'string'
      ? spawnRequest.metadata.agentName
      : null

  return await new Promise<string>((resolve, reject) => {
    const args = buildOpenCodeRunArgs({
      prompt: input.prompt,
      model: spawnRequest.model,
      agent,
      sessionId: existingSessionId,
      cwd: workspaceDir,
      bypassPermissions: spawnRequest.mode === 'bypassPermissions',
    })

    const proc = spawn(opencodeBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
      reject(new Error(`OpenCode turn timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stdout?.on('data', chunk => { stdout += chunk.toString() })
    proc.stderr?.on('data', chunk => { stderr += chunk.toString() })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    proc.on('close', code => {
      clearTimeout(timer)
      if (timedOut) return
      if (code !== 0) {
        reject(new Error(sanitizeAgentCliDiagnostic(stderr.trim() || stdout.trim() || `OpenCode exited with ${code}`)))
        return
      }

      const parsed = parseOpenCodeRunOutput(stdout)
      if (parsed.sessionId) openCodeSessions.set(participantId, parsed.sessionId)
      resolve(parsed.text || stdout.trim())
    })
  })
}

function normalizeOpenClawModelRef(model?: string | null): string {
  return (model ?? '').trim().toLowerCase()
}

function parseOpenClawAgents(openclawBin: string, shellPath?: string | null): Array<{ id: string; name?: string; model?: string; isDefault?: boolean }> {
  try {
    const raw = execFileSync(openclawBin, ['agents', 'list', '--json'], {
      encoding: 'utf-8',
      env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
      timeout: OPENCLAW_AGENT_LIST_TIMEOUT_MS,
      windowsHide: true,
    }).trim()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function selectOpenClawAgentId(openclawBin: string, shellPath?: string | null, preferredModel?: string | null): string | null {
  const agents = parseOpenClawAgents(openclawBin, shellPath)
  if (agents.length === 0) return 'main'

  const requested = normalizeOpenClawModelRef(preferredModel)
  const isStable = (id: string): boolean => !id.startsWith('mc-gateway-') && !/^lead-[0-9a-f-]+$/i.test(id)

  if (requested) {
    const directStable = agents.find(agent => isStable(agent.id) && normalizeOpenClawModelRef(agent.id) === requested)
    if (directStable) return directStable.id

    const directAny = agents.find(agent => normalizeOpenClawModelRef(agent.id) === requested)
    if (directAny) return directAny.id

    const exactStable = agents.find(agent => isStable(agent.id) && normalizeOpenClawModelRef(agent.model) === requested)
    if (exactStable) return exactStable.id

    const exactAny = agents.find(agent => normalizeOpenClawModelRef(agent.model) === requested)
    if (exactAny) return exactAny.id

    return null
  }

  return agents.find(agent => agent.isDefault)?.id ?? agents[0]?.id ?? 'main'
}

async function runOpenClawTurn(participantId: string, spawnRequest: RelaySpawnRequest, input: RelayTurnInput, timeoutMs = 300_000): Promise<string> {
  const openclawBin = getAgentPath('openclaw') || 'openclaw'
  const shellPath = getShellEnvPath()
  const existingSessionId = openClawSessions.get(participantId) ?? null
  const agentId = existingSessionId ? null : selectOpenClawAgentId(openclawBin, shellPath, spawnRequest.model)
  if (!existingSessionId && !agentId) {
    const agents = parseOpenClawAgents(openclawBin, shellPath)
    const available = agents
      .map(agent => agent.model || agent.id)
      .filter((value, index, all): value is string => typeof value === 'string' && value.trim().length > 0 && all.indexOf(value) === index)
    const details = available.length > 0 ? ` Available: ${available.join(', ')}` : ''
    throw new Error(`OpenClaw model must match exactly: ${spawnRequest.model}.${details}`)
  }

  return await new Promise<string>((resolve, reject) => {
    const args = buildOpenClawAgentArgs({
      prompt: input.prompt,
      agentId,
      sessionId: existingSessionId,
      thinking: spawnRequest.thinking,
    })

    const proc = spawn(openclawBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
      reject(new Error(`OpenClaw turn timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return
      if (code !== 0) {
        reject(new Error(sanitizeAgentCliDiagnostic(stderr.trim() || stdout.trim() || `OpenClaw exited with ${code}`)))
        return
      }

      const parsed = parseOpenClawOutput(stdout)
      if (parsed.sessionId) openClawSessions.set(participantId, parsed.sessionId)
      resolve(parsed.text || stdout.trim())
    })
  })
}

async function runHermesTurn(participantId: string, spawnRequest: RelaySpawnRequest, input: RelayTurnInput, timeoutMs = 300_000): Promise<string> {
  const hermesBin = getAgentPath('hermes') || 'hermes'
  const shellPath = getShellEnvPath()

  // Map mode to Hermes toolsets. CodeSurf owns the context envelope, so Hermes
  // should not independently inject workspace rules unless a future UI exposes
  // that as an inspected choice.
  const modeMap: Record<string, string> = {
    'full': 'terminal,file,web,browser',
    'terminal': 'terminal,file',
    'web': 'web,browser',
    'query': '',
    'bypassPermissions': 'terminal,file,web,browser',
    'default': 'terminal,file',
    'plan': '',
  }
  const toolsets = modeMap[spawnRequest.mode ?? ''] ?? 'terminal,file'
  const existingSessionId = hermesSessions.get(participantId) ?? null
  const provider = typeof spawnRequest.metadata?.provider === 'string'
    ? spawnRequest.metadata.provider
    : null

  return await new Promise<string>((resolve, reject) => {
    const args = buildHermesChatArgs({
      prompt: input.prompt,
      model: spawnRequest.model,
      provider,
      toolsets,
      resumeSessionId: existingSessionId,
      ignoreRules: true,
      bypassPermissions: spawnRequest.mode === 'bypassPermissions',
    })

    const proc = spawn(hermesBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(shellPath && { PATH: shellPath }) },
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      proc.kill('SIGTERM')
      reject(new Error(`Hermes turn timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) return
      if (code !== 0) {
        reject(new Error(sanitizeAgentCliDiagnostic(stderr.trim() || `Hermes exited with ${code}`)))
        return
      }
      const parsed = parseHermesOutput(stdout)
      if (parsed.sessionId) hermesSessions.set(participantId, parsed.sessionId)
      resolve(parsed.text)
    })
  })
}

class MainProcessRelayExecutor implements RelayAgentExecutor {
  constructor(
    private readonly participantId: string,
    private readonly spawnRequest: RelaySpawnRequest,
  ) {}

  async runTurn(input: RelayTurnInput): Promise<string> {
    switch (this.spawnRequest.provider) {
      case 'claude':
        return runClaudeTurn(this.participantId, this.spawnRequest, input, this.spawnRequest.timeoutMs)
      case 'codex':
        return runCodexTurn(this.spawnRequest, input, this.spawnRequest.timeoutMs)
      case 'opencode':
        return runOpenCodeTurn(this.participantId, this.spawnRequest, input, this.spawnRequest.timeoutMs)
      case 'openclaw':
        return runOpenClawTurn(this.participantId, this.spawnRequest, input, this.spawnRequest.timeoutMs)
      case 'hermes':
        return runHermesTurn(this.participantId, this.spawnRequest, input, this.spawnRequest.timeoutMs)
      default:
        throw new Error(`Unsupported relay provider: ${this.spawnRequest.provider ?? 'unknown'}`)
    }
  }
}

export function createMainProcessRelayExecutor(participantId: string, spawnRequest: RelaySpawnRequest): RelayAgentExecutor {
  return new MainProcessRelayExecutor(participantId, spawnRequest)
}
