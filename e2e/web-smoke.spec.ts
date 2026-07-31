import { expect, test } from '@playwright/test'
import { launchBuiltWebPreview, type LaunchedWebPreview } from './helpers/launch-web-preview'

test.describe('CodeSurf built-web smoke', () => {
  let preview: LaunchedWebPreview

  test.beforeAll(async () => {
    preview = await launchBuiltWebPreview()
  })

  test.afterAll(async () => {
    await preview?.close()
  })

  test('installs the runtime bridge and persists daemon-backed workspace canvas state', async ({
    page,
  }) => {
    const runtimeConfigResponse = page.waitForResponse(
      (response) =>
        response.url() === `${preview.url}codesurf-runtime-config.js` && response.status() === 200,
    )

    await page.goto(preview.url, { waitUntil: 'domcontentloaded' })
    const configResponse = await runtimeConfigResponse
    expect(configResponse.headers()['cache-control']).toContain('no-store')
    expect(configResponse.headers()['content-type']).toContain('application/javascript')

    await page.waitForFunction(() => {
      const runtime = window as typeof window & {
        __CODESURF_PLATFORM__?: string
        electron?: {
          workspace?: { create?: unknown }
          canvas?: { save?: unknown }
        }
      }
      return (
        runtime.__CODESURF_PLATFORM__ === 'web' &&
        typeof runtime.electron?.workspace?.create === 'function' &&
        typeof runtime.electron?.canvas?.save === 'function'
      )
    })
    await expect(page.locator('#root')).toBeVisible()
    await expect(page.locator('#root')).not.toContainText('Loading…', { timeout: 45_000 })

    const firstPass = await page.evaluate(async () => {
      const runtime = window as typeof window & {
        __CODESURF_PLATFORM__?: string
        __CODESURF_HOST__?: string
        __CODESURF_HOST_TOKEN__?: string
        __CODESURF_CAPABILITIES__?: Record<string, boolean>
        electron: {
          workspace: {
            list: () => Promise<Array<{ id: string }>>
            create: (name: string) => Promise<{ id: string }>
          }
          canvas: {
            save: (workspaceId: string, state: unknown) => Promise<void>
            load: (workspaceId: string) => Promise<unknown>
          }
          system: {
            daemonStatus: () => Promise<{ running: boolean }>
          }
        }
      }
      const marker = `web-smoke-${crypto.randomUUID()}`
      const target = await runtime.electron.workspace.create(`${marker}-target`)
      // Keep the persisted target out of the mounted App's active-workspace
      // autosave path while the page reloads.
      const guard = await runtime.electron.workspace.create(`${marker}-guard`)
      const canvasState = {
        tiles: [{ id: marker, type: 'note', x: 120, y: 80, width: 320, height: 200 }],
        viewport: { tx: 31, ty: 47, zoom: 1.25 },
        nextZIndex: 2,
      }
      await runtime.electron.canvas.save(target.id, canvasState)

      const listed = await runtime.electron.workspace.list()
      const loaded = (await runtime.electron.canvas.load(target.id)) as typeof canvasState | null
      const daemon = await runtime.electron.system.daemonStatus()
      return {
        platform: runtime.__CODESURF_PLATFORM__,
        host: runtime.__CODESURF_HOST__,
        hostTokenLength: runtime.__CODESURF_HOST_TOKEN__?.length ?? 0,
        workspaceCapability: runtime.__CODESURF_CAPABILITIES__?.workspace,
        canvasCapability: runtime.__CODESURF_CAPABILITIES__?.canvas,
        targetId: target.id,
        guardId: guard.id,
        marker,
        listedIds: listed.map((workspace) => workspace.id),
        loaded,
        daemonRunning: daemon.running,
      }
    })

    expect(firstPass.platform).toBe('web')
    expect(firstPass.host).toBe(preview.hostUrl)
    expect(firstPass.hostTokenLength).toBeGreaterThanOrEqual(32)
    expect(firstPass.workspaceCapability).toBe(true)
    expect(firstPass.canvasCapability).toBe(true)
    expect(firstPass.listedIds).toEqual(
      expect.arrayContaining([firstPass.targetId, firstPass.guardId]),
    )
    expect(firstPass.loaded).toEqual(
      expect.objectContaining({
        tiles: [expect.objectContaining({ id: firstPass.marker, type: 'note' })],
        viewport: { tx: 31, ty: 47, zoom: 1.25 },
      }),
    )
    expect(firstPass.daemonRunning).toBe(true)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () =>
        typeof (window as typeof window & { electron?: { workspace?: { list?: unknown } } })
          .electron?.workspace?.list === 'function',
    )

    const afterReload = await page.evaluate(
      async ({ targetId, guardId, marker }) => {
        const bridge = (
          window as typeof window & {
            electron: {
              workspace: {
                list: () => Promise<Array<{ id: string }>>
                delete: (id: string) => Promise<void>
              }
              canvas: {
                load: (workspaceId: string) => Promise<{
                  tiles?: Array<{ id: string; type: string }>
                  viewport?: { tx: number; ty: number; zoom: number }
                } | null>
              }
            }
          }
        ).electron
        const listed = await bridge.workspace.list()
        const loaded = await bridge.canvas.load(targetId)
        await bridge.workspace.delete(targetId)
        await bridge.workspace.delete(guardId)
        return {
          listedIds: listed.map((workspace) => workspace.id),
          hasMarkerTile:
            loaded?.tiles?.some((tile) => tile.id === marker && tile.type === 'note') ?? false,
          viewport: loaded?.viewport ?? null,
        }
      },
      {
        targetId: firstPass.targetId,
        guardId: firstPass.guardId,
        marker: firstPass.marker,
      },
    )

    expect(afterReload.listedIds).toEqual(
      expect.arrayContaining([firstPass.targetId, firstPass.guardId]),
    )
    expect(afterReload.hasMarkerTile).toBe(true)
    expect(afterReload.viewport).toEqual({ tx: 31, ty: 47, zoom: 1.25 })
  })
})
