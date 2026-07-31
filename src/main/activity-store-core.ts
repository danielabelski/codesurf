import { randomUUID } from 'node:crypto'
import type {
  ActivityQuery,
  ActivityRecord,
} from '../shared/activity-types.ts'
import { capActivityRecords } from './activity-cap.ts'
import type { ActivityPersistence } from './activity-persistence.ts'
import { serializeActivityDocument } from './activity-persistence.ts'
import {
  MAX_ACTIVITY_FILE_BYTES,
  MAX_ACTIVITY_QUERY_LIMIT,
  MAX_ACTIVITY_QUERY_RESPONSE_BYTES,
  validateActivityId,
  validateActivityQuery,
  validateActivityTileId,
  validateActivityUpsertInput,
  validateActivityWorkspaceId,
} from './activity-validation.ts'

export const DEFAULT_ACTIVITY_SAVE_DEBOUNCE_MS = 1000
export const DEFAULT_ACTIVITY_SAVE_RETRY_MS = 1000
export const DEFAULT_MAX_LOADED_ACTIVITY_WORKSPACES = 32

export interface ActivityScheduler {
  set(callback: () => void, delayMs: number): unknown
  clear(handle: unknown): void
}

export interface ActivityStoreOptions {
  persistence: ActivityPersistence
  now?: () => number
  createId?: () => string
  scheduler?: ActivityScheduler
  saveDebounceMs?: number
  saveRetryMs?: number
  maxLoadedWorkspaces?: number
  maxFileBytes?: number
  maxQueryResponseBytes?: number
}

interface StoreState {
  workspaceId: string
  records: ActivityRecord[]
  generation: number
  persistedGeneration: number
  saveTimer: unknown | null
  persistPromise: Promise<void> | null
  lastSaveError: unknown
  lastAccess: number
  activeUsers: number
}

export interface ActivityStoreStats {
  loadedWorkspaceIds: string[]
  loadingWorkspaceIds: string[]
  dirtyWorkspaceIds: string[]
}

export class ActivityStoreClosedError extends Error {
  constructor() {
    super('Activity store is closing')
    this.name = 'ActivityStoreClosedError'
  }
}

const defaultScheduler: ActivityScheduler = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    handle.unref?.()
    return handle
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

function cloneRecord(record: ActivityRecord): ActivityRecord {
  return {
    ...record,
    ...(record.metadata === undefined
      ? {}
      : { metadata: JSON.parse(JSON.stringify(record.metadata)) as Record<string, unknown> }),
  }
}

function cloneRecords(records: ActivityRecord[]): ActivityRecord[] {
  return records.map(cloneRecord)
}

function mergeMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (patch === undefined) return existing
  return Object.fromEntries([
    ...Object.entries(existing ?? {}),
    ...Object.entries(patch),
  ])
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
  return value
}

export class ActivityStore {
  private readonly persistence: ActivityPersistence
  private readonly now: () => number
  private readonly createId: () => string
  private readonly scheduler: ActivityScheduler
  private readonly saveDebounceMs: number
  private readonly saveRetryMs: number
  private readonly maxLoadedWorkspaces: number
  private readonly maxFileBytes: number
  private readonly maxQueryResponseBytes: number
  private readonly stores = new Map<string, StoreState>()
  private readonly loads = new Map<string, Promise<StoreState>>()
  private readonly pendingAcquires = new Map<string, number>()
  private accessSequence = 0
  private evictionTail: Promise<void> = Promise.resolve()
  private closing = false
  private activeOperations = 0
  private readonly operationWaiters: Array<() => void> = []

  constructor(options: ActivityStoreOptions) {
    this.persistence = options.persistence
    this.now = options.now ?? Date.now
    this.createId = options.createId ?? randomUUID
    this.scheduler = options.scheduler ?? defaultScheduler
    this.saveDebounceMs = assertPositiveInteger(
      options.saveDebounceMs ?? DEFAULT_ACTIVITY_SAVE_DEBOUNCE_MS,
      'saveDebounceMs',
    )
    this.saveRetryMs = assertPositiveInteger(
      options.saveRetryMs ?? DEFAULT_ACTIVITY_SAVE_RETRY_MS,
      'saveRetryMs',
    )
    this.maxLoadedWorkspaces = assertPositiveInteger(
      options.maxLoadedWorkspaces ?? DEFAULT_MAX_LOADED_ACTIVITY_WORKSPACES,
      'maxLoadedWorkspaces',
    )
    this.maxFileBytes = assertPositiveInteger(
      options.maxFileBytes ?? MAX_ACTIVITY_FILE_BYTES,
      'maxFileBytes',
    )
    this.maxQueryResponseBytes = assertPositiveInteger(
      options.maxQueryResponseBytes ?? MAX_ACTIVITY_QUERY_RESPONSE_BYTES,
      'maxQueryResponseBytes',
    )
  }

  private touch(state: StoreState): void {
    state.lastAccess = ++this.accessSequence
  }

  private scheduleSave(state: StoreState, delayMs = this.saveDebounceMs): void {
    if (state.saveTimer !== null || state.persistedGeneration >= state.generation) return
    state.saveTimer = this.scheduler.set(() => {
      state.saveTimer = null
      void this.persistState(state)
    }, delayMs)
  }

  private markDirty(state: StoreState): void {
    state.generation += 1
    this.scheduleSave(state)
  }

  private persistState(state: StoreState): Promise<void> {
    if (state.persistPromise) return state.persistPromise
    const task = (async () => {
      while (state.persistedGeneration < state.generation) {
        const generation = state.generation
        const snapshot = cloneRecords(state.records)
        await this.persistence.save(state.workspaceId, snapshot)
        state.persistedGeneration = Math.max(state.persistedGeneration, generation)
      }
    })()
    state.persistPromise = task
    void task.then(
      () => {
        if (state.persistPromise === task) state.persistPromise = null
        state.lastSaveError = null
        if (state.persistedGeneration < state.generation) this.scheduleSave(state, 1)
        this.queueEviction()
      },
      error => {
        if (state.persistPromise === task) state.persistPromise = null
        state.lastSaveError = error
        if (this.stores.get(state.workspaceId) === state) {
          this.scheduleSave(state, this.saveRetryMs)
        }
      },
    )
    return task
  }

  private async flushState(state: StoreState): Promise<void> {
    if (state.saveTimer !== null) {
      this.scheduler.clear(state.saveTimer)
      state.saveTimer = null
    }
    while (state.persistedGeneration < state.generation) {
      await this.persistState(state)
    }
  }

  private async loadState(workspaceId: string): Promise<StoreState> {
    const existing = this.stores.get(workspaceId)
    if (existing) return existing

    const activeLoad = this.loads.get(workspaceId)
    if (activeLoad) return activeLoad

    const load = this.persistence.load(workspaceId).then(result => {
      const raced = this.stores.get(workspaceId)
      if (raced) return raced
      const needsRewrite = result.needsRewrite
      const state: StoreState = {
        workspaceId,
        records: cloneRecords(result.records),
        generation: needsRewrite ? 1 : 0,
        persistedGeneration: 0,
        saveTimer: null,
        persistPromise: null,
        lastSaveError: null,
        lastAccess: 0,
        activeUsers: 0,
      }
      this.stores.set(workspaceId, state)
      if (needsRewrite) this.scheduleSave(state)
      return state
    })
    this.loads.set(workspaceId, load)
    void load.finally(() => {
      if (this.loads.get(workspaceId) === load) this.loads.delete(workspaceId)
    }).catch(() => {})
    return load
  }

  private async acquire(workspaceIdValue: unknown): Promise<StoreState> {
    const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
    this.pendingAcquires.set(workspaceId, (this.pendingAcquires.get(workspaceId) ?? 0) + 1)
    try {
      const state = await this.loadState(workspaceId)
      state.activeUsers += 1
      this.touch(state)
      return state
    } finally {
      const remaining = (this.pendingAcquires.get(workspaceId) ?? 1) - 1
      if (remaining === 0) this.pendingAcquires.delete(workspaceId)
      else this.pendingAcquires.set(workspaceId, remaining)
    }
  }

  private release(state: StoreState): void {
    state.activeUsers = Math.max(0, state.activeUsers - 1)
    this.queueEviction()
  }

  private async withStore<T>(
    workspaceId: unknown,
    operation: (state: StoreState) => T | Promise<T>,
  ): Promise<T> {
    if (this.closing) throw new ActivityStoreClosedError()
    this.activeOperations += 1
    let state: StoreState | null = null
    try {
      state = await this.acquire(workspaceId)
      return await operation(state)
    } finally {
      if (state) this.release(state)
      this.activeOperations -= 1
      if (this.activeOperations === 0) {
        for (const resolve of this.operationWaiters.splice(0)) resolve()
      }
    }
  }

  private waitForActiveOperations(): Promise<void> {
    if (this.activeOperations === 0) return Promise.resolve()
    return new Promise(resolve => this.operationWaiters.push(resolve))
  }

  private queueEviction(): void {
    const task = this.evictionTail.then(() => this.evictToLimit())
    this.evictionTail = task.catch(() => {})
  }

  private async evictToLimit(): Promise<void> {
    while (this.stores.size > this.maxLoadedWorkspaces) {
      const candidate = [...this.stores.values()]
        .filter(state => (
          state.activeUsers === 0
          && (this.pendingAcquires.get(state.workspaceId) ?? 0) === 0
        ))
        .sort((left, right) => left.lastAccess - right.lastAccess)[0]
      if (!candidate) return

      try {
        await this.flushState(candidate)
      } catch {
        return
      }
      if (
        candidate.activeUsers !== 0
        || (this.pendingAcquires.get(candidate.workspaceId) ?? 0) !== 0
        || candidate.persistPromise
        || candidate.persistedGeneration < candidate.generation
        || this.stores.get(candidate.workspaceId) !== candidate
      ) {
        continue
      }
      this.stores.delete(candidate.workspaceId)
    }
  }

  private assertCandidateFits(workspaceId: string, records: ActivityRecord[]): void {
    const bytes = Buffer.byteLength(serializeActivityDocument(workspaceId, records), 'utf8')
    if (bytes > this.maxFileBytes) {
      throw new Error(`Activity store exceeds ${this.maxFileBytes} bytes`)
    }
  }

  private boundResults(records: ActivityRecord[], limit: number): ActivityRecord[] {
    const result: ActivityRecord[] = []
    let bytes = 2
    for (const record of records) {
      if (result.length >= limit) break
      const clone = cloneRecord(record)
      const recordBytes = Buffer.byteLength(JSON.stringify(clone), 'utf8')
      const separatorBytes = result.length === 0 ? 0 : 1
      if (bytes + separatorBytes + recordBytes > this.maxQueryResponseBytes) break
      result.push(clone)
      bytes += separatorBytes + recordBytes
    }
    return result
  }

  private groupResults(records: ActivityRecord[]): Record<string, ActivityRecord[]> {
    const groups = new Map<string, ActivityRecord[]>()
    let bytes = 2
    let count = 0
    for (const record of records) {
      if (count >= MAX_ACTIVITY_QUERY_LIMIT) break
      const clone = cloneRecord(record)
      const key = clone.agent ?? `tile:${clone.tileId}`
      const group = groups.get(key)
      const recordBytes = Buffer.byteLength(JSON.stringify(clone), 'utf8')
      const addedBytes = group
        ? 1 + recordBytes
        : (groups.size === 0 ? 0 : 1)
          + Buffer.byteLength(JSON.stringify(key), 'utf8')
          + 3
          + recordBytes
      if (bytes + addedBytes > this.maxQueryResponseBytes) break
      if (group) group.push(clone)
      else groups.set(key, [clone])
      bytes += addedBytes
      count += 1
    }
    return Object.fromEntries(groups)
  }

  async upsert(workspaceIdValue: unknown, inputValue: unknown): Promise<ActivityRecord> {
    const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
    const data = validateActivityUpsertInput(inputValue)
    return this.withStore(workspaceId, state => {
      const now = this.now()
      const index = data.id === undefined
        ? -1
        : state.records.findIndex(record => record.tileId === data.tileId && record.id === data.id)
      let record: ActivityRecord
      const candidate = [...state.records]
      if (index >= 0) {
        const existing = state.records[index]
        const metadata = mergeMetadata(existing.metadata, data.metadata)
        record = {
          ...existing,
          status: data.status ?? existing.status,
          title: data.title,
          ...(data.detail === undefined ? { detail: existing.detail } : { detail: data.detail }),
          ...(metadata === undefined ? {} : { metadata }),
          ...(data.agent === undefined ? { agent: existing.agent } : { agent: data.agent }),
          updatedAt: now,
        }
        candidate[index] = record
      } else {
        record = {
          id: data.id ?? validateActivityId(this.createId()),
          tileId: data.tileId,
          workspaceId,
          type: data.type,
          status: data.status ?? 'pending',
          title: data.title,
          ...(data.detail === undefined ? {} : { detail: data.detail }),
          ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
          ...(data.agent === undefined ? {} : { agent: data.agent }),
          createdAt: now,
          updatedAt: now,
        }
        candidate.push(record)
      }

      let capped = capActivityRecords(candidate, now)
      if (!capped.includes(record)) {
        capped = [...capped.slice(0, -1), record]
      }
      this.assertCandidateFits(workspaceId, capped)
      state.records = capped
      this.markDirty(state)
      return cloneRecord(record)
    })
  }

  async query(queryValue: unknown): Promise<ActivityRecord[]> {
    const query: ActivityQuery = validateActivityQuery(queryValue)
    return this.withStore(query.workspaceId, state => {
      let records = state.records.filter(record => (
        (query.tileId === undefined || record.tileId === query.tileId)
        && (query.type === undefined || record.type === query.type)
        && (query.status === undefined || record.status === query.status)
        && (query.agent === undefined || record.agent === query.agent)
      ))
      records = [...records].sort((left, right) => right.updatedAt - left.updatedAt)
      return this.boundResults(records, query.limit ?? MAX_ACTIVITY_QUERY_LIMIT)
    })
  }

  async byTile(workspaceId: unknown, tileIdValue: unknown): Promise<ActivityRecord[]> {
    const tileId = validateActivityTileId(tileIdValue)
    return this.query({ workspaceId, tileId })
  }

  async delete(workspaceId: unknown, tileIdValue: unknown, idValue: unknown): Promise<boolean> {
    const tileId = validateActivityTileId(tileIdValue)
    const id = validateActivityId(idValue)
    return this.withStore(workspaceId, state => {
      const index = state.records.findIndex(record => record.tileId === tileId && record.id === id)
      if (index === -1) return false
      const candidate = [...state.records.slice(0, index), ...state.records.slice(index + 1)]
      this.assertCandidateFits(state.workspaceId, candidate)
      state.records = candidate
      this.markDirty(state)
      return true
    })
  }

  async clearTile(workspaceId: unknown, tileIdValue: unknown): Promise<number> {
    const tileId = validateActivityTileId(tileIdValue)
    return this.withStore(workspaceId, state => {
      const candidate = state.records.filter(record => record.tileId !== tileId)
      const removed = state.records.length - candidate.length
      if (removed > 0) {
        this.assertCandidateFits(state.workspaceId, candidate)
        state.records = candidate
        this.markDirty(state)
      }
      return removed
    })
  }

  async byAgent(workspaceIdValue: unknown): Promise<Record<string, ActivityRecord[]>> {
    const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
    return this.withStore(workspaceId, state => {
      const sorted = [...state.records].sort((left, right) => right.updatedAt - left.updatedAt)
      return this.groupResults(sorted)
    })
  }

  async flushAll(): Promise<void> {
    this.closing = true
    await this.waitForActiveOperations()
    await Promise.allSettled([...this.loads.values()])
    const results = await Promise.allSettled(
      [...this.stores.values()].map(state => this.flushState(state)),
    )
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to flush activity stores')
    this.queueEviction()
    await this.evictionTail
  }

  async settleMaintenance(): Promise<void> {
    await this.evictionTail
  }

  getStats(): ActivityStoreStats {
    return {
      loadedWorkspaceIds: [...this.stores.keys()],
      loadingWorkspaceIds: [...this.loads.keys()],
      dirtyWorkspaceIds: [...this.stores.values()]
        .filter(state => state.persistedGeneration < state.generation)
        .map(state => state.workspaceId),
    }
  }
}
