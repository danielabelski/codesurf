/**
 * CodeSurf Agent Rooms — Mosaic-style multi-agent connectivity.
 *
 * Canvas wires establish room membership. Members share a sequenced event
 * ledger. Each member has an ack cursor; `consume` returns only unread events
 * and advances the cursor. Realtime fan-out goes over the main process bus
 * (`room:<id>` and `tile:<id>`).
 */

import { randomUUID } from 'node:crypto'
import { bus } from '../event-bus.ts'
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

const MAX_EVENTS_PER_ROOM = 500

// tileId → roomId
const membership = new Map<string, string>()
// roomId → room
const rooms = new Map<string, AgentRoom>()

// Optional PTY notifier for terminal tiles (secondary; primary is consume)
type NotifyCallback = (tileId: string, line: string) => void
let notifyTerminalFn: NotifyCallback | null = null

export function setTerminalNotifier(fn: NotifyCallback): void {
  notifyTerminalFn = fn
}

function memberKeyOf(tileIds: Iterable<string>): string {
  return [...tileIds].sort().join('|')
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
    members: [...room.members.values()].sort((a, b) => a.tileId.localeCompare(b.tileId)),
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
    tileType,
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
  const component = new Set<string>([tileId, ...peerIds.filter(Boolean)])
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
        ensureMember(room, id, tileTypes[id] ?? 'unknown')
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
    }
  }

  for (const id of component) {
    // If they were in a different room, leave it first
    const prev = membership.get(id)
    if (prev && prev !== host.id) {
      const old = rooms.get(prev)
      if (old) {
        old.members.delete(id)
        if (old.members.size < 2) dissolveRoom(old.id)
      }
    }
    ensureMember(host, id, tileTypes[id] ?? 'unknown')
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
  }
  rooms.delete(roomId)
  bus.publish({
    channel: `room:${roomId}`,
    type: 'system',
    source: 'agent-room',
    payload: { action: 'dissolved', roomId },
  })
}

export function leaveRoom(tileId: string): void {
  const rid = membership.get(tileId)
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
  const rid = membership.get(tileId)
  if (!rid) return null
  const room = rooms.get(rid)
  return room ? snapshot(room) : null
}

export function getRoom(roomId: string): RoomSnapshot | null {
  const room = rooms.get(roomId)
  return room ? snapshot(room) : null
}

export function post(input: PostInput): RoomEvent | null {
  const roomId = membership.get(input.fromTileId)
  if (!roomId) return null
  const room = rooms.get(roomId)
  if (!room) return null

  const member = ensureMember(room, input.fromTileId, input.fromTileType ?? 'unknown')
  const text = input.text.trim()
  if (!text) return null

  const event: RoomEvent = {
    id: randomUUID(),
    sequence: room.nextSequence++,
    roomId: room.id,
    kind: input.kind ?? 'message',
    fromTileId: input.fromTileId,
    fromTileType: member.tileType || input.fromTileType || 'unknown',
    text,
    targetTileIds: input.targetTileIds?.filter(Boolean) ?? [],
    createdAt: Date.now(),
    meta: input.meta,
  }

  room.events.push(event)
  if (room.events.length > MAX_EVENTS_PER_ROOM) {
    room.events.splice(0, room.events.length - MAX_EVENTS_PER_ROOM)
  }
  room.updatedAt = Date.now()

  // Auto-ack own posts so we don't re-consume our own messages
  member.acknowledgedSeq = Math.max(member.acknowledgedSeq, event.sequence)
  member.updatedAt = Date.now()

  publishRoom(room, 'event', { event })
  writeRoomFiles(room)

  // Secondary: brief PTY ping for terminals (not the primary delivery path)
  for (const [tid, m] of room.members) {
    if (tid === input.fromTileId) continue
    if (event.targetTileIds.length > 0 && !event.targetTileIds.includes(tid)) continue
    if (m.tileType === 'terminal' && notifyTerminalFn) {
      notifyTerminalFn(tid, `[codesurf room] ${event.kind} from ${event.fromTileId}: ${text.slice(0, 200)}`)
    }
  }

  return event
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
  const roomId = membership.get(tileId)
  if (!roomId) {
    return { roomId: null, text: '', events: [], latestSequence: 0, members: [] }
  }
  const room = rooms.get(roomId)
  if (!room) {
    return { roomId: null, text: '', events: [], latestSequence: 0, members: [] }
  }

  const member = ensureMember(room, tileId)
  const pending = room.events.filter(
    (e) => e.sequence > member.acknowledgedSeq && isVisible(e, tileId),
  )

  if (pending.length > 0) {
    member.acknowledgedSeq = pending[pending.length - 1]!.sequence
    member.updatedAt = Date.now()
    room.updatedAt = Date.now()
    writeRoomFiles(room)
  }

  const text = formatEventsForInject(pending, room)
  return {
    roomId: room.id,
    text,
    events: pending,
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
    standingText: lines.join('\n'),
  }
}

export function setMemberState(
  tileId: string,
  update: Partial<Pick<RoomMember, 'tileType' | 'status' | 'task' | 'files' | 'displayName'>>,
  opts: { announce?: boolean } = {},
): RoomMember | null {
  const roomId = membership.get(tileId)
  if (!roomId) {
    // Not in a room yet — no-op member record isn't useful; chat will sync links first
    return null
  }
  const room = rooms.get(roomId)
  if (!room) return null
  const member = ensureMember(room, tileId, update.tileType)
  if (update.tileType) member.tileType = update.tileType
  if (update.status) member.status = update.status
  if (update.task !== undefined) member.task = update.task
  if (update.files) member.files = update.files
  if (update.displayName !== undefined) member.displayName = update.displayName
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

  publishRoom(room, 'member_state', { member })
  writeRoomFiles(room)
  return member
}

function formatEventsForInject(events: RoomEvent[], room: AgentRoom): string {
  if (events.length === 0) return ''
  const lines = [
    '## Shared agent room traffic (new since your last turn)',
    `Room: ${room.id.slice(0, 8)} · ${events.length} event(s)`,
    '',
  ]
  for (const e of events) {
    lines.push(`### [${e.kind}] from \`${e.fromTileId}\` (${e.fromTileType}) @ seq ${e.sequence}`)
    lines.push(e.text)
    lines.push('')
  }
  lines.push(
    'Acknowledge this context in your work. To reply to room members use the room_post / peer_send_message MCP tools, or just continue — your turn summary will be shared when the turn ends.',
  )
  return lines.join('\n')
}

// ── Filesystem helpers for terminal agents ───────────────────────────────────

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { CODESURF_HOME } from '../paths.ts'

/** Best-effort room files under ~/.codesurf/rooms and per-tile room.md */
function writeRoomFiles(room: AgentRoom): void {
  const snap = snapshot(room)
  const payload = {
    ...snap,
    recentEvents: room.events.slice(-40),
  }
  const dir = join(CODESURF_HOME, 'rooms')
  void fs.mkdir(dir, { recursive: true }).then(() =>
    fs.writeFile(join(dir, `${room.id}.json`), JSON.stringify(payload, null, 2)),
  ).catch(() => {})

  // Per-member inbox files for terminals that can read the filesystem
  for (const m of room.members.values()) {
    const pending = room.events.filter(
      (e) => e.sequence > m.acknowledgedSeq && isVisible(e, m.tileId),
    )
    const body = [
      `# Agent Room`,
      ``,
      `- room_id: \`${room.id}\``,
      `- your_tile_id: \`${m.tileId}\``,
      `- members: ${snap.members.map((x) => x.tileId).join(', ')}`,
      `- unconsumed: ${pending.length}`,
      ``,
      pending.length
        ? formatEventsForInject(pending, room)
        : '_No pending room traffic. Use MCP `room_status` / `room_consume` or wait for peers._',
      ``,
    ].join('\n')

    // Store under home so we don't need workspace path here
    const tileDir = join(CODESURF_HOME, 'room-inboxes', m.tileId)
    void fs.mkdir(tileDir, { recursive: true }).then(() =>
      fs.writeFile(join(tileDir, 'ROOM.md'), body),
    ).catch(() => {})
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

export function setState(
  tileId: string,
  update: Partial<Omit<PeerAgentState, 'tileId' | 'updatedAt' | 'todos' | 'roomId'>>,
): PeerAgentState {
  const member = setMemberState(tileId, {
    tileType: update.tileType,
    status: update.status as MemberStatus | undefined,
    task: update.task,
    files: update.files,
  }, { announce: true })
  const room = getRoomForTile(tileId)
  return {
    tileId,
    tileType: member?.tileType ?? update.tileType ?? 'unknown',
    status: member?.status ?? update.status ?? 'idle',
    task: member?.task ?? update.task ?? '',
    files: member?.files ?? update.files ?? [],
    todos: todosByTile.get(tileId) ?? [],
    updatedAt: Date.now(),
    roomId: room?.id ?? null,
  }
}

export function getState(tileId: string): PeerAgentState | null {
  const room = getRoomForTile(tileId)
  if (!room) return null
  const m = room.members.find((x) => x.tileId === tileId)
  if (!m) return null
  return {
    tileId: m.tileId,
    tileType: m.tileType,
    status: m.status,
    task: m.task,
    files: m.files,
    todos: todosByTile.get(tileId) ?? [],
    updatedAt: m.updatedAt,
    roomId: room.id,
  }
}

export function getLinkedPeerStates(tileId: string): PeerAgentState[] {
  const room = getRoomForTile(tileId)
  if (!room) return []
  return room.members
    .filter((m) => m.tileId !== tileId)
    .map((m) => ({
      tileId: m.tileId,
      tileType: m.tileType,
      status: m.status,
      task: m.task,
      files: m.files,
      todos: todosByTile.get(m.tileId) ?? [],
      updatedAt: m.updatedAt,
      roomId: room.id,
    }))
}

export function addTodo(tileId: string, text: string): PeerTodo {
  const list = todosByTile.get(tileId) ?? []
  const todo: PeerTodo = {
    id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    text,
    done: false,
    createdAt: Date.now(),
  }
  list.push(todo)
  todosByTile.set(tileId, list)
  post({
    fromTileId: tileId,
    kind: 'task',
    text: `todo added: ${text}`,
    meta: { todoId: todo.id },
  })
  return todo
}

export function completeTodo(tileId: string, todoId: string): boolean {
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
  const event = post({
    fromTileId,
    targetTileIds: [toTileId],
    kind: 'message',
    text,
  })
  return {
    id: event?.id ?? randomUUID(),
    from: fromTileId,
    fromType: event?.fromTileType ?? 'unknown',
    text,
    timestamp: event?.createdAt ?? Date.now(),
    read: false,
  }
}

export function readMessages(tileId: string): PeerMessage[] {
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
  const d = digest(tileId)
  const consumed = consume(tileId)
  // Ensure member type is recorded
  if (d.roomId) {
    setMemberState(tileId, { tileType, status: 'working' })
  }
  const parts = [d.standingText, consumed.text].filter((s) => s.trim().length > 0)
  return {
    roomId: d.roomId,
    systemExtra: parts.join('\n\n'),
    consumed,
  }
}

/** After a turn finishes, share a compact summary with the room. */
export function publishTurnSummary(
  tileId: string,
  summary: string,
  tileType = 'chat',
): RoomEvent | null {
  const text = summary.trim()
  if (!text) return null
  setMemberState(tileId, { tileType, status: 'idle' })
  return post({
    fromTileId: tileId,
    fromTileType: tileType,
    kind: 'summary',
    text: text.slice(0, 4000),
  })
}

export type { RoomEvent, RoomEventKind, RoomMember, RoomSnapshot, ConsumeResult }
