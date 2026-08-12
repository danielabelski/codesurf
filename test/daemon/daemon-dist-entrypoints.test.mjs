import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { getDaemonRuntimeEntries } from '@codesurf/daemon/package-layout'

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

test('shipping packagers verify dist and consume the package-owned runtime layout', async () => {
  const [manifest, daemonManifest, npmBuilder, desktopSidecar, electronHook, electrobunConfig] = await Promise.all([
    readFile(join(ROOT_DIR, 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(ROOT_DIR, 'packages', 'codesurf-daemon', 'package.json'), 'utf8').then(JSON.parse),
    readFile(join(ROOT_DIR, 'scripts', 'build-npm-package.mjs'), 'utf8'),
    readFile(join(ROOT_DIR, 'scripts', 'desktop-sidecar.mjs'), 'utf8'),
    readFile(join(ROOT_DIR, 'scripts', 'before-build.js'), 'utf8'),
    readFile(join(ROOT_DIR, 'electrobun.config.ts'), 'utf8'),
  ])

  assert.match(npmBuilder, /\['--prefix', 'packages\/codesurf-daemon', 'run', 'verify:dist'\]/)
  assert.match(npmBuilder, /getDaemonRuntimeEntries/)
  assert.match(npmBuilder, /getDaemonCompiledExports/)
  assert.match(desktopSidecar, /verifyDaemonDist\(root\)/)
  assert.match(desktopSidecar, /getDaemonRuntimeEntries/)
  assert.match(desktopSidecar, /getDaemonCompiledExports/)
  assert.match(electronHook, /packages\/codesurf-daemon run verify:dist/)
  assert.match(electrobunConfig, /daemonRuntimeEntries\(daemonManifest\.files\)/)
  assert.doesNotMatch(electrobunConfig, /'packages\/codesurf-daemon':/)

  const expectedEntries = getDaemonRuntimeEntries(daemonManifest).sort()
  const entriesFrom = patterns => patterns
    .filter(pattern => pattern.startsWith('packages/codesurf-daemon/'))
    .map(pattern => pattern
      .slice('packages/codesurf-daemon/'.length)
      .replace(/\/\*\*\/\*$/u, '')
      .replace(/\/+$/u, ''))
    .sort()
  assert.deepEqual(entriesFrom(manifest.files ?? []), expectedEntries)
  assert.deepEqual(entriesFrom(manifest.build?.files ?? []), expectedEntries)

  const electrobun = await import(
    `${pathToFileURL(join(ROOT_DIR, 'electrobun.config.ts')).href}?contract-test=${Date.now()}`
  )
  const electrobunEntries = Object.keys(electrobun.default.build.copy)
    .filter(path => path.startsWith('packages/codesurf-daemon/'))
    .map(path => path.slice('packages/codesurf-daemon/'.length))
    .sort()
  assert.deepEqual(electrobunEntries, expectedEntries)

  assert.equal((manifest.files ?? []).includes('packages/codesurf-daemon/'), false)
  assert.equal((manifest.build?.files ?? []).includes('packages/codesurf-daemon/**/*'), false)
})
