import type { McpPrincipal } from './auth.ts'
import { resolveAuthoritativeCanvasPeers } from '../chat/peer-authority-policy.ts'
import { getTileNodeTools } from '../../shared/nodeTools.ts'
import type { TileType } from '../../shared/types.ts'

function ownData(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== 'object') return undefined
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

function targetTileType(canvas: unknown, targetTileId: string): string | null {
  const tiles = ownData(canvas, 'tiles')
  if (!Array.isArray(tiles)) return null
  for (const tile of tiles.slice(0, 2_048)) {
    if (ownData(tile, 'id') !== targetTileId) continue
    const type = ownData(tile, 'type')
    return typeof type === 'string' && type.trim() ? type.trim() : null
  }
  return null
}

/**
 * Validate peer dispatch against current workspace canvas function state.
 * Canvas state is renderer-replaceable and is not a privileged trust root;
 * this check only prevents a tile credential from reaching an unconnected or
 * type-incompatible sink. The target handler remains the authority for the
 * requested operation and its permission checks.
 */
export function authorizePeerBridgeTarget(options: {
  principal: McpPrincipal
  workspaceId: string
  targetTileId: string
  toolName: string
  canvas: unknown
}): { ok: true; tileType: string } | { ok: false; error: string } {
  const { principal, workspaceId, targetTileId, toolName, canvas } = options
  const tileType = targetTileType(canvas, targetTileId)
  if (!tileType) return { ok: false, error: 'Forbidden: target tile is not present in this workspace' }

  if (principal.kind === 'tile') {
    if (principal.workspaceId !== workspaceId) {
      return { ok: false, error: 'Forbidden: target is outside the authenticated workspace' }
    }
    if (principal.tileId === targetTileId) {
      return { ok: false, error: 'Forbidden: peer tools cannot target the caller tile' }
    }
    const connected = resolveAuthoritativeCanvasPeers(canvas, principal.tileId)
      .some(peer => peer.peerId === targetTileId)
    if (!connected) {
      return { ok: false, error: 'Forbidden: target tile is not a current connected peer' }
    }
  }

  const exposesTool = getTileNodeTools(tileType as TileType).some(tool => tool.name === toolName)
  if (!exposesTool) {
    return { ok: false, error: `Forbidden: ${tileType} tiles do not expose ${toolName}` }
  }
  return { ok: true, tileType }
}
