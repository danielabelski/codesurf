/**
 * Electron-free MCP auth primitives: resolve a bearer token to a principal
 * and check that a tile-scoped principal only targets its own tile.
 *
 * Kept separate from mcp-server.ts (which imports `electron`) so it can be
 * unit-tested under plain `node --test`.
 */

export type McpPrincipal =
  | { kind: 'global' }
  | { kind: 'tile', tileId: string }

/**
 * Resolve a presented bearer/query token to a principal.
 *
 * `tileTokens` maps tileId -> token. We match on the token VALUE, not the
 * map key — presenting a bare tileId as a token must never authenticate.
 */
export function resolvePrincipal(
  token: string | null,
  globalToken: string,
  tileTokens: Map<string, string>,
): McpPrincipal | null {
  if (!token) return null
  if (token === globalToken) return { kind: 'global' }
  for (const [tileId, storedToken] of tileTokens) {
    if (storedToken === token) return { kind: 'tile', tileId }
  }
  return null
}

/**
 * Enforce that a tile-scoped principal only acts on its own tile.
 * Returns an error message string when the check fails, or null when the
 * caller is authorized (global principals are always authorized).
 */
export function assertTileScope(principal: McpPrincipal, targetTileId: string | undefined | null): string | null {
  if (principal.kind === 'global') return null
  if (targetTileId === principal.tileId) return null
  return `Forbidden: token is scoped to tile '${principal.tileId}', cannot target '${targetTileId ?? ''}'`
}
