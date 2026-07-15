/**
 * Expanded-group, lock-connection, min-size, and locked-connection helpers.
 * Extracted from useCanvasEngine.
 */
import {
  useCallback,
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react'
import type { TileState, GroupState } from '../../../shared/types'
import type { CanvasViewport, PersistCanvasStateFn, SaveCanvasFn } from './canvasEngineMath'
import { computeFitViewport } from './canvasEngineMath'

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