import { test, expect } from '@playwright/test'
import { dismissAgentSetupIfPresent } from './helpers/dismiss-setup'
import { closeCodeSurfElectron, launchCodeSurfElectron } from './helpers/launch-electron'
import { waitForElectronBridge } from './helpers/wait-bridge'

test.describe('Canvas IPC surface', () => {
  test('preload exposes canvas APIs and returns structured load results', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'canvas.load')

      const canvasProbe = await page.evaluate(async () => {
        const bridge = (window as Window & {
          electron: {
            workspace: { list: () => Promise<Array<{ id: string; path?: string }>> }
            canvas: { load: (workspaceId: string) => Promise<unknown> }
          }
        }).electron

        const workspaces = await bridge.workspace.list()
        const workspaceId = workspaces[0]?.id ?? 'e2e-empty-workspace'
        const loaded = await bridge.canvas.load(workspaceId)

        return {
          workspaceCount: workspaces.length,
          workspaceId,
          loadedIsNullOrObject: loaded === null || (typeof loaded === 'object' && loaded !== null),
        }
      })

      expect(canvasProbe.workspaceCount).toBeGreaterThanOrEqual(0)
      expect(canvasProbe.loadedIsNullOrObject).toBe(true)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('canvas save and reload round-trips tile state', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'canvas.save')

      const roundTrip = await page.evaluate(async () => {
        const bridge = (window as Window & {
          electron: {
            workspace: {
              list: () => Promise<Array<{ id: string }>>
              create: (name: string) => Promise<{ id: string }>
            }
            canvas: {
              load: (workspaceId: string) => Promise<{ tiles?: Array<{ id: string; type: string }> } | null>
              save: (workspaceId: string, state: unknown) => Promise<unknown>
            }
          }
        }).electron

        const workspaces = await bridge.workspace.list()
        let workspaceId = workspaces[0]?.id
        if (!workspaceId) {
          const created = await bridge.workspace.create('e2e-canvas-roundtrip')
          workspaceId = created.id
        }

        const tileId = 'e2e-tile-1'
        const payload = {
          tiles: [{ id: tileId, type: 'note', x: 120, y: 80, width: 320, height: 200 }],
          viewport: { tx: 0, ty: 0, zoom: 1 },
          nextZIndex: 2,
        }

        await bridge.canvas.save(workspaceId, payload)
        const reloaded = await bridge.canvas.load(workspaceId)
        const tiles = Array.isArray(reloaded?.tiles) ? reloaded.tiles : []

        return {
          workspaceId,
          savedTileCount: payload.tiles.length,
          reloadedTileCount: tiles.length,
          hasSavedTile: tiles.some(tile => tile.id === tileId && tile.type === 'note'),
        }
      })

      expect(roundTrip.savedTileCount).toBeGreaterThan(0)
      expect(roundTrip.reloadedTileCount).toBeGreaterThanOrEqual(roundTrip.savedTileCount)
      expect(roundTrip.hasSavedTile).toBe(true)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('command shell creates a note tile on the canvas', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'workspace.setActive')

      await page.evaluate(async () => {
        const bridge = (window as Window & {
          electron: {
            workspace: {
              list: () => Promise<Array<{ id: string }>>
              create: (name: string) => Promise<{ id: string }>
              setActive: (id: string) => Promise<unknown>
            }
          }
        }).electron

        const workspaces = await bridge.workspace.list()
        let id = workspaces[0]?.id
        if (!id) {
          id = (await bridge.workspace.create('e2e-shell-tile')).id
        }
        await bridge.workspace.setActive(id)
      })

      await page.reload()
      await waitForElectronBridge(page, 'canvas.load')
      await dismissAgentSetupIfPresent(page)
      await page.waitForSelector('[data-canvas-surface="true"]', { timeout: 45_000 })
      // The surface mounts before the async workspace hydration commits. Give
      // that initial load a chance to settle so it cannot replace the tile
      // created by the command-shell event below.
      await page.waitForTimeout(750)

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: 'note' } }))
      })
      const noteEditor = page.locator('textarea[placeholder="Type a note..."]')
      await expect(noteEditor).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-tile-chrome="true"]').filter({ has: noteEditor })).toBeVisible()
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('production Electron resolves dynamically loaded tile bodies from file assets', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      const failedAssetRequests: string[] = []
      const loadedTileChunks = new Set<string>()
      let noteChunkAttempts = 0
      await page.route(/\/assets\/NoteTile-[^/]+\.js(?:\?.*)?$/, async route => {
        noteChunkAttempts += 1
        if (noteChunkAttempts === 1) {
          await route.abort('failed')
          return
        }
        await route.continue()
      })
      page.on('requestfailed', request => {
        if (request.url().includes('/assets/')) failedAssetRequests.push(request.url())
      })
      page.on('response', response => {
        const match = response.url().match(
          /\/assets\/(NoteTile|TerminalTile|BrowserTile|CodeTile)-[^/]+\.js(?:\?.*)?$/,
        )
        if (match && response.ok()) loadedTileChunks.add(match[1])
      })

      await waitForElectronBridge(page, 'workspace.setActive')
      await page.evaluate(async () => {
        const workspaces = await window.electron.workspace.list()
        const workspace = workspaces[0] ?? await window.electron.workspace.create('e2e-lazy-tile-bodies')
        await window.electron.workspace.setActive(workspace.id)
      })

      await page.reload()
      await waitForElectronBridge(page, 'canvas.load')
      await dismissAgentSetupIfPresent(page)
      await page.waitForSelector('[data-canvas-surface="true"]', { timeout: 45_000 })
      await page.waitForTimeout(750)

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: 'terminal' } }))
      })
      const terminalTitle = page.getByText('Terminal', { exact: true }).first()
      await expect(terminalTitle).toBeVisible()
      const terminalChrome = terminalTitle.locator(
        'xpath=ancestor::*[@data-tile-chrome="true"][1]',
      )
      const terminalChromeHandle = await terminalChrome.elementHandle()
      expect(terminalChromeHandle).not.toBeNull()

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: 'note' } }))
      })
      const retryTile = page.locator('[data-loadable-tile-retry="true"]').last()
      await expect(retryTile).toBeVisible()
      await expect(terminalChrome).toBeVisible()
      await retryTile.click()
      await expect(page.locator('textarea[placeholder="Type a note..."]')).toBeVisible()
      await expect(terminalChrome).toBeVisible()
      expect(await terminalChromeHandle!.evaluate(element => element.isConnected)).toBe(true)

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: 'code' } }))
      })
      await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 45_000 })

      await page.evaluate(() => {
        window.dispatchEvent(new CustomEvent('codesurf:new-tile', { detail: { type: 'browser' } }))
      })
      await expect(page.locator('input[aria-label="Address"]')).toBeVisible()

      expect([...loadedTileChunks].sort()).toEqual([
        'BrowserTile',
        'CodeTile',
        'NoteTile',
        'TerminalTile',
      ])
      expect(noteChunkAttempts).toBe(2)
      expect(failedAssetRequests).toHaveLength(1)
      expect(failedAssetRequests[0]).toMatch(/\/assets\/NoteTile-[^/]+\.js$/)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

  test('canvas viewport save and reload round-trips pan and zoom', async () => {
    const launch = await launchCodeSurfElectron()

    try {
      const { page } = launch
      await waitForElectronBridge(page, 'canvas.save')

      const viewportRoundTrip = await page.evaluate(async () => {
        const bridge = (window as Window & {
          electron: {
            workspace: {
              list: () => Promise<Array<{ id: string }>>
              create: (name: string) => Promise<{ id: string }>
            }
            canvas: {
              load: (workspaceId: string) => Promise<{ viewport?: { tx: number; ty: number; zoom: number }; tiles?: unknown[] } | null>
              save: (workspaceId: string, state: unknown) => Promise<unknown>
            }
          }
        }).electron

        const workspaces = await bridge.workspace.list()
        let workspaceId = workspaces[0]?.id
        if (!workspaceId) {
          const createdWorkspace = await bridge.workspace.create('e2e-viewport')
          workspaceId = createdWorkspace.id
        }

        const viewport = { tx: 140, ty: 96, zoom: 1.35 }
        const payload = {
          tiles: [],
          viewport,
          nextZIndex: 1,
        }

        await bridge.canvas.save(workspaceId, payload)
        const reloaded = await bridge.canvas.load(workspaceId)
        const reloadedViewport = reloaded?.viewport ?? { tx: 0, ty: 0, zoom: 1 }

        return { saved: viewport, reloaded: reloadedViewport }
      })

      expect(viewportRoundTrip.reloaded).toEqual(viewportRoundTrip.saved)
    } finally {
      await closeCodeSurfElectron(launch)
    }
  })

})