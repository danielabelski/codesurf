/**
 * Pure canvas visibility helpers (panel tile sets, expanded-group membership).
 * Electron/React free — safe for node:test.
 */

import type { GroupState, TileState } from '../../../shared/types'

export type ExpandedCanvasMembership = {
  tileIds: Set<string>
  groupIds: Set<string>
}

/**
 * Tiles that should not render free on the canvas.
 * `layoutTileIds` is typically getAllTileIds(panelLayout).
 */
export function computePanelTileIds(
  layoutTileIds: readonly string[],
  groups: GroupState[],
  tiles: TileState[],
): Set<string> {
  const ids = new Set<string>(layoutTileIds)
  for (const g of groups) {
    if (g.layoutMode) {
      for (const t of tiles) {
        if (t.groupId === g.id) ids.add(t.id)
      }
    }
  }
  return ids
}

/** Members of a non-layout group expanded as a fullscreen sub-canvas. */
export function computeExpandedCanvasMembership(
  expandedCanvasGroupId: string | null,
  groups: GroupState[],
  tiles: TileState[],
): ExpandedCanvasMembership | null {
  if (!expandedCanvasGroupId) return null
  const groupIds = new Set<string>()
  const walk = (gid: string) => {
    if (groupIds.has(gid)) return
    groupIds.add(gid)
    for (const child of groups) if (child.parentGroupId === gid) walk(child.id)
  }
  walk(expandedCanvasGroupId)
  const tileIds = new Set(tiles.filter(t => t.groupId && groupIds.has(t.groupId)).map(t => t.id))
  return { tileIds, groupIds }
}
