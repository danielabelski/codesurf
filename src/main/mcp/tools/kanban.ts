import { bus } from '../../event-bus'
import { errorMessage } from '../../../shared/errors.ts'
import { promises as fs } from 'fs'
import { join } from 'path'
import { CONTEX_HOME } from '../../paths'
import { asString, type McpToolContext, type McpToolSchema } from '../types'
import { assertTileScope } from '../auth'

export interface MCPKanbanColumn {
  id: string
  title: string
}

export interface MCPKanbanCard {
  id: string
  title: string
  description: string
  instructions: string
  columnId: string
  color: string
  linkedTileId?: string
  linkedTileType?: string
  linkedGroupId?: string
  linkedTileIds?: string[]
  justMoved?: boolean
  agent: string
  model?: string
  mcpConfig?: string
  mcpServers: Array<{ name: string; url?: string; cmd?: string }>
  tools: string[]
  skillsAndCommands: string[]
  fileRefs: string[]
  cardRefs: string[]
  hooks: string[]
  launched: boolean
  briefPath?: string
  launchPrompt?: string
  comments: Array<{ id: string; text: string; ts: number }>
  attachments: Array<{ id: string; name: string; path: string }>
}

export interface MCPKanbanState {
  columns: MCPKanbanColumn[]
  cards: MCPKanbanCard[]
}

export interface ResolvedKanbanTarget {
  workspaceId: string
  boardTileId: string
  path: string
  state: MCPKanbanState
}

async function listWorkspaceIds(): Promise<string[]> {
  try {
    const raw = await fs.readFile(join(CONTEX_HOME, 'config.json'), 'utf8')
    const cfg = JSON.parse(raw) as { workspaces?: Array<{ id: string }> }
    const ids = (cfg.workspaces ?? []).map(ws => ws.id).filter(Boolean)
    if (ids.length > 0) return ids
  } catch { /**/ }

  try {
    const entries = await fs.readdir(join(CONTEX_HOME, 'workspaces'), { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return []
  }
}

export function kanbanStateFile(workspaceId: string, boardTileId: string): string {
  return join(CONTEX_HOME, 'workspaces', workspaceId, '.contex', `kanban-${boardTileId}.json`)
}

export async function resolveKanbanTarget(boardTileId?: string, workspaceId?: string): Promise<ResolvedKanbanTarget> {
  const workspaceIds = workspaceId ? [workspaceId] : await listWorkspaceIds()
  const candidates: Array<{ workspaceId: string; boardTileId: string; path: string }> = []

  for (const wsId of workspaceIds) {
    if (boardTileId) {
      const path = kanbanStateFile(wsId, boardTileId)
      try {
        await fs.access(path)
        candidates.push({ workspaceId: wsId, boardTileId, path })
      } catch { /**/ }
      continue
    }

    try {
      const dir = join(CONTEX_HOME, 'workspaces', wsId, '.contex')
      const entries = await fs.readdir(dir)
      for (const name of entries) {
        const match = /^kanban-(.+)\.json$/.exec(name)
        if (!match) continue
        candidates.push({ workspaceId: wsId, boardTileId: match[1], path: join(dir, name) })
      }
    } catch { /**/ }
  }

  if (candidates.length === 0) {
    throw new Error(boardTileId ? `Kanban board '${boardTileId}' not found` : 'No kanban boards found')
  }
  if (candidates.length > 1) {
    throw new Error(`Multiple kanban boards found; specify board_tile_id (${candidates.map(c => c.boardTileId).join(', ')})`)
  }

  const target = candidates[0]
  const raw = await fs.readFile(target.path, 'utf8')
  const parsed = JSON.parse(raw) as Partial<MCPKanbanState>
  return {
    ...target,
    state: {
      columns: Array.isArray(parsed.columns) ? parsed.columns as MCPKanbanColumn[] : [],
      cards: Array.isArray(parsed.cards) ? parsed.cards as MCPKanbanCard[] : [],
    },
  }
}

export async function saveKanbanTarget(target: ResolvedKanbanTarget, state: MCPKanbanState): Promise<void> {
  await fs.mkdir(join(CONTEX_HOME, 'workspaces', target.workspaceId, '.contex'), { recursive: true })
  await fs.writeFile(target.path, JSON.stringify(state, null, 2))
}

export function summarizeKanbanState(target: ResolvedKanbanTarget): string {
  return JSON.stringify({
    workspaceId: target.workspaceId,
    boardTileId: target.boardTileId,
    columns: target.state.columns,
    cards: target.state.cards.map(card => ({
      id: card.id,
      title: card.title,
      columnId: card.columnId,
      launched: card.launched,
      agent: card.agent,
      model: card.model,
      tools: card.tools,
      fileRefs: card.fileRefs,
      cardRefs: card.cardRefs,
    })),
  }, null, 2)
}

export const KANBAN_TOOLS: McpToolSchema[] = [
  {
    name: 'card_complete',
    description: 'Call this when your task is complete. Moves the card to the next column on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id:  { type: 'string', description: 'Your card ID — available as $CARD_ID' },
        summary:  { type: 'string', description: 'What was done' },
        next_col: { type: 'string', description: 'Override target column id (optional)' }
      },
      required: ['card_id', 'summary']
    }
  },
  {
    name: 'card_update',
    description: 'Stream a progress note to the canvas mid-task.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        note:    { type: 'string', description: 'Progress update visible on the canvas' },
        status:  { type: 'string', enum: ['working', 'blocked', 'waiting'], description: 'Optional status' }
      },
      required: ['card_id', 'note']
    }
  },
  {
    name: 'card_error',
    description: 'Signal that the task failed or needs human review.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        reason:  { type: 'string' }
      },
      required: ['card_id', 'reason']
    }
  },
  {
    name: 'canvas_event',
    description: 'Send a custom event to the canvas host.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        event:   { type: 'string' },
        payload: { type: 'object' }
      },
      required: ['card_id', 'event']
    }
  },
  {
    name: 'request_input',
    description: 'Ask the canvas operator for input or clarification. Blocks until the canvas responds via /inject.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id:  { type: 'string' },
        question: { type: 'string', description: 'What do you need from the human?' },
        options:  { type: 'array', items: { type: 'string' }, description: 'Optional choices to present' }
      },
      required: ['card_id', 'question']
    }
  },
  {
    name: 'kanban_get_board',
    description: 'Return columns and cards for a built-in kanban board. If multiple boards exist, specify board_tile_id.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' }
      }
    }
  },
  {
    name: 'kanban_create_card',
    description: 'Create a kanban card on a built-in kanban board.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        column_id: { type: 'string' },
        agent: { type: 'string' },
        model: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
        file_refs: { type: 'array', items: { type: 'string' } },
        card_refs: { type: 'array', items: { type: 'string' } },
        color: { type: 'string' }
      },
      required: ['title']
    }
  },
  {
    name: 'kanban_update_card',
    description: 'Edit an existing kanban card on a built-in kanban board.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        card_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        instructions: { type: 'string' },
        column_id: { type: 'string' },
        agent: { type: 'string' },
        model: { type: 'string' },
        tools: { type: 'array', items: { type: 'string' } },
        file_refs: { type: 'array', items: { type: 'string' } },
        card_refs: { type: 'array', items: { type: 'string' } },
        color: { type: 'string' },
        launched: { type: 'boolean' }
      },
      required: ['card_id']
    }
  },
  {
    name: 'kanban_move_card',
    description: 'Move a kanban card to another column.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        card_id: { type: 'string' },
        column_id: { type: 'string' }
      },
      required: ['card_id', 'column_id']
    }
  },
  {
    name: 'kanban_pause_card',
    description: 'Pause a running kanban card.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        card_id: { type: 'string' }
      },
      required: ['card_id']
    }
  },
  {
    name: 'kanban_delete_card',
    description: 'Delete a kanban card.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        card_id: { type: 'string' }
      },
      required: ['card_id']
    }
  },
  {
    name: 'kanban_create_column',
    description: 'Create a new kanban column/list.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        title: { type: 'string' },
        column_id: { type: 'string' }
      },
      required: ['title']
    }
  },
  {
    name: 'kanban_rename_column',
    description: 'Rename a kanban column/list.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        column_id: { type: 'string' },
        title: { type: 'string' }
      },
      required: ['column_id', 'title']
    }
  },
  {
    name: 'kanban_delete_column',
    description: 'Delete a kanban column/list and its cards.',
    inputSchema: {
      type: 'object',
      properties: {
        board_tile_id: { type: 'string' },
        workspace_id: { type: 'string' },
        column_id: { type: 'string' }
      },
      required: ['column_id']
    }
  },
]

const KANBAN_TOOL_NAMES = new Set(KANBAN_TOOLS.map(tool => tool.name))

export async function handleKanbanTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<string | null> {
  if (!KANBAN_TOOL_NAMES.has(name)) {
    return null
  }

  const cardId = args.card_id as string
  const { pushSSE, sendToRenderer } = ctx

  // card_complete/card_update/card_error/canvas_event/request_input all take
  // card_id == $CARD_ID, i.e. the caller's own tile. A tile-scoped token must
  // not be able to act on another tile's card.
  if (
    name === 'card_complete' || name === 'card_update' || name === 'card_error' ||
    name === 'canvas_event' || name === 'request_input'
  ) {
    const scopeError = assertTileScope(ctx.principal, cardId)
    if (scopeError) return scopeError
  }

  if (name === 'card_complete') {
    const payload = { cardId, summary: args.summary, nextCol: args.next_col }
    pushSSE(cardId, 'card_complete', payload)
    sendToRenderer('card_complete', payload)
    bus.publish({
      channel: `card:${cardId}`,
      type: 'task',
      source: 'mcp',
      payload: { cardId, summary: args.summary, nextCol: args.next_col, action: 'complete' }
    })
    return `Card ${cardId} marked complete: ${args.summary}`
  }

  if (name === 'card_update') {
    const payload = { cardId, note: args.note, status: args.status }
    pushSSE(cardId, 'card_update', payload)
    sendToRenderer('card_update', payload)
    bus.publish({
      channel: `card:${cardId}`,
      type: 'progress',
      source: 'mcp',
      payload: { cardId, note: args.note, status: args.status }
    })
    return `Card ${cardId} updated`
  }

  if (name === 'card_error') {
    const payload = { cardId, reason: args.reason }
    pushSSE(cardId, 'card_error', payload)
    sendToRenderer('card_error', payload)
    bus.publish({
      channel: `card:${cardId}`,
      type: 'notification',
      source: 'mcp',
      payload: { cardId, reason: args.reason, level: 'error' }
    })
    return `Card ${cardId} flagged: ${args.reason}`
  }

  if (name === 'canvas_event') {
    const payload = { cardId, event: args.event, data: args.payload ?? {} }
    pushSSE(cardId, args.event as string, payload)
    sendToRenderer('canvas_event', payload)
    bus.publish({
      channel: `card:${cardId}`,
      type: 'data',
      source: 'mcp',
      payload: { cardId, event: args.event, data: args.payload ?? {} }
    })
    return `Event '${args.event}' sent to canvas`
  }

  if (name === 'request_input') {
    const payload = { cardId, question: args.question, options: args.options ?? [] }
    pushSSE(cardId, 'input_requested', payload)
    sendToRenderer('input_requested', payload)
    bus.publish({
      channel: `card:${cardId}`,
      type: 'ask',
      source: 'mcp',
      payload: { cardId, question: args.question, options: args.options ?? [] }
    })
    return `Input requested from canvas operator: "${args.question}"`
  }

  if (name.startsWith('kanban_')) {
    const boardTileId = asString(args.board_tile_id)
    const workspaceId = asString(args.workspace_id)
    try {
      const target = await resolveKanbanTarget(boardTileId, workspaceId)
      const state: MCPKanbanState = {
        columns: [...target.state.columns],
        cards: [...target.state.cards],
      }

      if (name === 'kanban_get_board') {
        return summarizeKanbanState(target)
      }

      if (name === 'kanban_create_card') {
        const title = asString(args.title)
        if (!title) return 'Missing title'
        const columnId = asString(args.column_id) ?? state.columns[0]?.id ?? 'backlog'
        const now = Date.now()
        const card: MCPKanbanCard = {
          id: `card-${target.boardTileId}-${now}`,
          title,
          description: asString(args.description) ?? '',
          instructions: asString(args.instructions) ?? '',
          columnId,
          color: asString(args.color) ?? 'rgba(88, 166, 255, 0.16)',
          agent: asString(args.agent) ?? 'claude',
          model: asString(args.model),
          mcpConfig: undefined,
          mcpServers: [],
          tools: Array.isArray(args.tools) ? args.tools.filter((v): v is string => typeof v === 'string') : ['all'],
          skillsAndCommands: [],
          fileRefs: Array.isArray(args.file_refs) ? args.file_refs.filter((v): v is string => typeof v === 'string') : [],
          cardRefs: Array.isArray(args.card_refs) ? args.card_refs.filter((v): v is string => typeof v === 'string') : [],
          hooks: [],
          launched: false,
          comments: [],
          attachments: [],
        }
        state.cards.push(card)
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_card_created', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, card })
        return `Created card ${card.id} (${card.title}) on board ${target.boardTileId}`
      }

      if (name === 'kanban_update_card') {
        const targetCardId = asString(args.card_id)
        if (!targetCardId) return 'Missing card_id'
        const idx = state.cards.findIndex(card => card.id === targetCardId)
        if (idx < 0) return `Card ${targetCardId} not found`
        const current = state.cards[idx]
        const patch: Partial<MCPKanbanCard> = {}
        if (asString(args.title) !== undefined) patch.title = asString(args.title)!
        if (asString(args.description) !== undefined) patch.description = asString(args.description)!
        if (asString(args.instructions) !== undefined) patch.instructions = asString(args.instructions)!
        if (asString(args.column_id) !== undefined) patch.columnId = asString(args.column_id)!
        if (asString(args.agent) !== undefined) patch.agent = asString(args.agent)!
        if (asString(args.model) !== undefined) patch.model = asString(args.model)
        if (asString(args.color) !== undefined) patch.color = asString(args.color)!
        if (Array.isArray(args.tools)) patch.tools = args.tools.filter((v): v is string => typeof v === 'string')
        if (Array.isArray(args.file_refs)) patch.fileRefs = args.file_refs.filter((v): v is string => typeof v === 'string')
        if (Array.isArray(args.card_refs)) patch.cardRefs = args.card_refs.filter((v): v is string => typeof v === 'string')
        if (typeof args.launched === 'boolean') patch.launched = args.launched
        const card = { ...current, ...patch }
        state.cards[idx] = card
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_card_updated', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, cardId: targetCardId, patch })
        return `Updated card ${targetCardId}`
      }

      if (name === 'kanban_move_card') {
        const targetCardId = asString(args.card_id)
        const columnId = asString(args.column_id)
        if (!targetCardId || !columnId) return 'Missing card_id or column_id'
        const idx = state.cards.findIndex(card => card.id === targetCardId)
        if (idx < 0) return `Card ${targetCardId} not found`
        state.cards[idx] = { ...state.cards[idx], columnId }
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_card_moved', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, cardId: targetCardId, columnId })
        return `Moved card ${targetCardId} to ${columnId}`
      }

      if (name === 'kanban_pause_card') {
        const targetCardId = asString(args.card_id)
        if (!targetCardId) return 'Missing card_id'
        const idx = state.cards.findIndex(card => card.id === targetCardId)
        if (idx < 0) return `Card ${targetCardId} not found`
        const current = state.cards[idx]
        state.cards[idx] = { ...current, launched: false, columnId: current.columnId === 'running' ? 'backlog' : current.columnId }
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_card_paused', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, cardId: targetCardId })
        return `Paused card ${targetCardId}`
      }

      if (name === 'kanban_delete_card') {
        const targetCardId = asString(args.card_id)
        if (!targetCardId) return 'Missing card_id'
        state.cards = state.cards.filter(card => card.id !== targetCardId)
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_card_deleted', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, cardId: targetCardId })
        return `Deleted card ${targetCardId}`
      }

      if (name === 'kanban_create_column') {
        const title = asString(args.title)
        if (!title) return 'Missing title'
        const column = { id: asString(args.column_id) ?? `col-${Date.now()}`, title }
        state.columns.push(column)
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_column_created', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, column })
        return `Created column ${column.id} (${column.title})`
      }

      if (name === 'kanban_rename_column') {
        const columnId = asString(args.column_id)
        const title = asString(args.title)
        if (!columnId || !title) return 'Missing column_id or title'
        state.columns = state.columns.map(column => column.id === columnId ? { ...column, title } : column)
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_column_renamed', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, columnId, title })
        return `Renamed column ${columnId} to ${title}`
      }

      if (name === 'kanban_delete_column') {
        const columnId = asString(args.column_id)
        if (!columnId) return 'Missing column_id'
        state.columns = state.columns.filter(column => column.id !== columnId)
        state.cards = state.cards.filter(card => card.columnId !== columnId)
        await saveKanbanTarget(target, state)
        sendToRenderer('kanban_column_deleted', { boardTileId: target.boardTileId, workspaceId: target.workspaceId, columnId })
        return `Deleted column ${columnId}`
      }
    } catch (err) {
      return `Kanban tool error: ${errorMessage(err)}`
    }
  }

  return null
}