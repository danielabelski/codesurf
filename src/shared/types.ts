export interface Workspace {
  id: string
  name: string
  path: string
}

export type TileType = 'terminal' | 'note' | 'code' | 'image' | 'kanban' | 'browser' | 'chat'

export interface FontConfig {
  family: string
  size: number
  lineHeight: number
}

export interface AppSettings {
  // General — App fonts
  primaryFont: FontConfig
  secondaryFont: FontConfig
  monoFont: FontConfig
  // Canvas
  canvasBackground: string
  gridColorSmall: string
  gridColorLarge: string
  gridSpacingSmall: number
  gridSpacingLarge: number
  snapToGrid: boolean
  gridSize: number
  // Terminal
  terminalFontSize: number
  terminalFontFamily: string
  // Appearance
  uiFontSize: number
  // Sidebar
  sidebarDefaultSort: 'name' | 'type' | 'ext'
  sidebarIgnored: string[]
  // Behaviour
  autoSaveIntervalMs: number
  defaultTileSizes: Record<TileType, { w: number; h: number }>
}

export const DEFAULT_SETTINGS: AppSettings = {
  primaryFont: { family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif', size: 14, lineHeight: 1.5 },
  secondaryFont: { family: '"SF Pro Display", "Segoe UI", "Helvetica Neue", sans-serif', size: 12, lineHeight: 1.4 },
  monoFont: { family: '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", "Fira Code", monospace', size: 13, lineHeight: 1.5 },
  canvasBackground: '#1e1e1e',
  gridColorSmall: '#333333',
  gridColorLarge: '#4a4a4a',
  gridSpacingSmall: 20,
  gridSpacingLarge: 100,
  snapToGrid: true,
  gridSize: 20,
  terminalFontSize: 13,
  terminalFontFamily: '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", monospace',
  uiFontSize: 12,
  sidebarDefaultSort: 'name',
  sidebarIgnored: ['.git', 'node_modules', '.next', 'dist', 'dist-electron', '.DS_Store', '__pycache__', '.cache', 'out'],
  autoSaveIntervalMs: 500,
  defaultTileSizes: {
    terminal: { w: 600, h: 400 },
    code:     { w: 680, h: 500 },
    note:     { w: 500, h: 400 },
    image:    { w: 440, h: 360 },
    kanban:   { w: 900, h: 560 },
    browser:  { w: 1000, h: 700 },
    chat:     { w: 420, h: 600 },
  }
}

export function withDefaultSettings(input: Partial<AppSettings> | null | undefined): AppSettings {
  const settings = input ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    primaryFont: { ...DEFAULT_SETTINGS.primaryFont, ...(settings.primaryFont ?? {}) },
    secondaryFont: { ...DEFAULT_SETTINGS.secondaryFont, ...(settings.secondaryFont ?? {}) },
    monoFont: { ...DEFAULT_SETTINGS.monoFont, ...(settings.monoFont ?? {}) },
    sidebarIgnored: settings.sidebarIgnored ?? DEFAULT_SETTINGS.sidebarIgnored,
    defaultTileSizes: {
      ...DEFAULT_SETTINGS.defaultTileSizes,
      ...(settings.defaultTileSizes ?? {})
    }
  } as AppSettings
}

export interface Config {
  workspaces: Workspace[]
  activeWorkspaceIndex: number
  settings: AppSettings
}

export interface TileState {
  id: string
  type: TileType
  x: number
  y: number
  width: number
  height: number
  zIndex: number
  filePath?: string
  groupId?: string
}

export interface GroupState {
  id: string
  label?: string
  color?: string
  parentGroupId?: string
}

export interface CanvasState {
  tiles: TileState[]
  groups: GroupState[]
  viewport: { tx: number; ty: number; zoom: number }
  nextZIndex: number
}

// ─── Event Bus Types ────────────────────────────────────────────────────────

/** Event severity / category */
export type BusEventType =
  | 'progress'    // task progress update (percent, status text)
  | 'activity'    // log entry (terminal output, agent action)
  | 'task'        // task lifecycle (created, started, completed, failed)
  | 'notification'// alert / toast from any source
  | 'ask'         // agent asking for human input
  | 'answer'      // human responding to an ask
  | 'data'        // arbitrary structured data payload
  | 'system'      // internal bus events (subscribe, unsubscribe, error)

/** A single event on the bus */
export interface BusEvent {
  id: string
  channel: string          // e.g. "tile:abc123", "workspace:global", "agent:xyz"
  type: BusEventType
  source: string           // who published — tile ID, MCP tool name, "browser:postMessage", etc.
  timestamp: number
  payload: Record<string, unknown>
}

/** Subscription handle */
export interface BusSubscription {
  id: string
  channel: string          // supports wildcards: "tile:*", "*"
  subscriberId: string     // who subscribed — usually a tile ID
}

/** Channel metadata (optional, for UI display) */
export interface ChannelInfo {
  name: string             // human-readable label
  channel: string          // bus channel pattern
  unread: number           // unread event count for badge
  lastEvent?: BusEvent     // most recent event
}
