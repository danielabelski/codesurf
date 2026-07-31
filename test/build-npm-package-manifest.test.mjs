import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function writeFixtureFile(root, relativePath, contents = '') {
  const path = join(root, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents, 'utf8')
}

test('npm package build preserves the authoritative root Node engine', async t => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'codesurf-npm-package-manifest-'))
  t.after(async () => { await rm(fixtureRoot, { recursive: true, force: true }) })

  const rootManifest = JSON.parse(await readFile(join(ROOT_DIR, 'package.json'), 'utf8'))
  await mkdir(join(fixtureRoot, 'scripts'), { recursive: true })
  await cp(
    join(ROOT_DIR, 'scripts', 'build-npm-package.mjs'),
    join(fixtureRoot, 'scripts', 'build-npm-package.mjs'),
  )
  await writeFixtureFile(fixtureRoot, 'package.json', `${JSON.stringify(rootManifest, null, 2)}\n`)
  await writeFixtureFile(fixtureRoot, 'dist-electron/main/index.js')
  await writeFixtureFile(fixtureRoot, 'dist-electron/renderer/index.html')
  await writeFixtureFile(fixtureRoot, 'dist-electron/preload/index.js')
  await writeFixtureFile(fixtureRoot, 'bin/codesurf.cjs')
  await writeFixtureFile(fixtureRoot, 'bin/codesurfd.mjs')
  const daemonExports = Object.fromEntries(
    [
      ['.', 'index'],
      ['./manager', 'manager'],
      ['./client', 'client'],
      ['./sse', 'sse'],
      ['./chat-cli', 'chat-cli'],
      ['./chat-session-store', 'chat-session-store'],
      ['./paths', 'paths'],
    ].map(([subpath, stem]) => [
      subpath,
      {
        types: `./dist/${stem}.d.ts`,
        import: `./dist/${stem}.js`,
        default: `./dist/${stem}.js`,
      },
    ]),
  )
  await writeFixtureFile(
    fixtureRoot,
    'packages/codesurf-daemon/package.json',
    `${JSON.stringify({
      name: '@codesurf/daemon',
      version: '0.1.0',
      type: 'module',
      exports: daemonExports,
      scripts: {
        build: 'node -e "process.exit(0)"',
        'verify:dist': 'node -e "process.exit(0)"',
      },
    })}\n`,
  )
  await writeFixtureFile(fixtureRoot, 'packages/codesurf-daemon/README.md')
  await writeFixtureFile(fixtureRoot, 'packages/codesurf-daemon/bin/codesurfd.mjs')
  await writeFixtureFile(fixtureRoot, 'packages/codesurf-daemon/vendor/dreaming.mjs')
  for (const target of Object.values(daemonExports)) {
    await writeFixtureFile(fixtureRoot, `packages/codesurf-daemon/${target.import}`, 'export {}\n')
    await writeFixtureFile(fixtureRoot, `packages/codesurf-daemon/${target.types}`, 'export {}\n')
  }

  const result = spawnSync(
    process.execPath,
    [join(fixtureRoot, 'scripts', 'build-npm-package.mjs'), '--skip-app-build', '--skip-pack'],
    { cwd: fixtureRoot, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const publishManifest = JSON.parse(
    await readFile(join(fixtureRoot, 'release', 'npm', 'package', 'package.json'), 'utf8'),
  )
  assert.deepEqual(publishManifest.engines, rootManifest.engines)
  assert.equal(publishManifest.engines?.node, '>=22.12.0')
  assert.equal(
    await readFile(
      join(fixtureRoot, 'release', 'npm', 'package', 'packages', 'codesurf-daemon', 'dist', 'index.js'),
      'utf8',
    ),
    'export {}\n',
  )
})
