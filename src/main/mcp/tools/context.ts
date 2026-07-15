import { promises as fs } from 'fs'
import { join } from 'path'
import { bus } from '../../event-bus'
import { CODESURF_HOME } from '../../paths'
import { loadWorkspaceTileState, saveWorkspaceTileState } from '../../storage/workspaceArtifacts'
import * as peerState from '../../peer-state'
import * as agentRoom from '../../agent-room/index.ts'
import { broadcastToRenderer } from '../../utils/broadcast'
import { asString, type McpToolContext, type McpToolSchema } from '../types'
import { errorMessage } from '../../../shared/errors.ts'
import { assertTileScope } from '../auth'

type UserConfigWorkspaceRef = {
  id: string
  path: string
}

const getContexDir = (): string => CODESURF_HOME

async function readWorkspaceRefsFromUserConfig(): Promise<UserConfigWorkspaceRef[]> {
  try {
    const userConfigPath = join(getContexDir(), 'config.json')
    const raw = await fs.readFile(userConfigPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      projects?: Array<{ id?: string; path?: string }>
      workspaces?: Array<{ id?: string; path?: string; projectIds?: string[]; primaryProjectId?: string | null }>
    }

    if (Array.isArray(parsed.projects) && Array.isArray(parsed.workspaces)) {
      const projectsById = new Map(
        parsed.projects
          .filter(project => typeof project?.id === 'string' && typeof project?.path === 'string' && project.path.trim())
          .map(project => [String(project.id), String(project.path).trim()] as const),
      )

      return parsed.workspaces.flatMap(workspace => {
        const workspaceId = typeof workspace?.id === 'string' ? workspace.id : ''
        if (!workspaceId) return []

        const directPath = typeof workspace?.path === 'string' ? workspace.path.trim() : ''
        if (directPath) return [{ id: workspaceId, path: directPath }]

        const primaryProjectId = typeof workspace?.primaryProjectId === 'string' ? workspace.primaryProjectId : null
        const projectIds = Array.isArray(workspace?.projectIds) ? workspace.projectIds : []
        const projectPath = (primaryProjectId && projectsById.get(primaryProjectId))
          || projectIds.map(projectId => projectsById.get(String(projectId))).find(Boolean)
          || ''
        return projectPath ? [{ id: workspaceId, path: projectPath }] : []
      })
    }

    if (Array.isArray(parsed.workspaces)) {
      return parsed.workspaces.flatMap(workspace => {
        const workspaceId = typeof workspace?.id === 'string' ? workspace.id : ''
        const workspacePath = typeof workspace?.path === 'string' ? workspace.path.trim() : ''
        return workspaceId && workspacePath ? [{ id: workspaceId, path: workspacePath }] : []
      })
    }
  } catch {
    // ignore missing or invalid config
  }

  return []
}

function assertMcpSafeId(id: string): string | null {
  return /[/\\]|\.\./.test(id) ? `Unsafe ID: ${id}` : null
}

export const CONTEXT_TOOLS: McpToolSchema[] = [
  {
    name: 'room_status',
    description: 'Show your agent room: room id, members, their status, and how many unread room events you have. Canvas wires place you in a room automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID (use $CARD_ID)' },
      },
      required: ['tile_id'],
    },
  },
  {
    name: 'room_post',
    description: 'Post into the shared agent room (message, task, handoff, summary, question, …). Room peers receive it on their next turn (and via realtime bus). Prefer this over freeform guessing about peers.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID' },
        text: { type: 'string', description: 'Message body' },
        kind: {
          type: 'string',
          enum: ['message', 'task', 'handoff', 'summary', 'status', 'finding', 'blocker', 'question', 'decision'],
          description: 'Event kind (default message)',
        },
        to_tile_id: { type: 'string', description: 'Optional: target a single room member; omit for whole room' },
      },
      required: ['tile_id', 'text'],
    },
  },
  {
    name: 'room_consume',
    description: 'Drain unread room events for you and mark them consumed. Usually auto-injected each chat turn; call from terminals when you need pending traffic now.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID' },
      },
      required: ['tile_id'],
    },
  },
  {
    name: 'peer_set_state',
    description: 'Announce your work state to the agent room (status, task, files). Room peers see this via room_status / peer_get_state and realtime updates.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID (use $CARD_ID)' },
        tile_type: { type: 'string', description: 'Your block type (terminal, chat, etc.)' },
        status: { type: 'string', enum: ['idle', 'working', 'blocked', 'waiting', 'done'], description: 'Current status' },
        task: { type: 'string', description: 'What you are currently working on' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files you are actively editing' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'peer_get_state',
    description: 'Snapshot of other members in your agent room (status, task, files). Prefer room traffic injection + room_status for coordination.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID — returns states of your room peers' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'peer_send_message',
    description: 'Send a direct message to a room peer (posts into the room ledger targeted at them).',
    inputSchema: {
      type: 'object',
      properties: {
        from_tile_id: { type: 'string', description: 'Your block ID' },
        to_tile_id: { type: 'string', description: 'Recipient peer block ID' },
        message: { type: 'string', description: 'Message text' },
      },
      required: ['from_tile_id', 'to_tile_id', 'message']
    }
  },
  {
    name: 'peer_read_messages',
    description: 'Consume unread room messages for you (same as room_consume).',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'peer_add_todo',
    description: 'Add a todo and announce it to the room.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID' },
        text: { type: 'string', description: 'Todo item text' },
      },
      required: ['tile_id', 'text']
    }
  },
  {
    name: 'peer_complete_todo',
    description: 'Mark one of your todos as done and announce it to the room.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID' },
        todo_id: { type: 'string', description: 'The todo ID to complete' },
      },
      required: ['tile_id', 'todo_id']
    }
  },
  {
    name: 'tile_context_get',
    description: 'Read context entries from a block. Agents can read/write any block context across workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The block ID to read context from' },
        workspace_id: { type: 'string', description: 'The workspace ID (optional; uses first workspace if omitted)' },
        tag: { type: 'string', description: 'Filter by tag prefix (e.g., "ctx:design"; optional)' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'tile_context_set',
    description: 'Write a context entry to a block. Agents can read/write any block context across workspaces.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The block ID to write context to' },
        workspace_id: { type: 'string', description: 'The workspace ID (optional; uses first workspace if omitted)' },
        key: { type: 'string', description: 'Context key (e.g., "ctx:design:palette")' },
        value: { description: 'Context value (any JSON-serializable value)' },
      },
      required: ['tile_id', 'key', 'value']
    }
  },
  {
    name: 'ext_invoke_action',
    description: 'Invoke a registered action on an extension block. Extensions declare actions that connected blocks can call (e.g. generate, setHtml). Use tile_context_get to read extension state afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Target extension block ID' },
        action: { type: 'string', description: 'Action name to invoke (e.g. "generate", "setHtml")' },
        params: { type: 'object', description: 'Parameters for the action' },
      },
      required: ['tile_id', 'action']
    }
  },
]

const CONTEXT_TOOL_NAMES = new Set(CONTEXT_TOOLS.map(tool => tool.name))

export async function handleContextTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<string | null> {
  if (!CONTEXT_TOOL_NAMES.has(name)) return null

  if (name === 'room_status') {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'
    const scopeError = assertTileScope(ctx.principal, tileId)
    if (scopeError) return scopeError
    const d = agentRoom.digest(tileId)
    if (!d.roomId) {
      return JSON.stringify({
        inRoom: false,
        message: 'Not in an agent room. Wire this block to another chat/terminal on the canvas first.',
      }, null, 2)
    }
    return JSON.stringify({
      inRoom: true,
      roomId: d.roomId,
      unconsumed: d.unconsumed,
      members: d.members,
      standing: d.standingText,
    }, null, 2)
  }

  if (name === 'room_post') {
    const tileId = ctx.principal.kind === 'tile' ? ctx.principal.tileId : asString(args.tile_id)
    const text = asString(args.text)
    if (!tileId || !text) return 'Missing tile_id or text'
    const scopeError = assertTileScope(ctx.principal, tileId)
    if (scopeError) return scopeError
    const kindRaw = asString(args.kind) ?? 'message'
    const allowedKinds = new Set([
      'message', 'task', 'handoff', 'summary', 'status', 'finding', 'blocker', 'question', 'decision',
    ])
    const kind = (allowedKinds.has(kindRaw) ? kindRaw : 'message') as agentRoom.RoomEventKind
    const to = asString(args.to_tile_id)
    const event = agentRoom.post({
      fromTileId: tileId,
      text,
      kind,
      targetTileIds: to ? [to] : undefined,
    })
    if (!event) {
      return 'Not in an agent room (or empty text). Wire this block to peers on the canvas first.'
    }
    return JSON.stringify({ ok: true, event }, null, 2)
  }

  if (name === 'room_consume') {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'
    const scopeError = assertTileScope(ctx.principal, tileId)
    if (scopeError) return scopeError
    const result = agentRoom.consume(tileId)
    if (!result.roomId) return 'Not in an agent room.'
    if (result.events.length === 0) return 'No unread room events.'
    return result.text || JSON.stringify(result.events, null, 2)
  }

  if (name === 'peer_set_state') {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'
    // tile_id is the caller's own block ("Your block ID" per schema) — a
    // tile-scoped token must not be able to declare state for another tile.
    const scopeError = assertTileScope(ctx.principal, tileId)
    if (scopeError) return scopeError
    const state = peerState.setState(tileId, {
      tileType: asString(args.tile_type) ?? undefined,
      status: (() => {
        const s = asString(args.status)
        if (s === 'idle' || s === 'working' || s === 'blocked' || s === 'waiting' || s === 'done') return s
        return undefined
      })(),
      task: asString(args.task) ?? undefined,
      files: Array.isArray(args.files) ? args.files.filter(f => typeof f === 'string') as string[] : undefined,
    })
    return JSON.stringify(state, null, 2)
  }

  if (name === 'peer_get_state') {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'
    // Read-only, but scoped to consistency with peer_set_state — a
    // tile-scoped token only queries its own peer graph.
    const scopeError = assertTileScope(ctx.principal, tileId)
    if (scopeError) return scopeError
    const room = agentRoom.getRoomForTile(tileId)
    const peerStates = peerState.getLinkedPeerStates(tileId)
    if (!room) {
      return JSON.stringify({
        inRoom: false,
        peers: [],
        message: 'Not in an agent room. Wire this block to another on the canvas.',
      }, null, 2)
    }
    return JSON.stringify({
      inRoom: true,
      roomId: room.id,
      peers: peerStates,
      members: room.members,
    }, null, 2)
  }

  if (name === 'peer_send_message') {
    // to_tile_id is intentionally cross-tile (the whole point is messaging a
    // peer). from_tile_id is a sender-identity claim: a tile-scoped
    // principal can't lie about who sent it, so stamp it from the token
    // rather than trusting the caller-supplied value.
    const from = ctx.principal.kind === 'tile' ? ctx.principal.tileId : asString(args.from_tile_id)
    const to = asString(args.to_tile_id)
    const message = asString(args.message)
    if (!from || !to || !message) return 'Missing from_tile_id, to_tile_id, or message'
    const msg = peerState.sendMessage(from, to, message)
    return `Message sent to ${to}: "${message}" (id: ${msg.id})`
  }

  if (name === 'peer_read_messages') {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'
    // Reads and marks-as-read another tile's inbox — a tile-scoped token
    // must not be able to read messages addressed to a different tile.
    const scopeError = assertTileScope(ctx.principal, tileId)
    if (scopeError) return scopeError
    const msgs = peerState.readMessages(tileId)
    if (msgs.length === 0) return 'No messages.'
    return JSON.stringify(msgs, null, 2)
  }

  if (name === 'peer_add_todo') {
    const tileId = asString(args.tile_id)
    const text = asString(args.text)
    if (!tileId || !text) return 'Missing tile_id or text'
    // Mutates tileId's shared todo list — self-scoped like peer_set_state.
    const scopeError = assertTileScope(ctx.principal, tileId)
    if (scopeError) return scopeError
    try {
      const todo = peerState.addTodo(tileId, text)
      return `Todo added: "${text}" (id: ${todo.id})`
    } catch (err) {
      return errorMessage(err)
    }
  }

  if (name === 'peer_complete_todo') {
    const tileId = asString(args.tile_id)
    const todoId = asString(args.todo_id)
    if (!tileId || !todoId) return 'Missing tile_id or todo_id'
    // Mutates tileId's shared todo list — self-scoped like peer_set_state.
    const scopeError = assertTileScope(ctx.principal, tileId)
    if (scopeError) return scopeError
    const ok = peerState.completeTodo(tileId, todoId)
    return ok ? `Todo ${todoId} marked done` : `Todo ${todoId} not found or already done`
  }

  if (name === 'tile_context_get') {
    // Cross-tile by design ("Agents can read/write any block context across
    // workspaces" per the tool's own schema description) — no scope guard.
    const tileId = asString(args.tile_id)
    const workspaceId = asString(args.workspace_id)
    const tagPrefix = asString(args.tag)
    if (!tileId) return 'Missing tile_id'
    const tileIdErr = assertMcpSafeId(tileId)
    if (tileIdErr) return tileIdErr
    if (workspaceId) {
      const wsErr = assertMcpSafeId(workspaceId)
      if (wsErr) return wsErr
    }

    try {
      const workspaceRefs = await readWorkspaceRefsFromUserConfig()
      const workspace = workspaceId
        ? workspaceRefs.find(ws => ws.id === workspaceId)
        : workspaceRefs[0]

      if (!workspace) return 'Workspace not found'

      try {
        const state = await loadWorkspaceTileState<{ _context?: Record<string, any> }>(workspace.id, tileId, {})
        const ctx = state._context ?? {}
        const entries = Object.values(ctx)

        if (tagPrefix) {
          return JSON.stringify(entries.filter((e: { key?: string }) => e.key?.startsWith(tagPrefix)), null, 2)
        }
        return JSON.stringify(entries, null, 2)
      } catch {
        return '[]'
      }
    } catch (err) {
      return `Error reading context: ${errorMessage(err)}`
    }
  }

  if (name === 'ext_invoke_action') {
    // Cross-tile by design — invoking actions on another block (e.g. an
    // extension tile) is the documented purpose of this tool.
    const tileId = asString(args.tile_id)
    const action = asString(args.action)
    if (!tileId || !action) return 'Missing tile_id or action'
    if (!peerState.getState(tileId)) return `Block '${tileId}' is not registered — action refused`
    const params = typeof args.params === 'object' && args.params ? args.params as Record<string, unknown> : {}
    broadcastToRenderer('tileContext:changed', {
      tileId,
      key: '_action',
      value: { action, params, ts: Date.now() },
    })
    return `Action '${action}' dispatched to extension block ${tileId}`
  }

  if (name === 'tile_context_set') {
    // Cross-tile by design, same as tile_context_get.
    const tileId = asString(args.tile_id)
    const workspaceId = asString(args.workspace_id)
    const key = asString(args.key)
    const value = args.value
    if (!tileId || !key) return 'Missing tile_id or key'
    const tileIdErrS = assertMcpSafeId(tileId)
    if (tileIdErrS) return tileIdErrS
    if (workspaceId) {
      const wsErr = assertMcpSafeId(workspaceId)
      if (wsErr) return wsErr
    }

    try {
      const workspaceRefs = await readWorkspaceRefsFromUserConfig()
      const workspace = workspaceId
        ? workspaceRefs.find(ws => ws.id === workspaceId)
        : workspaceRefs[0]

      if (!workspace) return 'Workspace not found'

      const state = await loadWorkspaceTileState<{ _context?: Record<string, any>; [k: string]: unknown }>(workspace.id, tileId, {})

      if (!state._context) state._context = {}
      state._context[key] = { key, value, updatedAt: Date.now(), source: tileId }

      await saveWorkspaceTileState(workspace.id, tileId, state)

      bus.publish({
        channel: `ctx:${tileId}`,
        type: 'data',
        source: 'mcp:context',
        payload: { action: 'context_changed', key, value, tileId },
      })

      return `Context ${key} set to: ${JSON.stringify(value)}`
    } catch (err) {
      return `Error writing context: ${errorMessage(err)}`
    }
  }

  return null
}
