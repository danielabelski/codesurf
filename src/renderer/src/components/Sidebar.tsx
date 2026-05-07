import React, { useEffect, useRef, useState, useMemo, useCallback, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Archive, ArchiveRestore, Clock3, Maximize2, Minimize2, Pencil, Pin, Search } from 'lucide-react'
import { getChatStreamingSnapshot, subscribeChatStreaming } from './chatStreamingStore'
import { getChatMessageSentSnapshot, subscribeChatMessageSent } from './chatMessageSentStore'
import type { ProjectRecord, Workspace, TileState } from '../../../shared/types'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { SidebarFooter } from './sidebar/SidebarFooter'
import { sidebarPathBelongsToProject } from './sidebar/path-utils'
import {
  SESSION_ACTION_BUTTON_SIZE,
  SESSION_ACTION_ICON_SIZE,
  formatSessionSidebarRelativeTime,
  getSessionRowExtraWidth,
  getSessionArchiveActionLabel,
} from './sidebar/session-actions'
import {
  getSessionTitleGenerationIndicator,
  getSessionTitleGenerationKey,
  type SessionTitleGenerationState,
  updateSessionTitleGenerationState,
} from './sidebar/session-title-generation'
import { getSessionOpenIntent } from './sidebar/session-open'
import { SIDEBAR_MENU_WIDTH, SidebarMenuPortal, ThreadMenuItem, ThreadMenuSectionLabel } from './sidebar/ui'
import { buildNestedSessionList, deriveProjectsFromWorkspaces, formatSessionTitleForSidebar, getProjectDisplayLabel, getSessionAgentIcon, getSessionAgentKey, getSessionAgentLabel, getWorkspaceProjectPaths, isCronSession, isSubagentSession, normalizeSidebarPath, RESOURCE_ITEMS, SpinnerIcon } from './sidebar/utils'
import { isInternalMaintenanceSession } from './sidebar/session-filters'
import { applySessionPromotions, isSessionActive } from './sidebar/session-ordering'
import { type DisplaySessionEntry, type ProjectListEntry, SESSION_PAGE_SIZE, type SessionEntry, type SessionProjectGroup, type ThreadOrganizeMode, type ThreadSortMode } from './sidebar/types'

interface ExtTileEntry { extId: string; type: string; label: string; icon?: string }
interface ExtensionEntrySummary { id: string; name: string; icon?: string | null; enabled: boolean }
interface SidebarTextDialogState {
  title: string
  description?: string
  confirmLabel: string
  initialValue: string
  placeholder?: string
  submit: (value: string) => Promise<void> | void
}
const GENERIC_SESSION_SOURCE_DETAILS = new Set(['transcript', 'conversation', 'project session', 'user session'])
const SESSION_READ_WATERMARKS_STORAGE_KEY = 'codesurf.sidebar.sessionReadWatermarks.v1'
const PINNED_SESSION_KEYS_STORAGE_KEY = 'codesurf.sidebar.pinnedSessionKeys.v1'
const PROJECT_SESSION_PREVIEW_COUNT = 5
const PROJECT_SESSION_SHOW_MORE_COUNT = 10
const SIDEBAR_RIGHT_RAIL_WIDTH = 44
// Nudge action buttons onto the same optical center as the timestamp rail so
// hovering a row swaps time for archive without a lateral jump.
const SIDEBAR_RIGHT_RAIL_ACTION_RIGHT = 2
type SessionReadWatermarks = Record<string, number>
type PinnedSessionKeys = Record<string, true>

function getSessionSidebarIndicatorColor(session: SessionEntry, theme: ReturnType<typeof useTheme>): string {
  const key = getSessionAgentKey(session)
  if (key === 'codex') return '#6ea8ff'
  if (key === 'claude') return '#d9a066'
  if (key === 'cursor') return '#b792ff'
  if (key === 'openclaw') return '#62cfa6'
  if (key === 'opencode') return '#64d2ff'
  if (key === 'codesurf') return '#95a1b3'
  return theme.accent.base
}

function getSessionActivityKey(session: SessionEntry): string {
  const agentKey = getSessionAgentKey(session)
  const sessionId = session.sessionId?.trim()
  if (sessionId) return `${agentKey}:session:${sessionId}`
  const filePath = session.filePath?.trim()
  if (filePath) return `${agentKey}:file:${filePath}`
  return `${agentKey}:entry:${session.workspaceId}:${session.id}`
}

function getSessionSelectionKey(session: SessionEntry): string {
  return `${session.workspaceId}:${session.id}`
}

function loadSessionReadWatermarks(): SessionReadWatermarks {
  try {
    const raw = window.localStorage.getItem(SESSION_READ_WATERMARKS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const next: SessionReadWatermarks = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key !== 'string' || typeof value !== 'number') continue
      if (!Number.isFinite(value) || value <= 0) continue
      next[key] = value
    }
    return next
  } catch {
    return {}
  }
}

function saveSessionReadWatermarks(watermarks: SessionReadWatermarks): void {
  try {
    window.localStorage.setItem(SESSION_READ_WATERMARKS_STORAGE_KEY, JSON.stringify(watermarks))
  } catch {
    // Ignore storage failures; unread dots are a non-critical UI affordance.
  }
}

function loadPinnedSessionKeys(): PinnedSessionKeys {
  try {
    const raw = window.localStorage.getItem(PINNED_SESSION_KEYS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const next: PinnedSessionKeys = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === 'string' && value === true) next[key] = true
    }
    return next
  } catch {
    return {}
  }
}

function savePinnedSessionKeys(keys: PinnedSessionKeys): void {
  try {
    window.localStorage.setItem(PINNED_SESSION_KEYS_STORAGE_KEY, JSON.stringify(keys))
  } catch {
    // Pinning is a local affordance; ignore storage failures.
  }
}

function hasUnreadSessionUpdate(session: SessionEntry, watermarks: SessionReadWatermarks): boolean {
  const seenAt = watermarks[getSessionActivityKey(session)] ?? session.updatedAt
  return session.updatedAt > seenAt
}

function SessionSidebarIndicator({
  session,
  streaming,
  muted = false,
  theme,
}: {
  session: SessionEntry
  streaming: boolean
  muted?: boolean
  theme: ReturnType<typeof useTheme>
}): React.JSX.Element {
  if (streaming) {
    return <SpinnerIcon size={14} color={muted ? theme.text.disabled : theme.text.muted} />
  }

  const dotColor = getSessionSidebarIndicatorColor(session, theme)
  return (
    <span
      aria-hidden="true"
      style={{
        width: 14,
        height: 14,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: muted ? 0.52 : 1,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: dotColor,
          boxShadow: `0 0 0 1px color-mix(in srgb, ${dotColor} 42%, transparent)`,
        }}
      />
    </span>
  )
}

function formatSessionSidebarSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 0 : 1)}KB`
  if (bytes < 10 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  if (bytes < 100 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${Math.round(bytes / (1024 * 1024))}MB`
}

function formatSessionSidebarMeta(session: SessionEntry): string {
  const parts: string[] = []
  const detail = String(session.sourceDetail ?? '').trim()
  const normalizedDetail = detail.toLowerCase()
  const sizeLabel = formatSessionSidebarSize(session.sizeBytes)

  parts.push(getSessionAgentLabel(session))
  if (detail && !GENERIC_SESSION_SOURCE_DETAILS.has(normalizedDetail)) {
    parts.push(detail)
  }
  if (sizeLabel) parts.push(sizeLabel)

  return parts.join(' • ')
}

function SessionSidebarRow({
  label,
  meta,
  icon,
  active,
  muted,
  emphasize,
  onClick,
  onContextMenu,
  indent = 0,
  indentUnit = 10,
  extra,
  extraWidth,
  leading,
  leadingVisible,
  trailing,
  title,
  onDoubleClick,
}: {
  label: string
  meta?: string
  icon?: React.ReactNode
  active?: boolean
  muted?: boolean
  emphasize?: boolean
  onClick: () => void
  onContextMenu?: (e: React.MouseEvent) => void
  indent?: number
  indentUnit?: number
  extra?: React.ReactNode
  extraWidth?: number
  leading?: React.ReactNode
  leadingVisible?: boolean
  trailing?: React.ReactNode
  title?: string
  onDoubleClick?: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)
  const labelWeight = active
    ? Math.min(900, fonts.weight + 100)
    : emphasize === true
      ? Math.min(900, fonts.weight + 100)
      : fonts.weight
  const labelColor = active
    ? theme.text.primary
    : muted
      ? theme.text.disabled
      : emphasize === true
        ? theme.text.primary
        : emphasize === false
          ? theme.text.muted
          : theme.text.primary
  const metaColor = muted
    ? theme.text.disabled
    : active
      ? theme.text.secondary
      : theme.text.disabled
  const leadingIconLeft = Math.max(0, 8 + indent * indentUnit - 14)
  const activeBackground = theme.mode === 'light' ? 'rgba(255,255,255,0.56)' : 'rgba(255,255,255,0.075)'
  const hoverBackground = theme.mode === 'light' ? 'rgba(255,255,255,0.34)' : theme.surface.hover
  const activeShadow = theme.mode === 'light'
    ? 'inset 0 0 0 1px rgba(255,255,255,0.90), 0 0 0 1px rgba(15,23,42,0.06)'
    : 'var(--cs-edge-shadow)'

  return (
    <div
      className={`cs-thread-row${active ? ' cs-thread-row-active' : ''}`}
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: `${leading ? 22 : 0}px minmax(0, 1fr) ${SIDEBAR_RIGHT_RAIL_WIDTH}px`,
        alignItems: 'center',
        columnGap: leading ? 6 : 0,
        paddingTop: meta ? 6 : 4,
        paddingBottom: meta ? 6 : 4,
        paddingLeft: `calc(var(--cs-sidebar-row-pad-x) + ${indent * indentUnit}px)`,
        paddingRight: 5,
        minHeight: meta ? 40 : 28,
        cursor: 'pointer',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        borderRadius: 'var(--cs-sidebar-row-radius)',
        margin: '0',
        background: 'transparent',
        boxShadow: 'none',
        transition: 'background 0.1s ease, box-shadow 0.1s ease',
        position: 'relative',
        ...({ '--cs-thread-row-accent': active ? theme.accent.base : theme.text.muted } as React.CSSProperties),
      }}
    >
      {(active || hovered) && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 1,
            bottom: 1,
            borderRadius: 'inherit',
            background: active ? activeBackground : hoverBackground,
            boxShadow: active ? activeShadow : 'var(--cs-edge-shadow-subtle)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      )}
      <span
        style={{
          width: 22,
          display: leading ? 'flex' : 'none',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: leadingVisible || hovered || active ? 1 : 0,
          transition: 'opacity 0.1s ease',
          position: 'relative',
          zIndex: 1,
        }}
      >
        {leading}
      </span>
      {icon && (
        <span
          style={{
            position: 'absolute',
            left: leadingIconLeft,
            top: '50%',
            transform: 'translateY(-50%)',
            color: active ? theme.accent.base : muted ? theme.text.disabled : theme.text.muted,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          {icon}
        </span>
      )}
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: meta ? 2 : 0, position: 'relative', zIndex: 1 }}>
        <span style={{
          fontSize: fonts.size,
          fontWeight: labelWeight,
          lineHeight: fonts.lineHeight,
          color: labelColor,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {label}
        </span>
        {meta && (
          <span style={{
            fontSize: Math.max(10, fonts.secondarySize - 1),
            fontWeight: 500,
            lineHeight: 1.25,
            color: metaColor,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {meta}
          </span>
        )}
      </div>
      {trailing && (
        <span style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          width: SIDEBAR_RIGHT_RAIL_WIDTH,
          minWidth: SIDEBAR_RIGHT_RAIL_WIDTH,
          paddingRight: 8,
          boxSizing: 'border-box',
          color: active ? theme.text.secondary : muted ? theme.text.disabled : theme.text.disabled,
          opacity: extra && hovered ? 0 : 1,
          transition: 'opacity 0.1s ease',
          position: 'relative',
          zIndex: 1,
        }}>
          {trailing}
        </span>
      )}
      {extra && (
        <span style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          width: extraWidth,
          minWidth: 20,
          minHeight: 20,
          position: 'absolute',
          right: SIDEBAR_RIGHT_RAIL_ACTION_RIGHT,
          top: '50%',
          transform: 'translateY(-50%)',
          opacity: hovered ? 1 : 0,
          visibility: hovered ? 'visible' : 'hidden',
          pointerEvents: hovered ? 'auto' : 'none',
          zIndex: 1,
          transition: 'opacity 0.1s ease',
        }}>
          {extra}
        </span>
      )}
    </div>
  )
}

function SidebarTextDialog({
  state,
  onClose,
}: {
  state: SidebarTextDialogState
  onClose: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(state.initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setValue(state.initialValue)
    setBusy(false)
    setError(null)
  }, [state])

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [state])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [busy, onClose])

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await state.submit(value)
      onClose()
    } catch (submitError) {
      setBusy(false)
      setError(submitError instanceof Error ? submitError.message : String(submitError))
    }
  }, [busy, onClose, state, value])

  return createPortal(
    <div
      onMouseDown={event => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        background: 'rgba(0, 0, 0, 0.48)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          width: '100%',
          maxWidth: 420,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: 18,
          borderRadius: 12,
          border: `1px solid ${theme.border.default}`,
          background: theme.surface.panelElevated,
          boxShadow: theme.shadow.panel,
          color: theme.text.primary,
          fontFamily: fonts.primary,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ fontSize: fonts.size + 2, fontWeight: Math.min(900, fonts.weight + 100), color: theme.text.primary }}>
            {state.title}
          </div>
          {state.description && (
            <div style={{ fontSize: fonts.secondarySize, lineHeight: 1.45, color: theme.text.muted }}>
              {state.description}
            </div>
          )}
        </div>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={event => setValue(event.target.value)}
          placeholder={state.placeholder}
          spellCheck={false}
          disabled={busy}
          style={{
            width: '100%',
            padding: '10px 12px',
            borderRadius: 8,
            border: `1px solid ${error ? theme.status.danger : theme.border.default}`,
            background: theme.surface.hover,
            color: theme.text.primary,
            outline: 'none',
            fontFamily: fonts.primary,
            fontSize: fonts.size,
            boxSizing: 'border-box',
          }}
        />

        {error && (
          <div style={{ fontSize: fonts.secondarySize, color: theme.status.danger }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: `1px solid ${theme.border.default}`,
              background: 'transparent',
              color: theme.text.secondary,
              cursor: busy ? 'default' : 'pointer',
              fontFamily: fonts.primary,
              fontSize: fonts.size,
            }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy}
            style={{
              padding: '8px 12px',
              borderRadius: 8,
              border: 'none',
              background: theme.accent.base,
              color: theme.mode === 'light' ? '#fff' : '#0b1118',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy ? 0.7 : 1,
              fontFamily: fonts.primary,
              fontSize: fonts.size,
              fontWeight: Math.min(900, fonts.weight + 100),
            }}
          >
            {busy ? 'Working…' : state.confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}

interface Props {
  workspace: Workspace | null
  workspaces: Workspace[]
  tiles: TileState[]
  onSwitchWorkspace: (id: string) => void
  onDeleteWorkspace: (id: string) => void
  onNewWorkspace: (name: string) => void
  onOpenFolder: () => void
  onOpenFile: (filePath: string, options?: { persist?: boolean }) => void
  onFocusTile: (tileId: string) => void
  onUpdateTile: (tileId: string, patch: Partial<TileState>) => void
  onCloseTile: (tileId: string) => void
  onNewTerminal: () => void
  onNewKanban: () => void
  onNewBrowser: () => void
  onNewChat: () => void
  /**
   * Start a new chat scoped to a specific project row. Host decides whether
   * to open it fullscreen or drop it onto the canvas based on the current
   * view mode. When omitted, the per-row "+" buttons are hidden.
   */
  onNewChatForProject?: (args: { projectId: string; projectPath: string; workspaceId: string | null }) => void
  onNewFiles: () => void
  onOpenSettings: (tab: string) => void
  onOpenSessionInChat: (session: SessionEntry, options?: { persist?: boolean }) => void
  onOpenSessionInApp: (session: SessionEntry) => void
  extensionTiles?: ExtTileEntry[]
  extensionEntries?: ExtensionEntrySummary[]
  onAddExtensionTile?: (type: string) => void
  pinnedExtensionIds?: string[]
  onTogglePinnedExtension?: (extId: string) => void
  collapsed: boolean
  width: number
  onWidthChange: (width: number) => void
  minWidth?: number
  maxWidth?: number
  onResizeStateChange?: (resizing: boolean) => void
  onToggleCollapse: () => void
  showFooter?: boolean
  /**
   * Tile id of the currently focused chat, or null when the focus isn't on a
   * chat. Used to emphasize the matching session row in the thread list so
   * the user can see "you are here" without clicking around.
   */
  activeChatTileId?: string | null
  activeChatSessionId?: string | null
  activeChatSessionEntryId?: string | null
}

const SESSION_FOCUS_REFRESH_STALE_MS = 15_000

function SidebarSearchPalette({
  query,
  sessions,
  onQueryChange,
  onOpenSession,
  onClose,
}: {
  query: string
  sessions: SessionEntry[]
  onQueryChange: (value: string) => void
  onOpenSession: (session: SessionEntry) => void
  onClose: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => inputRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return createPortal(
    <div
      role="dialog"
      aria-label="Search chats"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        background: 'rgba(0, 0, 0, 0.28)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '7vh',
      }}
    >
      <div
        style={{
          width: 'min(680px, calc(100vw - 72px))',
          maxHeight: 'min(560px, calc(100vh - 96px))',
          borderRadius: 22,
          background: theme.surface.panelElevated,
          border: `1px solid ${theme.border.default}`,
          boxShadow: theme.shadow.panel,
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="Search chats"
          style={{
            width: '100%',
            border: 'none',
            outline: 'none',
            background: 'transparent',
            color: theme.text.primary,
            fontSize: Math.max(15, fonts.size + 2),
            fontFamily: fonts.primary,
            fontWeight: 600,
            padding: '12px 16px 10px',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ padding: '8px 14px 6px', color: theme.text.disabled, fontSize: Math.max(11, fonts.secondarySize), fontWeight: 700 }}>
          Recent chats
        </div>
        <div className="cs-fade-scroll-y cs-fade-scroll-y-sm" style={{ overflowY: 'auto', paddingBottom: 6 }}>
          {sessions.map((session, index) => (
            <button
              key={`${session.workspaceId}:${session.id}`}
              type="button"
              onClick={() => {
                onOpenSession(session)
                onClose()
              }}
              style={{
                width: '100%',
                border: 'none',
                borderRadius: 14,
                background: index === 0 ? theme.surface.hover : 'transparent',
                color: index === 0 ? theme.text.primary : theme.text.secondary,
                cursor: 'pointer',
                display: 'grid',
                gridTemplateColumns: '20px minmax(0, 1fr) auto auto',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px',
                fontFamily: fonts.primary,
                textAlign: 'left',
              }}
              onMouseEnter={event => {
                event.currentTarget.style.background = theme.surface.hover
                event.currentTarget.style.color = theme.text.primary
              }}
              onMouseLeave={event => {
                event.currentTarget.style.background = index === 0 ? theme.surface.hover : 'transparent'
                event.currentTarget.style.color = index === 0 ? theme.text.primary : theme.text.secondary
              }}
            >
              <span style={{ display: 'flex', color: 'currentColor', opacity: 0.75 }}>{getSessionAgentIcon(session)}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: Math.max(12, fonts.size), fontWeight: 650 }}>
                {formatSessionTitleForSidebar(session.title, 90)}
              </span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: theme.text.disabled, fontSize: Math.max(11, fonts.secondarySize), maxWidth: 150 }}>
                {session.workspaceName ?? session.sourceLabel}
              </span>
              <span style={{ borderRadius: 10, background: theme.surface.panelMuted, color: theme.text.secondary, padding: '1px 7px', fontSize: Math.max(11, fonts.secondarySize), lineHeight: 1.35 }}>
                {index < 9 ? `⌘${index + 1}` : ''}
              </span>
            </button>
          ))}
          {sessions.length === 0 && (
            <div style={{ padding: '16px 14px 22px', color: theme.text.disabled, fontSize: Math.max(12, fonts.size) }}>
              No matching chats
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function SidebarTopItem({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [hovered, setHovered] = useState(false)

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: '100%',
        minHeight: 25,
        display: 'grid',
        gridTemplateColumns: '24px minmax(0, 1fr)',
        alignItems: 'center',
        columnGap: 8,
        padding: '2px 10px 2px 8px',
        border: 'none',
        borderRadius: 6,
        background: hovered ? theme.surface.hover : 'transparent',
        color: theme.text.secondary,
        cursor: 'pointer',
        fontFamily: fonts.primary,
        fontSize: fonts.size,
        fontWeight: fonts.weight,
        lineHeight: fonts.lineHeight * 0.9,
        textAlign: 'left',
      }}
    >
      <span
        style={{
          width: 24,
          height: 22,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: theme.text.muted,
        }}
      >
        {icon}
      </span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </button>
  )
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar({
  workspace, workspaces, tiles: _tiles, onSwitchWorkspace: _onSwitchWorkspace, onDeleteWorkspace: _onDeleteWorkspace, onNewWorkspace: _onNewWorkspace, onOpenFolder, onOpenFile, onFocusTile: _onFocusTile, onUpdateTile: _onUpdateTile, onCloseTile: _onCloseTile,
  onNewTerminal, onNewKanban, onNewBrowser, onNewChat, onNewChatForProject, onNewFiles, onOpenSettings,
  onOpenSessionInChat, onOpenSessionInApp,
  extensionTiles, extensionEntries, onAddExtensionTile, pinnedExtensionIds = [],
  collapsed, width, onWidthChange, minWidth = 270, maxWidth = 520, onResizeStateChange, onToggleCollapse: _onToggleCollapse, showFooter = true,
  activeChatTileId = null,
  activeChatSessionId = null,
  activeChatSessionEntryId = null,
}: Props): React.JSX.Element {
  const fonts = useAppFonts()
  const theme = useTheme()
  const widthRef = useRef(width)
  const scrollRef = useRef<HTMLDivElement>(null)
  void pinnedExtensionIds
  useEffect(() => { widthRef.current = width }, [width])
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false)
  const [searchPaletteQuery, setSearchPaletteQuery] = useState('')
  const [sessionCtx, setSessionCtx] = useState<{ x: number; y: number; session: SessionEntry } | null>(null)
  const [projectCtx, setProjectCtx] = useState<{ x: number; y: number; group: SessionProjectGroup } | null>(null)
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [threadMenuOpen, setThreadMenuOpen] = useState(false)
  const [threadOrganizeMode, setThreadOrganizeMode] = useState<ThreadOrganizeMode>('project')
  const [threadSortMode, setThreadSortMode] = useState<ThreadSortMode>('updated')
  const [showArchivedSessions, setShowArchivedSessions] = useState(false)
  const [showCronSessions, setShowCronSessions] = useState(false)
  const [showSubagentSessions, setShowSubagentSessions] = useState(true)
  const [hiddenSessionAgents, setHiddenSessionAgents] = useState<Record<string, boolean>>({})
  const [collapsedThreadGroups, setCollapsedThreadGroups] = useState<Record<string, boolean>>({})
  const [projectSessionVisibleCounts, setProjectSessionVisibleCounts] = useState<Record<string, number>>({})
  const [loadedSessionWorkspaceIds, setLoadedSessionWorkspaceIds] = useState<string[]>([])
  const [hoveredProjectRow, setHoveredProjectRow] = useState<string | null>(null)
  const [archivingSessionId, setArchivingSessionId] = useState<string | null>(null)
  const [generatingSessionTitleIds, setGeneratingSessionTitleIds] = useState<SessionTitleGenerationState>({})
  const [visibleSessionCount, setVisibleSessionCount] = useState(SESSION_PAGE_SIZE)
  const [sessionPromotions, setSessionPromotions] = useState<Record<string, number>>({})
  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [sessionReadWatermarks, setSessionReadWatermarks] = useState<SessionReadWatermarks>(() => loadSessionReadWatermarks())
  const [pinnedSessionKeys, setPinnedSessionKeys] = useState<PinnedSessionKeys>(() => loadPinnedSessionKeys())
  const [textDialog, setTextDialog] = useState<SidebarTextDialogState | null>(null)
  const threadMenuRef = useRef<HTMLDivElement>(null)
  const sessionLoadRequestSeqRef = useRef(0)
  const latestSessionLoadTokenByWorkspaceRef = useRef(new Map<string, number>())
  const lastSessionLoadAtByWorkspaceRef = useRef(new Map<string, number>())
  const readSeededWorkspaceIdsRef = useRef(new Set<string>())

  const openSearchPalette = useCallback(() => {
    setSearchPaletteQuery('')
    setSearchPaletteOpen(true)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'g')) return
      event.preventDefault()
      event.stopPropagation()
      openSearchPalette()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [openSearchPalette])

  useEffect(() => {
    let cancelled = false

    const loadProjects = async () => {
      const listProjects = window.electron.workspace.listProjects
      if (typeof listProjects !== 'function') {
        if (!cancelled) setProjects([])
        return
      }

      const next = await listProjects().catch(() => null)
      if (cancelled || !next) return
      setProjects(next)
    }

    void loadProjects()
    window.addEventListener('focus', loadProjects)

    return () => {
      cancelled = true
      window.removeEventListener('focus', loadProjects)
    }
  }, [workspaces])

  const projectEntries = useMemo<ProjectListEntry[]>(() => {
    const workspaceIdsByPath = new Map<string, string[]>()
    for (const workspaceEntry of workspaces) {
      for (const projectPath of getWorkspaceProjectPaths(workspaceEntry)) {
        const existing = workspaceIdsByPath.get(projectPath) ?? []
        if (!existing.includes(workspaceEntry.id)) existing.push(workspaceEntry.id)
        workspaceIdsByPath.set(projectPath, existing)
      }
    }

    const sourceProjects = projects.length > 0
      ? projects.map(project => ({
        id: project.id,
        name: project.name,
        path: project.path,
        workspaceIds: [],
        representativeWorkspaceId: null,
      }))
      : deriveProjectsFromWorkspaces(workspaces)

    return sourceProjects
      .map(project => {
        const normalizedPath = normalizeSidebarPath(project.path)
        const workspaceIds = workspaceIdsByPath.get(normalizedPath) ?? []
        return {
          ...project,
          workspaceIds,
          representativeWorkspaceId: workspaceIds.includes(workspace?.id ?? '')
            ? (workspace?.id ?? null)
            : (workspaceIds[0] ?? null),
        }
      })
      .filter(project => project.workspaceIds.length > 0)
      .sort((a, b) => getProjectDisplayLabel(a).localeCompare(getProjectDisplayLabel(b), undefined, { sensitivity: 'base' }))
  }, [projects, workspaces, workspace?.id])

  const workspaceById = useMemo(() => new Map(workspaces.map(workspaceEntry => [workspaceEntry.id, workspaceEntry] as const)), [workspaces])

  const refreshProjects = useCallback(async () => {
    const listProjects = window.electron.workspace.listProjects
    if (typeof listProjects !== 'function') return
    const next = await listProjects().catch(() => null)
    if (next) setProjects(next)
  }, [])

  const activeProjectId = useMemo(() => {
    const primaryProjectPath = normalizeSidebarPath(workspace?.path)
    const currentPaths = new Set(getWorkspaceProjectPaths(workspace))
    const currentProject = projectEntries.find(project => normalizeSidebarPath(project.path) === primaryProjectPath)
      ?? projectEntries.find(project => currentPaths.has(normalizeSidebarPath(project.path)))
      ?? null
    return currentProject?.id ?? projectEntries[0]?.id ?? null
  }, [projectEntries, workspace])

  const loadedSessionWorkspaceIdSet = useMemo(() => new Set(loadedSessionWorkspaceIds), [loadedSessionWorkspaceIds])

  useEffect(() => {
    if (activeProjectId) setSelectedProjectId(activeProjectId)
  }, [activeProjectId])

  useEffect(() => {
    const activeSessions = sessions.filter(session => isSessionActive(session, {
      activeChatTileId,
      activeChatSessionId,
      activeChatSessionEntryId,
    }))
    if (activeSessions.length === 0) return
    if (activeSessions.some(session => getSessionSelectionKey(session) === selectedSessionKey)) return
    setSelectedSessionKey(getSessionSelectionKey(activeSessions[0]))
  }, [activeChatSessionEntryId, activeChatSessionId, activeChatTileId, selectedSessionKey, sessions])

  const scrollSessionsToTop = useCallback(() => {
    window.requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: 0, behavior: 'auto' })
    })
  }, [])

  const promoteSession = useCallback((session: SessionEntry | null | undefined) => {
    if (!session) return
    const promotedAt = Date.now()
    setSessionPromotions(prev => {
      const current = prev[session.id] ?? 0
      if (current >= promotedAt) return prev
      return {
        ...prev,
        [session.id]: promotedAt,
      }
    })
    scrollSessionsToTop()
  }, [scrollSessionsToTop])

  const markSessionRead = useCallback((session: SessionEntry | null | undefined) => {
    if (!session) return
    const key = getSessionActivityKey(session)
    setSessionReadWatermarks(prev => {
      const current = prev[key] ?? 0
      if (current >= session.updatedAt) return prev
      return {
        ...prev,
        [key]: session.updatedAt,
      }
    })
  }, [])

  useEffect(() => {
    saveSessionReadWatermarks(sessionReadWatermarks)
  }, [sessionReadWatermarks])

  useEffect(() => {
    savePinnedSessionKeys(pinnedSessionKeys)
  }, [pinnedSessionKeys])

  useEffect(() => {
    const validIds = new Set(sessions.map(session => session.id))
    setSessionPromotions(prev => {
      let changed = false
      const next: Record<string, number> = {}
      for (const [sessionId, promotedAt] of Object.entries(prev)) {
        if (!validIds.has(sessionId)) {
          changed = true
          continue
        }
        next[sessionId] = promotedAt
      }
      return changed ? next : prev
    })
  }, [sessions])

  useEffect(() => {
    if (sessions.length === 0) return
    setSessionReadWatermarks(prev => {
      let changed = false
      const next: SessionReadWatermarks = { ...prev }
      for (const session of sessions) {
        const key = getSessionActivityKey(session)
        if (Object.prototype.hasOwnProperty.call(next, key)) continue
        const isSeededWorkspace = readSeededWorkspaceIdsRef.current.has(session.workspaceId)
        next[key] = isSeededWorkspace ? 0 : session.updatedAt
        changed = true
      }
      for (const session of sessions) {
        readSeededWorkspaceIdsRef.current.add(session.workspaceId)
      }
      return changed ? next : prev
    })
  }, [sessions])

  useEffect(() => {
    const activeSessions = sessions.filter(session => isSessionActive(session, {
      activeChatTileId,
      activeChatSessionId,
      activeChatSessionEntryId,
    }))
    if (activeSessions.length === 0) return
    setSessionReadWatermarks(prev => {
      let changed = false
      const next: SessionReadWatermarks = { ...prev }
      for (const session of activeSessions) {
        const key = getSessionActivityKey(session)
        const current = next[key] ?? 0
        if (current >= session.updatedAt) continue
        next[key] = session.updatedAt
        changed = true
      }
      return changed ? next : prev
    })
  }, [activeChatSessionEntryId, activeChatSessionId, activeChatTileId, sessions])

  // Streaming session/tile ids published by ChatTile — used to swap the row
  // icon for a spinner while the thread is actively streaming. Read-only: we
  // no longer use streaming as a promotion trigger because it fires for any
  // stream start (resume, tool-call continuation, auto-continue), not just a
  // user submit.
  const streamingSnapshot = useSyncExternalStore(subscribeChatStreaming, getChatStreamingSnapshot, getChatStreamingSnapshot)

  // Explicit "user hit send" signal from ChatTile. Promote only when the seq
  // advances — opening, focusing, or resuming a thread does not publish here.
  const sentSnapshot = useSyncExternalStore(subscribeChatMessageSent, getChatMessageSentSnapshot, getChatMessageSentSnapshot)
  const lastPromotedSeqRef = useRef(0)
  useEffect(() => {
    if (!sentSnapshot || sentSnapshot.seq <= lastPromotedSeqRef.current) return
    lastPromotedSeqRef.current = sentSnapshot.seq
    const match = sessions.find(session => {
      if (sentSnapshot.entryId && session.id === sentSnapshot.entryId) return true
      if (sentSnapshot.tileId && session.tileId === sentSnapshot.tileId) return true
      return false
    })
    if (match) promoteSession(match)
  }, [sentSnapshot, sessions, promoteSession])

  const isThreadGroupCollapsed = useCallback((group: SessionProjectGroup | ProjectListEntry) => {
    const groupKey = 'key' in group ? group.key : group.id
    const explicit = collapsedThreadGroups[groupKey]
    if (typeof explicit === 'boolean') return explicit
    // The sidebar is shared chrome: switching workspace/tab state should only
    // change the main panel, not silently reshape the conversation list.
    return false
  }, [collapsedThreadGroups])

  const allProjectThreadGroupsCollapsed = useMemo(() => {
    return projectEntries.length > 0 && projectEntries.every(projectEntry => isThreadGroupCollapsed(projectEntry))
  }, [isThreadGroupCollapsed, projectEntries])

  useEffect(() => {
    if (!threadMenuOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const insidePortal = Boolean(target?.closest('[data-sidebar-menu-portal="true"]'))
      if (!insidePortal && threadMenuRef.current && !threadMenuRef.current.contains(event.target as Node)) {
        setThreadMenuOpen(false)
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setThreadMenuOpen(false)
    }
    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [threadMenuOpen])

  const annotateSessions = useCallback((workspaceEntry: Workspace, items: Array<Omit<SessionEntry, 'workspaceId' | 'workspaceName' | 'workspacePath'>>): SessionEntry[] => {
    return items.map(session => ({
      ...session,
      workspaceId: workspaceEntry.id,
      workspaceName: workspaceEntry.name,
      workspacePath: workspaceEntry.path,
    }))
  }, [])

  const loadWorkspaceSessions = useCallback(async (workspaceEntry: Workspace, forceRefresh = false) => {
    const requestToken = sessionLoadRequestSeqRef.current + 1
    sessionLoadRequestSeqRef.current = requestToken
    latestSessionLoadTokenByWorkspaceRef.current.set(workspaceEntry.id, requestToken)

    let items: Array<Omit<SessionEntry, 'workspaceId' | 'workspaceName' | 'workspacePath'>>
    try {
      items = await window.electron.canvas.listSessions(workspaceEntry.id, forceRefresh)
    } catch (error) {
      console.warn('[sidebar] failed to load sessions', {
        workspaceId: workspaceEntry.id,
        forceRefresh,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    if (latestSessionLoadTokenByWorkspaceRef.current.get(workspaceEntry.id) !== requestToken) return
    const annotated = annotateSessions(workspaceEntry, items)
    if (annotated.length === 0) readSeededWorkspaceIdsRef.current.add(workspaceEntry.id)
    setSessions(prev => [...prev.filter(session => session.workspaceId !== workspaceEntry.id), ...annotated])
    lastSessionLoadAtByWorkspaceRef.current.set(workspaceEntry.id, Date.now())
    setLoadedSessionWorkspaceIds(prev => prev.includes(workspaceEntry.id) ? prev : [...prev, workspaceEntry.id])
  }, [annotateSessions])

  useEffect(() => {
    const validWorkspaceIds = new Set(projectEntries.flatMap(projectEntry => projectEntry.workspaceIds))
    setSessions(prev => prev.filter(session => validWorkspaceIds.has(session.workspaceId)))
    setLoadedSessionWorkspaceIds(prev => prev.filter(workspaceId => validWorkspaceIds.has(workspaceId)))
  }, [projectEntries])

  useEffect(() => {
    if (projectEntries.length === 0) {
      setSessions([])
      setLoadedSessionWorkspaceIds([])
      return
    }

    const workspaceIdsToLoad = new Set<string>()
    for (const projectEntry of projectEntries) {
      for (const workspaceId of projectEntry.workspaceIds) {
        workspaceIdsToLoad.add(workspaceId)
      }
    }

    for (const workspaceId of workspaceIdsToLoad) {
      if (loadedSessionWorkspaceIdSet.has(workspaceId)) continue
      const workspaceEntry = workspaceById.get(workspaceId)
      if (workspaceEntry) void loadWorkspaceSessions(workspaceEntry)
    }
  }, [
    loadWorkspaceSessions,
    loadedSessionWorkspaceIdSet,
    projectEntries,
    workspaceById,
  ])

  useEffect(() => {
    const unsubscribe = window.electron.canvas.onSessionsChanged(({ workspaceId }) => {
      // Wildcard '*' (or missing) → refresh every loaded workspace. Used by
      // the thread indexer when a reseed affects rows across workspaces.
      if (!workspaceId || workspaceId === '*') {
        for (const loadedId of loadedSessionWorkspaceIdSet) {
          const entry = workspaceById.get(loadedId)
          if (entry) void loadWorkspaceSessions(entry, false)
        }
        return
      }
      const workspaceEntry = workspaceById.get(workspaceId)
      if (!workspaceEntry || !loadedSessionWorkspaceIdSet.has(workspaceEntry.id)) return
      void loadWorkspaceSessions(workspaceEntry, true)
    })

    const onFocus = () => {
      const now = Date.now()
      const visibleWorkspaceIds = new Set<string>()
      if (workspace?.id) visibleWorkspaceIds.add(workspace.id)
      for (const projectEntry of projectEntries) {
        if (isThreadGroupCollapsed(projectEntry)) continue
        for (const workspaceId of projectEntry.workspaceIds) visibleWorkspaceIds.add(workspaceId)
      }

      for (const workspaceId of loadedSessionWorkspaceIdSet) {
        if (!visibleWorkspaceIds.has(workspaceId)) continue
        const lastLoadedAt = lastSessionLoadAtByWorkspaceRef.current.get(workspaceId) ?? 0
        if ((now - lastLoadedAt) < SESSION_FOCUS_REFRESH_STALE_MS) continue
        const workspaceEntry = workspaceById.get(workspaceId)
        if (workspaceEntry) void loadWorkspaceSessions(workspaceEntry, true)
      }
    }

    window.addEventListener('focus', onFocus)
    return () => {
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [isThreadGroupCollapsed, loadWorkspaceSessions, loadedSessionWorkspaceIdSet, projectEntries, workspace?.id, workspaceById])

  const promotedSessions = useMemo(() => applySessionPromotions(sessions, sessionPromotions), [sessions, sessionPromotions])

  const orderedProjectEntries = projectEntries

  const resizing = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  const toggleThreadGroup = useCallback((key: string) => {
    setSelectedProjectId(key)
    const projectEntry = projectEntries.find(entry => entry.id === key) ?? null
    const isActiveGroup = key === activeProjectId
    const isCollapsed = collapsedThreadGroups[key] ?? false

    if (!isActiveGroup && projectEntry) {
      setCollapsedThreadGroups(prev => ({ ...prev, [key]: false }))
      for (const workspaceId of projectEntry.workspaceIds) {
        const workspaceEntry = workspaceById.get(workspaceId)
        if (workspaceEntry) void loadWorkspaceSessions(workspaceEntry)
      }
      // Switching to a different project should jump back to that project's
      // existing workspace/tab state rather than acting like a collapse toggle.
      const targetWsId = projectEntry.representativeWorkspaceId ?? projectEntry.workspaceIds[0]
      if (targetWsId && targetWsId !== workspace?.id) {
        _onSwitchWorkspace(targetWsId)
      }
      return
    }

    const shouldCollapse = !isCollapsed
    if (shouldCollapse) {
      setProjectSessionVisibleCounts(prev => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
    setCollapsedThreadGroups(prev => ({ ...prev, [key]: shouldCollapse }))
  }, [activeProjectId, collapsedThreadGroups, loadWorkspaceSessions, projectEntries, workspaceById, workspace?.id, _onSwitchWorkspace])

  const toggleAllThreadGroups = useCallback(() => {
    setProjectSessionVisibleCounts({})
    setCollapsedThreadGroups(() => {
      const next: Record<string, boolean> = {}
      for (const projectEntry of projectEntries) {
        next[projectEntry.id] = !allProjectThreadGroupsCollapsed
      }
      return next
    })
  }, [allProjectThreadGroupsCollapsed, projectEntries])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return
      onWidthChange(Math.max(minWidth, Math.min(maxWidth, startWidth.current + e.clientX - startX.current)))
    }
    const onUp = () => {
      if (!resizing.current) return
      resizing.current = false
      onResizeStateChange?.(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onResizeStateChange, onWidthChange])

  const visibleSessions = useMemo(() => {
    // Dedup across workspaces: the same underlying chat can be surfaced by
    // multiple workspaces that share a project path. When it carries a real
    // provider sessionId we key on (agent, sessionId) so duplicates collapse;
    // fall back to `id` only for rows without a sessionId. Tiebreaker prefers
    // workspace/project scope over user scope, then the more recent entry.
    const deduped = new Map<string, SessionEntry>()
    const archivedByKey = new Map<string, boolean>()
    const keyFor = (session: SessionEntry): string => {
      if (session.sessionId) return `sid:${getSessionAgentKey(session)}:${session.sessionId}`
      return `id:${session.id}`
    }
    const scopeRank = (session: SessionEntry): number => (session.scope === 'user' ? 0 : 1)
    for (const session of promotedSessions) {
      const key = keyFor(session)
      // OR-merge archived across every copy of the session: archive state is
      // stored per-workspace, so a row archived in workspace A can appear
      // "unarchived" via workspace B. If ANY copy is archived, treat the
      // deduped row as archived.
      if (session.isArchived === true) archivedByKey.set(key, true)
      const existing = deduped.get(key)
      if (!existing) {
        deduped.set(key, session)
        continue
      }
      const existingScore = scopeRank(existing)
      const nextScore = scopeRank(session)
      if (nextScore > existingScore) { deduped.set(key, session); continue }
      if (nextScore === existingScore && session.updatedAt > existing.updatedAt) {
        deduped.set(key, session)
      }
    }
    for (const [key, entry] of deduped) {
      if (archivedByKey.get(key) === true && entry.isArchived !== true) {
        deduped.set(key, { ...entry, isArchived: true })
      }
    }

    const filtered = [...deduped.values()].filter(session => {
      const normalizedTitle = session.title?.trim().toLowerCase() ?? ''
      const hasContent = Boolean(session.title?.trim()) || Boolean(session.lastMessage?.trim()) || session.messageCount > 0
      if (!hasContent) return false
      if (normalizedTitle === 'new agent') return false
      if (isInternalMaintenanceSession(session)) return false
      if (!showArchivedSessions && session.isArchived === true) return false
      if (!showCronSessions && isCronSession(session)) return false
      if (!showSubagentSessions && isSubagentSession(session)) return false
      if (hiddenSessionAgents[getSessionAgentKey(session)] === true) return false
      return true
    })
    return buildNestedSessionList(filtered, threadSortMode, sessionPromotions)
  }, [promotedSessions, showArchivedSessions, showCronSessions, showSubagentSessions, hiddenSessionAgents, threadOrganizeMode, threadSortMode, sessionPromotions])

  const toggleSessionPinned = useCallback((session: SessionEntry) => {
    const key = getSessionActivityKey(session)
    setPinnedSessionKeys(prev => {
      if (prev[key]) {
        const next = { ...prev }
        delete next[key]
        return next
      }
      return { ...prev, [key]: true }
    })
  }, [])

  const pinnedVisibleSessions = useMemo(() => (
    visibleSessions.filter(session => pinnedSessionKeys[getSessionActivityKey(session)] === true)
  ), [pinnedSessionKeys, visibleSessions])

  const normalVisibleSessions = useMemo(() => (
    visibleSessions.filter(session => pinnedSessionKeys[getSessionActivityKey(session)] !== true)
  ), [pinnedSessionKeys, visibleSessions])

  const availableSessionAgents = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; icon: React.JSX.Element }>()
    for (const session of sessions) {
      const key = getSessionAgentKey(session)
      if (byKey.has(key)) continue
      byKey.set(key, {
        key,
        label: getSessionAgentLabel(session),
        icon: getSessionAgentIcon(session),
      })
    }
    return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
  }, [sessions])

  // Chronological mode uses a single flat list with one paginator.
  // Project mode renders the full project thread list and relies on the
  // sidebar scroller instead of a second per-project paging layer.
  useEffect(() => {
    setVisibleSessionCount(SESSION_PAGE_SIZE)
    setProjectSessionVisibleCounts({})
  }, [showArchivedSessions, showCronSessions, showSubagentSessions, threadOrganizeMode, threadSortMode])

  // Keep per-project pagination independent of the active workspace tab. The
  // sidebar should not reset visible thread counts just because the main view
  // switched to another tab/workspace.

  const displayedSessions = useMemo(() => {
    if (threadOrganizeMode !== 'chronological') return normalVisibleSessions
    return normalVisibleSessions.slice(0, visibleSessionCount)
  }, [normalVisibleSessions, visibleSessionCount, threadOrganizeMode])

  const displayedSessionGroups = useMemo<SessionProjectGroup[]>(() => {
    if (threadOrganizeMode === 'chronological') {
      return displayedSessions.length > 0 ? [{
        projectId: 'chronological',
        projectPath: '',
        representativeWorkspaceId: null,
        key: 'chronological',
        label: 'Threads',
        sessions: displayedSessions,
      }] : []
    }
    return orderedProjectEntries
      .map(projectEntry => {
        const projectPath = normalizeSidebarPath(projectEntry.path)
        const workspaceIdSet = new Set(projectEntry.workspaceIds)
        const allWorkspaceSessions = normalVisibleSessions.filter(session => {
          const sessionProjectPath = normalizeSidebarPath(session.projectPath ?? session.workspacePath)
          if (sessionProjectPath) return sidebarPathBelongsToProject(projectPath, sessionProjectPath)
          return workspaceIdSet.has(session.workspaceId)
        })
        return {
          projectId: projectEntry.id,
          projectPath: projectEntry.path,
          representativeWorkspaceId: projectEntry.representativeWorkspaceId,
          key: projectEntry.id,
          label: getProjectDisplayLabel(projectEntry),
          sessions: allWorkspaceSessions,
        }
      })
  }, [normalVisibleSessions, displayedSessions, orderedProjectEntries, threadOrganizeMode])

  const filteredSessionGroups = displayedSessionGroups

  const hasMoreSessions = threadOrganizeMode === 'chronological'
    ? displayedSessions.length < normalVisibleSessions.length
    : false

  const searchPaletteSessions = useMemo(() => {
    const q = searchPaletteQuery.trim().toLowerCase()
    const base = visibleSessions
    const filtered = q
      ? base.filter(session =>
        session.title?.toLowerCase().includes(q)
        || session.lastMessage?.toLowerCase().includes(q)
        || session.sourceLabel?.toLowerCase().includes(q)
        || session.workspaceName?.toLowerCase().includes(q)
      )
      : base
    return filtered.slice(0, 9)
  }, [searchPaletteQuery, visibleSessions])

  const setSessionArchived = useCallback(async (session: SessionEntry, archived: boolean) => {
    if (!session.workspaceId || archivingSessionId) return
    setArchivingSessionId(session.id)
    try {
      // Archive state is persisted per-workspace, but the same underlying chat
      // can be surfaced by multiple workspaces sharing a project path. Write
      // the flag to every workspace that lists this session (match by
      // agent + sessionId, or by id when sessionId is absent) so the row
      // can't resurrect from a copy that wasn't told about the change.
      const agentKey = getSessionAgentKey(session)
      const targets = new Map<string, SessionEntry>()
      for (const candidate of sessions) {
        const sameBySessionId = Boolean(session.sessionId)
          && candidate.sessionId === session.sessionId
          && getSessionAgentKey(candidate) === agentKey
        const sameById = candidate.id === session.id
        if (!sameBySessionId && !sameById) continue
        if (!candidate.workspaceId) continue
        const key = `${candidate.workspaceId}::${candidate.id}`
        if (!targets.has(key)) targets.set(key, candidate)
      }
      if (targets.size === 0) {
        targets.set(`${session.workspaceId}::${session.id}`, session)
      }

      const results = await Promise.all(
        [...targets.values()].map(target =>
          window.electron.canvas.setSessionArchived(target.workspaceId, target.id, archived)
            .catch(() => ({ ok: false }))
            .then(result => ({ target, ok: Boolean(result?.ok) }))
        ),
      )

      const succeeded = new Set(
        results.filter(r => r.ok).map(r => `${r.target.workspaceId}::${r.target.id}`),
      )
      if (succeeded.size > 0) {
        setSessions(prev => prev.map(entry => {
          if (!succeeded.has(`${entry.workspaceId}::${entry.id}`)) return entry
          return { ...entry, isArchived: archived }
        }))
      }
    } finally {
      setArchivingSessionId(null)
    }
  }, [archivingSessionId, sessions])

  const handleArchiveSessionClick = useCallback((session: SessionEntry) => {
    void setSessionArchived(session, !(session.isArchived === true))
  }, [setSessionArchived])

  const openSessionFromSidebar = useCallback((session: SessionEntry, options?: { persist?: boolean }) => {
    setSelectedSessionKey(getSessionSelectionKey(session))
    setSelectedProjectId(projectEntries.find(projectEntry => projectEntry.workspaceIds.includes(session.workspaceId))?.id ?? selectedProjectId)
    markSessionRead(session)
    const intent = getSessionOpenIntent(session, options)
    if (intent.kind === 'chat') {
      onOpenSessionInChat(session, { persist: intent.persist })
      return
    }
    if (intent.kind === 'app') {
      onOpenSessionInApp(session)
      return
    }
    if (intent.kind === 'file' && session.filePath) {
      onOpenFile(session.filePath, { persist: intent.persist })
    }
  }, [markSessionRead, onOpenFile, onOpenSessionInApp, onOpenSessionInChat, projectEntries, selectedProjectId])

  const openSessionMiniFromSidebar = useCallback((session: SessionEntry) => {
    const tileId = typeof session.tileId === 'string' ? session.tileId.trim() : ''
    if (!tileId) {
      openSessionFromSidebar(session)
      return
    }
    setSelectedSessionKey(getSessionSelectionKey(session))
    setSelectedProjectId(projectEntries.find(projectEntry => projectEntry.workspaceIds.includes(session.workspaceId))?.id ?? selectedProjectId)
    markSessionRead(session)
    void window.electron.window.openMiniChat({
      workspaceId: session.workspaceId,
      tileId,
      title: session.title,
    }).catch(error => {
      console.warn('[sidebar] failed to open mini chat window', error)
      openSessionFromSidebar(session)
    })
  }, [markSessionRead, openSessionFromSidebar, projectEntries, selectedProjectId])

  const sessionContextMenuItems = useCallback((session: SessionEntry): MenuItem[] => {
    const items: MenuItem[] = []
    const sessionKey = getSessionTitleGenerationKey(session.workspaceId, session.id)
    const titleGeneration = getSessionTitleGenerationIndicator(generatingSessionTitleIds[sessionKey] === true)
    if (session.canOpenInChat !== false) {
      items.push({ label: 'Open in Chat', action: () => onOpenSessionInChat(session) })
      items.push({ label: 'Open in Pinned Tab', action: () => onOpenSessionInChat(session, { persist: true }) })
      if (typeof session.tileId === 'string' && session.tileId.trim().length > 0) {
        items.push({ label: 'Open Mini Window', action: () => openSessionMiniFromSidebar(session) })
      }
    }
    if (session.canOpenInApp) {
      items.push({ label: `Open in ${session.sourceLabel}`, action: () => onOpenSessionInApp(session) })
    }
    if (session.id.startsWith('codesurf-runtime:') && (session.checkpointCount ?? 0) > 0) {
      items.push({
        label: session.checkpointCount === 1 ? 'Restore Latest Checkpoint' : `Restore Latest Checkpoint (${session.checkpointCount})`,
        action: () => {
          const confirmed = window.confirm(`Restore the latest checkpoint for "${session.title}"?`)
          if (!confirmed) return
          void window.electron.canvas.listCheckpoints(session.workspaceId, session.id)
            .then(checkpoints => {
              const latest = checkpoints[0]
              if (!latest) return null
              return window.electron.canvas.restoreCheckpoint(session.workspaceId, latest.id, session.id)
            })
            .then(async result => {
              if (!result?.ok) {
                if (result?.error) window.alert(result.error)
                return
              }
              const workspaceEntry = workspaceById.get(session.workspaceId)
              if (workspaceEntry) await loadWorkspaceSessions(workspaceEntry, true)
              if (session.canOpenInChat !== false) await onOpenSessionInChat(session)
            })
            .catch(error => {
              window.alert(error instanceof Error ? error.message : String(error))
            })
        },
      })
    }
    if (session.filePath) {
      items.push({ label: 'Open Raw File', action: () => onOpenFile(session.filePath!) })
      items.push({ label: 'Open Raw File in Pinned Tab', action: () => onOpenFile(session.filePath!, { persist: true }) })
    }

    items.push({
      label: 'Rename Thread',
      action: () => {
        setTextDialog({
          title: 'Rename Thread',
          description: 'Update the title shown in the sidebar for this conversation.',
          confirmLabel: 'Rename',
          initialValue: session.title,
          submit: async (rawValue: string) => {
            const nextTitle = rawValue.trim()
            if (!nextTitle || nextTitle === session.title) return
            const result = await window.electron.canvas.renameSession(session.workspaceId, session.id, nextTitle)
            if (!result?.ok) throw new Error(result?.error || 'Failed to rename thread.')
            setSessions(prev => prev.map(entry => entry.id === session.id && entry.workspaceId === session.workspaceId
              ? { ...entry, title: nextTitle }
              : entry))
            const workspaceEntry = workspaceById.get(session.workspaceId)
            if (workspaceEntry) await loadWorkspaceSessions(workspaceEntry, true)
          },
        })
      },
    })

    items.push({
      label: titleGeneration.menuLabel,
      action: () => {
        if (generatingSessionTitleIds[sessionKey] === true) return
        setGeneratingSessionTitleIds(prev => updateSessionTitleGenerationState(prev, sessionKey, true))
        void window.electron.canvas.generateSessionTitle(session.workspaceId, session.id, {
          id: session.id,
          source: session.source,
          filePath: session.filePath,
          sessionId: session.sessionId,
          provider: session.provider,
          model: session.model,
          messageCount: session.messageCount,
          title: session.title,
          projectPath: session.projectPath ?? null,
        })
          .then(async result => {
            if (!result?.ok) throw new Error(result?.error || 'Failed to generate thread title.')
            const nextTitle = result.title ?? session.title
            setSessions(prev => prev.map(entry => entry.id === session.id && entry.workspaceId === session.workspaceId
              ? { ...entry, title: nextTitle }
              : entry))
            const workspaceEntry = workspaceById.get(session.workspaceId)
            if (workspaceEntry) await loadWorkspaceSessions(workspaceEntry, true)
          })
          .catch(error => {
            window.alert(error instanceof Error ? error.message : String(error))
          })
          .finally(() => {
            setGeneratingSessionTitleIds(prev => updateSessionTitleGenerationState(prev, sessionKey, false))
          })
      },
    })

    items.push({
      label: getSessionArchiveActionLabel(session.isArchived === true),
      action: () => { void setSessionArchived(session, !(session.isArchived === true)) },
    })

    return items.length > 0 ? items : [{ label: 'No actions available', action: () => {} }]
  }, [generatingSessionTitleIds, loadWorkspaceSessions, onOpenFile, onOpenSessionInApp, onOpenSessionInChat, openSessionMiniFromSidebar, setSessionArchived, workspaceById])

  const handleOpenProjectFromSidebar = useCallback(() => {
    onOpenFolder()
    setThreadMenuOpen(false)
  }, [onOpenFolder])

  const projectContextMenuItems = useCallback((group: SessionProjectGroup): MenuItem[] => {
    const projectEntry = projectEntries.find(entry => entry.id === group.projectId) ?? null
    const projectPath = projectEntry?.path ?? group.projectPath
    const workspaceIds = projectEntry?.workspaceIds ?? []

    return [
      {
        label: 'Open in Finder',
        action: () => {
          if (!projectPath) return
          const reveal = window.electron.fs.revealInFinder
          if (typeof reveal !== 'function') return
          void reveal(projectPath).catch(() => {})
        },
      },
      {
        label: 'Create permanent worktree',
        action: () => {
          if (!projectPath) return
          setTextDialog({
            title: 'Create Permanent Worktree',
            description: `Create a named worktree for ${group.label}. Invalid characters will be replaced with "-".`,
            confirmLabel: 'Create',
            initialValue: '',
            placeholder: 'feature/my-branch',
            submit: async (rawValue: string) => {
              const name = rawValue.trim()
              if (!name) return
              const safeName = name.replace(/[^A-Za-z0-9._/-]/g, '-')
              if (!safeName) throw new Error('Invalid worktree name.')
              const result = await window.electron.workspace.createProjectWorktree({
                projectId: projectEntry?.id,
                projectPath,
                name: safeName,
              })
              if (!result?.ok) throw new Error(result?.error || 'Failed to create worktree.')
              await refreshProjects()
            },
          })
        },
      },
      {
        label: 'Rename project',
        action: () => {
          const currentName = projectEntry?.name ?? group.label
          setTextDialog({
            title: 'Rename Project',
            description: 'Change the display name used for this project in the sidebar.',
            confirmLabel: 'Rename',
            initialValue: currentName,
            submit: async (rawValue: string) => {
              const nextName = rawValue.trim()
              if (!nextName || nextName === currentName) return
              const result = await window.electron.workspace.renameProject({
                projectId: projectEntry?.id,
                projectPath,
                name: nextName,
              })
              if (!result?.ok) throw new Error(result?.error || 'Failed to rename project.')
              await refreshProjects()
            },
          })
        },
      },
      {
        label: 'Archive chats',
        action: () => {
          const projectSessions = sessions.filter(session => {
            const normalizedProjectPath = normalizeSidebarPath(session.projectPath ?? session.workspacePath)
            if (normalizedProjectPath && projectPath) return sidebarPathBelongsToProject(projectPath, normalizedProjectPath)
            return workspaceIds.includes(session.workspaceId)
          }).filter(session => session.isArchived !== true)
          if (projectSessions.length === 0) return
          const confirmed = window.confirm(`Archive ${projectSessions.length} chat${projectSessions.length === 1 ? '' : 's'} in ${group.label}?`)
          if (!confirmed) return
          for (const session of projectSessions) {
            void setSessionArchived(session, true)
          }
        },
      },
      {
        label: 'Remove',
        action: () => {
          const confirmed = window.confirm(`Remove ${group.label} from the sidebar? (Files are not deleted.)`)
          if (!confirmed) return
          void Promise.all(workspaceIds.map(workspaceId =>
            window.electron.workspace.removeProjectFolder(workspaceId, projectPath).catch(() => null),
          )).then(async () => {
            const listProjects = window.electron.workspace.listProjects
            if (typeof listProjects !== 'function') return
            const next = await listProjects().catch(() => null)
            if (next) setProjects(next)
          })
        },
      },
    ]
  }, [projectEntries, sessions, setSessionArchived])

  const renderSessionRow = useCallback((session: DisplaySessionEntry) => {
    // Selection must be keyed by the concrete sidebar entry, not by the
    // provider session id. Some agents reuse session ids across mirrored rows,
    // which made multiple entries look selected at once.
    const isSelected = selectedSessionKey === getSessionSelectionKey(session)
    const isStreaming =
      (session.tileId ? streamingSnapshot.tileIds.has(session.tileId) : false)
      || streamingSnapshot.entryIds.has(session.id)
    const sessionMeta = formatSessionSidebarMeta(session)
    const sessionTitleKey = getSessionTitleGenerationKey(session.workspaceId, session.id)
    const titleGeneration = getSessionTitleGenerationIndicator(generatingSessionTitleIds[sessionTitleKey] === true, sessionMeta)
    const rowMeta = titleGeneration.rowMeta
    const isGeneratingTitle = generatingSessionTitleIds[sessionTitleKey] === true
    const hasUnreadUpdate = !isSelected && hasUnreadSessionUpdate(session, sessionReadWatermarks)
    const showActivityIndicator = isStreaming || isGeneratingTitle || hasUnreadUpdate
    const isPinned = pinnedSessionKeys[getSessionActivityKey(session)] === true
    const muted = session.isArchived === true && !isSelected
    const relativeTime = formatSessionSidebarRelativeTime(session.updatedAt)
    const scheduled = isCronSession(session)
    const canOpenMiniWindow = typeof session.tileId === 'string' && session.tileId.trim().length > 0

    return (
      <SessionSidebarRow
        key={session.id}
        label={formatSessionTitleForSidebar(session.title)}
        meta={rowMeta}
        leading={
          <button
            type="button"
            title={isPinned ? 'Unpin thread' : 'Pin thread'}
            aria-label={isPinned ? 'Unpin thread' : 'Pin thread'}
            onClick={e => {
              e.stopPropagation()
              toggleSessionPinned(session)
            }}
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: isPinned ? theme.text.secondary : theme.text.disabled,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
            }}
          >
            <Pin size={15} strokeWidth={1.7} />
          </button>
        }
        leadingVisible={isPinned}
        trailing={
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: showActivityIndicator || scheduled ? 'flex-end' : 'flex-end',
            width: '100%',
            minWidth: 0,
          }}>
            {scheduled && (
              <Clock3 size={15} strokeWidth={1.7} />
            )}
            {showActivityIndicator ? (
              <SessionSidebarIndicator session={session} streaming={isStreaming || isGeneratingTitle} muted={muted} theme={theme} />
            ) : (
              <span style={{
                width: '100%',
                textAlign: 'right',
                fontSize: Math.max(11, fonts.secondarySize),
                fontWeight: 650,
                lineHeight: 1,
                color: muted ? theme.text.disabled : theme.text.disabled,
              }}>
                {relativeTime}
              </span>
            )}
          </span>
        }
        indent={Math.max(0, session.displayIndent)}
        indentUnit={6}
        extraWidth={getSessionRowExtraWidth(session.checkpointCount, canOpenMiniWindow)}
        title={`${session.title}${sessionMeta ? `\n${sessionMeta}` : ''}\n${session.sourceLabel}${session.messageCount > 0 ? ` · ${session.messageCount} msg` : ''}${(session.checkpointCount ?? 0) > 0 ? ` · ${session.checkpointCount} checkpoint${session.checkpointCount === 1 ? '' : 's'}` : ''}${session.isArchived ? ' · archived' : ''}${titleGeneration.rowTitleSuffix}`}
        active={isSelected}
        muted={muted}
        onClick={() => { openSessionFromSidebar(session) }}
        onDoubleClick={() => { openSessionFromSidebar(session, { persist: true }) }}
        onContextMenu={e => {
          e.preventDefault()
          setSessionCtx({ x: e.clientX, y: e.clientY, session })
        }}
        extra={
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            {(session.checkpointCount ?? 0) > 0 && (
              <>
                <div
                  title={`${session.checkpointCount} checkpoint${session.checkpointCount === 1 ? '' : 's'} available`}
                  style={{
                    minWidth: 18,
                    height: 18,
                    padding: '0 6px',
                    borderRadius: 999,
                    border: `1px solid ${theme.chat.assistantBubbleBorder}`,
                    background: theme.chat.assistantBubble,
                    color: theme.text.secondary,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    fontWeight: 600,
                    lineHeight: 1,
                    boxSizing: 'border-box',
                  }}
                >
                  {session.checkpointCount}
                </div>
                <button
                  title="Restore latest checkpoint"
                  onClick={e => {
                    e.stopPropagation()
                    const confirmed = window.confirm(`Restore the latest checkpoint for "${session.title}"?`)
                    if (!confirmed) return
                    void window.electron.canvas.listCheckpoints(session.workspaceId, session.id)
                      .then(checkpoints => {
                        const latest = checkpoints[0]
                        if (!latest) return null
                        return window.electron.canvas.restoreCheckpoint(session.workspaceId, latest.id, session.id)
                      })
                      .then(async result => {
                        if (!result?.ok) {
                          if (result?.error) window.alert(result.error)
                          return
                        }
                        const workspaceEntry = workspaceById.get(session.workspaceId)
                        if (workspaceEntry) await loadWorkspaceSessions(workspaceEntry, true)
                        if (session.canOpenInChat !== false) await onOpenSessionInChat(session)
                      })
                      .catch(error => {
                        window.alert(error instanceof Error ? error.message : String(error))
                      })
                  }}
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    border: 'none',
                    background: 'transparent',
                    color: theme.text.disabled,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 14 14" fill="none">
                    <path d="M3.1 4.1V1.9m0 0h2.3m-2.3 0 2 2m1.9-1.1a4.8 4.8 0 1 1-2.7 8.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </>
            )}
            {canOpenMiniWindow && (
              <button
                title="Open mini window"
                aria-label={`Open mini window for ${session.title}`}
                onClick={e => {
                  e.stopPropagation()
                  openSessionMiniFromSidebar(session)
                }}
                style={{
                  width: SESSION_ACTION_BUTTON_SIZE,
                  height: SESSION_ACTION_BUTTON_SIZE,
                  borderRadius: 7,
                  border: 'none',
                  background: 'transparent',
                  color: theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <Maximize2 size={SESSION_ACTION_ICON_SIZE} strokeWidth={1.7} />
              </button>
            )}
            <button
              title={getSessionArchiveActionLabel(session.isArchived === true)}
              onClick={e => {
                e.stopPropagation()
                handleArchiveSessionClick(session)
              }}
              disabled={archivingSessionId === session.id}
              style={{
                width: SESSION_ACTION_BUTTON_SIZE,
                height: SESSION_ACTION_BUTTON_SIZE,
                borderRadius: 7,
                border: 'none',
                background: session.isArchived === true ? theme.surface.hover : 'transparent',
                color: session.isArchived === true ? theme.text.secondary : theme.text.disabled,
                cursor: archivingSessionId === session.id ? 'default' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                opacity: archivingSessionId === session.id ? 0.5 : 1,
                flexShrink: 0,
              }}
            >
              {session.isArchived === true ? (
                <ArchiveRestore size={SESSION_ACTION_ICON_SIZE} strokeWidth={1.7} />
              ) : (
                <Archive size={SESSION_ACTION_ICON_SIZE} strokeWidth={1.7} />
              )}
            </button>
          </div>
        }
      />
    )
  }, [
    activeChatSessionEntryId,
    activeChatSessionId,
    activeChatTileId,
    archivingSessionId,
    fonts.secondarySize,
    generatingSessionTitleIds,
    handleArchiveSessionClick,
    loadWorkspaceSessions,
    onOpenSessionInChat,
    openSessionFromSidebar,
    openSessionMiniFromSidebar,
    pinnedSessionKeys,
    selectedSessionKey,
    sessionReadWatermarks,
    streamingSnapshot.entryIds,
    streamingSnapshot.tileIds,
    theme,
    toggleSessionPinned,
    workspaceById,
  ])

  return (
    <div style={{
      width: collapsed ? 0 : Math.max(width, minWidth),
      minWidth: collapsed ? 0 : minWidth,
      height: '100%',
      display: 'flex', flexDirection: 'column',
      position: 'relative', overflow: 'hidden',
      transition: 'width 0.15s ease',
      userSelect: 'none',
      WebkitUserSelect: 'none',
      fontFamily: fonts.primary,
      fontSize: fonts.size,
      fontWeight: fonts.weight,
      lineHeight: fonts.lineHeight,
    }}>
      <div
        style={{
          flexShrink: 0,
          zIndex: 2,
          padding: '16px 8px 8px',
          background: 'transparent',
          fontSize: fonts.secondarySize,
          fontWeight: fonts.secondaryWeight,
          lineHeight: fonts.secondaryLineHeight * 0.9,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SidebarTopItem
            label="New Chat"
            icon={<Pencil size={18} strokeWidth={1.9} />}
            onClick={onNewChat}
          />
          <SidebarTopItem
            label="Search"
            icon={<Search size={18} strokeWidth={1.9} />}
            onClick={openSearchPalette}
          />
          {RESOURCE_ITEMS.map(item => (
            <SidebarTopItem
              key={item.id}
              label={item.label}
              icon={item.icon}
              onClick={() => onOpenSettings(item.id)}
            />
          ))}
        </div>
      </div>

      {/* Scrollable sections */}
      <div
        ref={scrollRef}
        className="cs-fade-scroll-y cs-fade-scroll-y-lg"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', paddingTop: 6, paddingBottom: 18, userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        <div style={{ userSelect: 'none', WebkitUserSelect: 'none' }}>

        <div style={{ padding: '0 8px 10px', fontSize: fonts.secondarySize, fontWeight: fonts.secondaryWeight, lineHeight: fonts.secondaryLineHeight }}>
          {pinnedVisibleSessions.length > 0 && (
            <div style={{ padding: '0 0 14px' }}>
              <div style={{
                padding: '4px 4px 6px',
                fontSize: fonts.size + 1,
                fontWeight: 700,
                color: theme.text.disabled,
              }}>
                Pinned
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                {pinnedVisibleSessions.map(renderSessionRow)}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <span style={{
              fontSize: fonts.secondarySize - 2,
              fontWeight: 700,
              color: theme.text.disabled,
              letterSpacing: 1.2,
              textTransform: 'uppercase',
              userSelect: 'none',
              WebkitUserSelect: 'none',
            }}>
              Projects
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }} ref={threadMenuRef}>
              <button
                type="button"
                title={allProjectThreadGroupsCollapsed ? 'Reopen all projects' : 'Collapse all projects'}
                aria-label={allProjectThreadGroupsCollapsed ? 'Reopen all projects' : 'Collapse all projects'}
                onClick={toggleAllThreadGroups}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 9,
                  border: 'none',
                  background: 'transparent',
                  color: theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: 0.85,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary; e.currentTarget.style.background = theme.surface.hover }}
                onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled; e.currentTarget.style.background = 'transparent' }}
              >
                {allProjectThreadGroupsCollapsed
                  ? <Maximize2 size={16} strokeWidth={1.7} />
                  : <Minimize2 size={16} strokeWidth={1.7} />}
              </button>
              <button
                title="Filter and sort projects and threads"
                aria-label="Filter and sort projects and threads"
                onClick={() => setThreadMenuOpen(open => !open)}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 9,
                  border: 'none',
                  background: threadMenuOpen ? theme.surface.hover : 'transparent',
                  color: threadMenuOpen ? theme.text.secondary : theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: threadMenuOpen || showArchivedSessions || showCronSessions || showSubagentSessions || Object.values(hiddenSessionAgents).some(Boolean) || threadOrganizeMode !== 'project' || threadSortMode !== 'updated' ? 1 : 0.8,
                }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M2.5 4h11M4.5 8h7M6.5 12h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </button>
              <button
                title="Open project folder"
                aria-label="Open project folder"
                onClick={handleOpenProjectFromSidebar}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 9,
                  border: 'none',
                  background: 'transparent',
                  color: theme.text.disabled,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: 0.85,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
              >
                <svg width="17" height="17" viewBox="0 0 18 18" fill="none">
                  <path d="M2.75 5.25c0-1.1.9-2 2-2h2.9l1.6 1.6h4.05c1.1 0 2 .9 2 2v5.95c0 1.1-.9 2-2 2H4.75c-1.1 0-2-.9-2-2v-7.55Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
                  <path d="M13.5 2.75v4M11.5 4.75h4" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
                </svg>
              </button>
              {threadMenuOpen && (
                <SidebarMenuPortal anchorRef={threadMenuRef}>
                  <div style={{
                    width: SIDEBAR_MENU_WIDTH,
                    background: theme.surface.panelElevated,
                    border: `1px solid ${theme.border.default}`,
                    borderRadius: 14,
                    boxShadow: theme.shadow.panel,
                    padding: 6,
                  }}>
                  <ThreadMenuSectionLabel>Organize</ThreadMenuSectionLabel>
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2.5 5c0-.83.67-1.5 1.5-1.5h2.5l1.4 1.4H12c.83 0 1.5.67 1.5 1.5v5c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5V5Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /></svg>}
                    label="By project"
                    active={threadOrganizeMode === 'project'}
                    onClick={() => setThreadOrganizeMode('project')}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.1" stroke="currentColor" strokeWidth="1.25" /><path d="M8 5.2v3.3l2 1.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    label="Chronological list"
                    active={threadOrganizeMode === 'chronological'}
                    onClick={() => setThreadOrganizeMode('chronological')}
                  />
                  <div style={{ height: 1, background: theme.border.default, margin: '6px 4px' }} />
                  <ThreadMenuSectionLabel>Sort by</ThreadMenuSectionLabel>
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 12.5V6.2M3.5 6.2l-1.8 1.8M3.5 6.2 5.3 8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /><rect x="7" y="3.25" width="6" height="2" rx="1" stroke="currentColor" strokeWidth="1.15" /><rect x="7" y="7" width="4.5" height="2" rx="1" stroke="currentColor" strokeWidth="1.15" /><rect x="7" y="10.75" width="3" height="2" rx="1" stroke="currentColor" strokeWidth="1.15" /></svg>}
                    label="Updated"
                    active={threadSortMode === 'updated'}
                    onClick={() => setThreadSortMode('updated')}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 4h9M5.5 7h5M6.5 10h4M7.5 13h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>}
                    label="Title"
                    active={threadSortMode === 'title'}
                    onClick={() => setThreadSortMode('title')}
                  />
                  <div style={{ height: 1, background: theme.border.default, margin: '6px 4px' }} />
                  <ThreadMenuSectionLabel>Show</ThreadMenuSectionLabel>
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.25 4.5h9.5v7.25a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V4.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M5.5 2.75h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><path d="M6.25 7.25h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>}
                    label="Archived"
                    active={showArchivedSessions}
                    onClick={() => setShowArchivedSessions(value => !value)}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 5.1h10M3 10.9h10" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" /><path d="M4.3 5.1v2.2c0 .92.75 1.67 1.67 1.67h1.06c.92 0 1.67.75 1.67 1.67v1" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    label="Sub-threads"
                    active={showSubagentSessions}
                    onClick={() => setShowSubagentSessions(value => !value)}
                  />
                  <ThreadMenuItem
                    icon={<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.1" stroke="currentColor" strokeWidth="1.25" /><path d="M8 5.2v3.3l2 1.35" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    label="Cron jobs"
                    active={showCronSessions}
                    onClick={() => setShowCronSessions(value => !value)}
                  />
                  {availableSessionAgents.length > 0 && (
                    <>
                      <div style={{ height: 1, background: theme.border.default, margin: '6px 4px' }} />
                      <ThreadMenuSectionLabel>Agents</ThreadMenuSectionLabel>
                      {availableSessionAgents.map(agent => (
                        <ThreadMenuItem
                          key={agent.key}
                          icon={agent.icon}
                          label={agent.label}
                          active={hiddenSessionAgents[agent.key] !== true}
                          onClick={() => {
                            setHiddenSessionAgents(prev => ({
                              ...prev,
                              [agent.key]: prev[agent.key] === true ? false : true,
                            }))
                          }}
                        />
                      ))}
                    </>
                  )}
                  </div>
                </SidebarMenuPortal>
              )}
              </div>
            </div>
          </div>

          {threadOrganizeMode === 'chronological' && normalVisibleSessions.length === 0 ? (
            <div style={{ padding: '4px 0', fontSize: fonts.secondarySize, color: theme.text.disabled }}>No threads yet</div>
          ) : (
            <>
              {filteredSessionGroups.map(group => {
                const projectSessionVisibleCount = projectSessionVisibleCounts[group.key] ?? PROJECT_SESSION_PREVIEW_COUNT
                const displayedGroupSessions = threadOrganizeMode === 'project'
                  ? group.sessions.slice(0, projectSessionVisibleCount)
                  : group.sessions
                const hiddenProjectSessionCount = threadOrganizeMode === 'project'
                  ? Math.max(0, group.sessions.length - displayedGroupSessions.length)
                  : 0
                const canShowLessProjectSessions = threadOrganizeMode === 'project' && displayedGroupSessions.length > PROJECT_SESSION_PREVIEW_COUNT
                const groupCollapsed = threadOrganizeMode === 'project' && isThreadGroupCollapsed(group)
                const groupSelected = threadOrganizeMode === 'project' && group.projectId === selectedProjectId

                return (
                <div key={group.key} style={{ paddingBottom: 8 }}>
                  {threadOrganizeMode === 'project' && (
                    <div
                      onMouseEnter={() => setHoveredProjectRow(group.key)}
                      onMouseLeave={() => setHoveredProjectRow(curr => curr === group.key ? null : curr)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        width: '100%',
                        padding: '6px 4px 8px 0',
                        color: groupSelected ? theme.text.primary : theme.text.secondary,
                        background: 'transparent',
                        boxShadow: 'none',
                        borderRadius: 8,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => toggleThreadGroup(group.key)}
                        title={`${isThreadGroupCollapsed(group) ? 'Expand' : 'Collapse'} ${group.label}`}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          flex: 1,
                          minWidth: 0,
                          background: 'transparent',
                          border: 'none',
                          padding: 0,
                          color: 'inherit',
                          textAlign: 'left',
                          cursor: 'pointer',
                          userSelect: 'none',
                          WebkitUserSelect: 'none',
                        }}
                      >
                        <span
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 10,
                            color: theme.text.disabled,
                            flexShrink: 0,
                          }}
                        >
                          <svg
                            width="8"
                            height="8"
                            viewBox="0 0 8 8"
                            style={{
                              transition: 'transform 0.15s ease',
                              transform: groupCollapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                            }}
                          >
                            <path d="M2 1l4 3-4 3" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', color: theme.text.disabled, flexShrink: 0 }}>
                          <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
                            <path d="M1.8 4.1c0-.9.7-1.6 1.6-1.6h2l1.1 1.2h4.1c.9 0 1.6.7 1.6 1.6v4.4c0 .9-.7 1.6-1.6 1.6H3.4c-.9 0-1.6-.7-1.6-1.6V4.1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <span style={{
                          fontSize: fonts.size + 1,
                          fontWeight: 600,
                          color: groupSelected ? theme.text.primary : theme.text.secondary,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                          flex: 1,
                        }}>
                          {group.label}
                        </span>
                      </button>
                      <button
                        type="button"
                        title={`Project actions: ${group.label}`}
                        onClick={e => {
                          e.stopPropagation()
                          const rect = e.currentTarget.getBoundingClientRect()
                          setProjectCtx({ x: rect.right, y: rect.bottom + 4, group })
                        }}
                        style={{
                          width: 20,
                          height: 20,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: 'transparent',
                          border: 'none',
                          borderRadius: 5,
                          color: theme.text.disabled,
                          cursor: 'pointer',
                          padding: 0,
                          flexShrink: 0,
                          opacity: hoveredProjectRow === group.key ? 1 : 0,
                          transition: 'opacity 0.1s ease, background 0.1s ease, color 0.1s ease',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = theme.surface.hover; e.currentTarget.style.color = theme.text.primary }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = theme.text.disabled }}
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                          <circle cx="3.2" cy="7" r="1.05" fill="currentColor" />
                          <circle cx="7" cy="7" r="1.05" fill="currentColor" />
                          <circle cx="10.8" cy="7" r="1.05" fill="currentColor" />
                        </svg>
                      </button>
                      {onNewChatForProject && (
                        <button
                          type="button"
                          title={`New chat in ${group.label}`}
                          onClick={e => {
                            e.stopPropagation()
                            onNewChatForProject({
                              projectId: group.projectId,
                              projectPath: group.projectPath,
                              workspaceId: group.representativeWorkspaceId,
                            })
                          }}
                          style={{
                            width: 20,
                            height: 20,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: 'transparent',
                            border: 'none',
                            borderRadius: 5,
                            color: theme.text.disabled,
                            cursor: 'pointer',
                            padding: 0,
                            flexShrink: 0,
                            opacity: hoveredProjectRow === group.key ? 1 : 0,
                            transition: 'opacity 0.1s ease, background 0.1s ease, color 0.1s ease',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = theme.surface.hover; e.currentTarget.style.color = theme.text.primary }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = theme.text.disabled }}
                        >
                          <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
                            <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}

                  {threadOrganizeMode === 'project' ? (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateRows: groupCollapsed ? '0fr' : '1fr',
                        opacity: groupCollapsed ? 0 : 1,
                        transition: 'grid-template-rows 180ms ease, opacity 140ms ease',
                      }}
                    >
                      <div style={{ overflow: 'hidden', minHeight: 0 }}>
                        {displayedGroupSessions.map(renderSessionRow)}

                        {(hiddenProjectSessionCount > 0 || canShowLessProjectSessions) && (
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 12,
                              padding: '4px 0 4px 24px',
                            }}
                          >
                            {hiddenProjectSessionCount > 0 && (
                              <button
                                type="button"
                                onClick={() => setProjectSessionVisibleCounts(prev => ({
                                  ...prev,
                                  [group.key]: Math.min(
                                    group.sessions.length,
                                    (prev[group.key] ?? PROJECT_SESSION_PREVIEW_COUNT) + PROJECT_SESSION_SHOW_MORE_COUNT,
                                  ),
                                }))}
                                style={{
                                  padding: 0,
                                  border: 'none',
                                  background: 'transparent',
                                  color: theme.text.disabled,
                                  cursor: 'pointer',
                                  fontSize: fonts.secondarySize,
                                  fontFamily: 'inherit',
                                  textAlign: 'left',
                                }}
                                onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                                onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
                              >
                                Show more
                              </button>
                            )}
                            {canShowLessProjectSessions && (
                              <button
                                type="button"
                                onClick={() => setProjectSessionVisibleCounts(prev => {
                                  const next = { ...prev }
                                  delete next[group.key]
                                  return next
                                })}
                                style={{
                                  padding: 0,
                                  border: 'none',
                                  background: 'transparent',
                                  color: theme.text.disabled,
                                  cursor: 'pointer',
                                  fontSize: fonts.secondarySize,
                                  fontFamily: 'inherit',
                                  textAlign: 'left',
                                }}
                                onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                                onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
                              >
                                Show less
                              </button>
                            )}
                          </div>
                        )}

                        {group.sessions.length === 0 && (
                          <div
                            style={{
                              padding: '0 0 2px 24px',
                              fontSize: fonts.secondarySize,
                              color: theme.text.disabled,
                            }}
                          >
                            No threads yet
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    displayedGroupSessions.map(renderSessionRow)
                  )}

                </div>
                )
              })}

              {hasMoreSessions && (
                <div style={{ padding: '2px 0 0', textAlign: 'center' }}>
                  <button
                    onClick={() => setVisibleSessionCount(count => count + SESSION_PAGE_SIZE)}
                    style={{
                      padding: 0,
                      border: 'none',
                      background: 'transparent',
                      color: theme.text.disabled,
                      cursor: 'pointer',
                      fontSize: fonts.secondarySize,
                      fontFamily: 'inherit',
                      textAlign: 'center',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.color = theme.text.secondary }}
                    onMouseLeave={e => { e.currentTarget.style.color = theme.text.disabled }}
                  >
                    More ({normalVisibleSessions.length - displayedSessions.length})
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        </div>
      </div>

      {showFooter && (
        <SidebarFooter
          onNewTerminal={onNewTerminal} onNewKanban={onNewKanban} onNewBrowser={onNewBrowser}
          onNewChat={onNewChat} onNewFiles={onNewFiles}
          onOpenSettings={onOpenSettings}
          extensionTiles={extensionTiles}
          extensionEntries={extensionEntries}
          onAddExtensionTile={onAddExtensionTile}
        />
      )}

      {sessionCtx && (
        <ContextMenu x={sessionCtx.x} y={sessionCtx.y} items={sessionContextMenuItems(sessionCtx.session)} onClose={() => setSessionCtx(null)} />
      )}

      {projectCtx && (
        <ContextMenu x={projectCtx.x} y={projectCtx.y} items={projectContextMenuItems(projectCtx.group)} onClose={() => setProjectCtx(null)} />
      )}

      {textDialog && (
        <SidebarTextDialog
          state={textDialog}
          onClose={() => setTextDialog(null)}
        />
      )}

      {searchPaletteOpen && (
        <SidebarSearchPalette
          query={searchPaletteQuery}
          sessions={searchPaletteSessions}
          onQueryChange={setSearchPaletteQuery}
          onOpenSession={openSessionFromSidebar}
          onClose={() => setSearchPaletteOpen(false)}
        />
      )}

      {/* Resize handle */}
      <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 8, cursor: 'col-resize', background: 'transparent' }}
        onMouseDown={e => { resizing.current = true; startX.current = e.clientX; startWidth.current = widthRef.current; onResizeStateChange?.(true); e.preventDefault() }}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      />
    </div>
  )
}

export { SidebarFooter } from './sidebar/SidebarFooter'
