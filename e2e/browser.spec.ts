import { test, expect } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { access, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { dismissAgentSetupIfPresent } from './helpers/dismiss-setup'
import {
  closeCodeSurfElectron,
  launchCodeSurfElectron,
  type LaunchedElectronApp,
} from './helpers/launch-electron'
import { waitForElectronBridge } from './helpers/wait-bridge'

const FIXTURE_HTML_PATH = join(__dirname, 'fixtures/browser-tile.html')
const TILE_ID = 'e2e-browser-behavior'

type GuestSnapshot = {
  url: string | null
  title: string | null
  heading: string | null
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  return (server.address() as AddressInfo).port
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeIdleConnections()
    server.closeAllConnections()
  })
}

test.describe('BrowserTile production Electron behavior', () => {
  test('navigates a real guest, records evidence, and restores the last URL', async () => {
    const fixtureHtml = await readFile(FIXTURE_HTML_PATH, 'utf8')
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(request.url ?? '/')
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      })
      response.end(fixtureHtml)
    })
    const port = await listen(server)
    const startUrl = `http://127.0.0.1:${port}/start`
    const nextUrl = `http://127.0.0.1:${port}/next`
    let launch: LaunchedElectronApp | null = null
    let testError: unknown = null
    const cleanupErrors: unknown[] = []

    try {
      const launched = await launchCodeSurfElectron()
      launch = launched
      const { page } = launched
      await waitForElectronBridge(page, 'canvas.save')

      const workspaceId = await page.evaluate(
        async ({ tileId, url }) => {
          const workspace = await window.electron.workspace.create('e2e-browser-behavior')
          await window.electron.canvas.save(workspace.id, {
            tiles: [
              {
                id: tileId,
                type: 'browser',
                label: 'Browser behavior fixture',
                filePath: url,
                x: 80,
                y: 70,
                width: 960,
                height: 650,
                zIndex: 1,
              },
            ],
            groups: [],
            viewport: { tx: 0, ty: 0, zoom: 1 },
            nextZIndex: 2,
          })
          await window.electron.workspace.setActive(workspace.id)
          return workspace.id
        },
        { tileId: TILE_ID, url: startUrl },
      )

      await page.reload()
      await waitForElectronBridge(page, 'canvas.load')
      await dismissAgentSetupIfPresent(page)

      const tile = page.locator(`[data-tile-id="${TILE_ID}"]`)
      const address = tile.locator('input[aria-label="Address"]')
      await expect(tile).toBeVisible({ timeout: 45_000 })
      await expect(address).toHaveValue(startUrl)
      await expect
        .poll(() => requests.filter((path) => path === '/start').length)
        .toBeGreaterThan(0)

      const guest = async (): Promise<GuestSnapshot> =>
        launched.app.evaluate(async ({ webContents }) => {
          const fixtureGuest = webContents
            .getAllWebContents()
            .find(
              (contents) =>
                contents.getType() === 'webview' &&
                contents.getURL().startsWith('http://127.0.0.1:'),
            )
          if (!fixtureGuest) return { url: null, title: null, heading: null }
          const heading = await fixtureGuest
            .executeJavaScript("document.querySelector('#fixture-title')?.textContent ?? null")
            .catch(() => null)
          return {
            url: fixtureGuest.getURL(),
            title: fixtureGuest.getTitle(),
            heading: typeof heading === 'string' ? heading : null,
          }
        })

      await expect.poll(guest).toEqual({
        url: startUrl,
        title: 'CodeSurf Browser Fixture Start',
        heading: 'Start page',
      })

      await address.fill(nextUrl)
      await address.press('Enter')
      await expect.poll(() => requests.filter((path) => path === '/next').length).toBeGreaterThan(0)
      await expect.poll(guest).toEqual({
        url: nextUrl,
        title: 'CodeSurf Browser Fixture Next',
        heading: 'Next page',
      })

      const back = tile.getByRole('button', { name: 'Back' })
      const forward = tile.getByRole('button', { name: 'Forward' })
      await expect(back).toBeEnabled()
      await back.click()
      await expect.poll(guest).toEqual({
        url: startUrl,
        title: 'CodeSurf Browser Fixture Start',
        heading: 'Start page',
      })
      await expect(forward).toBeEnabled()
      await forward.click()
      await expect.poll(guest).toEqual({
        url: nextUrl,
        title: 'CodeSurf Browser Fixture Next',
        heading: 'Next page',
      })

      await tile.getByRole('button', { name: 'Browser evidence' }).click()
      const drawer = tile.getByLabel('Evidence drawer', { exact: true })
      await expect(drawer).toBeVisible()
      await expect(drawer).toContainText('codesurf-browser-fixture-warning:next')
      await drawer.getByRole('button', { name: 'Lifecycle' }).click()
      await expect(drawer).toContainText('Frame finished loading')
      await drawer.getByRole('button', { name: 'Capture snapshot' }).click()
      await expect(drawer).toContainText('Snapshot captured')

      await expect
        .poll(async () =>
          page.evaluate(
            async ({ tileId, nextUrl }) => {
              const history = await window.electron.bus.history(`tile:${tileId}`, 100)
              const event = [...history]
                .reverse()
                .find(
                  (candidate) =>
                    candidate.type === 'browser.evidence.snapshot' &&
                    candidate.payload?.reason === 'user-capture',
                )
              const snapshot = event?.payload?.snapshot as
                | {
                    page?: { url?: string; title?: string }
                    events?: Array<{ kind?: string; message?: string; severity?: string }>
                  }
                | undefined
              return Boolean(
                snapshot?.page?.url === nextUrl &&
                snapshot.page.title === 'CodeSurf Browser Fixture Next' &&
                snapshot.events?.some(
                  (item) =>
                    item.kind === 'console' &&
                    item.severity === 'warning' &&
                    item.message === 'codesurf-browser-fixture-warning:next',
                ) &&
                snapshot.events?.some(
                  (item) => item.kind === 'lifecycle' && item.message === 'Frame finished loading',
                ),
              )
            },
            { tileId: TILE_ID, nextUrl },
          ),
        )
        .toBe(true)

      await expect
        .poll(async () =>
          page.evaluate(
            async ({ id, tileId }) => {
              const state = (await window.electron.canvas.loadTileState(id, tileId)) as {
                addressBar?: unknown
                currentUrl?: unknown
              } | null
              return {
                addressBar: typeof state?.addressBar === 'string' ? state.addressBar : null,
                currentUrl: typeof state?.currentUrl === 'string' ? state.currentUrl : null,
              }
            },
            { id: workspaceId, tileId: TILE_ID },
          ),
        )
        .toEqual({ addressBar: nextUrl, currentUrl: nextUrl })

      const nextRequestsBeforeReload = requests.filter((path) => path === '/next').length
      await page.reload()
      await waitForElectronBridge(page, 'canvas.load')
      await dismissAgentSetupIfPresent(page)

      const restoredTile = page.locator(`[data-tile-id="${TILE_ID}"]`)
      const restoredAddress = restoredTile.locator('input[aria-label="Address"]')
      await expect(restoredTile).toBeVisible({ timeout: 45_000 })
      await expect(restoredAddress).toHaveValue(nextUrl)
      await expect
        .poll(() => requests.filter((path) => path === '/next').length)
        .toBeGreaterThan(nextRequestsBeforeReload)
      await expect.poll(guest).toEqual({
        url: nextUrl,
        title: 'CodeSurf Browser Fixture Next',
        heading: 'Next page',
      })

      const contextDelete = await page.evaluate(
        async ({ id, tileId }) => {
          const key = 'ctx:browser:e2e-delete'
          await Promise.all([
            window.electron.canvas.saveTileState(id, tileId, {
              e2eConcurrentField: 'preserved',
            }),
            window.electron.tileContext?.set(id, tileId, key, { temporary: true }),
          ])
          const beforeDelete = await window.electron.tileContext?.get(id, tileId, key)
          await window.electron.tileContext?.delete(id, tileId, key)
          const afterDelete = await window.electron.tileContext?.get(id, tileId, key)
          const state = (await window.electron.canvas.loadTileState(id, tileId)) as {
            e2eConcurrentField?: unknown
            _context?: Record<string, unknown>
          } | null
          return {
            existed: beforeDelete !== null,
            deleted: afterDelete === null && !state?._context?.[key],
            concurrentField: state?.e2eConcurrentField ?? null,
          }
        },
        { id: workspaceId, tileId: TILE_ID },
      )
      expect(contextDelete).toEqual({
        existed: true,
        deleted: true,
        concurrentField: 'preserved',
      })

      const contextScope = await page.evaluate(
        async ({ primaryWorkspaceId, tileId }) => {
          const secondaryWorkspace = await window.electron.workspace.create('e2e-context-secondary')
          await window.electron.canvas.saveTileState(secondaryWorkspace.id, tileId, {
            marker: 'secondary-preserved',
          })
          await Promise.all([
            window.electron.tileContext?.set(
              primaryWorkspaceId,
              tileId,
              'ctx:scope:e2e',
              'primary',
            ),
            window.electron.tileContext?.set(
              secondaryWorkspace.id,
              tileId,
              'ctx:scope:e2e',
              'secondary',
            ),
          ])
          const [primary, secondary, primaryHistory, secondaryHistory] = await Promise.all([
            window.electron.tileContext?.get(primaryWorkspaceId, tileId, 'ctx:scope:e2e'),
            window.electron.tileContext?.get(secondaryWorkspace.id, tileId, 'ctx:scope:e2e'),
            window.electron.bus.history(`ctx:${primaryWorkspaceId}:${tileId}`, 20),
            window.electron.bus.history(`ctx:${secondaryWorkspace.id}:${tileId}`, 20),
          ])
          return {
            secondaryWorkspaceId: secondaryWorkspace.id,
            primaryValue: (primary as { value?: unknown } | null)?.value ?? null,
            secondaryValue: (secondary as { value?: unknown } | null)?.value ?? null,
            primaryHistoryScoped: primaryHistory.some(
              (event) =>
                event.payload?.workspaceId === primaryWorkspaceId &&
                event.payload?.tileId === tileId,
            ),
            secondaryHistoryScoped: secondaryHistory.some(
              (event) =>
                event.payload?.workspaceId === secondaryWorkspace.id &&
                event.payload?.tileId === tileId,
            ),
          }
        },
        { primaryWorkspaceId: workspaceId, tileId: TILE_ID },
      )
      expect(contextScope).toMatchObject({
        primaryValue: 'primary',
        secondaryValue: 'secondary',
        primaryHistoryScoped: true,
        secondaryHistoryScoped: true,
      })

      const secondaryStatePath = join(
        launched.homeDir,
        '.codesurf',
        'workspaces',
        contextScope.secondaryWorkspaceId,
        '.codesurf',
        `tile-state-${TILE_ID}.json`,
      )
      const [secondaryBytesBefore, secondaryStatBefore] = await Promise.all([
        readFile(secondaryStatePath),
        stat(secondaryStatePath),
      ])
      await page.evaluate(
        async ({ id, tileId }) => {
          await window.electron.tileContext?.delete(id, tileId, 'ctx:missing-no-op')
        },
        { id: contextScope.secondaryWorkspaceId, tileId: TILE_ID },
      )
      const [secondaryBytesAfter, secondaryStatAfter] = await Promise.all([
        readFile(secondaryStatePath),
        stat(secondaryStatePath),
      ])
      expect(secondaryBytesAfter.equals(secondaryBytesBefore)).toBe(true)
      expect(secondaryStatAfter.ino).toBe(secondaryStatBefore.ino)
      expect(secondaryStatAfter.mtimeMs).toBe(secondaryStatBefore.mtimeMs)

      const emptyWorkspaceId = await page.evaluate(async () => {
        const workspace = await window.electron.workspace.create('e2e-context-empty')
        return workspace.id
      })
      const absentStatePath = join(
        launched.homeDir,
        '.codesurf',
        'workspaces',
        emptyWorkspaceId,
        '.codesurf',
        'tile-state-never-written.json',
      )
      await expect(access(absentStatePath)).rejects.toThrow()
      await page.evaluate(
        async ({ id }) => {
          await window.electron.tileContext?.delete(id, 'never-written', 'ctx:missing-no-op')
        },
        { id: emptyWorkspaceId },
      )
      await expect(access(absentStatePath)).rejects.toThrow()
    } catch (error) {
      testError = error
    } finally {
      if (launch) {
        try {
          await closeCodeSurfElectron(launch)
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        await closeServer(server)
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        testError === null ? cleanupErrors : [testError, ...cleanupErrors],
        'BrowserTile E2E execution and cleanup failed',
      )
    }
    if (testError !== null) throw testError
  })
})
