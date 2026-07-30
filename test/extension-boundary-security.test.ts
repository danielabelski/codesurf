import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'
import { build, type Plugin } from 'esbuild'
import {
  MAX_EXTENSION_ID_LENGTH,
  isValidExtensionId,
  resolveExtensionSettingsPath,
} from '../src/main/extensions/identity.ts'
import { resolveCanonicalResourcePath } from '../src/main/extensions/resource-path.ts'

async function bundleMainModule(
  entryPoint: string,
  electronStubSource: string,
  env: Record<string, string> = {},
) {
  const bundleDir = await mkdtemp(join(tmpdir(), 'codesurf-main-module-test-'))
  const outfile = join(bundleDir, 'module.cjs')
  const electronStub: Plugin = {
    name: 'electron-stub',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({
        path: 'electron',
        namespace: 'electron-stub',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents: electronStubSource,
        loader: 'js',
      }))
    },
  }
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    plugins: [electronStub],
    logLevel: 'silent',
  })

  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  try {
    return await import(`${pathToFileURL(outfile).href}?test=${Date.now()}-${Math.random()}`)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

async function findExtensionManifests(root: string): Promise<string[]> {
  const manifests: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile() && entry.name === 'extension.json') {
        manifests.push(path)
      }
    }
  }
  await walk(root)
  return manifests
}

describe('extension identity boundary', () => {
  test('accepts the documented grammar and rejects traversal-shaped ids', () => {
    for (const id of ['a', 'a1', 'source-control', 'hello.world', 'hello_world']) {
      assert.equal(isValidExtensionId(id), true, id)
    }

    for (const id of [
      '',
      '.',
      '..',
      '../mcp-server',
      'mcp/server',
      'mcp\\server',
      'mcp%2fserver',
      'Uppercase',
      '-leading',
      'trailing.',
      'empty..segment',
      'empty--segment',
      'control\ncharacter',
      'a'.repeat(MAX_EXTENSION_ID_LENGTH + 1),
    ]) {
      assert.equal(isValidExtensionId(id), false, id)
    }
  })

  test('all tracked extension manifests use valid ids', async () => {
    const manifests = (
      await Promise.all([
        findExtensionManifests(join(process.cwd(), 'bundled-extensions')),
        findExtensionManifests(join(process.cwd(), 'examples', 'extensions')),
        findExtensionManifests(join(process.cwd(), 'test', 'fixtures')),
      ])
    ).flat()
    assert.ok(manifests.length > 0)

    for (const manifestPath of manifests) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { id?: unknown }
      assert.equal(isValidExtensionId(manifest.id), true, manifestPath)
    }
  })

  test('settings path validation rejects hostile ids before any write', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-settings-'))
    const settingsRoot = join(temp, 'extension-settings')
    await mkdir(settingsRoot)

    for (const id of [
      '../mcp-server',
      'nested/id',
      'nested\\id',
      'encoded%2fid',
      'Uppercase',
      'a'.repeat(MAX_EXTENSION_ID_LENGTH + 1),
    ]) {
      await assert.rejects(async () => {
        const candidate = resolveExtensionSettingsPath(settingsRoot, id)
        await writeFile(candidate, 'should not be written')
      }, /Invalid extension id/)
    }

    assert.deepEqual(await readdir(settingsRoot), [])
    await assert.rejects(access(join(temp, 'mcp-server.json')))
  })

  test('settings, store, and bridge IPC enforce identity and registry boundaries', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-ipc-'))
    const codesurfHome = join(temp, 'home')
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    Object.assign(globalThis, { __codesurfIpcHandlers: handlers })
    const electronStub = `
      const handlers = globalThis.__codesurfIpcHandlers
      export const ipcMain = {
        handle(channel, handler) { handlers.set(channel, handler) },
        removeHandler() {},
      }
      export const BrowserWindow = {
        fromWebContents() { return null },
        getFocusedWindow() { return null },
      }
      export const dialog = {}
      export const app = { getPath() { return ${JSON.stringify(temp)} } }
      export const net = {}
      export const protocol = {}
      export const safeStorage = {
        isEncryptionAvailable() { return false },
        encryptString(value) { return Buffer.from(value) },
        decryptString(value) { return Buffer.from(value).toString('utf8') },
      }
      export const session = {}
      export const utilityProcess = {}
    `
    const { registerExtensionIPC } = await bundleMainModule(
      'src/main/ipc/extensions.ts',
      electronStub,
      { CODESURF_HOME: codesurfHome },
    )
    const extension = {
      manifest: {
        id: 'safe-extension',
        name: 'Safe Extension',
        version: '1.0.0',
        tier: 'safe',
        _enabled: true,
        contributes: {
          settings: [{ key: 'token', type: 'string', default: 'default' }],
        },
      },
    }
    const registry = {
      get: (id: string) => id === 'safe-extension' ? extension : undefined,
      getCapabilityGate: () => ({ enforced: false, granted: [] }),
    }
    registerExtensionIPC(registry)

    const settingsGet = handlers.get('ext:settings-get')!
    const settingsSet = handlers.get('ext:settings-set')!
    const storeGet = handlers.get('ext:store-get')!
    const storeSet = handlers.get('ext:store-set')!
    const storeReplace = handlers.get('ext:store-replace')!
    const bridge = handlers.get('ext:get-bridge-script')!
    const capabilityGate = handlers.get('ext:capability-gate')!
    const hostileIds = [
      '../outside',
      'nested/id',
      'nested\\id',
      'encoded%2fid',
      'Uppercase',
      'a'.repeat(MAX_EXTENSION_ID_LENGTH + 1),
    ]

    for (const id of hostileIds) {
      await assert.rejects(async () => settingsGet({}, id), /Invalid extension id/)
      await assert.rejects(async () => settingsSet({}, id, { token: 'secret' }), /Invalid extension id/)
      await assert.rejects(async () => storeGet({}, id), /Invalid extension id/)
      await assert.rejects(async () => storeSet({}, id, { value: 1 }), /Invalid extension id/)
      await assert.rejects(async () => storeReplace({}, id, { value: 1 }), /Invalid extension id/)
      assert.throws(() => bridge({}, 'tile-1', id), /Invalid extension id/)
      assert.throws(() => capabilityGate({}, id), /Invalid extension id/)
    }

    assert.deepEqual(await settingsGet({}, 'unknown-extension'), {})
    assert.equal(await settingsSet({}, 'unknown-extension', { token: 'secret' }), false)
    await assert.rejects(async () => storeGet({}, 'unknown-extension'), /not registered/)
    assert.throws(() => bridge({}, 'tile-1', 'unknown-extension'), /not registered/)
    assert.throws(() => capabilityGate({}, 'unknown-extension'), /not registered/)

    assert.equal(await settingsSet({}, 'safe-extension', { token: 'saved', ignored: true }), true)
    assert.deepEqual(await settingsGet({}, 'safe-extension'), { token: 'saved' })
    const settingsDir = join(codesurfHome, 'extension-settings')
    const settingsFile = join(settingsDir, 'safe-extension.json')
    assert.equal((await stat(settingsDir)).mode & 0o777, 0o700)
    assert.equal((await stat(settingsFile)).mode & 0o777, 0o600)
    assert.match(bridge({}, 'tile-1', 'safe-extension') as string, /safe-extension/)
    assert.deepEqual(capabilityGate({}, 'safe-extension'), { enforced: false, granted: [] })
    assert.deepEqual(await storeSet({}, 'safe-extension', { value: 1 }), { value: 1 })
    assert.deepEqual(await storeGet({}, 'safe-extension'), { value: 1 })

    await assert.rejects(access(join(temp, 'outside.json')))
    await assert.rejects(access(join(codesurfHome, 'outside.json')))
  })
})

describe('canonical extension resource boundary', () => {
  test('serves nested files, rejects child symlink escapes, and reports missing files', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-assets-'))
    const root = join(temp, 'extension')
    const nested = join(root, 'assets', 'nested.txt')
    const external = join(temp, 'outside.txt')
    const escape = join(root, 'assets', 'escape.txt')
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(nested, 'inside')
    await writeFile(external, 'outside')
    await symlink(external, escape)

    const normal = await resolveCanonicalResourcePath(root, nested)
    assert.deepEqual(normal, { ok: true, path: await realpath(nested), status: 200 })
    assert.deepEqual(
      await resolveCanonicalResourcePath(root, escape),
      { ok: false, status: 403 },
    )
    assert.deepEqual(
      await resolveCanonicalResourcePath(root, join(root, 'missing.txt')),
      { ok: false, status: 404 },
    )
  })

  test('canonicalizes a deliberate extension-root symlink without allowing child escape', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-root-link-'))
    const realRoot = join(temp, 'real-extension')
    const linkedRoot = join(temp, 'linked-extension')
    const entry = join(realRoot, 'index.html')
    await mkdir(realRoot)
    await writeFile(entry, '<html></html>')
    await symlink(realRoot, linkedRoot)

    assert.deepEqual(
      await resolveCanonicalResourcePath(linkedRoot, join(linkedRoot, 'index.html')),
      { ok: true, path: await realpath(entry), status: 200 },
    )
  })

  test('protocol routes serve canonical children and reject missing or escaped resources', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-protocol-'))
    const root = join(temp, 'extension')
    const nested = join(root, 'assets', 'nested.html')
    const external = join(temp, 'outside.html')
    const escape = join(root, 'assets', 'escape.html')
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(nested, '<html>inside</html>')
    await writeFile(external, '<html>outside</html>')
    await symlink(external, escape)

    const protocolState: { handler?: (request: { url: string }) => Promise<Response> } = {}
    Object.assign(globalThis, { __codesurfProtocolState: protocolState })
    const electronStub = `
      const state = globalThis.__codesurfProtocolState
      export const protocol = {
        registerSchemesAsPrivileged() {},
        handle(_scheme, handler) { state.handler = handler },
      }
      export const net = {
        fetch() { throw new Error('net.fetch is not expected in this test') },
      }
    `
    const { registerExtensionProtocol } = await bundleMainModule(
      'src/main/extensions/protocol.ts',
      electronStub,
    )
    const extension = {
      manifest: {
        id: 'safe-extension',
        _path: root,
        _enabled: true,
      },
    }
    registerExtensionProtocol({
      get: (id: string) => id === 'safe-extension' ? extension : undefined,
      getCapabilityGate: () => ({ enforced: false, granted: [] }),
    })
    const handle = protocolState.handler!

    const nestedResponse = await handle({
      url: 'codesurf-ext://safe-extension/assets/nested.html',
    })
    assert.equal(nestedResponse.status, 200)
    assert.equal(await nestedResponse.text(), '<html>inside</html>')

    const missingResponse = await handle({
      url: 'codesurf-ext://safe-extension/assets/missing.html',
    })
    assert.equal(missingResponse.status, 404)

    const escapeResponse = await handle({
      url: 'codesurf-ext://safe-extension/assets/escape.html',
    })
    assert.equal(escapeResponse.status, 403)
    assert.doesNotMatch(await escapeResponse.text(), /outside/)

    const resourcePath = nested
      .split('/')
      .filter(Boolean)
      .map(segment => encodeURIComponent(segment))
      .join('/')
    const resourceResponse = await handle({
      url: `codesurf-ext://__runext_resource__/safe-extension/${resourcePath}`,
    })
    assert.equal(resourceResponse.status, 200)
    assert.equal(await resourceResponse.text(), '<html>inside</html>')

    const escapePath = escape
      .split('/')
      .filter(Boolean)
      .map(segment => encodeURIComponent(segment))
      .join('/')
    const escapedResourceResponse = await handle({
      url: `codesurf-ext://__runext_resource__/safe-extension/${escapePath}`,
    })
    assert.equal(escapedResourceResponse.status, 403)
    assert.doesNotMatch(await escapedResourceResponse.text(), /outside/)
  })
})
