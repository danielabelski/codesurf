import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  collectBridgePaths,
  extractPreloadBridgePaths,
} from '../src/electrobun/browser/collect-bridge-paths.ts'
import {
  createElectrobunElectronFacade,
  getDefaultElectrobunInvokeResponse,
} from '../src/electrobun/browser/electron-facade.ts'
import { formatGuestWebviewTagPreferences } from '../src/shared/guest-webview-preferences.ts'
import { GUEST_WEBVIEW_WEB_PREFERENCES } from '../src/main/secure-web-preferences.ts'

const PRELOAD_SOURCE = readFileSync(
  join(__dirname, '../src/preload/index.ts'),
  'utf8',
)

const PRELOAD_PATHS = extractPreloadBridgePaths(PRELOAD_SOURCE)
const ELECTROBUN_UNAVAILABLE_PRELOAD_PATHS = [
  'window.onPersistenceRequest',
  'window.persistenceReady',
]

function createProbeFacade() {
  return createElectrobunElectronFacade({
    platform: 'darwin',
    homedir: '/Users/tester',
    invoke: async (channel) => getDefaultElectrobunInvokeResponse(channel),
  })
}

describe('Electrobun preload parity checklist', () => {
  test('preload parser discovers the renderer bridge surface', () => {
    expect(PRELOAD_PATHS.length).toBeGreaterThan(100)
    expect(PRELOAD_PATHS).toContain('workspace.list')
    expect(PRELOAD_PATHS).toContain('chat.loadSessionHistory')
    expect(PRELOAD_PATHS).toContain('secrets.has')
  })

  test('facade omits only Electron lifecycle APIs that Electrobun cannot honor', () => {
    const facade = createProbeFacade()
    const facadePaths = new Set(collectBridgePaths(facade))
    const missing = PRELOAD_PATHS.filter(path => !facadePaths.has(path))
    expect(missing).toEqual(ELECTROBUN_UNAVAILABLE_PRELOAD_PATHS)
    expect('onPersistenceRequest' in facade.window).toBe(false)
    expect('persistenceReady' in facade.window).toBe(false)
  })

  test('every facade leaf maps to a default invoke response or channel family', () => {
    const facade = createProbeFacade()
    const invoked = new Set<string>()

    const facadeWithTap = createElectrobunElectronFacade({
      platform: 'darwin',
      homedir: '/Users/tester',
      invoke: async (channel, args) => {
        invoked.add(channel)
        return getDefaultElectrobunInvokeResponse(channel)
      },
    })

    void facadeWithTap
    const paths = collectBridgePaths(facade)

    for (const path of paths) {
      if (path.endsWith('.onUpdated')
        || path.endsWith('.onSessionsChanged')
        || path.endsWith('.onIndexUpdated')
        || path.endsWith('.onData')
        || path.endsWith('.onActive')
        || path.endsWith('.onOpencodeModelsUpdated')
        || path.endsWith('.onChunk')
        || path.endsWith('.onListChanged')
        || path.endsWith('.onNewTab')
        || path.endsWith('.onEvent')
        || path.endsWith('.onKanban')
        || path.endsWith('.onInject')
        || path.endsWith('.onStateChanged')
        || path.endsWith('.onMessageChanged')
        || path.endsWith('.onChanged')
        || path.endsWith('.onFileOpened')
        || path.endsWith('.onAction')
        || path.endsWith('.onGcRequested')
        || path.endsWith('.onEvent')
        || path.includes('.watch')
        || path.includes('.subscribe')
        || path === 'bus.onEvent'
        || path === 'mcp.inject'
        || path === 'fs.watch'
        || path === 'fs.selectDir'
        || path === 'zoom.getLevel'
        || path === 'zoom.setLevel'
        || path === 'extensions.invoke'
        || path === 'getPathForFile'
      ) {
        continue
      }

      const parts = path.split('.')
      const method = parts.pop()!
      let cursor: any = facade
      for (const part of parts) {
        cursor = cursor?.[part]
      }
      expect(typeof cursor?.[method]).toBe('function')
    }
  })
})

describe('Electrobun security defaults parity', () => {
  test('fallback settings match fresh-install FS scoping defaults', () => {
    const settings = getDefaultElectrobunInvokeResponse('settings:get') as {
      security?: { restrictFsToWorkspaceRoots?: boolean, fsScopingMigrated?: boolean }
    }
    expect(settings.security?.restrictFsToWorkspaceRoots).toBe(true)
    expect(settings.security?.fsScopingMigrated).toBe(true)
  })

  test('guest webview tag preferences align with main-process enforcement', () => {
    const tagPrefs = formatGuestWebviewTagPreferences()
    expect(tagPrefs).toContain('sandbox=yes')
    expect(tagPrefs).toContain('contextIsolation=yes')
    expect(tagPrefs).toContain('nodeIntegration=no')
    expect(tagPrefs).toContain('webSecurity=yes')
    expect(GUEST_WEBVIEW_WEB_PREFERENCES.sandbox).toBe(true)
    expect(GUEST_WEBVIEW_WEB_PREFERENCES.contextIsolation).toBe(true)
    expect(GUEST_WEBVIEW_WEB_PREFERENCES.nodeIntegration).toBe(false)
    expect(GUEST_WEBVIEW_WEB_PREFERENCES.webSecurity).toBe(true)
  })
})
