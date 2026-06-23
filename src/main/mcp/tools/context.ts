import { promises as fs } from 'fs'
import { join } from 'path'
import { bus } from '../../event-bus'
import { CONTEX_HOME } from '../../paths'
import { loadWorkspaceTileState, saveWorkspaceTileState } from '../../storage/workspaceArtifacts'
import * as peerState from '../../peer-state'
import { broadcastToRenderer } from '../../utils/broadcast'
import { asString, type McpToolContext, type McpToolSchema } from '../types'

type UserConfigWorkspaceRef = {
  id: string
  path: string
}

const getContexDir = (): string => CONTEX_HOME

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
    name: 'peer_set_state',
    description: 'Declare your current work state so linked peers can see what you are doing. Call this when you start a task, change status, or update your file list.',
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
    description: 'Read the work state of all linked peers — their status, current task, todos, and files. Call this to coordinate and avoid duplicating work.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'Your block ID — returns states of your linked peers' },
      },
      required: ['tile_id']
    }
  },
  {
    name: 'peer_send_message',
    description: 'Send a direct message to a linked peer. The peer will see it as a notification and can read it with peer_read_messages.',
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
    description: 'Read messages sent to you by linked peers. Returns all messages (marks unread as read).',
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
    description: 'Add a todo item to your shared list. Linked peers are notified and can see your todos via peer_get_state.',
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
    description: 'Mark one of your todos as done. Linked peers are notified.',
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
  _ctx: McpToolContext,
): Promise<string | null> {
  if (!CONTEXT_TOOL_NAMES.has(name)) return null

  if (name === 'peer_set_state') {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'
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
    const peerStates = peerState.getLinkedPeerStates(tileId)
    if (peerStates.length === 0) return 'No linked peers with registered state. Peers must call peer_set_state first.'
    return JSON.stringify(peerStates, null, 2)
  }

  if (name === 'peer_send_message') {
    const from = asString(args.from_tile_id)
    const to = asString(args.to_tile_id)
    const message = asString(args.message)
    if (!from || !to || !message) return 'Missing from_tile_id, to_tile_id, or message'
    const msg = peerState.sendMessage(from, to, message)
    return `Message sent to ${to}: "${message}" (id: ${msg.id})`
  }

  if (name === 'peer_read_messages') {
    const tileId = asString(args.tile_id)
    if (!tileId) return 'Missing tile_id'
    const msgs = peerState.readMessages(tileId)
    if (msgs.length === 0) return 'No messages.'
    return JSON.stringify(msgs, null, 2)
  }

  if (name === 'peer_add_todo') {
    const tileId = asString(args.tile_id)
    const text = asString(args.text)
    if (!tileId || !text) return 'Missing tile_id or text'
    try {
      const todo = peerState.addTodo(tileId, text)
      return `Todo added: "${text}" (id: ${todo.id})`
    } catch (err: any) {
      return err.message
    }
  }

  if (name === 'peer_complete_todo') {
    const tileId = asString(args.tile_id)
    const todoId = asString(args.todo_id)
    if (!tileId || !todoId) return 'Missing tile_id or todo_id'
    const ok = peerState.completeTodo(tileId, todoId)
    return ok ? `Todo ${todoId} marked done` : `Todo ${todoId} not found or already done`
  }

  if (name === 'tile_context_get') {
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
          return JSON.stringify(entries.filter((e: any) => e.key?.startsWith(tagPrefix)), null, 2)
        }
        return JSON.stringify(entries, null, 2)
      } catch {
        return '[]'
      }
    } catch (err: any) {
      return `Error reading context: ${err.message}`
    }
  }

  if (name === 'ext_invoke_action') {
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
    } catch (err: any) {
      return `Error writing context: ${err.message}`
    }
  }

  return null
}