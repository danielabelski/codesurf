export type ActivityType = 'task' | 'tool' | 'skill' | 'context'
export type ActivityStatus = 'pending' | 'running' | 'done' | 'error' | 'paused'

/** A single activity record persisted per-workspace */
export interface ActivityRecord {
  id: string
  tileId: string
  workspaceId: string
  type: ActivityType
  status: ActivityStatus
  title: string
  detail?: string
  metadata?: Record<string, unknown>
  agent?: string
  createdAt: number
  updatedAt: number
}

export interface ActivityUpsertInput {
  id?: string
  tileId: string
  type: ActivityType
  status?: ActivityStatus
  title: string
  detail?: string
  metadata?: Record<string, unknown>
  agent?: string
}

/** Query filter for activity:query IPC */
export interface ActivityQuery {
  workspaceId: string
  tileId?: string
  type?: ActivityType
  status?: ActivityStatus
  agent?: string
  limit?: number
}

export type ActivityHealthOperation = 'load' | 'save'

export interface ActivityHealthIssue {
  operation: ActivityHealthOperation
  code: string
  occurredAt: number
}

export interface ActivityHealthSnapshot {
  available: boolean
  status: 'healthy' | 'degraded' | 'unavailable'
  lastIssue?: ActivityHealthIssue
}

export interface ActivityHealthEvent extends ActivityHealthIssue {
  workspaceId: string
}
