/**
 * useCanvasEngine — viewport, coordinates, persistence, undo/redo, and zoom for the canvas.
 *
 * Extracted from App.tsx (TASK-W4-A). Owns canvas viewport state, world/screen
 * transforms, debounced persistence, and history stacks.
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  type RefObject,
  type Dispatch,
  type SetStateAction,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import type { TileState, GroupState, CanvasState, Workspace } from '../../../shared/types'
import type { PanelNode } from '../components/panelLayoutTree'
import type { CanvasAnchorPoint, CanvasAnchorSide, CanvasDragState } from './useCanvasDragSync.ts'
import {
  applyCanvasHistoryRedo,
  applyCanvasHistoryUndo,
  buildCanvasHistoryEntry,
  isEmptyCanvasHistoryEntry,
  type CanvasHistoryEntry,
} from './canvasHistory.ts'
import { perfFlags } from '../perfFlags.ts'

// ─── Canvas constants ───────────────────────────────────────────────────────

/** Screen-space snap padding for manual connection targets (divided by zoom at runtime). */
export const SNAP_THRESHOLD = 34

export const MIN_CANVAS_ZOOM = 0.25
export const MAX_CANVAS_ZOOM = 2
export const ZOOM_WHEEL_FACTOR_IN = 1.08
export const ZOOM_WHEEL_FACTOR_OUT = 0.92
export const CANVAS_SAVE_DEBOUNCE_MS = 500
export const HISTORY_MAX_ENTRIES = 50
export const FIT_VIEWPORT_PAD_PX = 48
export const FIT_VIEWPORT_MAX_ZOOM = 1.5
export const ARRANGE_FIT_PAD_PX = 60
export const ARRANGE_FIT_ZOOM_SCALE = 0.9

/** True when double-click should spawn a tile on empty canvas (BUG-13). */
export function shouldSpawnTileOnCanvasDoubleClick(target: { closest: (selector: string) => Element | null }): boolean {
  if (target.closest('[data-tile-chrome]')) return false
  if (target.closest('[data-canvas-group-frame]')) return false
  return true
}

export type CanvasViewport = { tx: number; ty: number; zoom: number }

export const DEFAULT_CANVAS_VIEWPORT: CanvasViewport = { tx: 0, ty: 0, zoom: 1 }

export type { CanvasHistoryEntry } from './canvasHistory.ts'

export type PersistCanvasStateFn = (
  tileList: TileState[],
  vp: CanvasViewport,
  nz: number,
  grps?: GroupState[],
) => void

export type SaveCanvasFn = (
  tileList: TileState[],
  vp: CanvasViewport,
  nz: number,
  grps?: GroupState[],
  /** Pre-drag snapshot — pass when tilesRef already holds final positions (H-11 fix). */
  beforeTiles?: TileState[],
) => void

export type CanvasEnginePersistRefs = {
  tilesRef: MutableRefObject<TileState[]>
  groupsRef: MutableRefObject<GroupState[]>
  lockedConnectionsRef: MutableRefObject<Array<{ sourceTileId: string; targetTileId: string }>>
  panelLayoutRef: MutableRefObject<PanelNode | null>
  savedLayoutRef: MutableRefObject<PanelNode | null>
  activePanelIdRef: MutableRefObject<string | null>
  expandedTileIdRef: MutableRefObject<string | null>
  expandedCanvasGroupIdRef: MutableRefObject<string | null>
  /** When true, debounced canvas persistence is deferred until drag ends. */
  canvasPersistSuspendedRef?: MutableRefObject<boolean>
}

export type UseCanvasEngineOptions = {
  workspace: Workspace | null
  canvasRef: RefObject<HTMLDivElement | null>
  tiles: TileState[]
  groups: GroupState[]
  panelLayout: PanelNode | null
  activePanelId: string | null
  expandedTileId: string | null
  persistRefs: CanvasEnginePersistRefs
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setGroups: Dispatch<SetStateAction<GroupState[]>>
  /** Optional initial viewport when restoring saved canvas state. */
  initialViewport?: CanvasViewport
  initialNextZIndex?: number
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function clampCanvasZoom(zoom: number): number {
  return Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM, zoom))
}

export function connectionSnapPadding(zoom: number): number {
  return SNAP_THRESHOLD / Math.max(MIN_CANVAS_ZOOM, zoom)
}

export function zoomAtPoint(
  viewport: CanvasViewport,
  mx: number,
  my: number,
  newZoom: number,
): CanvasViewport {
  const clamped = clampCanvasZoom(newZoom)
  const wx = (mx - viewport.tx) / viewport.zoom
  const wy = (my - viewport.ty) / viewport.zoom
  return {
    tx: mx - wx * clamped,
    ty: my - wy * clamped,
    zoom: clamped,
  }
}

export function computeFitViewport(
  bounds: { x: number; y: number; w: number; h: number },
  screen: { w: number; h: number },
): CanvasViewport {
  const availW = Math.max(1, screen.w - FIT_VIEWPORT_PAD_PX * 2)
  const availH = Math.max(1, screen.h - FIT_VIEWPORT_PAD_PX * 2)
  const zoom = Math.min(FIT_VIEWPORT_MAX_ZOOM, availW / bounds.w, availH / bounds.h)
  const tx = (screen.w - bounds.w * zoom) / 2 - bounds.x * zoom
  const ty = (screen.h - bounds.h * zoom) / 2 - bounds.y * zoom
  return { tx, ty, zoom }
}

export function computeArrangeFitViewport(
  tiles: TileState[],
  screen: { w: number; h: number },
  sidebarOffset: number,
  getArrangeWidth: (tile: TileState) => number,
): CanvasViewport | null {
  if (tiles.length === 0) return null
  const availableWidth = screen.w - sidebarOffset
  const minX = Math.min(...tiles.map(t => t.x))
  const minY = Math.min(...tiles.map(t => t.y))
  const maxX = Math.max(...tiles.map(t => t.x + getArrangeWidth(t)))
  const maxY = Math.max(...tiles.map(t => t.y + t.height))
  const fitZoom = Math.min(
    availableWidth / (maxX - minX + ARRANGE_FIT_PAD_PX * 2),
    screen.h / (maxY - minY + ARRANGE_FIT_PAD_PX * 2),
    MAX_CANVAS_ZOOM,
  )
  const newZoom = fitZoom * ARRANGE_FIT_ZOOM_SCALE
  const centerX = sidebarOffset + availableWidth / 2
  const tx = centerX - ((minX + maxX) / 2) * newZoom
  const ty = screen.h / 2 - ((minY + maxY) / 2) * newZoom
  return { tx, ty, zoom: newZoom }
}

export function computePanToTileViewport(
  tile: Pick<TileState, 'x' | 'y' | 'width' | 'height'>,
  screen: { w: number; h: number },
  currentZoom: number,
): Pick<CanvasViewport, 'tx' | 'ty'> {
  return {
    tx: screen.w / 2 - (tile.x + tile.width / 2) * currentZoom,
    ty: screen.h / 2 - (tile.y + tile.height / 2) * currentZoom,
  }
}

export function screenToWorldPoint(
  sx: number,
  sy: number,
  rect: DOMRect,
  viewport: CanvasViewport,
): { x: number; y: number } {
  return {
    x: (sx - rect.left - viewport.tx) / viewport.zoom,
    y: (sy - rect.top - viewport.ty) / viewport.zoom,
  }
}

export function worldToScreenPoint(
  point: { x: number; y: number },
  viewport: CanvasViewport,
): { x: number; y: number } {
  return {
    x: point.x * viewport.zoom + viewport.tx,
    y: point.y * viewport.zoom + viewport.ty,
  }
}

export function worldToScreenRect(
  tile: TileState,
  viewport: CanvasViewport,
): { left: number; top: number; width: number; height: number } {
  return {
    left: tile.x * viewport.zoom + viewport.tx,
    top: tile.y * viewport.zoom + viewport.ty,
    width: tile.width * viewport.zoom,
    height: tile.height * viewport.zoom,
  }
}

function buildCanvasStatePayload(
  tileList: TileState[],
  vp: CanvasViewport,
  nz: number,
  resolvedGroups: GroupState[],
  persistRefs: CanvasEnginePersistRefs,
  expandedCanvasPriorViewport: CanvasViewport | null,
): CanvasState {
  return {
    tiles: tileList,
    groups: resolvedGroups,
    viewport: vp,
    nextZIndex: nz,
    panelLayout: persistRefs.panelLayoutRef.current ?? persistRefs.savedLayoutRef.current,
    activePanelId: persistRefs.activePanelIdRef.current,
    tabViewActive: Boolean(persistRefs.panelLayoutRef.current),
    expandedTileId: persistRefs.expandedTileIdRef.current,
    expandedCanvasGroupId: persistRefs.expandedCanvasGroupIdRef.current,
    expandedCanvasPriorViewport,
    lockedConnections: persistRefs.lockedConnectionsRef.current.length > 0
      ? persistRefs.lockedConnectionsRef.current
      : undefined,
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export type UseCanvasEngineReturn = {
  viewport: CanvasViewport
  setViewport: Dispatch<SetStateAction<CanvasViewport>>
  viewportRef: MutableRefObject<CanvasViewport>
  nextZIndex: number
  setNextZIndex: Dispatch<SetStateAction<number>>
  nextZIndexRef: MutableRefObject<number>
  prevZoomRef: MutableRefObject<number>
  expandedCanvasPriorViewportRef: MutableRefObject<CanvasViewport | null>
  persistCanvasStateRef: MutableRefObject<PersistCanvasStateFn | null>
  historyBack: MutableRefObject<CanvasHistoryEntry[]>
  historyForward: MutableRefObject<CanvasHistoryEntry[]>
  skipHistory: MutableRefObject<boolean>
  panVelocityRef: MutableRefObject<{ vx: number; vy: number }>
  panLastPos: MutableRefObject<{ x: number; y: number; t: number }>
  panInertiaRaf: MutableRefObject<number>
  screenToWorld: (sx: number, sy: number) => { x: number; y: number }
  worldToScreen: (point: { x: number; y: number }) => { x: number; y: number }
  worldToScreenRect: (tile: TileState) => { left: number; top: number; width: number; height: number }
  viewportCenter: () => { x: number; y: number }
  saveCanvas: SaveCanvasFn
  persistCanvasState: PersistCanvasStateFn
  computeFitViewport: typeof computeFitViewport
  zoomToFitArrangedTiles: (
    merged: TileState[],
    getArrangeWidth: (tile: TileState) => number,
    sidebarOffset: number,
  ) => void
  panToTile: (tile: Pick<TileState, 'x' | 'y' | 'width' | 'height'>) => void
  toggleZoomOne: () => void
  resetCanvasZoom: () => void
  cancelPanInertia: () => void
  startPanInertia: () => void
  findManualConnectionTarget: (
    sourceTileId: string,
    point: { x: number; y: number },
    tiles: TileState[],
    panelTileIds: Set<string>,
    getTileCenter: (tile: TileState) => { x: number; y: number },
  ) => string | null
  restoreViewport: (saved: CanvasViewport | null | undefined) => void
  resetViewportState: () => void
  handleWheel: (e: React.WheelEvent) => void
  scheduleViewportUpdate: (nextViewport: CanvasViewport) => void
  /** Attach to the world-transform div — imperative gesture writes target it. */
  worldElRef: MutableRefObject<HTMLDivElement | null>
  /**
   * Apply a viewport change during a continuous gesture (pan / wheel zoom /
   * inertia). With the imperative-pan perf flag on, this writes the transform
   * straight to the world div every event and commits React state only on a
   * throttle; without the flag it falls back to a plain setViewport.
   */
  applyViewportGesture: (next: CanvasViewport) => void
  /** Commit the final gesture viewport to React state. Safe to call when idle. */
  endViewportGesture: () => void
  undoCanvas: () => void
  redoCanvas: () => void
  flushDeferredCanvasPersist: () => void
  /** Clear both undo and redo stacks (call on workspace switch / canvas load). */
  clearHistory: () => void
  /**
   * Immediately fire any pending debounced save for the given workspace id,
   * cancelling the scheduled timer. Call this BEFORE switching workspace so
   * the last edits for the outgoing workspace are not dropped or mis-attributed.
   */
  flushPendingSave: (workspaceId: string) => void
  /**
   * Record that the canvas state now belongs to the given workspace id.
   * The auto-save effect is gated on this matching workspace.id so that A's
   * tiles cannot be written into B's canvas.json during the switch window.
   */
  markCanvasLoaded: (id: string) => void
}

export function useCanvasEngine(options: UseCanvasEngineOptions): UseCanvasEngineReturn {
  const {
    workspace,
    canvasRef,
    tiles,
    groups,
    panelLayout,
    activePanelId,
    expandedTileId,
    persistRefs,
    setTiles,
    setGroups,
    initialViewport,
    initialNextZIndex,
  } = options

  const [viewport, setViewport] = useState<CanvasViewport>(initialViewport ?? DEFAULT_CANVAS_VIEWPORT)
  const [nextZIndex, setNextZIndex] = useState(initialNextZIndex ?? 1)

  const prevZoomRef = useRef(1)
  const panVelocityRef = useRef({ vx: 0, vy: 0 })
  const panLastPos = useRef({ x: 0, y: 0, t: 0 })
  const panInertiaRaf = useRef(0)

  const historyBack = useRef<CanvasHistoryEntry[]>([])
  const historyForward = useRef<CanvasHistoryEntry[]>([])
  const skipHistory = useRef(false)

  const viewportRef = useRef(viewport)
  const nextZIndexRef = useRef(nextZIndex)
  const viewportAnimationFrameRef = useRef<number | null>(null)
  const pendingViewportRef = useRef(viewport)
  const expandedCanvasPriorViewportRef = useRef<CanvasViewport | null>(null)
  const persistCanvasStateRef = useRef<PersistCanvasStateFn | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Dedicated timer for resetting skipHistory — must never be cleared by the persist path. */
  const skipHistoryResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPersistRef = useRef<{
    tileList: TileState[]
    vp: CanvasViewport
    nz: number
    grps: GroupState[]
  } | null>(null)
  const persistRefsRef = useRef(persistRefs)
  persistRefsRef.current = persistRefs

  /**
   * Ref-based workspace id so schedulePersistWrite can read the current id
   * without closing over the `workspace` state value. This keeps the function
   * identity stable across workspace changes (avoids identity churn in deps).
   */
  const workspaceIdRef = useRef<string | null>(workspace?.id ?? null)
  workspaceIdRef.current = workspace?.id ?? null

  /**
   * Tracks which workspace id the currently-loaded canvas state belongs to.
   * Set to null while a switch is in progress; set to the new id once the load
   * completes. The auto-save effect is gated on this matching workspace.id to
   * prevent A's tiles being written into B's canvas.json during the switch window.
   */
  const canvasLoadedForWorkspaceIdRef = useRef<string | null>(workspace?.id ?? null)

  const worldElRef = useRef<HTMLDivElement | null>(null)
  const viewportGestureActiveRef = useRef(false)
  const lastGestureCommitRef = useRef(0)
  const wheelGestureEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Keep viewport / z-index refs in sync with state. During an imperative
  // gesture the refs hold the LIVE gesture viewport (ahead of React state) —
  // don't clobber them with the throttled committed value.
  if (!viewportGestureActiveRef.current) {
    viewportRef.current = viewport
    pendingViewportRef.current = viewport
  }
  nextZIndexRef.current = nextZIndex

  const scheduleViewportUpdate = useCallback((nextVp: CanvasViewport) => {
    pendingViewportRef.current = nextVp
    if (viewportAnimationFrameRef.current !== null) return
    viewportAnimationFrameRef.current = requestAnimationFrame(() => {
      viewportAnimationFrameRef.current = null
      setViewport(pendingViewportRef.current)
    })
  }, [])

  /** Throttle for React state commits while an imperative gesture is live. */
  const GESTURE_COMMIT_INTERVAL_MS = 150

  const writeWorldTransform = useCallback((vp: CanvasViewport) => {
    const el = worldElRef.current
    if (el) el.style.transform = `translate(${vp.tx}px, ${vp.ty}px) scale(${vp.zoom})`
  }, [])

  const applyViewportGesture = useCallback((next: CanvasViewport) => {
    if (!perfFlags.imperativePan) {
      setViewport(next)
      return
    }
    viewportGestureActiveRef.current = true
    viewportRef.current = next
    pendingViewportRef.current = next
    writeWorldTransform(next)
    // Periodic state commits keep culling / minimap / overlays roughly in sync
    // during long gestures without paying a React render per pointer event.
    const now = performance.now()
    if (now - lastGestureCommitRef.current > GESTURE_COMMIT_INTERVAL_MS) {
      lastGestureCommitRef.current = now
      setViewport(next)
    }
  }, [writeWorldTransform])

  const endViewportGesture = useCallback(() => {
    if (!viewportGestureActiveRef.current) return
    viewportGestureActiveRef.current = false
    lastGestureCommitRef.current = 0
    setViewport(pendingViewportRef.current)
  }, [])

  // A throttled commit re-renders the world div with a viewport that may be a
  // few pointer events behind the last imperative write — re-apply the live
  // transform after every render while a gesture is active so the frame never
  // jumps backwards.
  useLayoutEffect(() => {
    if (viewportGestureActiveRef.current) writeWorldTransform(pendingViewportRef.current)
  })

  useEffect(() => () => {
    if (viewportAnimationFrameRef.current !== null) {
      cancelAnimationFrame(viewportAnimationFrameRef.current)
      viewportAnimationFrameRef.current = null
    }
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (skipHistoryResetTimer.current) clearTimeout(skipHistoryResetTimer.current)
    if (wheelGestureEndTimerRef.current) clearTimeout(wheelGestureEndTimerRef.current)
  }, [])

  const cancelPanInertia = useCallback(() => {
    cancelAnimationFrame(panInertiaRaf.current)
    panVelocityRef.current = { vx: 0, vy: 0 }
    // If inertia was cancelled mid-flight, commit whatever the gesture reached.
    endViewportGesture()
  }, [endViewportGesture])

  const startPanInertia = useCallback(() => {
    const { vx, vy } = panVelocityRef.current
    if (Math.abs(vx) <= 0.5 && Math.abs(vy) <= 0.5) {
      endViewportGesture()
      return
    }
    const friction = 0.92
    const animate = () => {
      const v = panVelocityRef.current
      if (Math.abs(v.vx) < 0.5 && Math.abs(v.vy) < 0.5) {
        endViewportGesture()
        return
      }
      if (perfFlags.imperativePan) {
        const cur = pendingViewportRef.current
        applyViewportGesture({ ...cur, tx: cur.tx + v.vx, ty: cur.ty + v.vy })
      } else {
        setViewport(prev => ({ ...prev, tx: prev.tx + v.vx, ty: prev.ty + v.vy }))
      }
      panVelocityRef.current = { vx: v.vx * friction, vy: v.vy * friction }
      panInertiaRaf.current = requestAnimationFrame(animate)
    }
    panInertiaRaf.current = requestAnimationFrame(animate)
  }, [applyViewportGesture, endViewportGesture])

  const schedulePersistWrite = useCallback((
    tileList: TileState[],
    vp: CanvasViewport,
    nz: number,
    resolvedGroups: GroupState[],
  ) => {
    // Use ref so this function has a stable identity (no `workspace` dep).
    // The workspace id is captured at call-time via the ref, not via closure.
    const wsId = workspaceIdRef.current
    if (!wsId) return
    const refs = persistRefsRef.current
    const priorViewport = expandedCanvasPriorViewportRef.current
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const state = buildCanvasStatePayload(
        tileList,
        vp,
        nz,
        resolvedGroups,
        refs,
        priorViewport,
      )
      window.electron.canvas.save(wsId, state)
    }, CANVAS_SAVE_DEBOUNCE_MS)
  }, [])  // stable — reads workspace id and refs via refs, never via closure

  const persistCanvasState = useCallback<PersistCanvasStateFn>((tileList, vp, nz, grps) => {
    if (!workspaceIdRef.current) return
    const refs = persistRefsRef.current
    const resolvedGroups = grps ?? refs.groupsRef.current

    if (refs.canvasPersistSuspendedRef?.current) {
      pendingPersistRef.current = { tileList, vp, nz, grps: resolvedGroups }
      return
    }

    schedulePersistWrite(tileList, vp, nz, resolvedGroups)
  }, [schedulePersistWrite])  // stable — workspace id read from ref

  const flushDeferredCanvasPersist = useCallback(() => {
    const pending = pendingPersistRef.current
    if (!pending) return
    pendingPersistRef.current = null
    schedulePersistWrite(pending.tileList, pending.vp, pending.nz, pending.grps)
  }, [schedulePersistWrite])

  /**
   * Immediately fire any pending debounced save, writing it under the given
   * workspace id. Must be called BEFORE setWorkspace() so the old id is used.
   * Cancels the pending timer so the delayed callback never fires.
   * Also drains pendingPersistRef (drag-suspend path) for the same reason.
   */
  const flushPendingSave = useCallback((oldWorkspaceId: string) => {
    if (!oldWorkspaceId) return
    // Only write if there is actually a pending save (either debounced timer or
    // drag-suspended pending). Avoid spurious writes on clean-state switches.
    const hasPendingTimer = saveTimer.current !== null
    const hasPendingDragSave = pendingPersistRef.current !== null
    if (!hasPendingTimer && !hasPendingDragSave) return

    // Cancel the debounced timer (prevent double-write after flush).
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    // Drain drag-suspended pending write.
    pendingPersistRef.current = null

    // Build and write immediately using authoritative ref values.
    const refs = persistRefsRef.current
    const tileList = refs.tilesRef.current
    const resolvedGroups = refs.groupsRef.current
    const vp = viewportRef.current
    const nz = nextZIndexRef.current
    const state = buildCanvasStatePayload(
      tileList,
      vp,
      nz,
      resolvedGroups,
      refs,
      expandedCanvasPriorViewportRef.current,
    )
    window.electron.canvas.save(oldWorkspaceId, state)
  }, [])  // stable — all reads go through refs

  /**
   * Mark that canvas state for the given workspace id has been loaded and
   * applied to React state. The auto-save effect is gated on this matching
   * workspace.id; call this after applying loaded state so saves resume.
   */
  const markCanvasLoaded = useCallback((id: string) => {
    canvasLoadedForWorkspaceIdRef.current = id
  }, [])

  const saveCanvas = useCallback<SaveCanvasFn>((tileList, vp, nz, grps, beforeTiles) => {
    if (!workspaceIdRef.current) return
    const refs = persistRefsRef.current
    const resolvedGroups = grps ?? refs.groupsRef.current

    if (!skipHistory.current) {
      // Use the explicit pre-drag snapshot when provided so that the diff is
      // computed against the state BEFORE movement, not the (already-updated)
      // tilesRef (H-11 fix).
      const historyBefore = beforeTiles ?? refs.tilesRef.current
      const entry = buildCanvasHistoryEntry(
        historyBefore,
        tileList,
        refs.groupsRef.current,
        resolvedGroups,
      )
      if (!isEmptyCanvasHistoryEntry(entry)) {
        historyBack.current.push(entry)
        if (historyBack.current.length > HISTORY_MAX_ENTRIES) historyBack.current.shift()
        historyForward.current = []
      }
    }

    persistCanvasState(tileList, vp, nz, resolvedGroups)
  }, [persistCanvasState])  // stable — workspace id read from ref

  // Read viewportRef (not viewport state) so this function's identity is stable
  // across pan frames — prevents CanvasTileItem memo from busting on every pan (medium fix).
  const screenToWorld = useCallback((sx: number, sy: number) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return screenToWorldPoint(sx, sy, rect, viewportRef.current)
  }, [canvasRef, viewportRef])

  const viewportCenter = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 200, y: 100 }
    return screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
  }, [canvasRef, screenToWorld])

  const worldToScreen = useCallback((point: { x: number; y: number }) => (
    worldToScreenPoint(point, viewportRef.current)
  ), [viewportRef])

  const worldToScreenRectBound = useCallback((tile: TileState) => (
    worldToScreenRect(tile, viewportRef.current)
  ), [viewportRef])

  const findManualConnectionTarget = useCallback((
    sourceTileId: string,
    point: { x: number; y: number },
    tileList: TileState[],
    panelTileIds: Set<string>,
    getTileCenter: (tile: TileState) => { x: number; y: number },
  ): string | null => {
    const snapPadding = connectionSnapPadding(viewportRef.current.zoom)
    const candidates = tileList
      .filter(tile => tile.id !== sourceTileId && !panelTileIds.has(tile.id))
      .filter(tile => (
        point.x >= tile.x - snapPadding
        && point.x <= tile.x + tile.width + snapPadding
        && point.y >= tile.y - snapPadding
        && point.y <= tile.y + tile.height + snapPadding
      ))
      .map(tile => ({
        tile,
        distance: Math.hypot(point.x - getTileCenter(tile).x, point.y - getTileCenter(tile).y),
      }))
      .sort((a, b) => a.distance - b.distance)
    return candidates[0]?.tile.id ?? null
  }, [])

  const restoreViewport = useCallback((saved: CanvasViewport | null | undefined) => {
    setViewport(saved
      ? { tx: saved.tx, ty: saved.ty, zoom: saved.zoom }
      : DEFAULT_CANVAS_VIEWPORT)
  }, [])

  const resetViewportState = useCallback(() => {
    setViewport(DEFAULT_CANVAS_VIEWPORT)
    setNextZIndex(1)
  }, [])

  const panToTile = useCallback((tile: Pick<TileState, 'x' | 'y' | 'width' | 'height'>) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const pan = computePanToTileViewport(tile, { w: rect.width, h: rect.height }, viewport.zoom)
    setViewport(prev => ({ ...prev, ...pan }))
  }, [canvasRef, viewport.zoom])

  const zoomToFitArrangedTiles = useCallback((
    merged: TileState[],
    getArrangeWidth: (tile: TileState) => number,
    sidebarOffset: number,
  ) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect || merged.length === 0) return
    const fit = computeArrangeFitViewport(merged, { w: rect.width, h: rect.height }, sidebarOffset, getArrangeWidth)
    if (fit) setViewport(fit)
  }, [canvasRef])

  const toggleZoomOne = useCallback(() => {
    setViewport(prev => {
      if (prev.zoom === 1) {
        return { ...prev, zoom: prevZoomRef.current !== 1 ? prevZoomRef.current : 1 }
      }
      prevZoomRef.current = prev.zoom
      return { ...prev, zoom: 1 }
    })
  }, [])

  const resetCanvasZoom = useCallback(() => {
    setViewport(prev => ({ ...prev, zoom: 1 }))
    window.electron.zoom.setLevel(0)
  }, [])

  const handleWheel = useCallback((_e: ReactWheelEvent) => {}, [])

  // Auto-save when layout metadata changes.
  // Guard: only persist when the loaded canvas state actually belongs to the
  // current workspace. During a workspace switch, canvasLoadedForWorkspaceIdRef
  // is null (cleared by flushPendingSave caller before setWorkspace) until
  // markCanvasLoaded() is called after canvas.load() completes — preventing
  // A's tiles from being written into B's canvas.json in the switch window.
  useEffect(() => {
    if (!workspace) return
    if (canvasLoadedForWorkspaceIdRef.current !== workspace.id) return
    persistCanvasState(tiles, viewport, nextZIndex, groups)
  }, [workspace, panelLayout, activePanelId, expandedTileId, persistCanvasState, tiles, viewport, nextZIndex, groups])

  // Cmd+0 reset zoom, Cmd+=/- UI zoom
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '0') {
        e.preventDefault()
        resetCanvasZoom()
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        window.electron.zoom.setLevel(window.electron.zoom.getLevel() + 0.5)
      } else if (e.key === '-') {
        e.preventDefault()
        window.electron.zoom.setLevel(window.electron.zoom.getLevel() - 0.5)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [resetCanvasZoom])

  // Wheel zoom — native listener for { passive: false }
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      const vp = viewportRef.current
      const factor = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR_IN : ZOOM_WHEEL_FACTOR_OUT
      const newZoom = clampCanvasZoom(vp.zoom * factor)
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const next = zoomAtPoint(vp, mx, my, newZoom)
      if (perfFlags.imperativePan) {
        // Wheel zoom is a continuous gesture with no natural end event — treat
        // a 160ms wheel-idle gap as the gesture end and commit then.
        applyViewportGesture(next)
        if (wheelGestureEndTimerRef.current) clearTimeout(wheelGestureEndTimerRef.current)
        wheelGestureEndTimerRef.current = setTimeout(() => {
          wheelGestureEndTimerRef.current = null
          endViewportGesture()
        }, 160)
      } else {
        setViewport(next)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [canvasRef, viewportRef, applyViewportGesture, endViewportGesture])

  const applyHistoryEntry = useCallback((
    entry: CanvasHistoryEntry,
    direction: 'undo' | 'redo',
  ) => {
    skipHistory.current = true
    const refs = persistRefsRef.current
    const currentTiles = refs.tilesRef.current
    const currentGroups = refs.groupsRef.current
    const { tiles, groups } = direction === 'undo'
      ? applyCanvasHistoryUndo(currentTiles, currentGroups, entry)
      : applyCanvasHistoryRedo(currentTiles, currentGroups, entry)
    setTiles(tiles)
    setGroups(groups)

    // Reset skipHistory on a dedicated timer — never share saveTimer so
    // schedulePersistWrite cannot cancel the reset (H-12 fix).
    if (skipHistoryResetTimer.current) clearTimeout(skipHistoryResetTimer.current)

    if (workspace) {
      // Persist via the normal save path (which reads saveTimer only).
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        const state: CanvasState = {
          tiles,
          groups,
          viewport: viewportRef.current,
          nextZIndex: nextZIndexRef.current,
        }
        window.electron.canvas.save(workspace.id, state)
      }, CANVAS_SAVE_DEBOUNCE_MS)
    }

    // Reset the skip flag after state has flushed — use a separate timer that
    // the persist path (clearTimeout(saveTimer)) can never touch.
    skipHistoryResetTimer.current = setTimeout(() => {
      skipHistoryResetTimer.current = null
      skipHistory.current = false
    }, 0)
  }, [workspace, setTiles, setGroups])

  const undoCanvas = useCallback(() => {
    if (historyBack.current.length === 0) return
    const entry = historyBack.current.pop()!
    historyForward.current.push(entry)
    applyHistoryEntry(entry, 'undo')
  }, [applyHistoryEntry])

  const redoCanvas = useCallback(() => {
    if (historyForward.current.length === 0) return
    const entry = historyForward.current.pop()!
    historyBack.current.push(entry)
    if (historyBack.current.length > HISTORY_MAX_ENTRIES) historyBack.current.shift()
    applyHistoryEntry(entry, 'redo')
  }, [applyHistoryEntry])

  /** Clear both stacks when a new canvas is loaded to prevent cross-workspace replay (H-3). */
  const clearHistory = useCallback(() => {
    historyBack.current = []
    historyForward.current = []
  }, [])

  persistCanvasStateRef.current = persistCanvasState

  return {
    viewport,
    setViewport,
    viewportRef,
    nextZIndex,
    setNextZIndex,
    nextZIndexRef,
    prevZoomRef,
    expandedCanvasPriorViewportRef,
    persistCanvasStateRef,
    historyBack,
    historyForward,
    skipHistory,
    panVelocityRef,
    panLastPos,
    panInertiaRaf,
    screenToWorld,
    worldToScreen,
    worldToScreenRect: worldToScreenRectBound,
    viewportCenter,
    saveCanvas,
    persistCanvasState,
    computeFitViewport,
    zoomToFitArrangedTiles,
    panToTile,
    toggleZoomOne,
    resetCanvasZoom,
    cancelPanInertia,
    startPanInertia,
    findManualConnectionTarget,
    restoreViewport,
    resetViewportState,
    handleWheel,
    scheduleViewportUpdate,
    worldElRef,
    applyViewportGesture,
    endViewportGesture,
    undoCanvas,
    redoCanvas,
    flushDeferredCanvasPersist,
    clearHistory,
    flushPendingSave,
    markCanvasLoaded,
  }
}

export {
  ALIGN_GUIDE_THRESH,
  computeAlignmentGuides,
  useCanvasDragSync,
  type AlignmentGuide,
  type CanvasAnchorPoint,
  type CanvasAnchorSide,
  type CanvasDragState,
  type UseCanvasDragSyncOptions,
} from './useCanvasDragSync.ts'

// ─── Canvas surface mouse handlers ───────────────────────────────────────────

export type UseCanvasPointerHandlersOptions = {
  canvasRef: RefObject<HTMLDivElement | null>
  viewport: CanvasViewport
  setDragState: Dispatch<SetStateAction<CanvasDragState>>
  setSelectedTileId: Dispatch<SetStateAction<string | null>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  panLastPos: MutableRefObject<{ x: number; y: number; t: number }>
  cancelPanInertia: () => void
  screenToWorld: (sx: number, sy: number) => { x: number; y: number }
  spaceHeld: MutableRefObject<boolean>
  bringToFront: (id: string) => void
  getConnectionHandlePoint: (tile: TileState, side: CanvasAnchorSide) => CanvasAnchorPoint
  panelLayout: PanelNode | null
  addTile: (type: TileState['type'], filePath?: string, pos?: { x: number; y: number }) => string
}

export function useCanvasPointerHandlers(options: UseCanvasPointerHandlersOptions) {
  const {
    canvasRef,
    viewport,
    setDragState,
    setSelectedTileId,
    setSelectedTileIds,
    panLastPos,
    cancelPanInertia,
    screenToWorld,
    spaceHeld,
    bringToFront,
    getConnectionHandlePoint,
    panelLayout,
    addTile,
  } = options

  const handleCanvasMouseDown = useCallback((e: ReactMouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest('[data-tile-chrome]')) return
    e.preventDefault()
    const isPan = e.button === 1 || (e.button === 0 && (e.metaKey || spaceHeld.current))
    if (isPan) {
      cancelPanInertia()
      panLastPos.current = { x: e.clientX, y: e.clientY, t: performance.now() }
      setDragState({ type: 'pan', startX: e.clientX, startY: e.clientY, initTx: viewport.tx, initTy: viewport.ty })
      setSelectedTileId(null)
      return
    }
    if (e.button === 0) {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const wx = (e.clientX - rect.left - viewport.tx) / viewport.zoom
      const wy = (e.clientY - rect.top - viewport.ty) / viewport.zoom
      setDragState({ type: 'select', startWx: wx, startWy: wy, curWx: wx, curWy: wy })
      setSelectedTileIds(new Set())
      setSelectedTileId(null)
    }
  }, [canvasRef, viewport, setDragState, setSelectedTileId, setSelectedTileIds, panLastPos, cancelPanInertia, spaceHeld])

  const handleConnectionMouseDown = useCallback((
    e: ReactMouseEvent,
    tile: TileState,
    side: CanvasAnchorSide,
  ) => {
    e.stopPropagation()
    e.preventDefault()
    bringToFront(tile.id)
    const anchor = getConnectionHandlePoint(tile, side)
    setDragState({
      type: 'connection',
      sourceTileId: tile.id,
      startX: e.clientX,
      startY: e.clientY,
      side,
      anchor,
      current: screenToWorld(e.clientX, e.clientY),
      targetTileId: null,
    })
  }, [bringToFront, getConnectionHandlePoint, screenToWorld, setDragState])

  const handleResizeMouseDown = useCallback((
    e: ReactMouseEvent,
    tile: TileState,
    dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw',
  ) => {
    e.stopPropagation()
    e.preventDefault()
    setDragState({
      type: 'resize',
      tileId: tile.id,
      dir,
      startX: e.clientX,
      startY: e.clientY,
      initX: tile.x,
      initY: tile.y,
      initW: tile.width,
      initH: tile.height,
    })
  }, [setDragState])

  const handleCanvasDoubleClick = useCallback((e: ReactMouseEvent) => {
    if (panelLayout) return
    const target = e.target as HTMLElement
    if (!shouldSpawnTileOnCanvasDoubleClick(target)) return
    const world = screenToWorld(e.clientX, e.clientY)
    addTile('terminal', undefined, world)
  }, [panelLayout, screenToWorld, addTile])

  const handleTileMouseDown = useCallback((e: ReactMouseEvent, tile: TileState) => {
    e.stopPropagation()
    bringToFront(tile.id)
    setDragState({
      type: 'tile',
      tileId: tile.id,
      startX: e.clientX,
      startY: e.clientY,
      initX: tile.x,
      initY: tile.y,
      groupSnapshots: [],
    })
  }, [bringToFront, setDragState])

  return {
    handleCanvasMouseDown,
    handleConnectionMouseDown,
    handleResizeMouseDown,
    handleCanvasDoubleClick,
    handleTileMouseDown,
  }
}

export type UseConnectionHandleHoverOptions = {
  setHoveredConnectionHandle: Dispatch<SetStateAction<{ tileId: string; side: CanvasAnchorSide } | null>>
}

export function useConnectionHandleHover(options: UseConnectionHandleHoverOptions) {
  const { setHoveredConnectionHandle } = options
  const connectionHandleHideTimerRef = useRef<number | null>(null)

  const showConnectionHandleForSide = useCallback((tileId: string, side: CanvasAnchorSide) => {
    if (connectionHandleHideTimerRef.current !== null) {
      window.clearTimeout(connectionHandleHideTimerRef.current)
      connectionHandleHideTimerRef.current = null
    }
    setHoveredConnectionHandle({ tileId, side })
  }, [setHoveredConnectionHandle])

  const scheduleConnectionHandleHide = useCallback((tileId: string, side: CanvasAnchorSide) => {
    if (connectionHandleHideTimerRef.current !== null) {
      window.clearTimeout(connectionHandleHideTimerRef.current)
    }
    connectionHandleHideTimerRef.current = window.setTimeout(() => {
      connectionHandleHideTimerRef.current = null
      setHoveredConnectionHandle(prev => prev?.tileId === tileId && prev.side === side ? null : prev)
    }, 140)
  }, [setHoveredConnectionHandle])

  useEffect(() => () => {
    if (connectionHandleHideTimerRef.current !== null) {
      window.clearTimeout(connectionHandleHideTimerRef.current)
      connectionHandleHideTimerRef.current = null
    }
  }, [])

  return { showConnectionHandleForSide, scheduleConnectionHandleHide }
}

export type CanvasContextMenuItem = {
  label: string
  action: () => void
  divider?: boolean
  danger?: boolean
}

export type UseCanvasContextMenuOptions = {
  screenToWorld: (sx: number, sy: number) => { x: number; y: number }
  panelLayout: PanelNode | null
  groups: GroupState[]
  groupBoundsRef: MutableRefObject<(id: string) => { x: number; y: number; w: number; h: number } | null>
  addTile: (type: TileState['type'], filePath?: string, pos?: { x: number; y: number }) => string
  pinnedCanvasExtensionTiles: Array<{ type: string; label: string }>
  clipboardRef: MutableRefObject<TileState[]>
  pasteAt: (pos: { x: number; y: number }, groupId?: string) => void
  selectedTileIds: Set<string>
  groupSelectedTiles: () => void
  setCtxMenu: Dispatch<SetStateAction<{ x: number; y: number; items: CanvasContextMenuItem[] } | null>>
}

export function useCanvasContextMenu(options: UseCanvasContextMenuOptions) {
  const {
    screenToWorld,
    panelLayout,
    groups,
    groupBoundsRef,
    addTile,
    pinnedCanvasExtensionTiles,
    clipboardRef,
    pasteAt,
    selectedTileIds,
    groupSelectedTiles,
    setCtxMenu,
  } = options

  return useCallback((e: ReactMouseEvent) => {
    e.preventDefault()
    if (panelLayout) return
    const world = screenToWorld(e.clientX, e.clientY)
    const hitGroup = groups.find(g => {
      const b = groupBoundsRef.current(g.id)
      return b && world.x >= b.x && world.x <= b.x + b.w && world.y >= b.y && world.y <= b.y + b.h
    })
    const items: CanvasContextMenuItem[] = [
      { label: 'New Terminal', action: () => addTile('terminal', undefined, world) },
      { label: 'New Note', action: () => addTile('note', undefined, world) },
      { label: 'New Browser', action: () => addTile('browser', undefined, world) },
      { label: 'New Board', action: () => addTile('kanban', undefined, world) },
    ]
    if (pinnedCanvasExtensionTiles.length > 0) {
      items.push({ label: '', action: () => {}, divider: true })
      for (const ext of pinnedCanvasExtensionTiles) {
        items.push({
          label: ext.label,
          action: () => addTile(ext.type as TileState['type'], undefined, world),
        })
      }
    }
    if (clipboardRef.current.length > 0) {
      items.push({ label: '', action: () => {}, divider: true })
      items.push({ label: 'Paste', action: () => pasteAt(world) })
      if (hitGroup) {
        items.push({ label: 'Paste into group', action: () => pasteAt(world, hitGroup.id) })
      }
    }
    if (selectedTileIds.size >= 2) {
      items.push({ label: '', action: () => {}, divider: true })
      items.push({ label: `Group ${selectedTileIds.size} blocks`, action: () => groupSelectedTiles() })
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }, [
    screenToWorld,
    panelLayout,
    groups,
    groupBoundsRef,
    addTile,
    pinnedCanvasExtensionTiles,
    clipboardRef,
    pasteAt,
    selectedTileIds,
    groupSelectedTiles,
    setCtxMenu,
  ])
}

export type UseTileContextMenuOptions = {
  viewport: CanvasViewport
  nextZIndex: number
  groups: GroupState[]
  workspacePath: string | null | undefined
  saveCanvas: SaveCanvasFn
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setSelectedTileId: Dispatch<SetStateAction<string | null>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  setCtxMenu: Dispatch<SetStateAction<{ x: number; y: number; items: CanvasContextMenuItem[] } | null>>
  clipboardRef: MutableRefObject<TileState[]>
  duplicateTiles: (ids: string[]) => void
  copyTiles: (cut: boolean) => void
  pasteTiles: (pos?: { x: number; y: number }, groupId?: string) => void
  ungroupTiles: (groupId: string) => void
  ungroupAll: (groupId: string) => void
  closeTile: (id: string) => void
  importFileToWorkspace: (filePath: string, tileId: string) => void | Promise<unknown>
}

export function useTileContextMenu(options: UseTileContextMenuOptions) {
  const {
    viewport,
    nextZIndex,
    groups,
    workspacePath,
    saveCanvas,
    setTiles,
    setSelectedTileId,
    setSelectedTileIds,
    setCtxMenu,
    clipboardRef,
    duplicateTiles,
    copyTiles,
    pasteTiles,
    ungroupTiles,
    ungroupAll,
    closeTile,
    importFileToWorkspace,
  } = options

  return useCallback((e: ReactMouseEvent, tile: TileState) => {
    e.preventDefault()
    e.stopPropagation()
    const items: CanvasContextMenuItem[] = [
      { label: 'Duplicate', action: () => duplicateTiles([tile.id]) },
      { label: 'Copy', action: () => { setSelectedTileId(tile.id); setSelectedTileIds(new Set()); copyTiles(false) } },
      { label: 'Cut', action: () => { setSelectedTileId(tile.id); setSelectedTileIds(new Set()); copyTiles(true) } },
    ]
    if (clipboardRef.current.length > 0) {
      items.push({ label: '', action: () => {}, divider: true })
      items.push({ label: 'Paste', action: () => pasteTiles() })
      if (tile.groupId) {
        items.push({ label: 'Paste into this group', action: () => pasteTiles(undefined, tile.groupId) })
      }
    }
    items.push({ label: '', action: () => {}, divider: true })
    if (tile.groupId) {
      items.push({ label: 'Remove from group', action: () => {
        setTiles(prev => {
          const updated = prev.map(t => t.id === tile.id ? { ...t, groupId: undefined } : t)
          saveCanvas(updated, viewport, nextZIndex)
          return updated
        })
      } })
      items.push({ label: 'Ungroup', action: () => ungroupTiles(tile.groupId!) })
      items.push({ label: 'Ungroup All', action: () => ungroupAll(tile.groupId!) })
      items.push({ label: '', action: () => {}, divider: true })
    }
    const availableGroups = groups.filter(g => g.id !== tile.groupId)
    if (availableGroups.length > 0) {
      availableGroups.forEach(g => {
        items.push({
          label: `Add to ${g.label ?? g.id.slice(-6)}`,
          action: () => {
            setTiles(prev => {
              const updated = prev.map(t => t.id === tile.id ? { ...t, groupId: g.id } : t)
              saveCanvas(updated, viewport, nextZIndex)
              return updated
            })
          },
        })
      })
      items.push({ label: '', action: () => {}, divider: true })
    }
    if (tile.type === 'file' && tile.filePath && workspacePath && !tile.filePath.startsWith(workspacePath)) {
      items.push({
        label: 'Add to workspace',
        action: () => { void importFileToWorkspace(tile.filePath!, tile.id) },
      })
      items.push({ label: '', action: () => {}, divider: true })
    }
    const currentlyChromeless = !!tile.hideTitlebar || !!tile.hideNavbar
    items.push({
      label: currentlyChromeless ? 'Show Controls' : 'Hide Controls',
      action: () => {
        setTiles(prev => {
          const updated = prev.map(t => t.id === tile.id
            ? { ...t, hideTitlebar: !currentlyChromeless, hideNavbar: !currentlyChromeless }
            : t)
          saveCanvas(updated, viewport, nextZIndex)
          return updated
        })
      },
    })
    items.push({ label: '', action: () => {}, divider: true })
    items.push({ label: 'Close', action: () => closeTile(tile.id), danger: true })
    setCtxMenu({ x: e.clientX, y: e.clientY, items })
  }, [
    viewport,
    nextZIndex,
    groups,
    workspacePath,
    saveCanvas,
    setTiles,
    setSelectedTileId,
    setSelectedTileIds,
    setCtxMenu,
    clipboardRef,
    duplicateTiles,
    copyTiles,
    pasteTiles,
    ungroupTiles,
    ungroupAll,
    closeTile,
    importFileToWorkspace,
  ])
}

export type UseCanvasExpandedGroupOptions = {
  canvasRef: RefObject<HTMLDivElement | null>
  viewportRef: MutableRefObject<CanvasViewport>
  expandedCanvasPriorViewportRef: MutableRefObject<CanvasViewport | null>
  expandedCanvasGroupIdRef: MutableRefObject<string | null>
  groupsRef: MutableRefObject<GroupState[]>
  setViewport: Dispatch<SetStateAction<CanvasViewport>>
  setExpandedCanvasGroupId: Dispatch<SetStateAction<string | null>>
  setExpandedTileId: Dispatch<SetStateAction<string | null>>
  groupBounds: (groupId: string) => { x: number; y: number; w: number; h: number } | null
}

export function useCanvasExpandedGroup(options: UseCanvasExpandedGroupOptions) {
  const {
    canvasRef,
    viewportRef,
    expandedCanvasPriorViewportRef,
    expandedCanvasGroupIdRef,
    groupsRef,
    setViewport,
    setExpandedCanvasGroupId,
    setExpandedTileId,
    groupBounds,
  } = options

  const enterCanvasExpanded = useCallback((groupId: string) => {
    const g = groupsRef.current.find(gr => gr.id === groupId)
    if (!g || g.layoutMode) return
    const bounds = groupBounds(groupId)
    if (!bounds) return
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    expandedCanvasPriorViewportRef.current = { ...viewportRef.current }
    const fit = computeFitViewport(bounds, { w: rect.width, h: rect.height })
    setViewport(fit)
    viewportRef.current = fit
    setExpandedCanvasGroupId(groupId)
    expandedCanvasGroupIdRef.current = groupId
    setExpandedTileId(null)
  }, [
    canvasRef,
    viewportRef,
    expandedCanvasPriorViewportRef,
    expandedCanvasGroupIdRef,
    groupsRef,
    setViewport,
    setExpandedCanvasGroupId,
    setExpandedTileId,
    groupBounds,
  ])

  const exitCanvasExpanded = useCallback(() => {
    const prior = expandedCanvasPriorViewportRef.current
    setExpandedCanvasGroupId(null)
    expandedCanvasGroupIdRef.current = null
    if (prior) {
      setViewport(prior)
      viewportRef.current = prior
    }
    expandedCanvasPriorViewportRef.current = null
  }, [
    expandedCanvasPriorViewportRef,
    expandedCanvasGroupIdRef,
    setViewport,
    viewportRef,
    setExpandedCanvasGroupId,
  ])

  return { enterCanvasExpanded, exitCanvasExpanded }
}

export type UseLockConnectionOptions = {
  persistCanvasState: PersistCanvasStateFn
  tilesRef: MutableRefObject<TileState[]>
  groupsRef: MutableRefObject<GroupState[]>
  viewportRef: MutableRefObject<CanvasViewport>
  nextZIndexRef: MutableRefObject<number>
  lockedConnectionsRef: MutableRefObject<Array<{ sourceTileId: string; targetTileId: string }>>
  setLockedConnections: Dispatch<SetStateAction<Array<{ sourceTileId: string; targetTileId: string }>>>
  setSuppressedConnections: Dispatch<SetStateAction<Set<string>>>
}

export function useLockConnection(options: UseLockConnectionOptions) {
  const {
    persistCanvasState,
    tilesRef,
    groupsRef,
    viewportRef,
    nextZIndexRef,
    lockedConnectionsRef,
    setLockedConnections,
    setSuppressedConnections,
  } = options

  return useCallback((tileA: string, tileB: string) => {
    const [a, b] = [tileA, tileB].sort()
    if (a === b) return
    setSuppressedConnections(prev => {
      const next = new Set(prev)
      next.delete(`${a}::${b}`)
      return next
    })
    setLockedConnections(prev => {
      const alreadyLocked = prev.some(lc => {
        const [la, lb] = [lc.sourceTileId, lc.targetTileId].sort()
        return la === a && lb === b
      })
      if (alreadyLocked) return prev
      const next = [...prev, { sourceTileId: a, targetTileId: b }]
      lockedConnectionsRef.current = next
      setTimeout(() => persistCanvasState(tilesRef.current, viewportRef.current, nextZIndexRef.current, groupsRef.current), 0)
      return next
    })
  }, [
    persistCanvasState,
    tilesRef,
    groupsRef,
    viewportRef,
    nextZIndexRef,
    lockedConnectionsRef,
    setLockedConnections,
    setSuppressedConnections,
  ])
}

export type UseEnforceTileMinimumSizesOptions = {
  tiles: TileState[]
  viewport: CanvasViewport
  nextZIndex: number
  saveCanvas: SaveCanvasFn
  setTiles: Dispatch<SetStateAction<TileState[]>>
  getMinTileWidth: (tileOrType: TileState | TileState['type']) => number
  getMinTileHeight: (tileOrType: TileState | TileState['type']) => number
}

export function useEnforceTileMinimumSizes(options: UseEnforceTileMinimumSizesOptions): void {
  const { tiles, viewport, nextZIndex, saveCanvas, setTiles, getMinTileWidth, getMinTileHeight } = options

  useEffect(() => {
    if (!tiles.some(tile => tile.width < getMinTileWidth(tile) || tile.height < getMinTileHeight(tile))) return
    setTiles(prev => {
      let changed = false
      const updated = prev.map(tile => {
        const minW = getMinTileWidth(tile)
        const minH = getMinTileHeight(tile)
        if (tile.width >= minW && tile.height >= minH) return tile
        changed = true
        return {
          ...tile,
          width: Math.max(tile.width, minW),
          height: Math.max(tile.height, minH),
        }
      })
      if (!changed) return prev
      saveCanvas(updated, viewport, nextZIndex)
      return updated
    })
  }, [tiles, viewport, nextZIndex, saveCanvas, setTiles, getMinTileWidth, getMinTileHeight])
}

export type UseLockedConnectionHelpersOptions = {
  lockedConnections: Array<{ sourceTileId: string; targetTileId: string }>
  persistCanvasState: PersistCanvasStateFn
  tilesRef: MutableRefObject<TileState[]>
  groupsRef: MutableRefObject<GroupState[]>
  viewportRef: MutableRefObject<CanvasViewport>
  nextZIndexRef: MutableRefObject<number>
  lockedConnectionsRef: MutableRefObject<Array<{ sourceTileId: string; targetTileId: string }>>
  setLockedConnections: Dispatch<SetStateAction<Array<{ sourceTileId: string; targetTileId: string }>>>
  setSuppressedConnections: Dispatch<SetStateAction<Set<string>>>
}

export function useLockedConnectionHelpers(options: UseLockedConnectionHelpersOptions) {
  const {
    lockedConnections,
    persistCanvasState,
    tilesRef,
    groupsRef,
    viewportRef,
    nextZIndexRef,
    lockedConnectionsRef,
    setLockedConnections,
    setSuppressedConnections,
  } = options

  const isConnectionLocked = useCallback((tileA: string, tileB: string) => {
    const [a, b] = [tileA, tileB].sort()
    return lockedConnections.some(lc => {
      const [la, lb] = [lc.sourceTileId, lc.targetTileId].sort()
      return la === a && lb === b
    })
  }, [lockedConnections])

  const toggleConnectionLock = useCallback((tileA: string, tileB: string) => {
    const [a, b] = [tileA, tileB].sort()
    setLockedConnections(prev => {
      const idx = prev.findIndex(lc => {
        const [la, lb] = [lc.sourceTileId, lc.targetTileId].sort()
        return la === a && lb === b
      })
      const next = idx >= 0
        ? prev.filter((_, i) => i !== idx)
        : [...prev, { sourceTileId: a, targetTileId: b }]
      lockedConnectionsRef.current = next
      console.log('[Lock]', idx >= 0 ? 'Unlocked' : 'Locked', a, b, 'total:', next.length)
      setTimeout(() => persistCanvasState(tilesRef.current, viewportRef.current, nextZIndexRef.current, groupsRef.current), 0)
      return next
    })
  }, [persistCanvasState, tilesRef, groupsRef, viewportRef, nextZIndexRef, lockedConnectionsRef, setLockedConnections])

  const deleteConnection = useCallback((tileA: string, tileB: string) => {
    const [a, b] = [tileA, tileB].sort()
    const key = `${a}::${b}`
    setLockedConnections(prev => {
      const next = prev.filter(lc => {
        const [la, lb] = [lc.sourceTileId, lc.targetTileId].sort()
        return !(la === a && lb === b)
      })
      lockedConnectionsRef.current = next
      setTimeout(() => persistCanvasState(tilesRef.current, viewportRef.current, nextZIndexRef.current, groupsRef.current), 0)
      return next
    })
    setSuppressedConnections(prev => new Set(prev).add(key))
  }, [persistCanvasState, tilesRef, groupsRef, viewportRef, nextZIndexRef, lockedConnectionsRef, setLockedConnections, setSuppressedConnections])

  return { isConnectionLocked, toggleConnectionLock, deleteConnection }
}