import type {
  RelayChannelMessageDraft,
  RelayDirectMessageDraft,
  RelayMessageKind,
  RelayPriority,
  RelaySpawnRequest,
  RelayWorkContext,
} from '../../../packages/codesurf-relay/src'

const MESSAGE_KINDS = new Set<RelayMessageKind>([
  'request',
  'reply',
  'update',
  'handoff',
  'alert',
  'memory',
  'channel',
  'system',
])
const PRIORITIES = new Set<RelayPriority>([
  'low',
  'normal',
  'high',
  'critical',
])
const PROVIDERS = new Set<NonNullable<RelaySpawnRequest['provider']>>([
  'claude',
  'codex',
  'opencode',
  'openclaw',
  'hermes',
  'unknown',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function hasValidMessageFields(value: Record<string, unknown>): boolean {
  return (
    isNonEmptyString(value.subject)
    && isNonEmptyString(value.body)
    && isOptionalString(value.threadId)
    && isOptionalString(value.replyToId)
    && (
      value.kind === undefined
      || (
        typeof value.kind === 'string'
        && MESSAGE_KINDS.has(value.kind as RelayMessageKind)
      )
    )
    && (
      value.priority === undefined
      || (
        typeof value.priority === 'string'
        && PRIORITIES.has(value.priority as RelayPriority)
      )
    )
    && (value.data === undefined || isRecord(value.data))
  )
}

export function isRelayDirectMessageDraft(
  value: unknown,
): value is RelayDirectMessageDraft {
  return (
    isRecord(value)
    && isNonEmptyString(value.to)
    && hasValidMessageFields(value)
  )
}

export function isRelayChannelMessageDraft(
  value: unknown,
): value is RelayChannelMessageDraft {
  return (
    isRecord(value)
    && isNonEmptyString(value.channel)
    && hasValidMessageFields(value)
  )
}

export function isRelaySpawnRequest(
  value: unknown,
): value is RelaySpawnRequest {
  if (!isRecord(value)) return false
  return (
    isNonEmptyString(value.name)
    && isNonEmptyString(value.task)
    && isOptionalString(value.id)
    && isOptionalString(value.tileId)
    && isOptionalString(value.model)
    && isOptionalString(value.mode)
    && isOptionalString(value.thinking)
    && (
      value.provider === undefined
      || (
        typeof value.provider === 'string'
        && PROVIDERS.has(value.provider as NonNullable<RelaySpawnRequest['provider']>)
      )
    )
    && (
      value.channels === undefined
      || (
        Array.isArray(value.channels)
        && value.channels.every(isNonEmptyString)
      )
    )
    && (value.metadata === undefined || isRecord(value.metadata))
    && (
      value.timeoutMs === undefined
      || (
        Number.isSafeInteger(value.timeoutMs)
        && (value.timeoutMs as number) > 0
      )
    )
  )
}

export function isRelayWorkContext(
  value: unknown,
): value is RelayWorkContext {
  if (!isRecord(value) || !isNonEmptyString(value.summary)) return false
  const stringListKeys = [
    'files',
    'topics',
    'collaborators',
    'blockers',
  ] as const
  for (const key of stringListKeys) {
    const candidate = value[key]
    if (
      candidate !== undefined
      && (
        !Array.isArray(candidate)
        || !candidate.every(item => typeof item === 'string')
      )
    ) {
      return false
    }
  }
  return (
    isOptionalString(value.branch)
    && isOptionalString(value.worktreePath)
    && (
      value.impacts === undefined
      || (
        Array.isArray(value.impacts)
        && value.impacts.every(impact => (
          isRecord(impact)
          && (
            impact.targetType === 'agent'
            || impact.targetType === 'human'
            || impact.targetType === 'system'
          )
          && isOptionalString(impact.targetId)
          && isNonEmptyString(impact.description)
          && (
            impact.severity === 'low'
            || impact.severity === 'medium'
            || impact.severity === 'high'
          )
        ))
      )
    )
  )
}
