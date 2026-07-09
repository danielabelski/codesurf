import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolvePrincipal } from '../src/main/mcp/auth.ts'
import { randomUUID } from 'node:crypto'

/**
 * Characterization for the SEC-05 wiring: tile-scoped tokens must be
 * distinct from the global token and stable per tileId. Mirrors the
 * logic in `buildContexHttpMcpServerEntry(url, tileId)` without importing
 * the Electron-bound mcp-server module.
 */
describe('tile MCP token principal model (SEC-05)', () => {
  const GLOBAL = randomUUID()
  const tileTokens = new Map<string, string>()

  function tokenFor(tileId: string): string {
    let t = tileTokens.get(tileId)
    if (!t) {
      t = randomUUID()
      tileTokens.set(tileId, t)
    }
    return t
  }

  function entry(tileId?: string): { type: string, url: string, headers: { Authorization: string } } {
    const token = tileId ? tokenFor(tileId) : GLOBAL
    return {
      type: 'http',
      url: 'http://127.0.0.1:1234/mcp',
      headers: { Authorization: `Bearer ${token}` },
    }
  }

  test('without tileId embeds the global bearer', () => {
    const e = entry()
    assert.match(e.headers.Authorization, /^Bearer /)
    const principal = resolvePrincipal(
      e.headers.Authorization.slice('Bearer '.length),
      GLOBAL,
      tileTokens,
    )
    assert.deepEqual(principal, { kind: 'global' })
  })

  test('with tileId uses a distinct token that resolves to that tile', () => {
    const globalEntry = entry()
    const tileEntry = entry('tile-alpha')
    assert.notEqual(globalEntry.headers.Authorization, tileEntry.headers.Authorization)
    const principal = resolvePrincipal(
      tileEntry.headers.Authorization.slice('Bearer '.length),
      GLOBAL,
      tileTokens,
    )
    assert.deepEqual(principal, { kind: 'tile', tileId: 'tile-alpha' })
  })

  test('same tileId yields a stable token', () => {
    assert.equal(entry('tile-stable').headers.Authorization, entry('tile-stable').headers.Authorization)
  })

  test('different tileIds yield different tokens', () => {
    assert.notEqual(
      entry('tile-a').headers.Authorization,
      entry('tile-b').headers.Authorization,
    )
  })
})
