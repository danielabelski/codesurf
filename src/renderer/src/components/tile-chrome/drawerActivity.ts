/**
 * Tile chrome drawer activity persistence + bus event processing.
 */
import type { SkillConfig } from '../../../../shared/types'
import type { AvailableToolItem, DrawerData } from './types'
import type React from 'react'

// ─── Activity store persistence ─────────────────────────────────────────────

export function persistToActivityStore(
  workspaceId: string | undefined,
  tileId: string,
  evt: { type: string; payload: Record<string, unknown>; id: string },
): void {
  if (!workspaceId || !window.electron?.activity) return
  const p = evt.payload as any

  if (evt.type === 'task') {
    window.electron.activity.upsert(workspaceId, {
      id: p.task_id ?? p.id ?? evt.id,
      tileId,
      type: 'task',
      status: p.status === 'done' ? 'done' : p.status === 'error' ? 'error' : p.status === 'in-progress' ? 'running' : 'pending',
      title: p.title ?? 'Untitled task',
      detail: p.detail,
      metadata: p,
    })
  }

  if (evt.type === 'tool_start' || evt.type === 'tool') {
    window.electron.activity.upsert(workspaceId, {
      id: p.tool_id ?? p.id ?? evt.id,
      tileId,
      type: 'tool',
      status: evt.type === 'tool_start' ? 'running' : (p.error ? 'error' : 'done'),
      title: p.name ?? p.tool ?? 'Unknown tool',
      detail: p.input?.toString()?.slice(0, 200),
      metadata: p,
    })
  }

  if (evt.type === 'file' || evt.type === 'file_activity') {
    window.electron.activity.upsert(workspaceId, {
      id: p.file_id ?? evt.id,
      tileId,
      type: 'skill',
      status: 'done',
      title: p.path ?? p.file ?? 'unknown',
      detail: p.action,
      metadata: p,
    })
  }

  if (evt.type === 'note' || evt.type === 'notification' || evt.type === 'progress') {
    window.electron.activity.upsert(workspaceId, {
      id: evt.id,
      tileId,
      type: 'context',
      status: 'done',
      title: p.message ?? p.text ?? p.title ?? p.status ?? JSON.stringify(p).slice(0, 200),
      detail: p.source ?? evt.type,
      metadata: p,
    })
  }
}

// ─── Event processing helpers ────────────────────────────────────────────────

export function processEvent(evt: { type: string; payload: Record<string, unknown>; id: string; timestamp: number }, setData: React.Dispatch<React.SetStateAction<DrawerData>>): void {
  const p = evt.payload as any

  if (evt.type === 'task') {
    if (p?.action === 'create' || (!p?.action && p?.title)) {
      setData(prev => {
        if (prev.tasks.some(t => t.id === (p.task_id ?? p.id))) return prev
        return { ...prev, tasks: [...prev.tasks, {
          id: p.task_id ?? p.id ?? evt.id,
          title: p.title ?? 'Untitled task',
          status: p.status ?? 'pending',
          detail: p.detail,
          timestamp: evt.timestamp,
        }]}
      })
    } else if (p?.action === 'update' && p?.task_id) {
      setData(prev => ({ ...prev, tasks: prev.tasks.map(t =>
        t.id === p.task_id
          ? { ...t, status: p.status ?? t.status, title: p.title ?? t.title, detail: p.detail ?? t.detail }
          : t
      )}))
    }
  }

  if (evt.type === 'tool_start' || evt.type === 'tool') {
    setData(prev => {
      const toolId = p?.tool_id ?? p?.id ?? evt.id
      if (evt.type === 'tool_start') {
        if (prev.tools.some(t => t.id === toolId)) return prev
        return { ...prev, tools: [...prev.tools, {
          id: toolId,
          name: p?.name ?? p?.tool ?? 'Unknown tool',
          status: 'running',
          input: typeof p?.input === 'string' ? p.input.slice(0, 120) : undefined,
          timestamp: evt.timestamp,
        }]}
      }
      // tool complete/update
      return { ...prev, tools: prev.tools.map(t =>
        t.id === toolId
          ? { ...t, status: p?.error ? 'error' : 'done', output: p?.output?.toString()?.slice(0, 120), elapsed: p?.elapsed }
          : t
      )}
    })
  }

  if (evt.type === 'tool_inventory') {
    const incoming = Array.isArray(p?.tools) ? p.tools : []
    const nextTools: AvailableToolItem[] = incoming
      .filter((tool): tool is Record<string, unknown> => typeof tool === 'object' && tool !== null)
      .map((tool, index) => {
        const source = tool.source === 'peer' || tool.source === 'mcp-server' ? tool.source : 'builtin'
        const label = typeof tool.label === 'string' ? tool.label : typeof tool.name === 'string' ? tool.name : `Tool ${index + 1}`
        return {
          id: typeof tool.id === 'string' ? tool.id : `${source}:${label}`,
          label,
          source,
          detail: typeof tool.detail === 'string' ? tool.detail : undefined,
        }
      })

    setData(prev => ({ ...prev, availableTools: nextTools }))
  }

  if (evt.type === 'skill_inventory') {
    const incoming = Array.isArray(p?.skills) ? p.skills : []
    const nextSkills: SkillConfig[] = incoming
      .filter((skill): skill is Record<string, unknown> => typeof skill === 'object' && skill !== null)
      .map((skill, index) => {
        const source = skill.source === 'mcp' || skill.source === 'workspace' || skill.source === 'command'
          ? skill.source
          : 'builtin'
        const name = typeof skill.name === 'string' ? skill.name : `Skill ${index + 1}`
        return {
          id: typeof skill.id === 'string' ? skill.id : `${source}:${name}`,
          name,
          enabled: skill.enabled !== false,
          source,
          server: typeof skill.server === 'string' ? skill.server : undefined,
          description: typeof skill.description === 'string' ? skill.description : undefined,
        }
      })

    setData(prev => ({ ...prev, skills: nextSkills }))
  }

  // Skills and context are managed interactively via the drawer, not from bus events.
  // Bus events for files/notes are persisted to the activity store but don't populate the drawer.
}
