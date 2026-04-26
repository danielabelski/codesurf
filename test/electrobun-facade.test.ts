import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  createElectrobunElectronFacade,
  createElectrobunEventHub,
  getDefaultElectrobunInvokeResponse,
  type ElectrobunInvokeCall,
} from '../src/electrobun/browser/electron-facade.ts'

describe('Electrobun window.electron facade', () => {
  test('maps startup-critical facade methods to existing Electron IPC channel names', async () => {
    const calls: ElectrobunInvokeCall[] = []
    const facade = createElectrobunElectronFacade({
      platform: 'darwin',
      homedir: '/Users/tester',
      invoke: async (channel, args) => {
        calls.push({ channel, args })
        return getDefaultElectrobunInvokeResponse(channel)
      },
    })

    await facade.workspace.list()
    await facade.settings.get()
    await facade.window.isFresh()
    await facade.shell.openExternal('https://example.com')
    await facade.canvas.queuedMessages.append({ id: 'msg-1' })
    await facade.terminal.updatePeers('tile-1', '/tmp/project', [])

    expect(calls).toEqual([
      { channel: 'workspace:list', args: [] },
      { channel: 'settings:get', args: [] },
      { channel: 'window:isFresh', args: [] },
      { channel: 'shell:openExternal', args: ['https://example.com'] },
      { channel: 'canvas:queuedMessages:append', args: [{ id: 'msg-1' }] },
      { channel: 'terminal:update-peers', args: ['tile-1', '/tmp/project', []] },
    ])
  })

  test('dispatches one-way runtime events to subscribed preload-style callbacks', () => {
    const hub = createElectrobunEventHub()
    const seen: unknown[] = []
    const cleanup = hub.on('bus:event', payload => seen.push(payload))

    hub.emit('bus:event', { channel: 'themes', payload: { mode: 'dark' } })
    cleanup()
    hub.emit('bus:event', { channel: 'themes', payload: { mode: 'light' } })

    expect(seen).toEqual([{ channel: 'themes', payload: { mode: 'dark' } }])
  })

  test('returns startup-safe defaults if the Electrobun runtime is temporarily unavailable', () => {
    expect(getDefaultElectrobunInvokeResponse('workspace:list')).toEqual([])
    expect(getDefaultElectrobunInvokeResponse('settings:get')).toMatchObject({ appearance: 'dark' })
    expect(getDefaultElectrobunInvokeResponse('window:isFresh')).toBe(false)
    expect(getDefaultElectrobunInvokeResponse('canvas:load')).toBe(null)
    expect(getDefaultElectrobunInvokeResponse('bus:publish')).toBe(true)
  })
})
