import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  ExtensionMediaConsentManager,
  ExtensionMediaConsentStore,
} from '../src/main/security/extensionMediaConsent.ts'
import {
  getDeclaredSensitiveMediaCapabilities,
  getExtensionIframeAllow,
} from '../src/shared/extension-sensitive-media.ts'

describe('extension sensitive media consent', () => {
  test('persists exact extension and kind decisions atomically with mode 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-consent-'))
    const filePath = join(directory, 'consent.json')
    const store = new ExtensionMediaConsentStore({ filePath })

    await store.setDecision('camera-tools', 'camera', 'allow')
    await store.setDecision('camera-tools', 'microphone', 'deny')

    const restarted = new ExtensionMediaConsentStore({ filePath })
    await restarted.ready
    assert.equal(restarted.getDecision('camera-tools', 'camera'), 'allow')
    assert.equal(restarted.getDecision('camera-tools', 'microphone'), 'deny')
    assert.equal(restarted.getDecision('other-extension', 'camera'), undefined)
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600)
    assert.deepEqual(
      (await fs.readdir(directory)).filter(name => name.includes('.tmp')),
      [],
    )
  })

  test('does not import generic grants, legacy shapes, or malformed identities', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-legacy-'))
    const filePath = join(directory, 'consent.json')
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      decisions: {
        '../attacker': { camera: 'allow' },
        valid: {
          camera: 'allow',
          geolocation: 'allow',
          microphone: 'maybe',
        },
      },
      grants: {
        grandfathered: ['camera', 'microphone'],
      },
    }))
    await fs.writeFile(
      join(directory, 'plugin-capability-grants.json'),
      JSON.stringify({ grandfathered: ['camera'] }),
    )

    const store = new ExtensionMediaConsentStore({ filePath })
    await store.ready
    assert.equal(store.getDecision('../attacker', 'camera'), undefined)
    assert.equal(store.getDecision('valid', 'camera'), 'allow')
    assert.equal(store.getDecision('valid', 'microphone'), undefined)
    assert.equal(store.getDecision('grandfathered', 'camera'), undefined)
  })

  test('deduplicates identical prompts, serializes distinct prompts, and persists denial on failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-prompts-'))
    const store = new ExtensionMediaConsentStore({
      filePath: join(directory, 'consent.json'),
    })
    const calls: string[] = []
    let activePrompts = 0
    let maximumActivePrompts = 0
    let releaseFirst: (() => void) | undefined
    const firstPrompt = new Promise<void>(resolve => { releaseFirst = resolve })
    const manager = new ExtensionMediaConsentManager(store, async request => {
      activePrompts += 1
      maximumActivePrompts = Math.max(maximumActivePrompts, activePrompts)
      calls.push(`${request.extensionId}:${request.kind}`)
      if (calls.length === 1) await firstPrompt
      activePrompts -= 1
      if (request.extensionId === 'broken-extension') throw new Error('dialog failed')
      return request.kind === 'camera'
    })
    await manager.ready

    const cameraA = manager.requestConsent({
      extensionId: 'media-extension',
      extensionName: 'Media Extension',
      kind: 'camera',
    })
    const cameraB = manager.requestConsent({
      extensionId: 'media-extension',
      extensionName: 'Media Extension',
      kind: 'camera',
    })
    const microphone = manager.requestConsent({
      extensionId: 'media-extension',
      extensionName: 'Media Extension',
      kind: 'microphone',
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(calls, ['media-extension:camera'])
    releaseFirst?.()

    assert.deepEqual(await Promise.all([cameraA, cameraB, microphone]), [true, true, false])
    assert.equal(maximumActivePrompts, 1)
    assert.deepEqual(calls, [
      'media-extension:camera',
      'media-extension:microphone',
    ])
    assert.equal(
      await manager.requestConsent({
        extensionId: 'media-extension',
        extensionName: 'Media Extension',
        kind: 'camera',
      }),
      true,
    )
    assert.equal(calls.length, 2)

    assert.equal(
      await manager.requestConsent({
        extensionId: 'broken-extension',
        extensionName: 'Broken Extension',
        kind: 'camera',
      }),
      false,
    )
    assert.equal(store.getDecision('broken-extension', 'camera'), 'deny')
  })

  test('revocation removes every decision for only the selected extension', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-revoke-'))
    const filePath = join(directory, 'consent.json')
    const store = new ExtensionMediaConsentStore({ filePath })
    await store.setDecision('one-extension', 'camera', 'allow')
    await store.setDecision('one-extension', 'microphone', 'deny')
    await store.setDecision('two-extension', 'camera', 'allow')

    await store.revokeExtension('one-extension')
    const restarted = new ExtensionMediaConsentStore({ filePath })
    await restarted.ready
    assert.equal(restarted.getDecision('one-extension', 'camera'), undefined)
    assert.equal(restarted.getDecision('one-extension', 'microphone'), undefined)
    assert.equal(restarted.getDecision('two-extension', 'camera'), 'allow')
  })

  test('disable during an open prompt cannot resurrect consent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'codesurf-media-prompt-revoke-'))
    const filePath = join(directory, 'consent.json')
    const store = new ExtensionMediaConsentStore({ filePath })
    let markPromptStarted: (() => void) | undefined
    let releasePrompt: (() => void) | undefined
    const promptStarted = new Promise<void>(resolve => { markPromptStarted = resolve })
    const promptBlocked = new Promise<void>(resolve => { releasePrompt = resolve })
    const manager = new ExtensionMediaConsentManager(store, async () => {
      markPromptStarted?.()
      await promptBlocked
      return true
    })
    const request = manager.requestConsent({
      extensionId: 'racy-extension',
      extensionName: 'Racy Extension',
      kind: 'camera',
    })
    await promptStarted

    const revoked = manager.revokeExtension('racy-extension')
    releasePrompt?.()
    assert.equal(await request, false)
    await revoked

    const restarted = new ExtensionMediaConsentStore({ filePath })
    await restarted.ready
    assert.equal(restarted.getDecision('racy-extension', 'camera'), undefined)
    assert.equal(manager.hasConsent('racy-extension', 'camera'), false)
  })

  test('derives iframe allow directives only from declared sensitive capabilities', () => {
    const declared = getDeclaredSensitiveMediaCapabilities([
      { name: 'network' },
      { name: 'camera' },
      { name: 'camera' },
      { name: 'microphone' },
    ])
    assert.deepEqual(declared, ['microphone', 'camera'])
    assert.equal(getExtensionIframeAllow(declared), 'autoplay; microphone; camera')
    assert.equal(getExtensionIframeAllow(undefined), 'autoplay')
  })

  test('LiveKit declares microphone and camera only, without display capture', async () => {
    const manifest = JSON.parse(await fs.readFile(
      join(process.cwd(), 'bundled-extensions/livekit-rooms/extension.json'),
      'utf8',
    )) as { capabilities?: Array<{ name?: string }> }
    assert.deepEqual(
      manifest.capabilities?.map(capability => capability.name),
      ['microphone', 'camera'],
    )
  })

  test('renderer surfaces do not retain blanket media iframe policies', async () => {
    const [extensionTile, pluginSurface, chatTile] = await Promise.all([
      fs.readFile(join(process.cwd(), 'src/renderer/src/components/ExtensionTile.tsx'), 'utf8'),
      fs.readFile(join(process.cwd(), 'src/renderer/src/components/PluginSurface.tsx'), 'utf8'),
      fs.readFile(join(process.cwd(), 'src/renderer/src/components/ChatTileWebview.tsx'), 'utf8'),
    ])
    assert.doesNotMatch(extensionTile, /allow="camera; microphone; display-capture/)
    assert.doesNotMatch(pluginSurface, /allow="camera; microphone; display-capture/)
    assert.doesNotMatch(chatTile, /allow="microphone"/)
    assert.match(
      extensionTile,
      /MCP-UI proxy frames deliberately receive no sensitive media policy/,
    )
  })
})
