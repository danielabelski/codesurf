import { Electroview } from 'electrobun/view'
import type { CodeSurfElectrobunRPC } from '../../src/shared/electrobun-rpc.ts'
import {
  createElectrobunElectronFacade,
  createElectrobunEventHub,
  detectPlatformFromUserAgent,
  getDefaultElectrobunInvokeResponse,
} from '../../src/electrobun/browser/electron-facade.ts'

const eventHub = createElectrobunEventHub()

const rpc = Electroview.defineRPC<CodeSurfElectrobunRPC>({
  handlers: {
    requests: {
      ping: () => true,
    },
    messages: {
      event: ({ channel, payload }) => {
        eventHub.emit(channel, payload)
      },
    },
  },
})

const electroview = new Electroview({ rpc })

const invoke = async (channel: string, args: unknown[]): Promise<unknown> => {
  try {
    const result = await electroview.rpc?.request.invoke({ channel, args })
    return result ?? getDefaultElectrobunInvokeResponse(channel)
  } catch (error) {
    console.warn(`[Electrobun] Falling back for ${channel}:`, error)
    return getDefaultElectrobunInvokeResponse(channel)
  }
}

const platform = detectPlatformFromUserAgent(globalThis.navigator?.userAgent ?? '')
const homedir = ''

const facade = createElectrobunElectronFacade({
  invoke,
  platform,
  homedir,
  eventHub,
})

Object.defineProperty(globalThis, 'electron', {
  value: facade,
  configurable: true,
  enumerable: false,
  writable: false,
})

Object.defineProperty(globalThis, '__codesurfElectrobun', {
  value: {
    runtime: 'electrobun',
    rpcReady: true,
    platform,
  },
  configurable: true,
  enumerable: false,
  writable: false,
})

try {
  electroview.rpc?.send.bridgeReady({
    platform,
    hasElectronFacade: Boolean((globalThis as any).electron),
    hasElectrobunWebviewTag: Boolean(globalThis.customElements?.get('electrobun-webview')),
    userAgent: globalThis.navigator?.userAgent,
  })
} catch (error) {
  console.warn('[Electrobun] bridgeReady message failed:', error)
}
