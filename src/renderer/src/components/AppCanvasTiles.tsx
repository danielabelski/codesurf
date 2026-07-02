import React from 'react'
import type { TileState } from '../../../shared/types'
import type { AppTheme } from '../theme'
import type { CanvasDragState } from '../hooks/useCanvasEngine'
import type { NegotiatedDiscoveryState } from '../hooks/useNegotiatedDiscovery'
import type { RenderTileBodyOptions } from '../hooks/useRenderTileBody'
import type { AnchorPoint } from '../lib/discoveryRuntime'
import { CanvasTileItem } from './canvas/CanvasTileItem'
import { perfFlags, CANVAS_LOD_ZOOM } from '../perfFlags'
import { isTileOffscreen, isHeavyTileType } from '../lib/canvasCulling'

type ResizeDir = 'e' | 's' | 'se' | 'w' | 'n' | 'nw' | 'ne' | 'sw'
type Side = AnchorPoint['side']

export type ExpandedCanvasMembership = {
  tileIds: Set<string>
  groupIds: Set<string>
}

export type AppCanvasTilesProps = {
  tiles: TileState[]
  panelTileIds: Set<string>
  expandedCanvasMembership: ExpandedCanvasMembership | null
  dragState: CanvasDragState
  viewport: { tx: number, ty: number, zoom: number }
  canvasPointerWorld: { x: number, y: number } | null
  theme: AppTheme
  dsc: { line: string, dot: string, bg: string, text: string }
  workspaceId?: string
  workspaceDir?: string
  selectedTileId: string | null
  selectedTileIds: Set<string>
  negotiatedDiscoveryState: NegotiatedDiscoveryState
  onCloseTile: (tileId: string) => void
  onBringToFront: (tileId: string) => void
  onTitlebarMouseDown: (event: React.MouseEvent, tile: TileState) => void
  onResizeMouseDown: (event: React.MouseEvent, tile: TileState, dir: ResizeDir) => void
  onContextMenu: (event: React.MouseEvent, tile: TileState) => void
  onEnterExpandedMode: (tileId: string) => void
  onExitExpandedMode: () => void
  onConnectionMouseDown: (event: React.MouseEvent, tile: TileState, side: AnchorPoint['side']) => void
  showConnectionHandleForSide: (tileId: string, side: AnchorPoint['side']) => void
  scheduleConnectionHandleHide: (tileId: string, side: AnchorPoint['side']) => void
  hoveredConnectionHandle: { tileId: string, side: AnchorPoint['side'] } | null
  setCanvasPointerWorld: React.Dispatch<React.SetStateAction<{ x: number, y: number } | null>>
  screenToWorld: (clientX: number, clientY: number) => { x: number, y: number }
  renderTileBody: (tile: TileState, options?: RenderTileBodyOptions) => React.ReactNode
}

export function filterVisibleCanvasTiles(
  tiles: TileState[],
  panelTileIds: Set<string>,
  expandedCanvasMembership: ExpandedCanvasMembership | null,
): TileState[] {
  return tiles
    .filter(tile => !panelTileIds.has(tile.id))
    .filter(tile => !expandedCanvasMembership || expandedCanvasMembership.tileIds.has(tile.id))
}

const EMPTY_PEERS: string[] = []

export function AppCanvasTiles(props: AppCanvasTilesProps): JSX.Element {
  const {
    tiles,
    panelTileIds,
    expandedCanvasMembership,
    dragState,
    viewport,
    theme,
    dsc,
    workspaceId,
    workspaceDir,
    selectedTileId,
    selectedTileIds,
    negotiatedDiscoveryState,
    onCloseTile,
    onBringToFront,
    onTitlebarMouseDown,
    onResizeMouseDown,
    onContextMenu,
    onEnterExpandedMode,
    onExitExpandedMode,
    onConnectionMouseDown,
    showConnectionHandleForSide,
    scheduleConnectionHandleHide,
    hoveredConnectionHandle,
    setCanvasPointerWorld,
    screenToWorld,
    renderTileBody,
  } = props

  const visibleTiles = filterVisibleCanvasTiles(tiles, panelTileIds, expandedCanvasMembership)
  const connectionDragActive = dragState.type === 'connection'
  // Perf: viewport culling + zoom LOD are computed per commit (not per pointer
  // event — imperative gestures throttle commits), so this stays cheap.
  const cullingOn = perfFlags.viewportCulling
  const lodActive = perfFlags.zoomLod && viewport.zoom < CANVAS_LOD_ZOOM
  const screenW = typeof window !== 'undefined' ? window.innerWidth : 1920
  const screenH = typeof window !== 'undefined' ? window.innerHeight : 1080

  // Only cheap, per-tile *scalars* are computed here. The expensive part — the tile
  // chrome, body (Monaco/terminal/browser), link sensors and handle — lives in the
  // memoized CanvasTileItem, so an interaction that changes one tile's flags only
  // re-renders that tile, not all of them.
  return (
    <>
      {visibleTiles.map(tile => {
        const isActiveDrag =
          (dragState.type === 'tile' && (dragState.tileId === tile.id || dragState.groupSnapshots.some(s => s.id === tile.id))) ||
          (dragState.type === 'resize' && dragState.tileId === tile.id) ||
          ((dragState.type === 'group' || dragState.type === 'group-resize') && tile.groupId === dragState.groupId)
        const isConnectionSource = dragState.type === 'connection' && dragState.sourceTileId === tile.id
        const isConnectionTarget = dragState.type === 'connection' && dragState.targetTileId === tile.id
        const hoveredSide: Side | null = hoveredConnectionHandle?.tileId === tile.id ? hoveredConnectionHandle.side : null
        const showConnectionHandle = isConnectionSource || Boolean(hoveredSide)
        // The handle is invisible unless hovered or the active source, so its resting
        // side/position is never seen — use a stable default when hidden. This keeps the
        // per-tile props independent of the live pointer position (canvasPointerWorld),
        // so moving the mouse no longer re-renders every tile.
        const activeHandleSide: Side = isConnectionSource
          ? dragState.side
          : hoveredSide ?? 'right'
        const isSelected = tile.id === selectedTileId || selectedTileIds.has(tile.id)
        // Never cull/LOD a tile mid-interaction or when it's the focused panel
        // member — a hidden body under the cursor would read as a glitch.
        const interacting = isActiveDrag || isSelected || panelTileIds.has(tile.id)
        const bodyCulled = cullingOn && !interacting &&
          isTileOffscreen(tile, viewport, screenW, screenH)
        const lodPlaceholder = lodActive && !interacting && !bodyCulled && isHeavyTileType(tile.type)

        return (
          <CanvasTileItem
            key={tile.id}
            tile={tile}
            zoom={viewport.zoom}
            bodyCulled={bodyCulled}
            lodPlaceholder={lodPlaceholder}
            workspaceId={workspaceId}
            workspaceDir={workspaceDir}
            isActiveDrag={isActiveDrag}
            isSelected={isSelected}
            isConnectionSource={isConnectionSource}
            isConnectionTarget={isConnectionTarget}
            connectionDragActive={connectionDragActive}
            showConnectionHandle={showConnectionHandle}
            activeHandleSide={activeHandleSide}
            forceExpanded={panelTileIds.has(tile.id)}
            discoveryConnected={negotiatedDiscoveryState.connectedTileIds.has(tile.id)}
            connectedPeers={negotiatedDiscoveryState.byTileConnections.get(tile.id)?.map(link => link.peerId) ?? EMPTY_PEERS}
            isUntitledNote={tile.type === 'note' && !tile.filePath}
            dscLine={dsc.line}
            dscText={dsc.text}
            theme={theme}
            onClose={onCloseTile}
            onActivate={onBringToFront}
            onTitlebarMouseDown={onTitlebarMouseDown}
            onResizeMouseDown={onResizeMouseDown}
            onContextMenu={onContextMenu}
            onEnterExpandedMode={onEnterExpandedMode}
            onExitExpandedMode={onExitExpandedMode}
            onConnectionMouseDown={onConnectionMouseDown}
            showConnectionHandleForSide={showConnectionHandleForSide}
            scheduleConnectionHandleHide={scheduleConnectionHandleHide}
            setCanvasPointerWorld={setCanvasPointerWorld}
            screenToWorld={screenToWorld}
            renderTileBody={renderTileBody}
          />
        )
      })}
    </>
  )
}
