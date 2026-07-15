import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  computeExpandedCanvasMembership,
  computePanelTileIds,
} from '../src/renderer/src/lib/canvasVisibility.ts'
import type { GroupState, TileState } from '../src/shared/types.ts'

function tile(id: string, groupId?: string): TileState {
  return { id, type: 'note', x: 0, y: 0, width: 100, height: 100, zIndex: 1, groupId }
}

function group(id: string, opts: Partial<GroupState> = {}): GroupState {
  return { id, ...opts }
}

describe('computePanelTileIds', () => {
  test('includes tiles in layoutMode groups', () => {
    const groups = [group('g1', { layoutMode: true })]
    const tiles = [tile('a', 'g1'), tile('b')]
    const ids = computePanelTileIds([], groups, tiles)
    assert.equal(ids.has('a'), true)
    assert.equal(ids.has('b'), false)
  })
})

describe('computeExpandedCanvasMembership', () => {
  test('returns null when nothing expanded', () => {
    assert.equal(computeExpandedCanvasMembership(null, [], []), null)
  })

  test('includes recursive child groups and their tiles', () => {
    const groups = [
      group('root'),
      group('child', { parentGroupId: 'root' }),
    ]
    const tiles = [tile('t1', 'root'), tile('t2', 'child'), tile('t3')]
    const mem = computeExpandedCanvasMembership('root', groups, tiles)
    assert.ok(mem)
    assert.equal(mem!.groupIds.has('root'), true)
    assert.equal(mem!.groupIds.has('child'), true)
    assert.equal(mem!.tileIds.has('t1'), true)
    assert.equal(mem!.tileIds.has('t2'), true)
    assert.equal(mem!.tileIds.has('t3'), false)
  })
})

describe('App uses derived canvas state hook', () => {
  test('App imports useAppCanvasDerivedState instead of inlining membership memos', () => {
    const app = readFileSync(join(process.cwd(), 'src/renderer/src/App.tsx'), 'utf8')
    assert.match(app, /useAppCanvasDerivedState/)
    assert.equal(/const panelTileIds = React\.useMemo/.test(app), false)
    assert.equal(/expandedCanvasMembership = React\.useMemo/.test(app), false)
  })
})
