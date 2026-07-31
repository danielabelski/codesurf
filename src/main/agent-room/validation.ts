import type { RoomEvent } from './types.ts'

export const TRUNCATION_MARKER = '[truncated]'
export const MAX_TILE_ID_BYTES = 128
export const MAX_ROOM_MEMBERS = 64
export const MAX_TILE_TYPE_BYTES = 64
export const MAX_DISPLAY_NAME_BYTES = 128
export const MAX_MEMBER_TASK_BYTES = 4096
export const MAX_MEMBER_FILES = 64
export const MAX_MEMBER_FILE_BYTES = 1024
export const MAX_TODOS_PER_TILE = 256
export const MAX_EVENT_TEXT_BYTES = 4096
export const MAX_EVENT_TARGETS = 32
export const MAX_METADATA_BYTES = 16 * 1024
export const MAX_METADATA_DEPTH = 6
export const MAX_METADATA_NODES = 256
export const MAX_METADATA_OBJECT_KEYS = 64
export const MAX_METADATA_ARRAY_ITEMS = 64
export const MAX_METADATA_STRING_BYTES = 2048
export const MAX_EVENTS_PER_ROOM = 500
export const MAX_RETAINED_EVENT_BYTES = 1024 * 1024
export const MAX_PROMPT_BYTES = 32 * 1024

const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/
const BLOCKED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export class AgentRoomValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentRoomValidationError'
  }
}

export function isValidAgentRoomId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_TILE_ID_BYTES) return false
  if (!SAFE_ID.test(value)) return false
  if (value === '.' || value === '..' || value.includes('..')) return false
  return true
}

export function assertValidAgentRoomId(value: unknown, label = 'tileId'): string {
  if (!isValidAgentRoomId(value)) {
    throw new AgentRoomValidationError(`Invalid ${label}`)
  }
  return value
}

export function truncateUtf8(
  rawValue: unknown,
  maxBytes: number,
  options: { marker?: string, trim?: boolean } = {},
): string {
  const marker = options.marker ?? TRUNCATION_MARKER
  let value: string
  try {
    const coerced = String(rawValue ?? '')
    value = options.trim === false ? coerced : coerced.trim()
  } catch {
    value = marker
  }
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value

  const markerBytes = Buffer.byteLength(marker, 'utf8')
  if (markerBytes >= maxBytes) {
    let markerOnly = ''
    for (const char of marker) {
      if (Buffer.byteLength(markerOnly + char, 'utf8') > maxBytes) break
      markerOnly += char
    }
    return markerOnly
  }

  const contentBudget = maxBytes - markerBytes
  let result = ''
  let used = 0
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (used + charBytes > contentBudget) break
    result += char
    used += charBytes
  }
  return `${result}${marker}`
}

export function boundTileType(value: unknown): string {
  return truncateUtf8(value || 'unknown', MAX_TILE_TYPE_BYTES) || 'unknown'
}

export function boundDisplayName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return truncateUtf8(value, MAX_DISPLAY_NAME_BYTES)
}

export function boundMemberTask(value: unknown): string {
  return truncateUtf8(value, MAX_MEMBER_TASK_BYTES)
}

export function boundMemberFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const limit = value.length > MAX_MEMBER_FILES
    ? MAX_MEMBER_FILES - 1
    : MAX_MEMBER_FILES
  for (const item of value.slice(0, MAX_MEMBER_FILES)) {
    if (typeof item !== 'string') continue
    result.push(truncateUtf8(item, MAX_MEMBER_FILE_BYTES))
    if (result.length >= limit) break
  }
  if (value.length > MAX_MEMBER_FILES) result.push(TRUNCATION_MARKER)
  return result
}

export function boundEventText(value: unknown): string {
  return truncateUtf8(value, MAX_EVENT_TEXT_BYTES)
}

export function boundTargetTileIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value.slice(0, MAX_EVENT_TARGETS)) {
    if (!isValidAgentRoomId(item) || seen.has(item)) continue
    seen.add(item)
    result.push(item)
    if (result.length >= MAX_EVENT_TARGETS) break
  }
  return result
}

interface MetadataBudget {
  nodes: number
  truncated: boolean
  seen: WeakSet<object>
}

function metadataMarker(reason: string): string {
  return `[truncated: ${reason}]`
}

function normalizeMetadataValue(value: unknown, depth: number, budget: MetadataBudget): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return typeof value === 'string'
      ? truncateUtf8(value, MAX_METADATA_STRING_BYTES)
      : value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : metadataMarker('non-finite number')
  }
  if (typeof value === 'bigint') return truncateUtf8(value.toString(), MAX_METADATA_STRING_BYTES)
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    budget.truncated = true
    return metadataMarker('unsupported value')
  }
  if (depth >= MAX_METADATA_DEPTH) {
    budget.truncated = true
    return metadataMarker('maximum depth')
  }
  if (!value || typeof value !== 'object') return String(value)
  if (budget.seen.has(value)) {
    budget.truncated = true
    return metadataMarker('circular reference')
  }
  if (budget.nodes >= MAX_METADATA_NODES) {
    budget.truncated = true
    return metadataMarker('node limit')
  }

  budget.nodes += 1
  budget.seen.add(value)
  try {
    if (Array.isArray(value)) {
      const output = value
        .slice(0, MAX_METADATA_ARRAY_ITEMS)
        .map(item => normalizeMetadataValue(item, depth + 1, budget))
      if (value.length > output.length) {
        budget.truncated = true
        output.push(metadataMarker(`${value.length - output.length} array item(s)`))
      }
      return output
    }

    const proto = Object.getPrototypeOf(value)
    if (proto !== Object.prototype && proto !== null) {
      budget.truncated = true
      return metadataMarker('non-plain object')
    }

    const output: Record<string, unknown> = {}
    const keys = Object.keys(value as Record<string, unknown>)
      .filter(key => !BLOCKED_OBJECT_KEYS.has(key))
      .sort()
    for (const key of keys.slice(0, MAX_METADATA_OBJECT_KEYS)) {
      const boundedKey = truncateUtf8(key, 128)
      output[boundedKey] = normalizeMetadataValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
        budget,
      )
    }
    if (keys.length > MAX_METADATA_OBJECT_KEYS) {
      budget.truncated = true
      output.__codesurfTruncatedKeys = metadataMarker(
        `${keys.length - MAX_METADATA_OBJECT_KEYS} object key(s)`,
      )
    }
    return output
  } finally {
    budget.seen.delete(value)
  }
}

export function boundMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined
  const budget: MetadataBudget = {
    nodes: 0,
    truncated: false,
    seen: new WeakSet(),
  }
  let normalized: unknown
  try {
    normalized = normalizeMetadataValue(value, 0, budget)
  } catch {
    return { __codesurfTruncated: metadataMarker('metadata access failed') }
  }
  const record = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized as Record<string, unknown>
    : { value: normalized }
  if (budget.truncated) record.__codesurfTruncated = TRUNCATION_MARKER

  let serialized: string
  try {
    serialized = JSON.stringify(record)
  } catch {
    return { __codesurfTruncated: metadataMarker('serialization failed') }
  }
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_METADATA_BYTES) return record
  return {
    __codesurfTruncated: metadataMarker(`metadata exceeded ${MAX_METADATA_BYTES} bytes`),
  }
}

export function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function capRetainedEvents(events: RoomEvent[]): RoomEvent[] {
  let next = events
  if (next.length > MAX_EVENTS_PER_ROOM) {
    next = next.slice(next.length - MAX_EVENTS_PER_ROOM)
  }

  let total = next.reduce((sum, event) => sum + serializedBytes(event), 0)
  let start = 0
  while (start < next.length && total > MAX_RETAINED_EVENT_BYTES) {
    total -= serializedBytes(next[start])
    start += 1
  }
  return start > 0 ? next.slice(start) : next
}

export function retainedEventBytes(events: RoomEvent[]): number {
  return events.reduce((sum, event) => sum + serializedBytes(event), 0)
}
