import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { expect } from './node-expect.ts'
import {
  createElectrobunElectronFacade,
  createElectrobunEventHub,
  getDefaultElectrobunInvokeResponse,
  invokeElectrobunWithFallback,
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
        return true
      },
    })
    expect(facade.__codesurfHostKind).toBe('electrobun')

    await facade.workspace.list()
    await facade.settings.get()
    await facade.window.isFresh()
    await facade.shell.openExternal('https://example.com')
    await facade.canvas.queuedMessages.append({ id: 'msg-1' })
    await facade.terminal.updatePeers('tile-1', 'workspace-1', '/tmp/project', [])
    await facade.fs.readFile('/tmp/project/README.md', 'ws-1')
    await facade.fs.watch('/tmp/project', () => {}, 'ws-1')()
    await new Promise(resolve => setImmediate(resolve))

    expect(calls).toEqual([
      { channel: 'workspace:list', args: [] },
      { channel: 'settings:get', args: [] },
      { channel: 'window:isFresh', args: [] },
      { channel: 'shell:openExternal', args: ['https://example.com'] },
      { channel: 'canvas:queuedMessages:append', args: [{ id: 'msg-1' }] },
      {
        channel: 'terminal:update-peers',
        args: ['tile-1', 'workspace-1', '/tmp/project', []],
      },
      { channel: 'fs:readFile', args: ['/tmp/project/README.md', 'ws-1'] },
      { channel: 'fs:watchStart', args: ['/tmp/project', 'ws-1'] },
      { channel: 'fs:watchStop', args: ['/tmp/project', 'ws-1'] },
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

  test('filesystem calls without a renderer scope use the host-owned active workspace id', async () => {
    const calls: ElectrobunInvokeCall[] = []
    const facade = createElectrobunElectronFacade({
      platform: 'darwin',
      homedir: '/Users/tester',
      invoke: async (channel, args) => {
        calls.push({ channel, args })
        return channel === 'workspace:getActive'
          ? { id: 'host-workspace', path: '/trusted/workspace' }
          : true
      },
    })

    await facade.fs.writeFile('/trusted/workspace/note.md', 'content')
    expect(calls).toEqual([
      { channel: 'workspace:getActive', args: [] },
      { channel: 'fs:writeFile', args: ['/trusted/workspace/note.md', 'content', 'host-workspace'] },
    ])
  })

  test('only returns defaults for optional reads when the runtime is unavailable', () => {
    expect(getDefaultElectrobunInvokeResponse('window:isFresh')).toBe(false)
    expect(getDefaultElectrobunInvokeResponse('pets:list')).toEqual([])
    expect(getDefaultElectrobunInvokeResponse('activity:health')).toEqual({
      available: false,
      status: 'unavailable',
    })
    assert.throws(() => getDefaultElectrobunInvokeResponse('workspace:list'))
    assert.throws(() => getDefaultElectrobunInvokeResponse('settings:get'))
    assert.throws(() => getDefaultElectrobunInvokeResponse('canvas:load'))
    assert.throws(() => getDefaultElectrobunInvokeResponse('bus:publish'))
    assert.throws(() => getDefaultElectrobunInvokeResponse('activity:upsert'))
  })

  test('preserves an authoritative null host response', async () => {
    expect(await invokeElectrobunWithFallback('canvas:load', async () => null)).toBe(null)
  })

  test('unavailable secrets are explicit failures, never fake successful writes', () => {
    expect(getDefaultElectrobunInvokeResponse('secrets:set')).toMatchObject({ ok: false })
    expect(getDefaultElectrobunInvokeResponse('secrets:delete')).toMatchObject({ ok: false })
    expect(getDefaultElectrobunInvokeResponse('secrets:list')).toMatchObject({ ok: false, names: [] })
    expect(getDefaultElectrobunInvokeResponse('secrets:has')).toMatchObject({ ok: false, has: false })
  })

  test('RPC faults propagate for secrets, filesystem writes, workspace mutations, and permission replies', async () => {
    const channels = [
      'secrets:set',
      'fs:writeFile',
      'workspace:create',
      'chat:answerToolPermission',
    ]
    for (const channel of channels) {
      await assert.rejects(
        invokeElectrobunWithFallback(channel, async () => {
          throw new Error(`fault:${channel}`)
        }),
        new RegExp(`fault:${channel}`),
      )
    }
  })
})
