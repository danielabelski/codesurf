import type {
  ActivityQuery,
  ActivityRecord,
  ActivityStatus,
  ActivityType,
  ActivityUpsertInput,
} from '../shared/activity-types.ts'

export const ACTIVITY_DOCUMENT_VERSION = 1
export const MAX_ACTIVITY_FILE_BYTES = 32 * 1024 * 1024
export const MAX_ACTIVITY_WORKSPACE_ID_LENGTH = 128
export const MAX_ACTIVITY_TILE_ID_LENGTH = 256
export const MAX_ACTIVITY_ID_LENGTH = 256
export const MAX_ACTIVITY_TITLE_LENGTH = 512
export const MAX_ACTIVITY_DETAIL_LENGTH = 4096
export const MAX_ACTIVITY_AGENT_LENGTH = 256
export const MAX_ACTIVITY_METADATA_BYTES = 4096
export const MAX_ACTIVITY_QUERY_LIMIT = 500

const ACTIVITY_TYPES = new Set<ActivityType>(['task', 'tool', 'skill', 'context'])
const ACTIVITY_STATUSES = new Set<ActivityStatus>(['pending', 'running', 'done', 'error', 'paused'])
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/
const MAX_METADATA_DEPTH = 8
const MAX_METADATA_NODES = 1024
const MAX_METADATA_KEY_LENGTH = 128
const MAX_METADATA_STRING_LENGTH = 2048

export interface ParsedActivityDocument {
  records: ActivityRecord[]
  needsRewrite: boolean
}

export class ActivityValidationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ActivityValidationError'
    this.code = code
  }
}

function fail(code: string, message: string): never {
  throw new ActivityValidationError(code, message)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail('invalid_object', `${label} must be an object`)
  return value
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('unknown_field', `${label} contains unknown field "${key}"`)
  }
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { allowEmpty?: boolean, identifier?: boolean } = {},
): string {
  if (typeof value !== 'string') fail('invalid_string', `${label} must be a string`)
  if (value.length > maxLength) fail('input_too_large', `${label} exceeds ${maxLength} characters`)
  if (!options.allowEmpty && value.length === 0) fail('invalid_string', `${label} cannot be empty`)
  if (value !== value.trim()) fail('non_canonical_string', `${label} cannot have surrounding whitespace`)
  if (CONTROL_CHARACTERS.test(value)) fail('invalid_string', `${label} contains control characters`)
  if (options.identifier && (value === '.' || value === '..')) {
    fail('invalid_identifier', `${label} is not a valid identifier`)
  }
  return value
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
  options: { allowEmpty?: boolean, identifier?: boolean } = {},
): string | undefined {
  if (value === undefined) return undefined
  return boundedString(value, label, maxLength, options)
}

export function validateActivityWorkspaceId(value: unknown): string {
  const workspaceId = boundedString(
    value,
    'workspaceId',
    MAX_ACTIVITY_WORKSPACE_ID_LENGTH,
    { identifier: true },
  )
  if (!SAFE_WORKSPACE_ID.test(workspaceId)) {
    fail('invalid_workspace_id', 'workspaceId must use only letters, numbers, dots, underscores, or hyphens')
  }
  return workspaceId
}

export function validateActivityTileId(value: unknown): string {
  return boundedString(value, 'tileId', MAX_ACTIVITY_TILE_ID_LENGTH, { identifier: true })
}

export function validateActivityId(value: unknown): string {
  return boundedString(value, 'activity id', MAX_ACTIVITY_ID_LENGTH, { identifier: true })
}

function validateActivityType(value: unknown): ActivityType {
  if (typeof value !== 'string' || !ACTIVITY_TYPES.has(value as ActivityType)) {
    fail('invalid_activity_type', 'type is not a supported activity type')
  }
  return value as ActivityType
}

function validateActivityStatus(value: unknown): ActivityStatus {
  if (typeof value !== 'string' || !ACTIVITY_STATUSES.has(value as ActivityStatus)) {
    fail('invalid_activity_status', 'status is not a supported activity status')
  }
  return value as ActivityStatus
}

function cloneJsonValue(
  value: unknown,
  path: string,
  depth: number,
  budget: { nodes: number },
): unknown {
  budget.nodes += 1
  if (budget.nodes > MAX_METADATA_NODES) fail('metadata_too_complex', 'metadata contains too many values')
  if (depth > MAX_METADATA_DEPTH) fail('metadata_too_deep', 'metadata is nested too deeply')
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_metadata', `${path} must be a finite number`)
    return value
  }
  if (typeof value === 'string') {
    if (value.length > MAX_METADATA_STRING_LENGTH) {
      fail('input_too_large', `${path} exceeds ${MAX_METADATA_STRING_LENGTH} characters`)
    }
    return value
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => cloneJsonValue(item, `${path}[${index}]`, depth + 1, budget))
  }
  if (!isPlainObject(value)) fail('invalid_metadata', `${path} must contain only JSON values`)

  const entries: Array<[string, unknown]> = []
  for (const [key, child] of Object.entries(value)) {
    if (!key || key.length > MAX_METADATA_KEY_LENGTH || CONTROL_CHARACTERS.test(key)) {
      fail('invalid_metadata', `${path} contains an invalid key`)
    }
    entries.push([key, cloneJsonValue(child, `${path}.${key}`, depth + 1, budget)])
  }
  return Object.fromEntries(entries)
}

function validateMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const metadata = cloneJsonValue(value, 'metadata', 0, { nodes: 0 })
  if (!isPlainObject(metadata)) fail('invalid_metadata', 'metadata must be an object')
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_ACTIVITY_METADATA_BYTES) {
    fail('input_too_large', `metadata exceeds ${MAX_ACTIVITY_METADATA_BYTES} bytes`)
  }
  return metadata
}

export function validateActivityUpsertInput(value: unknown): ActivityUpsertInput {
  const data = assertObject(value, 'activity')
  assertKnownKeys(data, new Set([
    'id',
    'tileId',
    'type',
    'status',
    'title',
    'detail',
    'metadata',
    'agent',
  ]), 'activity')

  const id = optionalBoundedString(data.id, 'activity id', MAX_ACTIVITY_ID_LENGTH, { identifier: true })
  const status = data.status === undefined ? undefined : validateActivityStatus(data.status)
  const detail = optionalBoundedString(
    data.detail,
    'detail',
    MAX_ACTIVITY_DETAIL_LENGTH,
    { allowEmpty: true },
  )
  const agent = optionalBoundedString(data.agent, 'agent', MAX_ACTIVITY_AGENT_LENGTH)
  const metadata = validateMetadata(data.metadata)

  return {
    ...(id === undefined ? {} : { id }),
    tileId: validateActivityTileId(data.tileId),
    type: validateActivityType(data.type),
    ...(status === undefined ? {} : { status }),
    title: boundedString(data.title, 'title', MAX_ACTIVITY_TITLE_LENGTH),
    ...(detail === undefined ? {} : { detail }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(agent === undefined ? {} : { agent }),
  }
}

export function validateActivityQuery(value: unknown): ActivityQuery {
  const query = assertObject(value, 'query')
  assertKnownKeys(query, new Set([
    'workspaceId',
    'tileId',
    'type',
    'status',
    'agent',
    'limit',
  ]), 'query')

  let limit: number | undefined
  if (query.limit !== undefined) {
    if (!Number.isSafeInteger(query.limit) || (query.limit as number) < 1 || (query.limit as number) > MAX_ACTIVITY_QUERY_LIMIT) {
      fail('invalid_limit', `limit must be an integer between 1 and ${MAX_ACTIVITY_QUERY_LIMIT}`)
    }
    limit = query.limit as number
  }

  const tileId = query.tileId === undefined ? undefined : validateActivityTileId(query.tileId)
  const type = query.type === undefined ? undefined : validateActivityType(query.type)
  const status = query.status === undefined ? undefined : validateActivityStatus(query.status)
  const agent = optionalBoundedString(query.agent, 'agent', MAX_ACTIVITY_AGENT_LENGTH)
  return {
    workspaceId: validateActivityWorkspaceId(query.workspaceId),
    ...(tileId === undefined ? {} : { tileId }),
    ...(type === undefined ? {} : { type }),
    ...(status === undefined ? {} : { status }),
    ...(agent === undefined ? {} : { agent }),
    ...(limit === undefined ? {} : { limit }),
  }
}

function validateTimestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('invalid_timestamp', `${label} must be a non-negative integer`)
  }
  return value as number
}

export function validateActivityRecord(value: unknown, workspaceId: string): ActivityRecord {
  const record = assertObject(value, 'activity record')
  assertKnownKeys(record, new Set([
    'id',
    'tileId',
    'workspaceId',
    'type',
    'status',
    'title',
    'detail',
    'metadata',
    'agent',
    'createdAt',
    'updatedAt',
  ]), 'activity record')
  const recordWorkspaceId = validateActivityWorkspaceId(record.workspaceId)
  if (recordWorkspaceId !== workspaceId) {
    fail('workspace_mismatch', 'activity record belongs to a different workspace')
  }
  const createdAt = validateTimestamp(record.createdAt, 'createdAt')
  const updatedAt = validateTimestamp(record.updatedAt, 'updatedAt')
  if (updatedAt < createdAt) fail('invalid_timestamp', 'updatedAt cannot precede createdAt')

  const detail = optionalBoundedString(
    record.detail,
    'detail',
    MAX_ACTIVITY_DETAIL_LENGTH,
    { allowEmpty: true },
  )
  const metadata = validateMetadata(record.metadata)
  const agent = optionalBoundedString(record.agent, 'agent', MAX_ACTIVITY_AGENT_LENGTH)
  return {
    id: validateActivityId(record.id),
    tileId: validateActivityTileId(record.tileId),
    workspaceId: recordWorkspaceId,
    type: validateActivityType(record.type),
    status: validateActivityStatus(record.status),
    title: boundedString(record.title, 'title', MAX_ACTIVITY_TITLE_LENGTH),
    ...(detail === undefined ? {} : { detail }),
    ...(metadata === undefined ? {} : { metadata }),
    ...(agent === undefined ? {} : { agent }),
    createdAt,
    updatedAt,
  }
}

export function parseActivityDocument(value: unknown, workspaceIdValue: unknown): ParsedActivityDocument {
  const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
  let rawRecords: unknown[]
  let needsRewrite = false

  if (Array.isArray(value)) {
    rawRecords = value
    needsRewrite = true
  } else {
    const document = assertObject(value, 'activity document')
    assertKnownKeys(document, new Set(['version', 'records']), 'activity document')
    if (!Number.isSafeInteger(document.version)) {
      fail('invalid_document_version', 'activity document version must be an integer')
    }
    if ((document.version as number) > ACTIVITY_DOCUMENT_VERSION) {
      fail('future_document_version', 'activity document was written by a newer CodeSurf version')
    }
    if (document.version !== ACTIVITY_DOCUMENT_VERSION) {
      fail('invalid_document_version', 'activity document version is unsupported')
    }
    if (!Array.isArray(document.records)) fail('invalid_records', 'activity document records must be an array')
    rawRecords = document.records
  }

  const records = rawRecords.map(record => validateActivityRecord(record, workspaceId))
  const identities = new Set<string>()
  for (const record of records) {
    const identity = `${record.tileId}\0${record.id}`
    if (identities.has(identity)) {
      fail('duplicate_activity_identity', 'activity document contains a duplicate tile-scoped identity')
    }
    identities.add(identity)
  }
  return { records, needsRewrite }
}
