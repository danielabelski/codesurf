import type { ExecutionHostType } from '../../shared/types'

export interface ProjectContextEnvelope {
  workspaceDir: string | null
  gitRemoteUrl: string | null
  gitBranch: string | null
  repoName: string | null
}

export interface ProviderContextPolicy {
  includeWorkspaceDir: boolean
  includeGitRemoteUrl: boolean
  includeGitBranch: boolean
  includeRepoName: boolean
  reason: string
}

export function buildProviderContextPolicy(args: {
  executionTarget?: 'local' | 'cloud'
  hostType?: ExecutionHostType | null
}): ProviderContextPolicy {
  const executionTarget = args.executionTarget ?? 'local'
  const hostType = args.hostType ?? 'runtime'
  const remoteBoundary = executionTarget === 'cloud' || hostType === 'remote-daemon'

  if (remoteBoundary) {
    return {
      includeWorkspaceDir: false,
      includeGitRemoteUrl: true,
      includeGitBranch: true,
      includeRepoName: true,
      reason: 'remote-boundary',
    }
  }

  return {
    includeWorkspaceDir: true,
    includeGitRemoteUrl: true,
    includeGitBranch: true,
    includeRepoName: true,
    reason: 'local-execution',
  }
}

export function applyProjectContextPolicy(
  context: ProjectContextEnvelope,
  policy: ProviderContextPolicy,
): ProjectContextEnvelope {
  const workspaceDir = policy.includeWorkspaceDir || !context.gitRemoteUrl
    ? context.workspaceDir
    : null

  return {
    workspaceDir,
    gitRemoteUrl: policy.includeGitRemoteUrl ? context.gitRemoteUrl : null,
    gitBranch: policy.includeGitBranch ? context.gitBranch : null,
    repoName: policy.includeRepoName ? context.repoName : null,
  }
}

export function describeProjectContextEnvelope(context: ProjectContextEnvelope): {
  hasWorkspaceDir: boolean
  hasGitRemoteUrl: boolean
  hasGitBranch: boolean
  hasRepoName: boolean
} {
  return {
    hasWorkspaceDir: Boolean(context.workspaceDir),
    hasGitRemoteUrl: Boolean(context.gitRemoteUrl),
    hasGitBranch: Boolean(context.gitBranch),
    hasRepoName: Boolean(context.repoName),
  }
}
