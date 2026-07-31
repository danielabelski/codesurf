import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  ensureNodeGyp,
  isProductionOnlyInstall,
} from '../scripts/rebuild-natives.mjs'
import { patchBraceExpansion } from '../scripts/patch-brace-expansion-compat.mjs'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RELAY_DIR = resolve(ROOT_DIR, 'packages/codesurf-relay')
const CHAT_APP_DIR = resolve(ROOT_DIR, 'apps/chat-app')
const require = createRequire(import.meta.url)
const ensureElectron = require('../scripts/ensure-electron.js')
const NODE_FLOOR = '>=22.12.0'
const CI_NODE_VERSION = '22.12.0'
const EXPECTED_TOOLCHAIN = {
  dependencies: {
    'monaco-editor': '0.56.0',
  },
  devDependencies: {
    '@babel/core': '7.29.7',
    '@electron/rebuild': '4.2.0',
    '@eslint/js': '9.39.1',
    '@vitejs/plugin-react': '5.2.0',
    'brace-expansion': '5.0.9',
    'ejs': '5.0.2',
    'electron-builder': '26.15.3',
    'eslint': '9.39.1',
    'eslint-plugin-react-hooks': '7.1.1',
    'esbuild': '0.28.1',
    'globals': '17.8.0',
    'node-gyp': '12.4.0',
    'postcss': '8.5.25',
    'prettier': '3.9.6',
    'typescript-eslint': '8.65.0',
    'vite': '7.3.6',
    'vite-plugin-pwa': '1.2.0',
  },
}
const EXPECTED_OVERRIDES = {
  '@babel/core': '$@babel/core',
  'brace-expansion': '$brace-expansion',
  'ejs': '$ejs',
  'esbuild': '$esbuild',
  'monaco-editor': {
    'dompurify': '3.4.12',
  },
  'vite-plugin-pwa': {
    'workbox-build': {
      '.': '7.4.0',
      '@rollup/plugin-terser': '1.0.0',
    },
    'workbox-window': '7.4.0',
  },
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function packageVersions(lock, packageName) {
  const suffix = `/node_modules/${packageName}`
  return [...new Set(
    Object.entries(lock.packages ?? {})
      .filter(([path]) => path === `node_modules/${packageName}` || path.endsWith(suffix))
      .map(([, entry]) => entry.version),
  )].sort()
}

test('security-sensitive build tools remain on the reviewed exact versions', async () => {
  const [manifest, lock] = await Promise.all([
    readJson(resolve(ROOT_DIR, 'package.json')),
    readJson(resolve(ROOT_DIR, 'package-lock.json')),
  ])

  assert.equal(manifest.engines?.node, NODE_FLOOR)
  assert.equal(manifest.packageManager, 'npm@10.9.0')
  assert.deepEqual(lock.packages?.['']?.engines, manifest.engines)
  assert.equal(manifest.dependencies?.['@types/better-sqlite3'], undefined)
  assert.equal(manifest.devDependencies?.['@types/better-sqlite3'], '^7.6.13')
  assert.deepEqual(manifest.overrides, EXPECTED_OVERRIDES)

  for (const [section, dependencies] of Object.entries(EXPECTED_TOOLCHAIN)) {
    for (const [name, version] of Object.entries(dependencies)) {
      assert.equal(manifest[section]?.[name], version, `${name} must stay exactly pinned`)
      assert.equal(lock.packages?.[`node_modules/${name}`]?.version, version, `${name} lock resolution must match`)
    }
  }

  const exactTransitiveResolutions = {
    '@babel/core': '7.29.7',
    'brace-expansion': '5.0.9',
    'dompurify': '3.4.12',
    'ejs': '5.0.2',
    'esbuild': '0.28.1',
    'node-gyp': '12.4.0',
    '@rollup/plugin-terser': '1.0.0',
    'serialize-javascript': '7.0.7',
    'workbox-build': '7.4.0',
    'workbox-window': '7.4.0',
  }
  for (const [name, version] of Object.entries(exactTransitiveResolutions)) {
    assert.deepEqual(packageVersions(lock, name), [version], `${name} must have one reviewed resolution`)
  }
})

test('CI and release jobs exercise the declared minimum Node runtime', async () => {
  const workflowPaths = [
    resolve(ROOT_DIR, '.github/workflows/ci.yml'),
    resolve(ROOT_DIR, '.github/workflows/release-on-tag.yml'),
  ]
  for (const path of workflowPaths) {
    const workflow = await readFile(path, 'utf8')
    assert.match(workflow, new RegExp(`node-version:\\s*${CI_NODE_VERSION.replaceAll('.', '\\.')}(?:\\s|$)`))
    assert.match(workflow, /npm audit --audit-level=low/)
    assert.match(workflow, /npm audit --omit=dev --audit-level=low/)
    assert.match(workflow, /npm --prefix packages\/codesurf-relay audit --audit-level=low/)
    assert.match(workflow, /npm --prefix apps\/chat-app ci/)
    assert.match(workflow, /npm --prefix apps\/chat-app audit --audit-level=low/)
    assert.match(workflow, /npm run lint && npm run format:check/)
  }

  const ciWorkflow = await readFile(workflowPaths[0], 'utf8')
  assert.match(ciWorkflow, /linux-core-contract:/)
  assert.match(ciWorkflow, /runs-on: ubuntu-latest/)
  assert.match(ciWorkflow, /npm run test:unit:core/)
  assert.match(ciWorkflow, /npm run test:packages/)
  assert.match(ciWorkflow, /npm ci --omit=dev/)
  assert.match(ciWorkflow, /npm run build:web && npm run verify:web-build/)
  assert.match(ciWorkflow, /npm run test:npm-package/)
  assert.match(ciWorkflow, /npm run smoke:electrobun/)
  assert.match(ciWorkflow, /npm --prefix apps\/chat-app run build/)

  const manifest = await readJson(resolve(ROOT_DIR, 'package.json'))
  assert.match(manifest.scripts?.['test:unit:core'] ?? '', /node --experimental-strip-types --test/)
  assert.equal(
    manifest.scripts?.['test:npm-package'],
    'npm run build:npm && node scripts/smoke-npm-package.mjs',
  )
})

test('relay test toolchain remains on the audited Node, Vite, and Vitest line', async () => {
  const [manifest, lock] = await Promise.all([
    readJson(resolve(RELAY_DIR, 'package.json')),
    readJson(resolve(RELAY_DIR, 'package-lock.json')),
  ])

  assert.equal(manifest.name, '@codesurf/relay')
  assert.equal(lock.name, manifest.name)
  assert.equal(lock.packages?.['']?.name, manifest.name)
  assert.equal(manifest.engines?.node, NODE_FLOOR)
  assert.deepEqual(lock.packages?.['']?.engines, manifest.engines)

  const expectedDevTools = {
    postcss: '8.5.25',
    vite: '7.3.6',
    vitest: '3.2.6',
  }
  for (const [name, version] of Object.entries(expectedDevTools)) {
    assert.equal(manifest.devDependencies?.[name], version)
    assert.equal(lock.packages?.[`node_modules/${name}`]?.version, version)
  }
  assert.deepEqual(packageVersions(lock, 'esbuild'), ['0.28.1'])
})

test('standalone chat app lock and audited build tools remain authoritative', async () => {
  const [manifest, lock] = await Promise.all([
    readJson(resolve(CHAT_APP_DIR, 'package.json')),
    readJson(resolve(CHAT_APP_DIR, 'package-lock.json')),
  ])

  assert.equal(manifest.packageManager, 'npm@10.9.0')
  assert.equal(manifest.engines?.node, NODE_FLOOR)
  assert.deepEqual(lock.packages?.['']?.engines, manifest.engines)
  assert.equal(
    manifest.dependencies?.['@codesurf/chat-bridge'],
    'file:../../packages/codesurf-chat-bridge',
  )
  assert.equal(
    lock.packages?.['']?.dependencies?.['@codesurf/chat-bridge'],
    manifest.dependencies['@codesurf/chat-bridge'],
  )
  assert.equal(lock.packages?.['../../packages/codesurf-chat-bridge']?.name, '@codesurf/chat-bridge')
  assert.equal(lock.packages?.['node_modules/@codesurf/chat-bridge']?.link, true)
  assert.equal(lock.packages?.['node_modules/@contex/chat-bridge'], undefined)

  const expectedDevTools = {
    '@babel/core': '7.29.7',
    '@vitejs/plugin-react': '5.2.0',
    esbuild: '0.28.1',
    postcss: '8.5.25',
    vite: '7.3.6',
  }
  for (const [name, version] of Object.entries(expectedDevTools)) {
    assert.equal(manifest.devDependencies?.[name], version)
    assert.equal(lock.packages?.[`node_modules/${name}`]?.version, version)
  }
  assert.deepEqual(manifest.overrides, {
    '@babel/core': '7.29.7',
    esbuild: '0.28.1',
    postcss: '8.5.25',
  })
  assert.deepEqual(packageVersions(lock, '@babel/core'), ['7.29.7'])
  assert.deepEqual(packageVersions(lock, 'esbuild'), ['0.28.1'])
  assert.deepEqual(packageVersions(lock, 'postcss'), ['8.5.25'])
})

test('native rebuild keeps package authority and handles production-only installs explicitly', () => {
  const cases = [
    [{ npm_config_omit: 'optional dev' }, true],
    [{ NPM_CONFIG_OMIT: 'peer,dev' }, true],
    [{ NODE_ENV: 'production' }, true],
    [{ npm_config_production: 'true' }, true],
    [{ NPM_CONFIG_PRODUCTION: '1' }, true],
    [{ npm_config_only: 'prod' }, true],
    [{ NPM_CONFIG_ONLY: 'production' }, true],
    [{ npm_config_omit: 'optional' }, false],
    [{ NODE_ENV: 'development' }, false],
    [{ NODE_ENV: 'production', npm_config_include: 'dev' }, false],
  ]
  for (const [env, expected] of cases) {
    assert.equal(isProductionOnlyInstall(env), expected)
    assert.equal(
      ensureElectron.isProductionOnlyInstall(env),
      expected,
      'Electron setup and native rebuild must interpret install mode identically',
    )
  }

  assert.throws(
    () => ensureNodeGyp(() => {
      throw new Error('not installed')
    }),
    /missing from the package root.*npm ci/,
  )
  assert.throws(
    () => ensureNodeGyp(() => '/fixture/node-gyp/package.json', () => ({ version: '11.5.0' })),
    /Expected node-gyp@12\.4\.0.*npm ci/,
  )
  assert.doesNotThrow(() => ensureNodeGyp())
})

const CJS_PATCH = [
  '// CODESURF_BRACE_EXPANSION_CALLABLE_COMPAT',
  'expand.expand = expand;',
  'expand.EXPANSION_MAX = exports.EXPANSION_MAX;',
  'expand.EXPANSION_MAX_LENGTH = exports.EXPANSION_MAX_LENGTH;',
  'module.exports = expand;',
  '',
].join('\n')
const ESM_PATCH = [
  '// CODESURF_BRACE_EXPANSION_DEFAULT_COMPAT',
  'export default expand;',
  '',
].join('\n')

async function pristineBraceFixture(t) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'codesurf-brace-expansion-'))
  t.after(async () => { await rm(fixtureRoot, { recursive: true, force: true }) })

  const packageDir = join(fixtureRoot, 'brace-expansion')
  await cp(resolve(ROOT_DIR, 'node_modules/brace-expansion'), packageDir, { recursive: true })
  await cp(
    resolve(ROOT_DIR, 'node_modules/balanced-match'),
    join(packageDir, 'node_modules/balanced-match'),
    { recursive: true },
  )

  for (const [relativePath, patch] of [
    ['dist/commonjs/index.js', CJS_PATCH],
    ['dist/esm/index.js', ESM_PATCH],
  ]) {
    const path = join(packageDir, relativePath)
    const source = await readFile(path, 'utf8')
    assert.match(source, /CODESURF_BRACE_EXPANSION_.*_COMPAT/)
    await writeFile(path, source.replace(patch, ''), 'utf8')
  }

  return packageDir
}

test('brace compatibility patch accepts a pristine fixture and is idempotent', async t => {
  const packageDir = await pristineBraceFixture(t)
  const cjsPath = join(packageDir, 'dist/commonjs/index.js')
  const esmPath = join(packageDir, 'dist/esm/index.js')

  patchBraceExpansion(packageDir)
  const firstPatch = await Promise.all([readFile(cjsPath, 'utf8'), readFile(esmPath, 'utf8')])
  patchBraceExpansion(packageDir)
  const secondPatch = await Promise.all([readFile(cjsPath, 'utf8'), readFile(esmPath, 'utf8')])
  assert.deepEqual(secondPatch, firstPatch)

  const fixtureRequire = createRequire(join(packageDir, 'probe.cjs'))
  const cjsExpand = fixtureRequire(packageDir)
  const esmModule = await import(`${pathToFileURL(esmPath).href}?fixture=${Date.now()}`)
  assert.equal(cjsExpand, cjsExpand.expand)
  assert.equal(esmModule.default, esmModule.expand)

  for (const expand of [cjsExpand, esmModule.default]) {
    assert.equal(expand.EXPANSION_MAX ?? esmModule.EXPANSION_MAX, 100_000)
    assert.equal(expand.EXPANSION_MAX_LENGTH ?? esmModule.EXPANSION_MAX_LENGTH, 4_000_000)
    assert.equal(expand('{1..100005}').length, 100_000, 'default result cap must remain enforced')
    assert.deepEqual(expand('{1..10}', { max: 3 }), ['1', '2', '3'])
    const lengthBounded = expand('{alpha,beta}'.repeat(20), { maxLength: 32 })
    assert.ok(lengthBounded.reduce((length, value) => length + value.length, 0) <= 32)
  }
})

test('brace compatibility patch rejects unreviewed version, license, and source shapes atomically', async t => {
  for (const corruption of ['version', 'license', 'source']) {
    await t.test(corruption, async t => {
      const packageDir = await pristineBraceFixture(t)
      const manifestPath = join(packageDir, 'package.json')
      const cjsPath = join(packageDir, 'dist/commonjs/index.js')
      const esmPath = join(packageDir, 'dist/esm/index.js')

      if (corruption === 'version' || corruption === 'license') {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        manifest[corruption] = corruption === 'version' ? '5.0.10' : 'Apache-2.0'
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      } else {
        const source = await readFile(esmPath, 'utf8')
        await writeFile(esmPath, source.replace('function expand(', 'function renamedExpand('), 'utf8')
      }

      const before = await Promise.all([readFile(cjsPath, 'utf8'), readFile(esmPath, 'utf8')])
      assert.throws(() => patchBraceExpansion(packageDir), /expected upstream|source shape changed/)
      const after = await Promise.all([readFile(cjsPath, 'utf8'), readFile(esmPath, 'utf8')])
      assert.deepEqual(after, before, 'a rejected fixture must not be partially patched')
    })
  }
})

test('reviewed out-of-range overrides preserve the APIs used by their consumers', () => {
  const braceExpand = require('brace-expansion')
  assert.equal(braceExpand.expand, braceExpand)
  assert.equal(braceExpand.EXPANSION_MAX, 100_000)
  assert.equal(braceExpand.EXPANSION_MAX_LENGTH, 4_000_000)
  assert.deepEqual(braceExpand('src/{main,renderer}/index.ts'), [
    'src/main/index.ts',
    'src/renderer/index.ts',
  ])
  assert.deepEqual(braceExpand('{1..1000}', { max: 3 }), ['1', '2', '3'])
  const boundedExpansion = braceExpand('{alpha,beta}'.repeat(3_000), {
    max: 64,
    maxLength: 16_384,
  })
  assert.ok(boundedExpansion.length <= 64)
  assert.ok(boundedExpansion.reduce((length, value) => length + value.length, 0) <= 16_384)

  const minimatchPackagePaths = [
    'node_modules/@electron/asar/node_modules/minimatch',
    'node_modules/@electron/universal/node_modules/minimatch',
    'node_modules/dir-compare/node_modules/minimatch',
    'node_modules/glob/node_modules/minimatch',
    'node_modules/minimatch',
  ]
  for (const packagePath of minimatchPackagePaths) {
    const minimatchModule = require(resolve(ROOT_DIR, packagePath))
    const matches = typeof minimatchModule === 'function'
      ? minimatchModule
      : minimatchModule.minimatch
    assert.equal(typeof matches, 'function', `${packagePath} must expose a matcher`)
    assert.equal(matches('src/main/index.ts', 'src/{main,renderer}/**/*.ts'), true)
    assert.equal(matches('src/preload/index.ts', 'src/{main,renderer}/**/*.ts'), false)
  }

  const ejs = require('ejs')
  assert.equal(ejs.render('<%= product %>-<%- version %>', { product: 'CodeSurf', version: '0.1.0' }), 'CodeSurf-0.1.0')
})
