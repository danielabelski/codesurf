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
