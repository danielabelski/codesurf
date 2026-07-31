import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { AppSettings, Persona, Workspace } from '../../src/shared/types.ts'
import type { ChatRequest } from '../../src/main/chat/types.ts'
import { resolveAuthoritativeAgentMode } from '../../src/main/chat/agent-mode-resolver.ts'
import {
  applyAuthoritativePersonaPolicy,
  canonicalizeElectronChatRequest,
} from '../../src/main/chat/request-policy.ts'
import {
  buildClaudeAgentModeOptions,
  buildCodexSpawnArgs,
  buildHermesSpawnArgs,
} from '../../src/main/chat/providers/agent-mode-payloads.ts'
import {
  validateCanonicalFsPathDetails,
  type FsPathIntent,
  type ValidatedFsPath,
} from '../../src/main/ipc/fs.ts'

export type ElectrobunChatRequest = Partial<ChatRequest> & Pick<ChatRequest, 'cardId'>

export interface ElectrobunWorkspaceAuthority {
  settings: AppSettings
  workspaces: Workspace[]
}

export interface AuthorizedElectrobunPath {
  path: ValidatedFsPath
  workspaceId: string | null
  allowedRoots: string[]
}

function workspaceRoots(workspace: Workspace | null | undefined): string[] {
  if (!workspace) return []
  const roots = new Set<string>()
  const candidates = [workspace.path, ...(workspace.projectPaths ?? [])]
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim()
    if (value) roots.add(path.resolve(value))
  }
  return [...roots]
}

export function findElectrobunWorkspace(
  workspaces: Workspace[],
  workspaceId: unknown,
): Workspace {
  const id = typeof workspaceId === 'string' ? workspaceId.trim() : ''
  if (!id) throw new Error('Access denied: workspaceId is required while filesystem scoping is enabled')
  const workspace = workspaces.find(candidate => candidate.id === id)
  if (!workspace) throw new Error(`Access denied: workspace not found: ${id}`)
  return workspace
}

export async function authorizeElectrobunFsPath(options: ElectrobunWorkspaceAuthority & {
  filePath: string
  intent: FsPathIntent
  workspaceId?: unknown
  allowReadOnlyOpenCodeConfig?: boolean
}): Promise<AuthorizedElectrobunPath> {
  const restrictToWorkspaceRoots = options.settings.security.restrictFsToWorkspaceRoots
  if (!restrictToWorkspaceRoots) {
    return {
      path: await validateCanonicalFsPathDetails(options.filePath, options.intent, {
        allowReadOnlyOpenCodeConfig: options.allowReadOnlyOpenCodeConfig,
      }),
      workspaceId: null,
      allowedRoots: [],
    }
  }

  const workspace = findElectrobunWorkspace(options.workspaces, options.workspaceId)
  const allowedRoots = workspaceRoots(workspace)
  return {
    path: await validateCanonicalFsPathDetails(options.filePath, options.intent, {
      restrictToWorkspaceRoots: true,
      allowedRoots,
      allowReadOnlyOpenCodeConfig: options.allowReadOnlyOpenCodeConfig,
    }),
    workspaceId: workspace.id,
    allowedRoots,
  }
}

/**
 * Terminal creation has no workspaceId field in the preload contract. Resolve
 * its cwd only by matching the canonical candidate against host-owned workspace
 * records, then run the same scoped path validator used by fs:* handlers.
 */
export async function authorizeElectrobunTerminalPath(options: ElectrobunWorkspaceAuthority & {
  filePath: string
  intent?: FsPathIntent
}): Promise<AuthorizedElectrobunPath> {
  const intent = options.intent ?? 'directory'
  if (!options.settings.security.restrictFsToWorkspaceRoots) {
    return await authorizeElectrobunFsPath({ ...options, intent })
  }

  const unscoped = await validateCanonicalFsPathDetails(options.filePath, intent)
  const candidates: Array<{ workspace: Workspace, root: string }> = []
  for (const workspace of options.workspaces) {
    for (const root of workspaceRoots(workspace)) {
      try {
        const canonicalRoot = await realpath(root)
        if (
          unscoped.operationPath === canonicalRoot
          || unscoped.operationPath.startsWith(`${canonicalRoot}${path.sep}`)
        ) {
          candidates.push({ workspace, root: canonicalRoot })
        }
      } catch {
        // A missing or broken configured root cannot authorize a terminal cwd.
      }
    }
  }
  candidates.sort((left, right) => right.root.length - left.root.length)
  const selected = candidates[0]?.workspace
  if (!selected) {
    throw new Error(`Access denied: terminal path "${options.filePath}" is outside registered workspace roots`)
  }
  return await authorizeElectrobunFsPath({
    ...options,
    intent,
    workspaceId: selected.id,
  })
}

function primaryWorkspaceRoot(workspace: Workspace | null | undefined): string | null {
  return workspaceRoots(workspace)[0] ?? null
}

export async function canonicalizeElectrobunChatRequest(
  request: ElectrobunChatRequest,
  workspaces: Workspace[],
): Promise<ChatRequest> {
  const canonical = await canonicalizeElectronChatRequest(
    request as ChatRequest,
    workspaceId => primaryWorkspaceRoot(
      workspaces.find(workspace => workspace.id === workspaceId),
    ),
  )
  const resolution = await resolveAuthoritativeAgentMode({
    agentId: canonical.agentId ?? null,
    resolveWorkspaceRoot: () => canonical.workspaceDir ?? null,
  })
  if (!resolution.ok) throw new Error(resolution.error)
  return applyAuthoritativePersonaPolicy(canonical, resolution.agentMode)
}

function claudePermissionMode(mode: unknown): string {
  switch (mode) {
    case 'acceptEdits':
    case 'auto':
    case 'bypassPermissions':
    case 'dontAsk':
    case 'plan':
      return mode
    case 'read-only':
      return 'plan'
    default:
      return 'manual'
  }
}

export function buildElectrobunClaudeSpawnArgs(
  request: ChatRequest,
  prompt: string,
  resumeSessionId?: string | null,
): string[] {
  const { tools, persona } = buildClaudeAgentModeOptions(request)
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages']
  if (request.model) args.push('--model', request.model)
  args.push('--permission-mode', claudePermissionMode(request.mode))
  if (persona) args.push('--append-system-prompt', persona)
  if (tools !== undefined) args.push('--tools', tools.join(','))
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  args.push(prompt)
  return args
}

export function buildElectrobunCodexSpawnArgs(
  request: ChatRequest,
  prompt: string,
  workspaceDir: string,
  resumeThreadId?: string | null,
): string[] {
  return buildCodexSpawnArgs({
    agentId: request.agentId,
    agentMode: request.agentMode,
    mode: request.mode,
    model: request.model || 'gpt-5.5',
    userContent: prompt,
    resumeThreadId,
    workspaceDir,
  })
}

export function buildElectrobunHermesSpawnArgs(
  request: ChatRequest,
  prompt: string,
  resumeSessionId?: string | null,
): string[] {
  return buildHermesSpawnArgs({
    agentId: request.agentId,
    agentMode: request.agentMode,
    mode: request.mode,
    model: request.model,
    userContent: prompt,
    existingSessionId: resumeSessionId,
  })
}

export function buildElectrobunPersonaPrompt(
  prompt: string,
  persona: Persona | null | undefined,
): string {
  const systemPrompt = persona?.systemPrompt?.trim()
  return systemPrompt ? `${systemPrompt}\n\n## User Request\n${prompt}` : prompt
}
