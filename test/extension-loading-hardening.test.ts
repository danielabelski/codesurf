import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build, type Plugin } from 'esbuild'

async function loadRegistryModule(codesurfHome: string) {
  const bundleDir = await mkdtemp(join(tmpdir(), 'codesurf-registry-test-'))
  const outfile = join(bundleDir, 'registry.mjs')
  const electronStub: Plugin = {
    name: 'electron-stub',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({
        path: 'electron',
        namespace: 'electron-stub',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents: [
          'export const app = {}',
          'export const BrowserWindow = {}',
          'export const dialog = {}',
          'export const ipcMain = {}',
          'export const net = {}',
          'export const protocol = {}',
          'export const safeStorage = {}',
          'export const session = {}',
          'export const utilityProcess = {}',
        ].join('\n'),
        loader: 'js',
      }))
    },
  }

  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ['src/main/extensions/registry.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    plugins: [electronStub],
    logLevel: 'silent',
  })

  const previousHome = process.env.CODESURF_HOME
  process.env.CODESURF_HOME = codesurfHome
  try {
    return await import(`${pathToFileURL(outfile).href}?test=${Date.now()}`)
  } finally {
    if (previousHome === undefined) delete process.env.CODESURF_HOME
    else process.env.CODESURF_HOME = previousHome
  }
}

async function loadExtensionIpcModule(
  codesurfHome: string,
  handlers: Map<string, (...args: unknown[]) => unknown>,
) {
  const bundleDir = await mkdtemp(join(tmpdir(), 'codesurf-extension-ipc-test-'))
  const outfile = join(bundleDir, 'extensions-ipc.cjs')
  Object.assign(globalThis, { __codesurfExtensionLoadingHandlers: handlers })
  const electronStub: Plugin = {
    name: 'electron-stub',
    setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({
        path: 'electron',
        namespace: 'electron-stub',
      }))
      builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
        contents: [
          'const handlers = globalThis.__codesurfExtensionLoadingHandlers',
          'export const ipcMain = { handle(channel, handler) { handlers.set(channel, handler) }, removeHandler() {} }',
          'export const BrowserWindow = { fromWebContents() { return null }, getFocusedWindow() { return null } }',
          'export const dialog = {}',
          'export const app = {}',
          'export const net = {}',
          'export const protocol = {}',
          'export const safeStorage = {',
          '  isEncryptionAvailable() { return false },',
          '  encryptString(value) { return Buffer.from(value) },',
          '  decryptString(value) { return Buffer.from(value).toString("utf8") },',
          '}',
          'export const session = {}',
          'export const utilityProcess = {}',
        ].join('\n'),
        loader: 'js',
      }))
    },
  }

  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ['src/main/ipc/extensions.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    plugins: [electronStub],
    logLevel: 'silent',
  })

  const previousHome = process.env.CODESURF_HOME
  process.env.CODESURF_HOME = codesurfHome
  try {
    return await import(`${pathToFileURL(outfile).href}?test=${Date.now()}-${Math.random()}`)
  } finally {
    if (previousHome === undefined) delete process.env.CODESURF_HOME
    else process.env.CODESURF_HOME = previousHome
  }
}

async function writeWorkspaceExtension(
  workspace: string,
  directory: string,
  id: string,
  tileType: string,
  extraTiles: Array<{ type: string; label: string; entry: string }> = [],
): Promise<string> {
  const extDir = join(workspace, '.codesurf', 'extensions', directory)
  await mkdir(extDir, { recursive: true })
  await writeFile(join(extDir, 'index.html'), '<html></html>')
  await writeFile(join(extDir, 'extension.json'), JSON.stringify({
    id,
    name: id,
    version: '1.0.0',
    tier: 'safe',
    contributes: {
      tiles: [{ type: tileType, label: id, entry: 'index.html' }, ...extraTiles],
    },
  }))
  return extDir
}

test('broker host replaces owned extension IPC handlers before re-registering', () => {
  const source = readFileSync(`${process.cwd()}/src/main/extensions/broker/host.ts`, 'utf8')

  assert.match(source, /const expectedPrefix = `ext:\$\{extId\}:`/)
  assert.match(source, /if \(this\.ipcChannels\.includes\(fullChannel\)\) \{\s*ipcMain\.removeHandler\(fullChannel\)/s)
  assert.match(source, /this\.ipcChannels = this\.ipcChannels\.filter\(channel => channel !== fullChannel\)/)
  assert.match(source, /this\.ipcChannels\.push\(fullChannel\)/)
})

test('extension IPC loading coalesces in-flight scans for the same workspace', () => {
  const source = readFileSync(`${process.cwd()}/src/main/ipc/extensions.ts`, 'utf8')

  assert.match(source, /let inFlightLoad: \{ workspacePath: string \| null; promise: Promise<void> \} \| null = null/)
  assert.match(source, /inFlightLoad && inFlightLoad\.workspacePath === targetWorkspacePath/)
  assert.match(source, /await inFlightLoad\.promise/)
  assert.match(source, /inFlightLoad = \{ workspacePath: targetWorkspacePath, promise: loadPromise \}/)
})

test('lightweight discovery establishes the executable workspace and replaces it on switch', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-workspace-transition-'))
  const codesurfHome = join(temp, 'home')
  const workspaceA = join(temp, 'workspace-a')
  const workspaceB = join(temp, 'workspace-b')
  const invalidDir = await writeWorkspaceExtension(
    workspaceA,
    'invalid',
    '../mcp-server',
    'escape',
  )
  const alphaDir = await writeWorkspaceExtension(
    workspaceA,
    'alpha',
    'workspace-alpha',
    'alpha',
    [{ type: 'escape', label: 'Escape', entry: 'escape.html' }],
  )
  const externalSurface = join(temp, 'outside-surface.html')
  await writeFile(externalSurface, '<html>outside</html>')
  await symlink(externalSurface, join(alphaDir, 'escape.html'))
  await writeWorkspaceExtension(workspaceB, 'beta', 'workspace-beta', 'beta')

  const { ExtensionRegistry } = await loadRegistryModule(codesurfHome)
  const registry = new ExtensionRegistry()
  await assert.rejects(
    registry.loadFromManifest({
      id: '../adapted',
      name: 'Invalid adapted extension',
      version: '1.0.0',
      tier: 'safe',
      contributes: {},
      _path: invalidDir,
    }),
    new RegExp(`Invalid extension id.*${invalidDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
  )

  const lightweightA = await registry.scanLightweight(workspaceA)
  assert.deepEqual(lightweightA.map((manifest: { id: string }) => manifest.id), ['workspace-alpha'])
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceA))

  const errors: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
  try {
    await registry.rescan(registry.getActiveWorkspacePath())
  } finally {
    console.error = originalError
  }
  assert.equal(registry.get('../mcp-server'), undefined)
  assert.ok(errors.some(message => message.includes(invalidDir) && message.includes('Invalid extension id')))
  assert.match(
    registry.getTileEntry('workspace-alpha', 'ext:alpha') ?? '',
    /^codesurf-ext:\/\/workspace-alpha\/index\.html/,
  )
  assert.equal(
    await registry.getSurfaceHtml('workspace-alpha', 'tile', 'ext:alpha'),
    '<html></html>',
  )
  assert.equal(
    await registry.getSurfaceHtml('workspace-alpha', 'tile', 'ext:escape'),
    null,
  )

  const lightweightB = await registry.scanLightweight(workspaceB)
  assert.deepEqual(lightweightB.map((manifest: { id: string }) => manifest.id), ['workspace-beta'])
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceB))
  await registry.rescan(registry.getActiveWorkspacePath())
  assert.equal(registry.getTileEntry('workspace-alpha', 'ext:alpha'), null)
  assert.match(
    registry.getTileEntry('workspace-beta', 'ext:beta') ?? '',
    /^codesurf-ext:\/\/workspace-beta\/index\.html/,
  )

  const lightweightWithoutWorkspace = await registry.scanLightweight(null)
  assert.deepEqual(lightweightWithoutWorkspace, [])
  assert.equal(registry.getActiveWorkspacePath(), null)
  assert.deepEqual(await registry.scanLightweight(), [])
  await registry.rescan(registry.getActiveWorkspacePath())
  assert.equal(registry.getTileEntry('workspace-beta', 'ext:beta'), null)

  await Promise.all([
    registry.scanLightweight(workspaceA),
    registry.scanLightweight(workspaceB),
  ])
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceB))
})

test('registered IPC keeps sidebar and executable collision precedence aligned', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-extension-collision-'))
  const codesurfHome = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const globalDir = join(codesurfHome, 'extensions', 'global-copy')
  const workspaceDir = join(workspace, '.codesurf', 'extensions', 'workspace-copy')
  await mkdir(globalDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })

  await writeFile(join(globalDir, 'global.html'), '<html>global</html>')
  await writeFile(join(globalDir, 'extension.json'), JSON.stringify({
    id: 'collision-extension',
    name: 'Trusted global metadata',
    version: '1.0.0',
    tier: 'safe',
    contributes: {
      actions: [{ name: 'global-action', description: 'Global action' }],
      tiles: [{
        type: 'shared',
        label: 'Global tile',
        entry: 'global.html',
      }],
    },
  }))
  await writeFile(join(workspaceDir, 'workspace.html'), '<html>workspace</html>')
  await writeFile(join(workspaceDir, 'extension.json'), JSON.stringify({
    id: 'collision-extension',
    name: 'Workspace metadata',
    version: '2.0.0',
    tier: 'safe',
    contributes: {
      actions: [{ name: 'workspace-action', description: 'Workspace action' }],
      tiles: [{
        type: 'shared',
        label: 'Workspace tile',
        entry: 'workspace.html',
      }],
    },
  }))

  const { ExtensionRegistry } = await loadRegistryModule(codesurfHome)
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const { registerExtensionIPC } = await loadExtensionIpcModule(codesurfHome, handlers)
  const registry = new ExtensionRegistry()
  registerExtensionIPC(registry)

  const listSidebar = handlers.get('ext:list-sidebar')!
  const listTiles = handlers.get('ext:list-tiles')!
  const tileEntry = handlers.get('ext:tile-entry')!

  const workspaceSidebar = await listSidebar({}, workspace) as {
    entries: Array<{ name: string }>
    tiles: Array<{
      label: string
      entry: string
      actions?: Array<{ name: string }>
    }>
  }
  assert.equal(workspaceSidebar.entries[0]?.name, 'Workspace metadata')
  assert.equal(workspaceSidebar.tiles[0]?.label, 'Workspace tile')
  assert.equal(workspaceSidebar.tiles[0]?.entry, 'workspace.html')
  assert.deepEqual(workspaceSidebar.tiles[0]?.actions, [{
    name: 'workspace-action',
    description: 'Workspace action',
  }])

  const workspaceTiles = await listTiles({}) as Array<{ label: string }>
  assert.deepEqual(workspaceTiles.map(tile => tile.label), ['Workspace tile'])
  assert.match(
    String(await tileEntry({}, 'collision-extension', 'ext:shared')),
    /^codesurf-ext:\/\/collision-extension\/workspace\.html/,
  )
  assert.equal(registry.get('collision-extension')?.manifest._path, resolve(workspaceDir))

  const globalSidebar = await listSidebar({}, null) as {
    entries: Array<{ name: string }>
    tiles: Array<{ label: string; entry: string }>
  }
  assert.equal(globalSidebar.entries[0]?.name, 'Trusted global metadata')
  assert.equal(globalSidebar.tiles[0]?.label, 'Global tile')
  assert.equal(globalSidebar.tiles[0]?.entry, 'global.html')
  assert.equal(registry.getActiveWorkspacePath(), null)

  const globalTiles = await listTiles({}) as Array<{ label: string }>
  assert.deepEqual(globalTiles.map(tile => tile.label), ['Global tile'])
  assert.match(
    String(await tileEntry({}, 'collision-extension', 'ext:shared')),
    /^codesurf-ext:\/\/collision-extension\/global\.html/,
  )
  assert.equal(registry.get('collision-extension')?.manifest._path, resolve(globalDir))
})

test('registry transition queue preserves request order and recovers after rejection', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'codesurf-workspace-queue-'))
  const { ExtensionRegistry } = await loadRegistryModule(join(temp, 'home'))
  const registry = new ExtensionRegistry()
  const workspaceA = join(temp, 'workspace-a')
  const workspaceB = join(temp, 'workspace-b')

  let releaseFirst!: () => void
  let markStarted!: () => void
  const firstBlocked = new Promise<void>(resolveBlocked => { releaseFirst = resolveBlocked })
  const firstStarted = new Promise<void>(resolveStarted => { markStarted = resolveStarted })
  let scanCalls = 0
  registry.scan = async () => {
    scanCalls += 1
    if (scanCalls === 1) {
      markStarted()
      await firstBlocked
    }
  }

  const first = registry.rescan(workspaceA)
  await firstStarted
  const second = registry.rescan(workspaceB)
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceA))
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceB))

  registry.scan = async () => { throw new Error('expected transition failure') }
  await assert.rejects(registry.rescan(workspaceA), /expected transition failure/)
  registry.scan = async () => {}
  await registry.rescan(workspaceB)
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceB))
})
