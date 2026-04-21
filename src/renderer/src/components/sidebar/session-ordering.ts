import type { ProjectListEntry, SessionEntry } from './types'

export interface ActiveSessionMatchState {
  activeChatTileId?: string | null
  activeChatSessionId?: string | null
  activeChatSessionEntryId?: string | null
}

function normalizeSidebarPath(path: string | null | undefined): string {
  return String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

export function isSessionActive(session: SessionEntry, activeState: ActiveSessionMatchState): boolean {
  const { activeChatTileId = null, activeChatSessionId = null, activeChatSessionEntryId = null } = activeState
  const hasSpecificActiveSession = Boolean(activeChatSessionEntryId || activeChatSessionId)
  return hasSpecificActiveSession
    ? (
        session.id === activeChatSessionEntryId
        || (Boolean(activeChatSessionId) && session.sessionId === activeChatSessionId)
      )
    : (
        Boolean(activeChatTileId) && session.tileId === activeChatTileId
      )
}

export function applySessionPromotions<T extends SessionEntry>(sessions: T[], promotedAtById: Record<string, number>): T[] {
  let changed = false
  const next = sessions.map(session => {
    const promotedAt = promotedAtById[session.id]
    if (!Number.isFinite(promotedAt) || promotedAt <= session.updatedAt) return session
    changed = true
    return {
      ...session,
      updatedAt: promotedAt,
    }
  })
  return changed ? next : sessions
}

export function compareSessionsWithSelectionPriority(
  a: SessionEntry,
  b: SessionEntry,
  sortMode: 'updated' | 'title',
  promotedAtById: Record<string, number>,
): number {
  const promotedA = Number.isFinite(promotedAtById[a.id]) ? promotedAtById[a.id]! : 0
  const promotedB = Number.isFinite(promotedAtById[b.id]) ? promotedAtById[b.id]! : 0
  if (promotedA !== promotedB) return promotedB - promotedA

  if (sortMode === 'title') {
    const titleCompare = a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    if (titleCompare !== 0) return titleCompare
    return b.updatedAt - a.updatedAt
  }

  return b.updatedAt - a.updatedAt
}

export function sortProjectEntriesByRecentSession(
  projectEntries: ProjectListEntry[],
  sessions: SessionEntry[],
  getProjectLabel: (project: ProjectListEntry) => string,
): ProjectListEntry[] {
  if (projectEntries.length <= 1) return projectEntries

  const latestByProjectId = new Map<string, number>()
  for (const projectEntry of projectEntries) {
    const projectPath = normalizeSidebarPath(projectEntry.path)
    const workspaceIdSet = new Set(projectEntry.workspaceIds)
    let latest = 0
    for (const session of sessions) {
      const sessionProjectPath = normalizeSidebarPath(session.projectPath ?? session.workspacePath)
      const belongs = sessionProjectPath
        ? sessionProjectPath === projectPath
        : workspaceIdSet.has(session.workspaceId)
      if (!belongs) continue
      latest = Math.max(latest, session.updatedAt)
    }
    latestByProjectId.set(projectEntry.id, latest)
  }

  return [...projectEntries].sort((a, b) => {
    const latestA = latestByProjectId.get(a.id) ?? 0
    const latestB = latestByProjectId.get(b.id) ?? 0
    if (latestA !== latestB) return latestB - latestA
    return getProjectLabel(a).localeCompare(getProjectLabel(b), undefined, { sensitivity: 'base' })
  })
}
