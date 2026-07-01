import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { resolvePrincipal, assertTileScope } from '../src/main/mcp/auth.ts'

const GLOBAL_TOKEN = 'global-secret-token'

function tileTokens(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries)
}

describe('resolvePrincipal', () => {
  test('global token resolves to a global principal', () => {
    const tokens = tileTokens([['tile-a', 'token-a']])
    assert.deepEqual(resolvePrincipal(GLOBAL_TOKEN, GLOBAL_TOKEN, tokens), { kind: 'global' })
  })

  test('a registered tile token (value match) resolves to that tile', () => {
    const tokens = tileTokens([['tile-a', 'token-a'], ['tile-b', 'token-b']])
    assert.deepEqual(resolvePrincipal('token-a', GLOBAL_TOKEN, tokens), { kind: 'tile', tileId: 'tile-a' })
    assert.deepEqual(resolvePrincipal('token-b', GLOBAL_TOKEN, tokens), { kind: 'tile', tileId: 'tile-b' })
  })

  test('presenting a tileId (map KEY) as the token must never authenticate', () => {
    const tokens = tileTokens([['tile-a', 'token-a']])
    assert.equal(resolvePrincipal('tile-a', GLOBAL_TOKEN, tokens), null)
  })

  test('an unknown token resolves to null', () => {
    const tokens = tileTokens([['tile-a', 'token-a']])
    assert.equal(resolvePrincipal('not-a-real-token', GLOBAL_TOKEN, tokens), null)
  })

  test('a null token resolves to null', () => {
    const tokens = tileTokens([['tile-a', 'token-a']])
    assert.equal(resolvePrincipal(null, GLOBAL_TOKEN, tokens), null)
  })
})

describe('assertTileScope', () => {
  test('a global principal passes any target', () => {
    assert.equal(assertTileScope({ kind: 'global' }, 'tile-a'), null)
    assert.equal(assertTileScope({ kind: 'global' }, 'tile-b'), null)
    assert.equal(assertTileScope({ kind: 'global' }, undefined), null)
  })

  test('a tile principal passes its own target', () => {
    assert.equal(assertTileScope({ kind: 'tile', tileId: 'tile-a' }, 'tile-a'), null)
  })

  test('a tile principal is rejected for another tile\'s target', () => {
    const error = assertTileScope({ kind: 'tile', tileId: 'tile-a' }, 'tile-b')
    assert.notEqual(error, null)
    assert.match(error as string, /tile-a/)
  })

  test('a tile principal is rejected for an undefined target', () => {
    const error = assertTileScope({ kind: 'tile', tileId: 'tile-a' }, undefined)
    assert.notEqual(error, null)
  })
})
