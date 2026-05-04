/**
 * Wire types for the codesurfd HTTP API. These match the shapes the daemon
 * actually serializes; they are the canonical definitions. Hosts may extend or
 * re-export them as needed.
 */

export interface Workspace {
  id: string
  name: string
  /** Primary project folder for legacy callers. */
  path: string
  /** All project folders attached to this workspace/canvas tab. */
  projectPaths?: string[]
}

export interface ProjectRecord {
  id: string
  name: string
  path: string
}

export type ExecutionHostType = 'runtime' | 'local-daemon' | 'remote-daemon'

export interface ExecutionHostRecord {
  id: string
  type: ExecutionHostType
  label: string
  enabled: boolean
  url?: string | null
  authToken?: string | null
}

export type SessionSource = 'codesurf' | 'claude' | 'codex' | 'cursor' | 'hermes' | 'openclaw' | 'opencode'
export type SessionScope = 'workspace' | 'project' | 'user'

export interface AggregatedSessionEntry {
  id: string
  source: SessionSource
  scope: SessionScope
  tileId: string | null
  sessionId: string | null
  provider: string
  model: string
  messageCount: number
  lastMessage: string | null
  updatedAt: number
  sizeBytes?: number
  filePath?: string
  title: string
  projectPath?: string | null
  sourceLabel: string
  sourceDetail?: string
  checkpointCount?: number
  isArchived?: boolean
  canOpenInChat?: boolean
  canOpenInApp?: boolean
  resumeBin?: string
  resumeArgs?: string[]
  relatedGroupId?: string | null
  nestingLevel?: number
}

export interface DreamRunSummary {
  id: string
  workspaceId: string
  workspaceName: string | null
  workspaceDir: string
  provider: string
  model: string
  status: string
  requestedAt: string
  startedAt: string
  completedAt: string | null
  sessionsReviewed: number
  reviewedSessionIds: string[]
  latestSessionUpdatedAt: string | null
  outputPath: string | null
  artifactPath: string | null
  summary: string | null
  promptPreview: string | null
  error: string | null
}

export interface AutoDreamSettings {
  enabled: boolean
  minSessions: number
  minIntervalMs: number
  debounceMs: number
  sweepMs: number
}

export interface AutoDreamPolicySummary extends AutoDreamSettings {
  pending: boolean
}

export interface DashboardDreamingSummary {
  workspaceId: string
  workspaceName: string | null
  workspaceDir: string | null
  running: boolean
  activeRun: DreamRunSummary | null
  lastRun: DreamRunSummary | null
  state: {
    workspaceId: string
    lastRunId: string | null
    lastCompletedAt: string | null
    lastSuccessfulRunId: string | null
    lastSuccessfulCompletedAt: string | null
    lastReviewedAt: string | null
    latestMemoryPath: string | null
  } | null
  auto: AutoDreamPolicySummary | null
}

export interface DaemonSkillEntry {
  id: string
  name: string
  description: string
  scope: 'global' | 'workspace' | 'command'
  kind: 'skill' | 'command'
  rootKind: string
  path: string
  displayPath: string
  sourcePath: string
  content?: string
}

export interface DaemonSkillRoot {
  id: string
  path: string
  displayPath: string
  scope: 'global' | 'workspace'
  kind: string
  label: string
  exists: boolean
  sourceType: 'directory' | 'file'
}

export interface DaemonSkillSelection {
  enabledIds: string[]
  disabledIds: string[]
  resolved: DaemonSkillEntry[]
  unresolvedIds: string[]
  summary?: string
  prompt?: string
}

export interface DaemonSkillIndex {
  workspaceDir: string | null
  roots: DaemonSkillRoot[]
  skills: DaemonSkillEntry[]
  selection: DaemonSkillSelection
}

export type DaemonToolPermissionScope = 'session' | 'today' | 'forever' | 'never'

export interface DaemonToolPermissionGrant {
  id: string
  provider: string
  toolName: string
  action: 'allow' | 'deny'
  scope: DaemonToolPermissionScope
  workspaceDir: string | null
  title?: string | null
  description?: string | null
  blockedPath?: string | null
  createdAt: string
  expiresAt?: string | null
}

export interface DaemonToolPermissionRequest {
  provider: string
  toolName: string
  workspaceDir?: string | null
  title?: string | null
  description?: string | null
  blockedPath?: string | null
}

export interface DaemonToolPermissionListResult {
  path: string
  grants: DaemonToolPermissionGrant[]
}

/**
 * AppSettings is host-specific (the daemon stores opaque JSON). Use `unknown`
 * here and re-cast in the host adapter. See collaborator-clone's
 * `src/shared/types.ts` for the desktop's full schema.
 */
export type DaemonAppSettings = unknown
