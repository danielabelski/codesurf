import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'

const ROOT_DIR = resolve(import.meta.dirname, '../..')

test('development and build entrypoints cannot launch against stale daemon dist', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT_DIR, 'package.json'), 'utf8'))
  const scripts = manifest.scripts ?? {}
  const directBuildEntrypoints = [
    'dev',
    'dev:go',
    'web:dev',
    'web:host',
    'web:preview',
    'web:pwa',
    'desktop:dev',
    'build:web',
    'build:main',
    'build',
    'dev:electrobun',
    'build:electrobun',
  ]
  for (const name of directBuildEntrypoints) {
    assert.match(scripts[name] ?? '', /\bnpm run build:daemon\b/, `${name} must build daemon dist first`)
  }
  assert.match(scripts.dogfood ?? '', /\bnpm run build\b/, 'dogfood must use the guarded root build')
  assert.match(scripts.preview ?? '', /\bnpm run verify:daemon-dist\b/, 'preview must reject stale daemon dist')
  assert.match(scripts.prepack ?? '', /\bnpm run verify:daemon-dist\b/, 'direct root npm pack must reject stale daemon dist')
})

test('shipping packagers verify dist and copy no daemon source tree', async () => {
  const [manifest, npmBuilder, desktopSidecar, electronHook, electrobunConfig] = await Promise.all([
    readFile(join(ROOT_DIR, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(ROOT_DIR, 'scripts', 'build-npm-package.mjs'), 'utf8'),
    readFile(join(ROOT_DIR, 'scripts', 'desktop-sidecar.mjs'), 'utf8'),
    readFile(join(ROOT_DIR, 'scripts', 'before-build.js'), 'utf8'),
    readFile(join(ROOT_DIR, 'electrobun.config.ts'), 'utf8'),
  ])

  assert.match(npmBuilder, /\['--prefix', 'packages\/codesurf-daemon', 'run', 'verify:dist'\]/)
  assert.match(npmBuilder, /\['bin', 'dist', 'vendor', 'README\.md', 'package\.json'\]/)
  assert.doesNotMatch(npmBuilder, /\['bin', 'src'/)
  assert.match(desktopSidecar, /verifyDaemonDist\(root\)/)
  assert.match(desktopSidecar, /daemonPackageEntries = \['bin', 'dist', 'vendor', 'README\.md', 'package\.json'\]/)
  assert.match(electronHook, /packages\/codesurf-daemon run verify:dist/)
  assert.match(electrobunConfig, /'packages\/codesurf-daemon\/dist'/)
  assert.doesNotMatch(electrobunConfig, /'packages\/codesurf-daemon':/)

  const packageFiles = manifest.files ?? []
  const electronFiles = manifest.build?.files ?? []
  assert.ok(packageFiles.includes('packages/codesurf-daemon/dist/'))
  assert.equal(packageFiles.includes('packages/codesurf-daemon/'), false)
  assert.ok(electronFiles.includes('packages/codesurf-daemon/dist/**/*'))
  assert.equal(electronFiles.includes('packages/codesurf-daemon/**/*'), false)
})
