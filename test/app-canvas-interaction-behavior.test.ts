import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { GroupState, TileState } from '../src/shared/types.ts'
import {
  createResizeDragState,
  createTileDragState,
} from '../src/renderer/src/hooks/useCanvasPointerHandlers.ts'
import {
  applyResizeDragToTile,
  computeTileDragPosition,
} from '../src/renderer/src/hooks/useCanvasDragSync.ts'
import { buildCanvasContextMenuItems } from '../src/renderer/src/hooks/useCanvasContextMenus.ts'
import {
  collectCanvasGroupTileIds,
  computeCanvasGroupBounds,
} from '../src/renderer/src/hooks/useCanvasGroupManager.ts'
import {
  executeCanvasKeyboardCommand,
  resolveCanvasKeyboardCommand,
} from '../src/renderer/src/hooks/useCanvasKeyboard.ts'
import {
  deleteLockedConnection,
  enterExpandedGroupState,
  exitExpandedGroupState,
  isLockedConnection,
  toggleLockedConnection,
} from '../src/renderer/src/hooks/useCanvasConnectionLock.ts'
import { computeFitViewport } from '../src/renderer/src/hooks/canvasEngineMath.ts'

function tile(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  groupId?: string,
): TileState {
  return { id, type: 'note', x, y, width, height, zIndex: 1, groupId } as TileState
}

describe('app canvas interaction behavior', () => {
  test('drag and resize starts preserve the tile geometry at pointer-down time', () => {
    const source = tile('tile-1', 10, 20, 300, 180)
    const tileDrag = createTileDragState(source, 40, 50)
    assert.deepEqual(tileDrag, {
      type: 'tile',
      tileId: 'tile-1',
      startX: 40,
      startY: 50,
      initX: 10,
      initY: 20,
      groupSnapshots: [],
    })
    assert.deepEqual(computeTileDragPosition({
      dragState: tileDrag,
      clientX: 100,
      clientY: 90,
      zoom: 2,
      snapValue: Math.round,
    }), { x: 40, y: 40, dx: 30, dy: 20 })

    const resizeDrag = createResizeDragState(source, 'nw', 35, 45)
    assert.deepEqual(resizeDrag, {
      type: 'resize',
      tileId: 'tile-1',
      dir: 'nw',
      startX: 35,
      startY: 45,
      initX: 10,
      initY: 20,
      initW: 300,
      initH: 180,
    })
    assert.deepEqual(applyResizeDragToTile({
      tile: source,
      dragState: resizeDrag,
      clientX: 75,
      clientY: 65,
      zoom: 2,
      snapValue: Math.round,
      minWidth: 100,
      minHeight: 80,
    }), tile('tile-1', 30, 30, 280, 170))
  })

  test('canvas context menu exposes extension, clipboard, group, and executable actions', () => {
    const calls: unknown[][] = []
    const items = buildCanvasContextMenuItems({
      world: { x: 120, y: 80 },
      hitGroupId: 'group-1',
      pinnedCanvasExtensionTiles: [{ type: 'ext:qa', label: 'QA Workbench' }],
      hasClipboard: true,
      selectedTileCount: 3,
      addTile: (...args) => { calls.push(['add', ...args]); return 'new-tile' },
      pasteAt: (...args) => calls.push(['paste', ...args]),
      groupSelectedTiles: () => calls.push(['group']),
    })
    const byLabel = new Map(items.map(item => [item.label, item]))
    byLabel.get('QA Workbench')?.action()
    byLabel.get('Paste into group')?.action()
    byLabel.get('Group 3 blocks')?.action()
    assert.deepEqual(calls, [
      ['add', 'ext:qa', undefined, { x: 120, y: 80 }],
      ['paste', { x: 120, y: 80 }, 'group-1'],
      ['group'],
    ])
  })

  test('nested group membership and expanded bounds include descendant tiles', () => {
    const groups = [
      { id: 'parent' },
      { id: 'child', parentGroupId: 'parent' },
    ] as GroupState[]
    const tiles = [
      tile('a', 100, 100, 100, 80, 'parent'),
      tile('b', 300, 250, 120, 90, 'child'),
    ]
    assert.deepEqual(collectCanvasGroupTileIds(tiles, groups, 'parent'), ['a', 'b'])
    assert.deepEqual(computeCanvasGroupBounds(tiles, groups, 'parent'), {
      x: 80,
      y: 80,
      w: 360,
      h: 280,
    })
    const entered = enterExpandedGroupState({
      group: groups[0],
      bounds: { x: 80, y: 80, w: 360, h: 280 },
      canvasSize: { w: 900, h: 700 },
      currentViewport: { zoom: 1, tx: 12, ty: 18 },
    })
    assert.deepEqual(entered, {
      expandedGroupId: 'parent',
      viewport: computeFitViewport({ x: 80, y: 80, w: 360, h: 280 }, { w: 900, h: 700 }),
      priorViewport: { zoom: 1, tx: 12, ty: 18 },
    })
    assert.deepEqual(exitExpandedGroupState(entered!), {
      expandedGroupId: null,
      viewport: { zoom: 1, tx: 12, ty: 18 },
      priorViewport: null,
    })
  })

  test('keyboard shortcuts distinguish undo and redo across platforms', () => {
    assert.equal(resolveCanvasKeyboardCommand({ key: 'z', metaKey: true, ctrlKey: false, shiftKey: false }), 'undo')
    assert.equal(resolveCanvasKeyboardCommand({ key: 'z', metaKey: false, ctrlKey: true, shiftKey: true }), 'redo')
    assert.equal(resolveCanvasKeyboardCommand({ key: 'y', metaKey: false, ctrlKey: true, shiftKey: false }), 'redo')
    assert.equal(resolveCanvasKeyboardCommand({ key: 'z', metaKey: false, ctrlKey: false, shiftKey: false }), null)
    const calls: string[] = []
    const actions = {
      selectedTileCount: 2,
      groupSelectedTiles: () => calls.push('group'),
      undoCanvas: () => calls.push('undo'),
      redoCanvas: () => calls.push('redo'),
    }
    executeCanvasKeyboardCommand('undo', actions)
    executeCanvasKeyboardCommand('redo', actions)
    executeCanvasKeyboardCommand('group', actions)
    assert.deepEqual(calls, ['undo', 'redo', 'group'])
  })

  test('connection locking is order-independent and deletion is idempotent', () => {
    const locked = toggleLockedConnection([], 'tile-b', 'tile-a')
    assert.deepEqual(locked, [{ sourceTileId: 'tile-a', targetTileId: 'tile-b' }])
    assert.equal(isLockedConnection(locked, 'tile-b', 'tile-a'), true)
    assert.deepEqual(toggleLockedConnection(locked, 'tile-a', 'tile-b'), [])
    const deleted = deleteLockedConnection(locked, 'tile-b', 'tile-a')
    assert.deepEqual(deleted, [])
    assert.equal(deleteLockedConnection(deleted, 'tile-a', 'tile-b'), deleted)
  })
})
