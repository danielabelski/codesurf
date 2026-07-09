import { withDefaultSettings, DEFAULT_SETTINGS, type AppSettings } from '../../../shared/types'

export const SETTINGS_CACHE_KEY = 'codesurf:settings-cache'
export const WORKSPACE_TAB_STATE_KEY = 'codesurf:workspace-tabs:v1'

export type PersistedWorkspaceTabState = {
  openWorkspaceIds: string[]
  currentWorkspaceId: string | null
}

export function readCachedSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = window.localStorage.getItem(SETTINGS_CACHE_KEY)
    return raw ? withDefaultSettings(JSON.parse(raw)) : DEFAULT_SETTINGS
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function readPersistedWorkspaceTabState(): PersistedWorkspaceTabState {
  if (typeof window === 'undefined') {
    return { openWorkspaceIds: [], currentWorkspaceId: null }
  }

  try {
    const raw = window.localStorage.getItem(WORKSPACE_TAB_STATE_KEY)
    if (!raw) return { openWorkspaceIds: [], currentWorkspaceId: null }
    const parsed = JSON.parse(raw) as Partial<PersistedWorkspaceTabState>
    const openWorkspaceIds = Array.isArray(parsed.openWorkspaceIds)
      ? parsed.openWorkspaceIds.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : []
    const currentWorkspaceId = typeof parsed.currentWorkspaceId === 'string' && parsed.currentWorkspaceId.trim().length > 0
      ? parsed.currentWorkspaceId
      : null
    return {
      openWorkspaceIds: Array.from(new Set(openWorkspaceIds)),
      currentWorkspaceId,
    }
  } catch {
    return { openWorkspaceIds: [], currentWorkspaceId: null }
  }
}

export function persistWorkspaceTabState(state: PersistedWorkspaceTabState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(WORKSPACE_TAB_STATE_KEY, JSON.stringify({
      openWorkspaceIds: Array.from(new Set(state.openWorkspaceIds.filter(id => typeof id === 'string' && id.trim().length > 0))),
      currentWorkspaceId: typeof state.currentWorkspaceId === 'string' && state.currentWorkspaceId.trim().length > 0
        ? state.currentWorkspaceId
        : null,
    }))
  } catch {
    // ignore localStorage failures
  }
}