import {
  useEffect,
  useRef,
  type RefObject,
  type Dispatch,
  type SetStateAction,
  type MutableRefObject,
} from 'react'
import type { TileState, GroupState } from '../../../shared/types'
import type { CanvasViewport } from './useCanvasEngine.ts'
import {
  computeAlignmentGuides,
  filterTilesForAlignmentGuides,
  type AlignmentGuide,
} from './canvasAlignment.ts'
import { perfFlags } from '../perfFlags.ts'

export type { AlignmentGuide } from './canvasAlignment.ts'
export { ALIGN_GUIDE_THRESH, computeAlignmentGuides, filterTilesForAlignmentGuides } from './canvasAlignment.ts'

// ─── Global canvas drag listeners ─────────────────────────────────────────────

export type CanvasAnchorSide = 'top' | 'right' | 'bottom' | 'left'

export type CanvasAnchorPoint = {
  side: CanvasAnchorSide
  x: number
  y: number
  gridX: number
  gridY: number
}

type CanvasDragEngine = {
  viewport: CanvasViewport
  setViewport: Dispatch<SetStateAction<CanvasViewport>>
  /** Live gesture viewport (includes uncommitted zoom from wheel mid-pan). */
  pendingViewportRef: MutableRefObject<CanvasViewport>
  panVelocityRef: MutableRefObject<{ vx: number, vy: number }>
  panLastPos: MutableRefObject<{ x: number, y: number, t: number }>
  startPanInertia: () => void
  screenToWorld: (sx: number, sy: number) => { x: number, y: number }
  saveCanvas: (tileList: TileState[], vp: CanvasViewport, nz: number, grps?: GroupState[], beforeTiles?: TileState[]) => void
  nextZIndex: number
  applyViewportGesture: (next: CanvasViewport) => void
}

export type CanvasDragState =
  | { type: null }
  | { type: 'pan'; startX: number; startY: number; initTx: number; initTy: number }
  | { type: 'tile'; tileId: string; startX: number; startY: number; initX: number; initY: number; groupSnapshots: { id: string; x: number; y: number }[] }
  | { type: 'resize'; tileId: string; dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'; startX: number; startY: number; initX: number; initY: number; initW: number; initH: number }
  | { type: 'select'; startWx: number; startWy: number; curWx: number; curWy: number }
  | { type: 'group'; groupId: string; startX: number; startY: number; snapshots: { id: string; x: number; y: number }[]; initLayoutBounds?: { x: number; y: number; w: number; h: number } }
  | { type: 'group-resize'; groupId: string; dir: 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'; startX: number; startY: number; initBounds: { x: number; y: number; w: number; h: number }; snapshots: { id: string; x: number; y: number; width: number; height: number }[] }
  | { type: 'connection'; sourceTileId: string; startX: number; startY: number; side: CanvasAnchorSide; anchor: CanvasAnchorPoint; current: { x: number; y: number }; targetTileId: string | null }

export type UseCanvasDragSyncOptions = {
  canvasRef: RefObject<HTMLDivElement | null>
  dragState: CanvasDragState
  setDragState: Dispatch<SetStateAction<CanvasDragState>>
  engine: Pick<
    CanvasDragEngine,
    | 'viewport'
    | 'setViewport'
    | 'pendingViewportRef'
    | 'panVelocityRef'
    | 'panLastPos'
    | 'startPanInertia'
    | 'screenToWorld'
    | 'saveCanvas'
    | 'nextZIndex'
    | 'applyViewportGesture'
  >
  tilesRef: MutableRefObject<TileState[]>
  groupsRef: MutableRefObject<GroupState[]>
  groups: GroupState[]
  setTiles: Dispatch<SetStateAction<TileState[]>>
  setGroups: Dispatch<SetStateAction<GroupState[]>>
  setGuides: Dispatch<SetStateAction<AlignmentGuide[]>>
  setCanvasPointerWorld: Dispatch<SetStateAction<{ x: number; y: number } | null>>
  setSelectedTileIds: Dispatch<SetStateAction<Set<string>>>
  setSuppressedConnections: Dispatch<SetStateAction<Set<string>>>
  suppressedConnectionsRef: MutableRefObject<Set<string>>
  panelTileIdsRef: MutableRefObject<Set<string>>
  groupBoundsRef: MutableRefObject<(id: string) => { x: number; y: number; w: number; h: number } | null>
  snapValue: (value: number) => number
  resolveManualConnectionTarget: (sourceTileId: string, point: { x: number; y: number }) => string | null
  lockConnection: (tileA: string, tileB: string) => void
  triggerDiscoveryPulse: (tileId: string, tileList: TileState[]) => void
  getMinTileWidth: (tileOrType: TileState | TileState['type']) => number
  getMinTileHeight: (tileOrType: TileState | TileState['type']) => number
}

export function useCanvasDragSync(options: UseCanvasDragSyncOptions): void {
  const {
    canvasRef,
    dragState,
    setDragState,
    engine,
    tilesRef,
    groupsRef,
    groups,
    setTiles,
    setGroups,
    setGuides,
    setCanvasPointerWorld,
    setSelectedTileIds,
    setSuppressedConnections,
    suppressedConnectionsRef,
    panelTileIdsRef,
    groupBoundsRef,
    snapValue,
    resolveManualConnectionTarget,
    lockConnection,
    triggerDiscoveryPulse,
    getMinTileWidth,
    getMinTileHeight,
  } = options

  const { viewport, setViewport, pendingViewportRef, panVelocityRef, panLastPos, startPanInertia, screenToWorld, saveCanvas, nextZIndex, applyViewportGesture } = engine

  const snapGuideRafRef = useRef<number | null>(null)
  /**
   * RAF coalescing for the non-tile drag branches (resize / group / group-resize
   * / connection / select). Mirrors the pendingTileDragRef pattern below: raw
   * mousemove events can fire far above frame rate, so only the LATEST update
   * closure runs, once per animation frame. Gated on perfFlags.dragRafCoalesce.
   */
  const pendingDragFrameRef = useRef<number | null>(null)
  const pendingDragUpdateRef = useRef<(() => void) | null>(null)
  const pendingTileDragRef = useRef<{
    tileId: string
    groupSnapshots: { id: string; x: number; y: number }[]
    newX: number
    newY: number
    ddx: number
    ddy: number
    width: number
    height: number
  } | null>(null)
  /**
   * Snapshot of tile positions captured at drag START, before any setTiles
   * calls have updated tilesRef.  Passed to saveCanvas as `beforeTiles` so
   * the history diff is computed against pre-drag state (H-11 fix).
   */
  const preDragSnapshotRef = useRef<TileState[] | null>(null)

  useEffect(() => {
    // Capture the pre-drag snapshot exactly once per drag gesture (H-11 fix).
    // The effect re-runs when dragState changes; on the first non-null type the
    // snapshot is empty, so we grab tilesRef before any setTiles has fired.
    if (dragState.type !== null && preDragSnapshotRef.current === null) {
      preDragSnapshotRef.current = tilesRef.current.map(t => ({ ...t }))
    }
    if (dragState.type === null) {
      preDragSnapshotRef.current = null
    }

    // Latest-wins, once-per-frame execution for non-tile drag branches.
    // Falls back to immediate execution when the perf flag is off.
    const scheduleDragUpdate = (fn: () => void) => {
      if (!perfFlags.dragRafCoalesce) { fn(); return }
      pendingDragUpdateRef.current = fn
      if (pendingDragFrameRef.current !== null) return
      pendingDragFrameRef.current = requestAnimationFrame(() => {
        pendingDragFrameRef.current = null
        const pending = pendingDragUpdateRef.current
        pendingDragUpdateRef.current = null
        pending?.()
      })
    }
    const flushPendingDragUpdate = () => {
      if (pendingDragFrameRef.current !== null) {
        cancelAnimationFrame(pendingDragFrameRef.current)
        pendingDragFrameRef.current = null
      }
      const pending = pendingDragUpdateRef.current
      pendingDragUpdateRef.current = null
      pending?.()
    }

    const onMove = (e: MouseEvent) => {
      if (dragState.type === null) return
      // Live viewport (incl. mid-gesture zoom) — never spread closed-over
      // `viewport` state for pan/zoom math or a wheel zoom mid-pan gets stomped.
      const liveVp = pendingViewportRef.current

      if (dragState.type === 'select') {
        scheduleDragUpdate(() => {
          const rect = canvasRef.current?.getBoundingClientRect()
          if (!rect) return
          const vp = pendingViewportRef.current
          const curWx = (e.clientX - rect.left - vp.tx) / vp.zoom
          const curWy = (e.clientY - rect.top - vp.ty) / vp.zoom
          setDragState(prev => prev.type === 'select' ? { ...prev, curWx, curWy } : prev)
        })
        return
      }
      const dx = e.clientX - dragState.startX
      const dy = e.clientY - dragState.startY

      if (dragState.type === 'pan') {
        const now = performance.now()
        const dt = now - panLastPos.current.t
        if (dt > 0) {
          const decay = 0.4
          panVelocityRef.current = {
            vx: decay * panVelocityRef.current.vx + (1 - decay) * (e.clientX - panLastPos.current.x) / dt * 16,
            vy: decay * panVelocityRef.current.vy + (1 - decay) * (e.clientY - panLastPos.current.y) / dt * 16,
          }
        }
        panLastPos.current = { x: e.clientX, y: e.clientY, t: now }
        // Keep live zoom; only pan translation comes from the drag delta.
        applyViewportGesture({
          ...liveVp,
          tx: dragState.initTx + dx,
          ty: dragState.initTy + dy,
        })
      } else if (dragState.type === 'group-resize') {
        scheduleDragUpdate(() => {
          const vp = pendingViewportRef.current
          const wdx = dx / vp.zoom
          const wdy = dy / vp.zoom
          const { dir, initBounds: ib, snapshots: snaps } = dragState

          let nx = ib.x, ny = ib.y, nw = ib.w, nh = ib.h
          if (dir.includes('e')) nw = Math.max(100, ib.w + wdx)
          if (dir.includes('s')) nh = Math.max(100, ib.h + wdy)
          if (dir.includes('w')) { nw = Math.max(100, ib.w - wdx); nx = ib.x + ib.w - nw }
          if (dir.includes('n')) { nh = Math.max(100, ib.h - wdy); ny = ib.y + ib.h - nh }

          const resizingGroup = groupsRef.current.find(g => g.id === dragState.groupId)
          if (resizingGroup?.layoutMode) {
            setGroups(prev => prev.map(g => g.id === dragState.groupId
              ? { ...g, layoutBounds: { x: snapValue(nx), y: snapValue(ny), w: snapValue(nw), h: snapValue(nh) } }
              : g))
          } else {
            const scaleX = nw / ib.w
            const scaleY = nh / ib.h
            setTiles(prev => prev.map(t => {
              const s = snaps.find(s2 => s2.id === t.id)
              if (!s) return t
              const minW = getMinTileWidth(t)
              const minH = getMinTileHeight(t)
              const relX = s.x - ib.x
              const relY = s.y - ib.y
              return {
                ...t,
                x: snapValue(nx + relX * scaleX),
                y: snapValue(ny + relY * scaleY),
                width: Math.max(minW, snapValue(s.width * scaleX)),
                height: Math.max(minH, snapValue(s.height * scaleY)),
              }
            }))
          }
        })
      } else if (dragState.type === 'group') {
        scheduleDragUpdate(() => {
          const vp = pendingViewportRef.current
          const wdx = dx / vp.zoom
          const wdy = dy / vp.zoom
          if (dragState.initLayoutBounds) {
            const lb = dragState.initLayoutBounds
            setGroups(prev => prev.map(g => g.id === dragState.groupId ? {
              ...g,
              layoutBounds: { ...lb, x: snapValue(lb.x + wdx), y: snapValue(lb.y + wdy) },
            } : g))
          } else {
            setTiles(prev => prev.map(t => {
              const snap2 = dragState.snapshots.find(s => s.id === t.id)
              if (!snap2) return t
              return { ...t, x: snapValue(snap2.x + wdx), y: snapValue(snap2.y + wdy) }
            }))
          }
        })
      } else if (dragState.type === 'connection') {
        scheduleDragUpdate(() => {
          const current = screenToWorld(e.clientX, e.clientY)
          const targetTileId = resolveManualConnectionTarget(dragState.sourceTileId, current)
          setCanvasPointerWorld(current)
          setDragState(prev => prev.type === 'connection' ? { ...prev, current, targetTileId } : prev)
        })
      } else if (dragState.type === 'tile') {
        const wdx = dx / liveVp.zoom
        const wdy = dy / liveVp.zoom
        const newX = snapValue(dragState.initX + wdx)
        const newY = snapValue(dragState.initY + wdy)
        const ddx = newX - dragState.initX
        const ddy = newY - dragState.initY
        const dragging = tilesRef.current.find(t => t.id === dragState.tileId)
        if (!dragging) return

        pendingTileDragRef.current = {
          tileId: dragState.tileId,
          groupSnapshots: dragState.groupSnapshots,
          newX,
          newY,
          ddx,
          ddy,
          width: dragging.width,
          height: dragging.height,
        }
        if (snapGuideRafRef.current !== null) return
        snapGuideRafRef.current = requestAnimationFrame(() => {
          snapGuideRafRef.current = null
          const pending = pendingTileDragRef.current
          if (!pending) return

          const excludeIds = new Set([
            pending.tileId,
            ...pending.groupSnapshots.map(g => g.id),
          ])
          const candidates = tilesRef.current.filter(t => !excludeIds.has(t.id))
          const others = filterTilesForAlignmentGuides(
            pending.newX,
            pending.newY,
            pending.width,
            pending.height,
            candidates,
          )
          setGuides(computeAlignmentGuides(
            pending.newX,
            pending.newY,
            pending.width,
            pending.height,
            others,
          ))
          setTiles(prev => prev.map(t => {
            if (t.id === pending.tileId) return { ...t, x: pending.newX, y: pending.newY }
            const snap2 = pending.groupSnapshots.find(g => g.id === t.id)
            if (snap2) {
              return {
                ...t,
                x: snapValue(snap2.x + pending.ddx),
                y: snapValue(snap2.y + pending.ddy),
              }
            }
            return t
          }))
        })
      } else if (dragState.type === 'resize') {
        scheduleDragUpdate(() => {
          const vp = pendingViewportRef.current
          const wdx = dx / vp.zoom
          const wdy = dy / vp.zoom
          const dir = dragState.dir
          setTiles(prev => prev.map(t => {
            if (t.id !== dragState.tileId) return t
            const minW = getMinTileWidth(t)
            const minH = getMinTileHeight(t)
            let { x, y, width: w, height: h } = t
            if (dir.includes('e')) w = Math.max(minW, snapValue(dragState.initW + wdx))
            if (dir.includes('s')) h = Math.max(minH, snapValue(dragState.initH + wdy))
            if (dir.includes('w')) { w = Math.max(minW, snapValue(dragState.initW - wdx)); x = snapValue(dragState.initX + wdx) }
            if (dir.includes('n')) { h = Math.max(minH, snapValue(dragState.initH - wdy)); y = snapValue(dragState.initY + wdy) }
            return { ...t, x, y, width: w, height: h }
          }))
        })
      }
    }

    const flushPendingTileDrag = () => {
      if (snapGuideRafRef.current !== null) {
        cancelAnimationFrame(snapGuideRafRef.current)
        snapGuideRafRef.current = null
      }
      const pending = pendingTileDragRef.current
      if (!pending) return
      setTiles(prev => prev.map(t => {
        if (t.id === pending.tileId) return { ...t, x: pending.newX, y: pending.newY }
        const snap2 = pending.groupSnapshots.find(g => g.id === t.id)
        if (snap2) {
          return {
            ...t,
            x: snapValue(snap2.x + pending.ddx),
            y: snapValue(snap2.y + pending.ddy),
          }
        }
        return t
      }))
      pendingTileDragRef.current = null
    }

    const onUp = () => {
      // Grab the pre-drag snapshot before any async state setters fire (H-11 fix).
      const beforeTiles = preDragSnapshotRef.current ?? undefined

      // Land the final coalesced move before the release logic reads state.
      flushPendingDragUpdate()
      if (dragState.type === 'tile') flushPendingTileDrag()
      if (dragState.type === 'connection') {
        if (dragState.targetTileId) {
          lockConnection(dragState.sourceTileId, dragState.targetTileId)
        }
      } else if (dragState.type === 'tile') {
        setTiles(prev => {
          const tile = prev.find(t => t.id === dragState.tileId)
          if (!tile) { saveCanvas(prev, viewport, nextZIndex, undefined, beforeTiles); return prev }

          const didMove = tile.x !== dragState.initX || tile.y !== dragState.initY
          if (didMove && suppressedConnectionsRef.current.size > 0) {
            setSuppressedConnections(prev => {
              const next = new Set(prev)
              for (const key of prev) {
                if (key.includes(tile.id)) next.delete(key)
              }
              return next.size === prev.size ? prev : next
            })
          }
          if (!didMove) { saveCanvas(prev, viewport, nextZIndex, undefined, beforeTiles); return prev }

          const tileCx = tile.x + tile.width / 2
          const tileCy = tile.y + tile.height / 2

          let newGroupId: string | undefined = tile.groupId
          for (const g of groups) {
            if (g.id === tile.groupId) continue
            const b = groupBoundsRef.current(g.id)
            if (b && tileCx >= b.x && tileCx <= b.x + b.w && tileCy >= b.y && tileCy <= b.y + b.h) {
              newGroupId = g.id
              break
            }
          }

          if (newGroupId !== tile.groupId) {
            const updated = prev.map(t => t.id === tile.id ? { ...t, groupId: newGroupId } : t)
            saveCanvas(updated, viewport, nextZIndex, undefined, beforeTiles)
            window.setTimeout(() => triggerDiscoveryPulse(tile.id, updated), 40)
            return updated
          }
          saveCanvas(prev, viewport, nextZIndex, undefined, beforeTiles)
          window.setTimeout(() => triggerDiscoveryPulse(tile.id, prev), 40)
          return prev
        })
      } else if (dragState.type === 'resize' || dragState.type === 'group' || dragState.type === 'group-resize') {
        setTiles(prev => { saveCanvas(prev, viewport, nextZIndex, groupsRef.current, beforeTiles); return prev })
      }
      if (dragState.type === 'select') {
        const minX = Math.min(dragState.startWx, dragState.curWx)
        const maxX = Math.max(dragState.startWx, dragState.curWx)
        const minY = Math.min(dragState.startWy, dragState.curWy)
        const maxY = Math.max(dragState.startWy, dragState.curWy)
        const size = Math.max(maxX - minX, maxY - minY)
        if (size > 10) {
          setTiles(prev => {
            const hit = new Set(
              prev
                .filter(t => !panelTileIdsRef.current.has(t.id))
                .filter(t => t.x < maxX && t.x + t.width > minX && t.y < maxY && t.y + t.height > minY)
                .map(t => t.id),
            )
            setSelectedTileIds(hit)
            return prev
          })
        }
      }
      if (dragState.type === 'pan') startPanInertia()
      setGuides([])
      setDragState({ type: null })
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      if (snapGuideRafRef.current !== null) {
        cancelAnimationFrame(snapGuideRafRef.current)
        snapGuideRafRef.current = null
      }
      pendingTileDragRef.current = null
      if (pendingDragFrameRef.current !== null) {
        cancelAnimationFrame(pendingDragFrameRef.current)
        pendingDragFrameRef.current = null
      }
      pendingDragUpdateRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [
    canvasRef,
    dragState,
    setDragState,
    viewport,
    setViewport,
    applyViewportGesture,
    panVelocityRef,
    panLastPos,
    startPanInertia,
    screenToWorld,
    saveCanvas,
    nextZIndex,
    tilesRef,
    groupsRef,
    groups,
    setTiles,
    setGroups,
    setGuides,
    setCanvasPointerWorld,
    setSelectedTileIds,
    setSuppressedConnections,
    suppressedConnectionsRef,
    panelTileIdsRef,
    groupBoundsRef,
    snapValue,
    resolveManualConnectionTarget,
    lockConnection,
    triggerDiscoveryPulse,
    getMinTileWidth,
    getMinTileHeight,
  ])
}
