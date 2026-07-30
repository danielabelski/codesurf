import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'
import { build, type Plugin } from 'esbuild'
import {
  MAX_EXTENSION_ID_LENGTH,
  isValidExtensionId,
  resolveExtensionSettingsPath,
} from '../src/main/extensions/identity.ts'
import {
  openCanonicalResource,
  readOpenedCanonicalResourceText,
  streamOpenedCanonicalResource,
} from '../src/main/extensions/resource-path.ts'

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

async function createPluginArchive(
  root: string,
  name: string,
  files: Record<string, unknown>,
): Promise<string> {
  const sourceDir = join(root, `${name}-source`)
  const archivePath = join(root, `${name}.zip`)
  await mkdir(sourceDir, { recursive: true })
  for (const [relativePath, value] of Object.entries(files)) {
    const target = join(sourceDir, relativePath)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value))
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('/usr/bin/zip', ['-q', '-r', archivePath, '.'], {
      cwd: sourceDir,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`zip failed with code ${code}: ${stderr}`))
    })
  })
  return archivePath
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

describe('extension archive identity transaction', () => {
  test('rejects mismatched or invalid effective ids and preserves an existing install', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-install-'))
    const codesurfHome = join(temp, 'home')
    const extensionsDir = join(codesurfHome, 'extensions')
    const existingDir = join(extensionsDir, 'stable-plugin')
    await mkdir(existingDir, { recursive: true })
    await writeFile(join(existingDir, 'extension.json'), JSON.stringify({
      id: 'stable-plugin',
      name: 'Original plugin',
      version: '1.0.0',
      tier: 'safe',
      contributes: {},
    }))
    await writeFile(join(existingDir, 'sentinel.txt'), 'original installation')

    const mismatchArchive = await createPluginArchive(temp, 'mismatch', {
      'package.json': {
        id: 'stable-plugin',
        name: 'Replacement package',
        version: '2.0.0',
      },
      'extension.json': {
        id: 'different-plugin',
        name: 'Different effective plugin',
        version: '2.0.0',
        tier: 'safe',
        contributes: {},
      },
    })
    const invalidArchive = await createPluginArchive(temp, 'invalid', {
      'package.json': {
        id: 'stable-plugin',
        name: 'Invalid replacement',
        version: '2.0.0',
      },
      'extension.json': {
        id: '../escape',
        name: 'Invalid effective plugin',
        version: '2.0.0',
        tier: 'safe',
        contributes: {},
      },
    })
    const adapterMismatchArchive = await createPluginArchive(temp, 'adapter-mismatch', {
      'package.json': {
        id: 'stable-plugin',
        name: 'Adapter replacement',
        version: '2.0.0',
      },
      'SKILL.md': '# Adapter replacement\nDescription: adapter identity test\n',
    })
    const validArchive = await createPluginArchive(temp, 'valid', {
      'package.json': {
        id: 'stable-plugin',
        name: 'Valid replacement',
        version: '2.0.0',
      },
      'extension.json': {
        id: 'stable-plugin',
        name: 'Valid effective plugin',
        version: '2.0.0',
        tier: 'safe',
        contributes: {},
      },
    })
    const freshArchive = await createPluginArchive(temp, 'fresh', {
      'package.json': {
        id: 'fresh-plugin',
        name: 'Fresh package',
        version: '1.0.0',
      },
      'extension.json': {
        id: 'fresh-plugin',
        name: 'Fresh effective plugin',
        version: '1.0.0',
        tier: 'safe',
        contributes: {},
      },
    })

    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    Object.assign(globalThis, { __codesurfInstallIpcHandlers: handlers })
    const electronStub = `
      const handlers = globalThis.__codesurfInstallIpcHandlers
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

    let registerOnRescan = false
    const registered = new Map<string, {
      manifest: {
        id: string
        name: string
        version: string
        _path: string
      }
    }>()
    const registry = {
      getActiveWorkspacePath: () => null,
      rescan: async () => {
        registered.clear()
        if (!registerOnRescan) return
        for (const entry of await readdir(extensionsDir, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('__tmp_')) continue
          const dir = join(extensionsDir, entry.name)
          const manifest = JSON.parse(await readFile(join(dir, 'extension.json'), 'utf8'))
          registered.set(manifest.id, {
            manifest: { ...manifest, _path: dir },
          })
        }
      },
      get: (id: string) => registered.get(id),
      getTileTypes: () => [],
    }
    registerExtensionIPC(registry)
    const install = handlers.get('ext:install-vsix')!

    const mismatch = await install({}, mismatchArchive) as { ok: boolean; error?: string }
    assert.equal(mismatch.ok, false)
    assert.match(mismatch.error ?? '', /does not match effective extension id/)
    assert.equal(await readFile(join(existingDir, 'sentinel.txt'), 'utf8'), 'original installation')

    const invalid = await install({}, invalidArchive) as { ok: boolean; error?: string }
    assert.equal(invalid.ok, false)
    assert.match(invalid.error ?? '', /Invalid extension id/)
    assert.equal(await readFile(join(existingDir, 'sentinel.txt'), 'utf8'), 'original installation')

    const adapterMismatch = await install({}, adapterMismatchArchive) as {
      ok: boolean
      error?: string
    }
    assert.equal(adapterMismatch.ok, false)
    assert.match(adapterMismatch.error ?? '', /effective extension id "pi-stable-plugin"/)
    assert.equal(await readFile(join(existingDir, 'sentinel.txt'), 'utf8'), 'original installation')

    const unregistered = await install({}, validArchive) as { ok: boolean; error?: string }
    assert.equal(unregistered.ok, false)
    assert.match(unregistered.error ?? '', /did not register/)
    assert.equal(await readFile(join(existingDir, 'sentinel.txt'), 'utf8'), 'original installation')

    registerOnRescan = true
    const installed = await install({}, freshArchive) as {
      ok: boolean
      extId?: string
      name?: string
    }
    assert.deepEqual(installed, {
      ok: true,
      extId: 'fresh-plugin',
      name: 'Fresh effective plugin',
      tiles: [],
    })
    assert.equal(
      JSON.parse(await readFile(join(extensionsDir, 'fresh-plugin', 'extension.json'), 'utf8')).id,
      'fresh-plugin',
    )
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

    const normal = await openCanonicalResource(root, nested)
    assert.equal(normal.ok, true)
    if (normal.ok) {
      assert.equal(normal.path, await realpath(nested))
      const text = await readOpenedCanonicalResourceText(normal)
      assert.deepEqual(text, {
        ok: true,
        path: await realpath(nested),
        text: 'inside',
        status: 200,
      })
    }
    assert.deepEqual(
      await openCanonicalResource(root, escape),
      { ok: false, status: 403 },
    )
    assert.deepEqual(
      await openCanonicalResource(root, join(root, 'missing.txt')),
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

    const resource = await openCanonicalResource(linkedRoot, join(linkedRoot, 'index.html'))
    assert.equal(resource.ok, true)
    if (resource.ok) {
      assert.equal(resource.path, await realpath(entry))
      const text = await readOpenedCanonicalResourceText(resource)
      assert.equal(text.ok && text.text, '<html></html>')
    }
  })

  test('streams binary resources from the authenticated handle and caps buffered text', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-stream-'))
    const root = join(temp, 'extension')
    const entry = join(root, 'asset.bin')
    await mkdir(root)
    await writeFile(entry, 'streamed-content')

    const streamed = await openCanonicalResource(root, entry)
    assert.equal(streamed.ok, true)
    if (streamed.ok) {
      const response = new Response(streamOpenedCanonicalResource(streamed))
      assert.equal(await response.text(), 'streamed-content')
      await assert.rejects(streamed.handle.stat())
    }

    const canceled = await openCanonicalResource(root, entry)
    assert.equal(canceled.ok, true)
    if (canceled.ok) {
      await streamOpenedCanonicalResource(canceled).cancel()
      await assert.rejects(canceled.handle.stat())
    }

    const capped = await openCanonicalResource(root, entry)
    assert.equal(capped.ok, true)
    if (capped.ok) {
      assert.deepEqual(
        await readOpenedCanonicalResourceText(capped, 4),
        { ok: false, status: 413 },
      )
      await assert.rejects(capped.handle.stat())
    }
  })

  test('rejects a directory swapped to an external symlink before open', async t => {
    const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-swap-'))
    const root = join(temp, 'extension')
    const assets = join(root, 'assets')
    const movedAssets = join(root, 'assets-original')
    const candidate = join(assets, 'entry.html')
    const externalDir = join(temp, 'external')
    await mkdir(assets, { recursive: true })
    await mkdir(externalDir)
    await writeFile(candidate, '<html>inside</html>')
    await writeFile(join(externalDir, 'entry.html'), '<html>outside</html>')

    const originalOpen = fs.open.bind(fs)
    let swapped = false
    t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
      if (!swapped) {
        swapped = true
        await rename(assets, movedAssets)
        await symlink(externalDir, assets)
      }
      return originalOpen(...args)
    })

    assert.deepEqual(
      await openCanonicalResource(root, candidate),
      { ok: false, status: 403 },
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
