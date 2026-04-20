import { execFileSync, spawn } from 'child_process'
import { query, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { RelayAgentExecutor, RelaySpawnRequest, RelayTurnInput } from '../../../packages/contex-relay/src'
import { getAgentPath, getShellEnvPath } from '../agent-paths'
import { resolveStoredPermission } from '../permissions'

const claudeSessions = new Map<string, string>()

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
  const workspaceDir = typeof spawnRequest.metadata?.workspaceDir === 'string'
    ? spawnRequest.metadata.workspaceDir
    : typeof spawnRequest.metadata?.projectPath === 'string'
      ? spawnRequest.metadata.projectPath
      : typeof spawnRequest.metadata?.cwd === 'string'
        ? spawnRequest.metadata.cwd
        : null
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
      canUseTool: async (toolName: string, _input: Record<string, unknown>, toolOptions: any) => {
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
  return await new Promise<string>((resolve, reject) => {
    const proc = spawn(codexBin, [
      'exec',
      '--model', spawnRequest.model ?? 'gpt-5.3-codex',
      '--approval-mode', spawnRequest.mode ?? 'read-only',
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
        reject(new Error(stderr.trim() || `Codex exited with ${code}`))
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function runOpenCodeTurn(spawnRequest: RelaySpawnRequest, input: RelayTurnInput, timeoutMs = 300_000): Promise<string> {
  const opencodeBin = getAgentPath('opencode') || 'opencode'
  const shellPath = getShellEnvPath()
  
  // Map mode to OpenCode approval mode
  const modeMap: Record<string, string> = {
    'default': 'suggest',
    'acceptEdits': 'auto-edit',
    'plan': 'suggest',
    'bypassPermissions': 'full-auto',
  }
  const approvalMode = modeMap[spawnRequest.mode ?? ''] ?? 'suggest'
  
  return await new Promise<string>((resolve, reject) => {
    const args = [
      'run',
      '--approval-mode', approvalMode,
      '--format', 'json',
    ]
    
    if (spawnRequest.model) {
      args.push('--model', spawnRequest.model)
    }
    
    args.push(input.prompt)
    
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
        reject(new Error(stderr.trim() || `OpenCode exited with ${code}`))
        return
      }
      
      // Try to extract JSON from stdout
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          resolve(jsonMatch[0])
        } else {
          resolve(stdout.trim())
        }
      } catch {
        resolve(stdout.trim())
      }
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
    }).trim()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function selectOpenClawAgentId(openclawBin: string, shellPath?: string | null, preferredModel?: string | null): string {
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

    const requestedFamily = requested.includes('/') ? requested.split('/')[0] : requested.split('-')[0]
    const familyStable = agents.find(agent => {
      if (!isStable(agent.id)) return false
      const model = normalizeOpenClawModelRef(agent.model)
      return model.startsWith(`${requestedFamily}/`) || model.includes(requestedFamily)
    })
    if (familyStable) return familyStable.id
  }

  return agents.find(agent => agent.isDefault)?.id ?? agents[0]?.id ?? 'main'
}

function extractOpenClawTextPayload(payload: any): string {
  if (!payload || typeof payload !== 'object') return ''
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.content === 'string') return payload.content
  if (typeof payload.message === 'string') return payload.message
  if (typeof payload.summary === 'string') return payload.summary
  if (Array.isArray(payload.parts)) {
    return payload.parts
      .map((part: any) => typeof part?.text === 'string' ? part.text : '')
      .filter(Boolean)
      .join('')
  }
  return ''
}

async function runOpenClawTurn(spawnRequest: RelaySpawnRequest, input: RelayTurnInput, timeoutMs = 300_000): Promise<string> {
  const openclawBin = getAgentPath('openclaw') || 'openclaw'
  const shellPath = getShellEnvPath()
  const agentId = selectOpenClawAgentId(openclawBin, shellPath, spawnRequest.model)

  return await new Promise<string>((resolve, reject) => {
    const args = ['agent', '--json', '--agent', agentId, '--message', input.prompt]

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
        reject(new Error(stderr.trim() || stdout.trim() || `OpenClaw exited with ${code}`))
        return
      }

      try {
        const parsed = JSON.parse(stdout)
        const payloads = Array.isArray(parsed?.payloads)
          ? parsed.payloads
          : Array.isArray(parsed?.result?.payloads)
            ? parsed.result.payloads
            : []
        const text = payloads
          .map((payload: any) => extractOpenClawTextPayload(payload))
          .filter(Boolean)
          .join('\n\n')
          || parsed?.summary
          || parsed?.result?.summary
          || ''
        resolve(text.trim())
      } catch {
        resolve(stdout.trim())
      }
    })
  })
}

async function runHermesTurn(spawnRequest: RelaySpawnRequest, input: RelayTurnInput, timeoutMs = 300_000): Promise<string> {
  const hermesBin = getAgentPath('hermes') || 'hermes'
  const shellPath = getShellEnvPath()

  // Map mode to hermes toolsets
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

  return await new Promise<string>((resolve, reject) => {
    const args = ['chat', '--query', input.prompt, '--quiet', '--source', 'tool']

    if (spawnRequest.model) {
      args.push('--model', spawnRequest.model)
    }

    if (toolsets) {
      args.push('--toolsets', toolsets)
    }

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
        reject(new Error(stderr.trim() || `Hermes exited with ${code}`))
        return
      }
      const cleaned = stdout
        .replace(/^\s*(?:session_id|session)\s*:\s*\S+\s*$/gmi, '')
        .trim()
      resolve(cleaned)
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
        return runOpenCodeTurn(this.spawnRequest, input, this.spawnRequest.timeoutMs)
      case 'openclaw':
        return runOpenClawTurn(this.spawnRequest, input, this.spawnRequest.timeoutMs)
      case 'hermes':
        return runHermesTurn(this.spawnRequest, input, this.spawnRequest.timeoutMs)
      default:
        throw new Error(`Unsupported relay provider: ${this.spawnRequest.provider ?? 'unknown'}`)
    }
  }
}

export function createMainProcessRelayExecutor(participantId: string, spawnRequest: RelaySpawnRequest): RelayAgentExecutor {
  return new MainProcessRelayExecutor(participantId, spawnRequest)
}
