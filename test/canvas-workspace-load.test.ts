import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { CanvasState, GroupState, LockedConnection, TileState } from '../src/shared/types.ts'
import type { PanelNode } from '../src/renderer/src/components/panelLayoutTree.ts'
import { applyEmptyCanvasWorkspaceState } from '../src/renderer/src/lib/canvasWorkspaceLoad.ts'

describe('empty canvas workspace hydration', () => {
  test('clears every authoritative canvas ref before lifecycle persistence can observe the new owner', () => {
    let tiles = [{ id: 'tile-a' }] as TileState[]
    let groups = [{ id: 'group-a' }] as GroupState[]
    let lockedConnections = [{
      sourceTileId: 'tile-a',
      targetTileId: 'tile-b',
    }] as LockedConnection[]
    let panelLayout = { type: 'leaf', id: 'panel-a', tabs: ['tile-a'], activeTab: 'tile-a' } as PanelNode
    let activePanelId: string | null = 'panel-a'
    let expandedTileId: string | null = 'tile-a'
    let expandedCanvasGroupId: string | null = 'group-a'
    const savedLayoutRef = { current: panelLayout as PanelNode | null }
    const expandedCanvasGroupIdRef = { current: expandedCanvasGroupId }
    const expandedCanvasPriorViewportRef = {
      current: { tx: 20, ty: 30, zoom: 2 } as CanvasState['viewport'] | null,
    }
    let viewportReset = false

    applyEmptyCanvasWorkspaceState({
      setTiles: next => { tiles = next },
      setGroups: next => { groups = next },
      setLockedConnections: next => { lockedConnections = next },
      setPanelLayout: next => { panelLayout = next as PanelNode },
      setActivePanelId: next => { activePanelId = next },
      setExpandedTileId: next => { expandedTileId = next },
      setExpandedCanvasGroupId: next => { expandedCanvasGroupId = next },
      savedLayoutRef,
      expandedCanvasGroupIdRef,
      expandedCanvasPriorViewportRef,
    }, () => {
      viewportReset = true
    })

    assert.deepEqual(tiles, [])
    assert.deepEqual(groups, [])
    assert.deepEqual(lockedConnections, [])
    assert.equal(viewportReset, true)
    assert.equal(savedLayoutRef.current, null)
    assert.equal(panelLayout, null)
    assert.equal(activePanelId, null)
    assert.equal(expandedTileId, null)
    assert.equal(expandedCanvasGroupId, null)
    assert.equal(expandedCanvasGroupIdRef.current, null)
    assert.equal(expandedCanvasPriorViewportRef.current, null)
  })
})
