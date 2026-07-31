/**
 * CodeSurf Agent Rooms — Mosaic-style multi-agent connectivity.
 *
 * Canvas wires establish room membership. Members share a sequenced event
 * ledger. Each member has an ack cursor; `consume` returns only unread events
 * and advances the cursor. Realtime fan-out goes over the main process bus
 * (`room:<id>` and `tile:<id>`).
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { bus } from '../event-bus.ts'
import { CODESURF_HOME } from '../paths.ts'
import {
  AgentRoomPersistenceQueue,
  NodeAgentRoomFileAdapter,
} from './persistence.ts'
import type {
  AgentRoom,
  ConsumeResult,
  MemberStatus,
  PostInput,
  RoomEvent,
  RoomEventKind,
  RoomMember,
  RoomSnapshot,
} from './types.ts'
import {
  AgentRoomValidationError,
  MAX_PROMPT_BYTES,
  MAX_ROOM_MEMBERS,
  MAX_TODOS_PER_TILE,
  boundDisplayName,
  boundEventText,
  boundMemberFiles,
  boundMemberTask,
  boundMetadata,
  boundTargetTileIds,
  boundTileType,
  capRetainedEvents,
  isValidAgentRoomId,
  retainedEventBytes,
  truncateUtf8,
} from './validation.ts'

// tileId → roomId
const membership = new Map<string, string>()
// roomId → room
const rooms = new Map<string, AgentRoom>()
const ownedRoomFiles = new Set<string>()
const ownedInboxFiles = new Set<string>()

function createPersistenceQueue(): AgentRoomPersistenceQueue {
  return new AgentRoomPersistenceQueue(new NodeAgentRoomFileAdapter(CODESURF_HOME))
}

let persistence = createPersistenceQueue()
let disposing = false
let disposePromise: Promise<void> | null = null

// Optional PTY notifier for terminal tiles (secondary; primary is consume)
type NotifyCallback = (tileId: string, line: string) => void
let notifyTerminalFn: NotifyCallback | null = null

const ROOM_EVENT_KINDS = new Set<RoomEventKind>([
  'message',
  'task',
  'handoff',
  'summary',
  'status',
  'finding',
  'blocker',
  'question',
  'decision',
  'fileChanged',
  'testResult',
  'reviewFinding',
])
const MEMBER_STATUSES = new Set<MemberStatus>([
  'idle',
  'working',
  'blocked',
  'waiting',
  'done',
  'unknown',
])
const MAX_STANDING_PROMPT_BYTES = 8 * 1024
const MAX_EVENT_PROMPT_BYTES = MAX_PROMPT_BYTES - MAX_STANDING_PROMPT_BYTES - 2

export function setTerminalNotifier(fn: NotifyCallback | null): void {
  notifyTerminalFn = disposing ? null : fn
}

function memberKeyOf(tileIds: Iterable<string>): string {
  return [...tileIds].sort().join('|')
}

function tileTypeFor(tileTypes: unknown, tileId: string): string {
  if (!tileTypes || typeof tileTypes !== 'object') return 'unknown'
  try {
    if (!Object.hasOwn(tileTypes, tileId)) return 'unknown'
    return boundTileType((tileTypes as Record<string, unknown>)[tileId])
  } catch {
    return 'unknown'
  }
}

function copyMember(member: RoomMember): RoomMember {
  return {
    ...member,
    files: [...member.files],
  }
}

function copyEvent(event: RoomEvent): RoomEvent {
  return {
    ...event,
    targetTileIds: [...event.targetTileIds],
    meta: event.meta ? structuredClone(event.meta) : undefined,
  }
}

function emptyConsumeResult(): ConsumeResult {
  return { roomId: null, text: '', events: [], latestSequence: 0, members: [] }
}

function roomFilePath(roomId: string): string {
  return join(CODESURF_HOME, 'rooms', `${roomId}.json`)
}

function inboxFilePath(tileId: string): string {
  return join(CODESURF_HOME, 'room-inboxes', tileId, 'ROOM.md')
}

function removeRoomArtifact(roomId: string): void {
  const path = roomFilePath(roomId)
  if (!ownedRoomFiles.delete(path)) return
  persistence.removeFile(path, { pruneEmptyParent: true })
}

function removeInboxArtifact(tileId: string): void {
  const path = inboxFilePath(tileId)
  if (!ownedInboxFiles.delete(path)) return
  persistence.removeFile(path, { pruneEmptyParent: true })
}

function publishRoom(room: AgentRoom, type: string, payload: Record<string, unknown>): void {
  bus.publish({
    channel: `room:${room.id}`,
    type: 'data',
    source: 'agent-room',
    payload: { roomId: room.id, ...payload, action: type },
  })
  for (const tileId of room.members.keys()) {
    bus.publish({
      channel: `tile:${tileId}`,
      type: type === 'event' ? 'notification' : 'data',
      source: 'agent-room',
      payload: { roomId: room.id, action: type, ...payload },
    })
  }
}

function snapshot(room: AgentRoom): RoomSnapshot {
  return {
    id: room.id,
    memberKey: room.memberKey,
    members: [...room.members.values()]
      .map(copyMember)
      .sort((a, b) => a.tileId.localeCompare(b.tileId)),
    eventCount: room.events.length,
    latestSequence: Math.max(0, room.nextSequence - 1),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  }
}

function ensureMember(room: AgentRoom, tileId: string, tileType = 'unknown'): RoomMember {
  let member = room.members.get(tileId)
  if (member) return member
  const now = Date.now()
  member = {
    tileId,
    tileType: boundTileType(tileType),
    status: 'unknown',
    task: '',
    files: [],
    // New joiners start at current head so they don't replay entire history.
    acknowledgedSeq: Math.max(0, room.nextSequence - 1),
    joinedAt: now,
    updatedAt: now,
  }
  room.members.set(tileId, member)
  membership.set(tileId, room.id)
  return member
}

/**
 * Reconcile canvas wire graph into rooms.
 * All tiles in a connected component share one room.
 */
export function syncMembership(
  tileId: string,
  peerIds: string[],
  tileTypes: Record<string, string> = {},
): RoomSnapshot | null {
  if (disposing) return null
  if (!isValidAgentRoomId(tileId) || !Array.isArray(peerIds)) return null
  if (peerIds.length >= MAX_ROOM_MEMBERS) return null
  if (peerIds.some(peerId => !isValidAgentRoomId(peerId))) return null

  const component = new Set<string>([tileId, ...peerIds])
  if (component.size > MAX_ROOM_MEMBERS) return null
  if (component.size < 2) {
    // Alone — leave any previous room
    leaveRoom(tileId)
    return null
  }

  // Expand to full component via existing memberships (transitive wires)
  let growing = true
  while (growing) {
    growing = false
    for (const id of [...component]) {
      const rid = membership.get(id)
      if (!rid) continue
      const room = rooms.get(rid)
      if (!room) continue
      for (const mid of room.members.keys()) {
        if (!component.has(mid)) {
          if (component.size >= MAX_ROOM_MEMBERS) return null
          component.add(mid)
          growing = true
        }
      }
    }
  }

  const key = memberKeyOf(component)

  // Reuse room if one already has the same member set
  for (const room of rooms.values()) {
    if (room.memberKey === key) {
      for (const id of component) {
        ensureMember(room, id, tileTypeFor(tileTypes, id))
      }
      room.updatedAt = Date.now()
      writeRoomFiles(room)
      return snapshot(room)
    }
  }

  // Merge: if any member already in a room, adopt that room and add everyone
  let host: AgentRoom | null = null
  for (const id of component) {
    const rid = membership.get(id)
    if (rid && rooms.has(rid)) {
      host = rooms.get(rid)!
      break
    }
  }

  if (!host) {
    const now = Date.now()
    host = {
      id: randomUUID(),
      memberKey: key,
      members: new Map(),
      events: [],
      nextSequence: 1,
      createdAt: now,
      updatedAt: now,
    }
    rooms.set(host.id, host)
  }

  // Remove members no longer in component
  for (const mid of [...host.members.keys()]) {
    if (!component.has(mid)) {
      host.members.delete(mid)
      if (membership.get(mid) === host.id) membership.delete(mid)
      todosByTile.delete(mid)
      removeInboxArtifact(mid)
    }
  }

  for (const id of component) {
    // If they were in a different room, leave it first
    const prev = membership.get(id)
    if (prev && prev !== host.id) {
      const old = rooms.get(prev)
      if (old) {
        old.members.delete(id)
        todosByTile.delete(id)
        removeInboxArtifact(id)
        if (old.members.size < 2) {
          dissolveRoom(old.id)
        } else {
          old.memberKey = memberKeyOf(old.members.keys())
          old.updatedAt = Date.now()
          publishRoom(old, 'membership', { left: id, members: snapshot(old).members })
          writeRoomFiles(old)
        }
      }
    }
    ensureMember(host, id, tileTypeFor(tileTypes, id))
  }

  host.memberKey = memberKeyOf(host.members.keys())
  host.updatedAt = Date.now()
  publishRoom(host, 'membership', { members: snapshot(host).members })
  writeRoomFiles(host)
  return snapshot(host)
}

/** Alias used by peer-state / terminal:update-peers */
export function updateLinks(tileId: string, peerIds: string[], tileTypes?: Record<string, string>): RoomSnapshot | null {
  return syncMembership(tileId, peerIds, tileTypes)
}

function dissolveRoom(roomId: string): void {
  const room = rooms.get(roomId)
  if (!room) return
  for (const mid of room.members.keys()) {
    if (membership.get(mid) === roomId) membership.delete(mid)
    todosByTile.delete(mid)
    removeInboxArtifact(mid)
  }
  rooms.delete(roomId)
  removeRoomArtifact(roomId)
  bus.publish({
    channel: `room:${roomId}`,
    type: 'system',
    source: 'agent-room',
    payload: { action: 'dissolved', roomId },
  })
  bus.dropChannel(`room:${roomId}`)
}

export function leaveRoom(tileId: string): void {
  if (disposing) return
  if (!isValidAgentRoomId(tileId)) return
  const rid = membership.get(tileId)
  todosByTile.delete(tileId)
  removeInboxArtifact(tileId)
  if (!rid) return
  const room = rooms.get(rid)
  membership.delete(tileId)
  if (!room) return
  room.members.delete(tileId)
  room.memberKey = memberKeyOf(room.members.keys())
  room.updatedAt = Date.now()
  if (room.members.size < 2) {
    dissolveRoom(rid)
  } else {
    publishRoom(room, 'membership', { left: tileId, members: snapshot(room).members })
    writeRoomFiles(room)
  }
}

export function removeTile(tileId: string): void {
  leaveRoom(tileId)
}

export function getRoomForTile(tileId: string): RoomSnapshot | null {
  if (!isValidAgentRoomId(tileId)) return null
  const rid = membership.get(tileId)
  if (!rid) return null
  const room = rooms.get(rid)
  return room ? snapshot(room) : null
}

export function getRoom(roomId: string): RoomSnapshot | null {
  if (!isValidAgentRoomId(roomId)) return null
  const room = rooms.get(roomId)
  return room ? snapshot(room) : null
}

export function post(input: PostInput): RoomEvent | null {
  if (disposing) return null
  if (!input || !isValidAgentRoomId(input.fromTileId)) return null
  if (typeof input.text !== 'string') return null
  if (input.targetTileIds !== undefined && !Array.isArray(input.targetTileIds)) return null

  const roomId = membership.get(input.fromTileId)
  if (!roomId) return null
  const room = rooms.get(roomId)
  if (!room) return null

  const member = ensureMember(room, input.fromTileId, boundTileType(input.fromTileType))
  const text = boundEventText(input.text)
  if (!text) return null
  const targetTileIds = boundTargetTileIds(input.targetTileIds)
  if (input.targetTileIds && input.targetTileIds.length > 0 && targetTileIds.length === 0) {
    return null
  }
  let meta = boundMetadata(input.meta)
  const omittedTargets = (input.targetTileIds?.length ?? 0) - targetTileIds.length
  if (omittedTargets > 0) {
    meta = boundMetadata({
      ...meta,
      __codesurfTruncatedTargets: `[truncated: ${omittedTargets} target(s)]`,
    })
  }
  const kind = ROOM_EVENT_KINDS.has(input.kind as RoomEventKind)
    ? input.kind as RoomEventKind
    : 'message'

  const event: RoomEvent = {
    id: randomUUID(),
    sequence: room.nextSequence++,
    roomId: room.id,
    kind,
    fromTileId: input.fromTileId,
    fromTileType: member.tileType || input.fromTileType || 'unknown',
    text,
    targetTileIds,
    createdAt: Date.now(),
    meta,
  }

  room.events.push(event)
  room.events = capRetainedEvents(room.events)
  room.updatedAt = Date.now()

  // Auto-ack own posts so we don't re-consume our own messages
  member.acknowledgedSeq = Math.max(member.acknowledgedSeq, event.sequence)
  member.updatedAt = Date.now()

  publishRoom(room, 'event', { event: copyEvent(event) })
  writeRoomFiles(room)

  // Secondary: brief PTY ping for terminals (not the primary delivery path)
  for (const [tid, m] of room.members) {
    if (tid === input.fromTileId) continue
    if (event.targetTileIds.length > 0 && !event.targetTileIds.includes(tid)) continue
    if (m.tileType === 'terminal' && notifyTerminalFn) {
      try {
        notifyTerminalFn(
          tid,
          `[codesurf room] ${event.kind} from ${event.fromTileId}: ${truncateUtf8(text, 200)}`,
        )
      } catch {
        // Terminal notification is secondary to the persisted room ledger.
      }
    }
  }

  return copyEvent(event)
}

function isVisible(event: RoomEvent, tileId: string): boolean {
  if (event.fromTileId === tileId) return false
  if (event.targetTileIds.length === 0) return true
  return event.targetTileIds.includes(tileId)
}

/**
 * Cursor-gated delivery: returns unread room events for this member and advances ack.
 */
export function consume(tileId: string): ConsumeResult {
  if (disposing) return emptyConsumeResult()
  if (!isValidAgentRoomId(tileId)) return emptyConsumeResult()
  const roomId = membership.get(tileId)
  if (!roomId) return emptyConsumeResult()
  const room = rooms.get(roomId)
  if (!room) return emptyConsumeResult()

  const member = ensureMember(room, tileId)
  const pending = room.events.filter(
    (e) => e.sequence > member.acknowledgedSeq && isVisible(e, tileId),
  )
  const expiredSequences = Math.max(
    0,
    (room.events[0]?.sequence ?? member.acknowledgedSeq + 1)
      - member.acknowledgedSeq
      - 1,
  )

  if (pending.length > 0) {
    member.acknowledgedSeq = pending[pending.length - 1]!.sequence
    member.updatedAt = Date.now()
    room.updatedAt = Date.now()
    writeRoomFiles(room)
  }

  const text = formatEventsForInject(pending, room, MAX_EVENT_PROMPT_BYTES, expiredSequences)
  return {
    roomId: room.id,
    text,
    events: pending.map(copyEvent),
    latestSequence: member.acknowledgedSeq,
    members: snapshot(room).members,
  }
}

/** Non-advancing view of room + unconsumed count (for prompts / status). */
export function digest(tileId: string): {
  roomId: string | null
  members: RoomMember[]
  unconsumed: number
  standingText: string
} {
  if (!isValidAgentRoomId(tileId)) {
    return { roomId: null, members: [], unconsumed: 0, standingText: '' }
  }
  const roomId = membership.get(tileId)
  if (!roomId) {
    return { roomId: null, members: [], unconsumed: 0, standingText: '' }
  }
  const room = rooms.get(roomId)
  if (!room) {
    return { roomId: null, members: [], unconsumed: 0, standingText: '' }
  }
  const member = ensureMember(room, tileId)
  const unconsumed = room.events.filter(
    (e) => e.sequence > member.acknowledgedSeq && isVisible(e, tileId),
  ).length

  const lines = [
    `## Agent Room ${room.id.slice(0, 8)}`,
    `You are a member of this room with ${room.members.size} block(s).`,
    '',
    '### Members',
    ...[...room.members.values()].map((m) => {
      const you = m.tileId === tileId ? ' (you)' : ''
      const task = m.task ? ` — ${m.task}` : ''
      return `- \`${m.tileId}\` (${m.tileType}${you}) status=${m.status}${task}`
    }),
  ]
  if (unconsumed > 0) {
    lines.push('', `### Pending room traffic: ${unconsumed} unread event(s) will be injected this turn.`)
  }

  return {
    roomId: room.id,
    members: snapshot(room).members,
    unconsumed,
    standingText: truncateUtf8(lines.join('\n'), MAX_STANDING_PROMPT_BYTES, {
      marker: '\n[truncated]',
      trim: false,
    }),
  }
}

export function setMemberState(
  tileId: string,
  update: Partial<Pick<RoomMember, 'tileType' | 'status' | 'task' | 'files' | 'displayName'>>,
  opts: { announce?: boolean } = {},
): RoomMember | null {
  if (disposing) return null
  if (!isValidAgentRoomId(tileId) || !update || typeof update !== 'object') return null
  const roomId = membership.get(tileId)
  if (!roomId) {
    // Not in a room yet — no-op member record isn't useful; chat will sync links first
    return null
  }
  const room = rooms.get(roomId)
  if (!room) return null
  const member = ensureMember(room, tileId, boundTileType(update.tileType))
  if (update.tileType !== undefined) member.tileType = boundTileType(update.tileType)
  if (MEMBER_STATUSES.has(update.status as MemberStatus)) {
    member.status = update.status as MemberStatus
  }
  if (update.task !== undefined) member.task = boundMemberTask(update.task)
  if (update.files !== undefined) member.files = boundMemberFiles(update.files)
  if (update.displayName !== undefined) {
    member.displayName = boundDisplayName(update.displayName)
  }
  member.updatedAt = Date.now()
  room.updatedAt = Date.now()

  if (opts.announce) {
    post({
      fromTileId: tileId,
      fromTileType: member.tileType,
      kind: 'status',
      text: `status=${member.status}${member.task ? ` task="${member.task}"` : ''}${member.files.length ? ` files=${member.files.slice(0, 5).join(',')}` : ''}`,
      meta: { status: member.status, task: member.task, files: member.files },
    })
  }

  publishRoom(room, 'member_state', { member: copyMember(member) })
  writeRoomFiles(room)
  return copyMember(member)
}

function formatEventsForInject(
  events: RoomEvent[],
  room: AgentRoom,
  maxBytes = MAX_EVENT_PROMPT_BYTES,
  expiredSequences = 0,
): string {
  if (events.length === 0) return ''
  const header = [
    '## Shared agent room traffic (new since your last turn)',
    `Room: ${room.id.slice(0, 8)} · ${events.length} event(s)`,
    '',
    ...(expiredSequences > 0
      ? [`[retained room traffic unavailable: ${expiredSequences} earlier sequence(s)]`, '']
      : []),
  ]
  const footer = [
    'Acknowledge this context in your work. To reply to room members use the room_post / peer_send_message MCP tools, or just continue — your turn summary will be shared when the turn ends.',
  ]
  const blocks = events.map(event => [
    `### [${event.kind}] from \`${event.fromTileId}\` (${event.fromTileType}) @ seq ${event.sequence}`,
    event.text,
    '',
  ].join('\n'))
  let selected: string[] = []
  let omitted = events.length

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const candidate = [blocks[index]!, ...selected]
    const candidateOmitted = index
    const lines = [
      ...header,
      ...(candidateOmitted > 0
        ? [`[earlier room traffic omitted: ${candidateOmitted} event(s)]`, '']
        : []),
      ...candidate,
      ...footer,
    ]
    if (Buffer.byteLength(lines.join('\n'), 'utf8') > maxBytes) break
    selected = candidate
    omitted = candidateOmitted
  }

  const lines = [
    ...header,
    ...(omitted > 0 ? [`[earlier room traffic omitted: ${omitted} event(s)]`, ''] : []),
    ...selected,
    ...footer,
  ]
  return truncateUtf8(lines.join('\n'), maxBytes, {
    marker: '\n[truncated]',
    trim: false,
  })
}

// ── Filesystem helpers for terminal agents ───────────────────────────────────

/** Revisioned, atomic room files under ~/.codesurf/rooms and per-tile inboxes. */
function writeRoomFiles(room: AgentRoom): void {
  const snap = snapshot(room)
  const payload = {
    ...snap,
    recentEvents: room.events.slice(-40).map(copyEvent),
  }
  const path = roomFilePath(room.id)
  ownedRoomFiles.add(path)
  persistence.writeJson(path, payload)

  // Per-member inbox files for terminals that can read the filesystem
  for (const m of room.members.values()) {
    const pending = room.events.filter(
      (e) => e.sequence > m.acknowledgedSeq && isVisible(e, m.tileId),
    )
    const expiredSequences = Math.max(
      0,
      (room.events[0]?.sequence ?? m.acknowledgedSeq + 1)
        - m.acknowledgedSeq
        - 1,
    )
    const body = truncateUtf8([
      `# Agent Room`,
      ``,
      `- room_id: \`${room.id}\``,
      `- your_tile_id: \`${m.tileId}\``,
      `- members: ${snap.members.map((x) => x.tileId).join(', ')}`,
      `- unconsumed: ${pending.length}`,
      ``,
      pending.length
        ? formatEventsForInject(pending, room, MAX_EVENT_PROMPT_BYTES, expiredSequences)
        : '_No pending room traffic. Use MCP `room_status` / `room_consume` or wait for peers._',
      ``,
    ].join('\n'), MAX_PROMPT_BYTES, {
      marker: '\n[truncated]',
      trim: false,
    })

    const inboxPath = inboxFilePath(m.tileId)
    ownedInboxFiles.add(inboxPath)
    persistence.writeText(inboxPath, body)
  }
}

// ── Compat shims matching old peer-state API ─────────────────────────────────

export interface PeerTodo {
  id: string
  text: string
  done: boolean
  createdAt: number
}

export interface PeerMessage {
  id: string
  from: string
  fromType: string
  text: string
  timestamp: number
  read: boolean
}

export interface PeerAgentState {
  tileId: string
  tileType: string
  status: MemberStatus
  task: string
  todos: PeerTodo[]
  files: string[]
  updatedAt: number
  roomId?: string | null
}

const todosByTile = new Map<string, PeerTodo[]>()

export function getAgentRoomStats(): {
  rooms: number
  memberships: number
  todos: number
  ownedRoomFiles: number
  ownedInboxFiles: number
  pendingPersistencePaths: number
  retainedEventBytes: number
} {
  let todoCount = 0
  for (const todos of todosByTile.values()) todoCount += todos.length
  let eventBytes = 0
  for (const room of rooms.values()) eventBytes += retainedEventBytes(room.events)
  return {
    rooms: rooms.size,
    memberships: membership.size,
    todos: todoCount,
    ownedRoomFiles: ownedRoomFiles.size,
    ownedInboxFiles: ownedInboxFiles.size,
    pendingPersistencePaths: persistence.getStats().pendingPaths,
    retainedEventBytes: eventBytes,
  }
}

export async function flushAgentRooms(): Promise<void> {
  if (disposePromise) {
    await disposePromise
    return
  }
  await persistence.flush()
}

async function disposeAgentRoomsInternal(): Promise<void> {
  notifyTerminalFn = null
  for (const roomId of rooms.keys()) bus.dropChannel(`room:${roomId}`)
  for (const path of ownedRoomFiles) {
    persistence.removeFile(path, { pruneEmptyParent: true })
  }
  for (const path of ownedInboxFiles) {
    persistence.removeFile(path, { pruneEmptyParent: true })
  }
  membership.clear()
  rooms.clear()
  todosByTile.clear()

  await persistence.dispose()
  ownedRoomFiles.clear()
  ownedInboxFiles.clear()
  persistence = createPersistenceQueue()
}

export function disposeAgentRooms(): Promise<void> {
  if (disposePromise) return disposePromise
  disposing = true
  const operation = disposeAgentRoomsInternal()
    .finally(() => {
      disposing = false
      disposePromise = null
    })
  disposePromise = operation
  return operation
}

export function setState(
  tileId: string,
  update: Partial<Omit<PeerAgentState, 'tileId' | 'updatedAt' | 'todos' | 'roomId'>>,
): PeerAgentState {
  if (disposing) {
    return {
      tileId: isValidAgentRoomId(tileId) ? tileId : 'invalid',
      tileType: 'unknown',
      status: 'idle',
      task: '',
      files: [],
      todos: [],
      updatedAt: Date.now(),
      roomId: null,
    }
  }
  const safeUpdate = update && typeof update === 'object' ? update : {}
  if (!isValidAgentRoomId(tileId)) {
    return {
      tileId: 'invalid',
      tileType: boundTileType(safeUpdate.tileType),
      status: MEMBER_STATUSES.has(safeUpdate.status as MemberStatus)
        ? safeUpdate.status as MemberStatus
        : 'idle',
      task: boundMemberTask(safeUpdate.task),
      files: boundMemberFiles(safeUpdate.files),
      todos: [],
      updatedAt: Date.now(),
      roomId: null,
    }
  }
  const member = setMemberState(tileId, {
    tileType: safeUpdate.tileType,
    status: safeUpdate.status as MemberStatus | undefined,
    task: safeUpdate.task,
    files: safeUpdate.files,
  }, { announce: true })
  const room = getRoomForTile(tileId)
  return {
    tileId,
    tileType: member?.tileType ?? boundTileType(safeUpdate.tileType),
    status: member?.status
      ?? (MEMBER_STATUSES.has(safeUpdate.status as MemberStatus)
        ? safeUpdate.status as MemberStatus
        : 'idle'),
    task: member?.task ?? boundMemberTask(safeUpdate.task),
    files: member?.files ?? boundMemberFiles(safeUpdate.files),
    todos: (todosByTile.get(tileId) ?? []).map(todo => ({ ...todo })),
    updatedAt: Date.now(),
    roomId: room?.id ?? null,
  }
}

export function getState(tileId: string): PeerAgentState | null {
  if (!isValidAgentRoomId(tileId)) return null
  const room = getRoomForTile(tileId)
  if (!room) return null
  const m = room.members.find((x) => x.tileId === tileId)
  if (!m) return null
  return {
    tileId: m.tileId,
    tileType: m.tileType,
    status: m.status,
    task: m.task,
    files: [...m.files],
    todos: (todosByTile.get(tileId) ?? []).map(todo => ({ ...todo })),
    updatedAt: m.updatedAt,
    roomId: room.id,
  }
}

export function getLinkedPeerStates(tileId: string): PeerAgentState[] {
  if (!isValidAgentRoomId(tileId)) return []
  const room = getRoomForTile(tileId)
  if (!room) return []
  return room.members
    .filter((m) => m.tileId !== tileId)
    .map((m) => ({
      tileId: m.tileId,
      tileType: m.tileType,
      status: m.status,
      task: m.task,
      files: [...m.files],
      todos: (todosByTile.get(m.tileId) ?? []).map(todo => ({ ...todo })),
      updatedAt: m.updatedAt,
      roomId: room.id,
    }))
}

export function addTodo(tileId: string, text: string): PeerTodo {
  if (disposing) throw new AgentRoomValidationError('Agent rooms are disposing')
  if (!isValidAgentRoomId(tileId)) {
    throw new AgentRoomValidationError('Invalid tileId')
  }
  const boundedText = boundEventText(text)
  if (!boundedText) throw new AgentRoomValidationError('Todo text is empty')
  const list = todosByTile.get(tileId) ?? []
  if (list.length >= MAX_TODOS_PER_TILE) {
    throw new AgentRoomValidationError(`Todo limit of ${MAX_TODOS_PER_TILE} reached`)
  }
  const todo: PeerTodo = {
    id: `todo-${randomUUID()}`,
    text: boundedText,
    done: false,
    createdAt: Date.now(),
  }
  list.push(todo)
  todosByTile.set(tileId, list)
  post({
    fromTileId: tileId,
    kind: 'task',
    text: `todo added: ${boundedText}`,
    meta: { todoId: todo.id },
  })
  return { ...todo }
}

export function completeTodo(tileId: string, todoId: string): boolean {
  if (disposing) return false
  if (!isValidAgentRoomId(tileId) || !isValidAgentRoomId(todoId)) return false
  const list = todosByTile.get(tileId) ?? []
  const todo = list.find((t) => t.id === todoId)
  if (!todo || todo.done) return false
  todo.done = true
  post({
    fromTileId: tileId,
    kind: 'status',
    text: `todo completed: ${todo.text}`,
    meta: { todoId },
  })
  return true
}

export function sendMessage(fromTileId: string, toTileId: string, text: string): PeerMessage {
  const boundedText = boundEventText(text)
  const event = isValidAgentRoomId(fromTileId)
    && isValidAgentRoomId(toTileId)
    && boundedText
    ? post({
        fromTileId,
        targetTileIds: [toTileId],
        kind: 'message',
        text: boundedText,
      })
    : null
  return {
    id: event?.id ?? randomUUID(),
    from: isValidAgentRoomId(fromTileId) ? fromTileId : 'invalid',
    fromType: event?.fromTileType ?? 'unknown',
    text: boundedText,
    timestamp: event?.createdAt ?? Date.now(),
    read: false,
  }
}

export function readMessages(tileId: string): PeerMessage[] {
  if (!isValidAgentRoomId(tileId)) return []
  const result = consume(tileId)
  return result.events.map((e) => ({
    id: e.id,
    from: e.fromTileId,
    fromType: e.fromTileType,
    text: e.text,
    timestamp: e.createdAt,
    read: true,
  }))
}

export function getUnreadMessages(tileId: string): PeerMessage[] {
  if (!isValidAgentRoomId(tileId)) return []
  const roomId = membership.get(tileId)
  if (!roomId) return []
  const room = rooms.get(roomId)
  if (!room) return []
  const member = room.members.get(tileId)
  if (!member) return []
  return room.events
    .filter((e) => e.sequence > member.acknowledgedSeq && isVisible(e, tileId))
    .map((e) => ({
      id: e.id,
      from: e.fromTileId,
      fromType: e.fromTileType,
      text: e.text,
      timestamp: e.createdAt,
      read: false,
    }))
}

/**
 * Build system-prompt injection for a chat/terminal turn:
 * standing room digest + consumed pending traffic.
 */
export function prepareTurnContext(tileId: string, tileType = 'chat'): {
  roomId: string | null
  systemExtra: string
  consumed: ConsumeResult
} {
  if (!isValidAgentRoomId(tileId)) {
    return {
      roomId: null,
      systemExtra: '',
      consumed: emptyConsumeResult(),
    }
  }
  const d = digest(tileId)
  const consumed = consume(tileId)
  // Ensure member type is recorded
  if (d.roomId) {
    setMemberState(tileId, { tileType, status: 'working' })
  }
  const parts = [d.standingText, consumed.text].filter((s) => s.trim().length > 0)
  return {
    roomId: d.roomId,
    systemExtra: truncateUtf8(parts.join('\n\n'), MAX_PROMPT_BYTES, {
      marker: '\n[truncated]',
      trim: false,
    }),
    consumed,
  }
}

/** After a turn finishes, share a compact summary with the room. */
export function publishTurnSummary(
  tileId: string,
  summary: string,
  tileType = 'chat',
): RoomEvent | null {
  if (!isValidAgentRoomId(tileId) || typeof summary !== 'string') return null
  const text = boundEventText(summary)
  if (!text) return null
  setMemberState(tileId, { tileType, status: 'idle' })
  return post({
    fromTileId: tileId,
    fromTileType: tileType,
    kind: 'summary',
    text,
  })
}

export type { RoomEvent, RoomEventKind, RoomMember, RoomSnapshot, ConsumeResult }
