export {
  createDaemonManager,
  resolveDaemonScriptFromCandidates,
  type DaemonManager,
  type DaemonManagerConfig,
  type DaemonStatusInfo,
} from './manager'

export {
  createDaemonClient,
  type DaemonClient,
  type DaemonClientHooks,
  type RequestOptions,
} from './client'

export {
  CODESURF_HOME,
  CODESURF_HOME_DIRNAME,
  DAEMON_PACKAGE_VERSION,
  defaultCodesurfHome,
} from './paths'

export type {
  AggregatedSessionEntry,
  AutoDreamPolicySummary,
  AutoDreamSettings,
  DaemonAppSettings,
  DaemonSkillEntry,
  DaemonSkillIndex,
  DaemonSkillRoot,
  DaemonSkillSelection,
  DaemonToolPermissionGrant,
  DaemonToolPermissionListResult,
  DaemonToolPermissionRequest,
  DaemonToolPermissionScope,
  DashboardDreamingSummary,
  DreamRunSummary,
  ExecutionHostRecord,
  ExecutionHostType,
  ProjectRecord,
  SessionScope,
  SessionSource,
  Workspace,
} from './types'
