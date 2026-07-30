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

  await Promise.all([
    registry.scanLightweight(workspaceA),
    registry.scanLightweight(workspaceB),
  ])
  assert.equal(registry.getActiveWorkspacePath(), resolve(workspaceB))
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
