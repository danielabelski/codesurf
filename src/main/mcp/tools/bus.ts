import { bus } from '../../event-bus'
import type { McpToolContext, McpToolSchema } from '../types'

export const BUS_TOOLS: McpToolSchema[] = [
  {
    name: 'update_progress',
    description: 'Report progress on a task. Any block subscribed to this channel will see the update.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to publish to (e.g. tile:abc123, task:xyz)' },
        status: { type: 'string', description: 'Current status text' },
        percent: { type: 'number', description: 'Progress 0-100 (optional)' },
        detail: { type: 'string', description: 'Additional detail (optional)' }
      },
      required: ['channel', 'status']
    }
  },
  {
    name: 'log_activity',
    description: 'Log an activity event. Appears in any subscribed activity feed or block indicator.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to publish to' },
        message: { type: 'string', description: 'Activity message' },
        level: { type: 'string', enum: ['info', 'warn', 'error', 'success'], description: 'Severity level' }
      },
      required: ['channel', 'message']
    }
  },
  {
    name: 'create_task',
    description: 'Create a new task visible to any subscribed task list or kanban.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to publish to' },
        title: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] }
      },
      required: ['channel', 'title']
    }
  },
  {
    name: 'update_task',
    description: 'Update a task status.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'] },
        title: { type: 'string', description: 'Updated title (optional)' },
        detail: { type: 'string', description: 'Status detail (optional)' }
      },
      required: ['channel', 'task_id', 'status']
    }
  },
  {
    name: 'notify',
    description: 'Send a notification to the canvas operator.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        title: { type: 'string' },
        message: { type: 'string' },
        level: { type: 'string', enum: ['info', 'warn', 'error', 'success'] }
      },
      required: ['channel', 'message']
    }
  },
]

const BUS_TOOL_NAMES = new Set(BUS_TOOLS.map(tool => tool.name))

// Tools here address a pub/sub `channel` string, not a tile_id/card_id — the
// event bus is a universal cross-tile broadcast mechanism by design (see
// CLAUDE.md), so there is no tile identity to scope against.
export async function handleBusTool(
  name: string,
  args: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<string | null> {
  if (!BUS_TOOL_NAMES.has(name)) return null

  const { sendToRenderer } = ctx

  if (name === 'update_progress') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'progress',
      source: 'mcp',
      payload: { status: args.status, percent: args.percent, detail: args.detail }
    })
    sendToRenderer('bus:event', evt)
    return `Progress updated on ${args.channel}: ${args.status}`
  }

  if (name === 'log_activity') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'activity',
      source: 'mcp',
      payload: { message: args.message, level: args.level ?? 'info' }
    })
    sendToRenderer('bus:event', evt)
    return `Activity logged on ${args.channel}: ${args.message}`
  }

  if (name === 'create_task') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'task',
      source: 'mcp',
      payload: { title: args.title, description: args.description, status: args.status ?? 'pending', action: 'create' }
    })
    sendToRenderer('bus:event', evt)
    return `Task created on ${args.channel}: ${args.title}`
  }

  if (name === 'update_task') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'task',
      source: 'mcp',
      payload: { task_id: args.task_id, status: args.status, title: args.title, detail: args.detail, action: 'update' }
    })
    sendToRenderer('bus:event', evt)
    return `Task ${args.task_id} updated on ${args.channel}: ${args.status}`
  }

  if (name === 'notify') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'notification',
      source: 'mcp',
      payload: { title: args.title, message: args.message, level: args.level ?? 'info' }
    })
    sendToRenderer('bus:event', evt)
    return `Notification sent on ${args.channel}: ${args.message}`
  }

  return null
}