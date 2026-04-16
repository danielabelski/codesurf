#!/usr/bin/env bun

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_ROOT = join(ROOT, 'release', 'npm')
const PACKAGE_DIR = join(OUT_ROOT, 'package')

const args = new Set(process.argv.slice(2))
const skipAppBuild = args.has('--skip-app-build')
const skipPack = args.has('--skip-pack')

function log(message) {
  process.stdout.write(`${message}\n`)
}

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    ...options,
  })
  if (result.status !== 0) {
    fail(`Command failed: ${command} ${commandArgs.join(' ')}`)
  }
}

function copyIfExists(sourceRelative, destRelative = sourceRelative) {
  const source = join(ROOT, sourceRelative)
  if (!existsSync(source)) return
  const destination = join(PACKAGE_DIR, destRelative)
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, force: true })
}

function copyResources() {
  const source = join(ROOT, 'resources')
  if (!existsSync(source)) return
  const destination = join(PACKAGE_DIR, 'resources')
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, {
    recursive: true,
    force: true,
    filter: entry => !entry.endsWith('.pxd'),
  })
}

function assertExists(relativePath) {
  const fullPath = join(ROOT, relativePath)
  if (!existsSync(fullPath)) {
    fail(`Missing required build artifact: ${relativePath}`)
  }
}

function sanitizeManifest(rootManifest) {
  const filteredOptionalDependencies = Object.fromEntries(
    Object.entries(rootManifest.optionalDependencies ?? {}).filter(([, value]) => {
      return typeof value === 'string' && !value.startsWith('file:')
    }),
  )

  return {
    name: rootManifest.name,
    version: rootManifest.version,
    productName: rootManifest.productName,
    description: rootManifest.description,
    license: rootManifest.license,
    author: rootManifest.author,
    main: rootManifest.main,
    bin: rootManifest.bin,
    files: rootManifest.files,
    keywords: rootManifest.keywords ?? [],
    dependencies: rootManifest.dependencies ?? {},
    ...(Object.keys(filteredOptionalDependencies).length > 0
      ? { optionalDependencies: filteredOptionalDependencies }
      : {}),
    engines: {
      node: '>=20.0.0',
    },
  }
}

function main() {
  const rootManifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

  if (!skipAppBuild) {
    log('Building Electron app...')
    run(process.platform === 'win32' ? 'bun.exe' : 'bun', ['run', 'build'])
  } else {
    log('Skipping app build')
  }

  assertExists('dist-electron/main/index.js')
  assertExists('dist-electron/renderer/index.html')
  assertExists('dist-electron/preload/index.js')
  assertExists('bin/codesurf.cjs')
  assertExists('bin/codesurfd.mjs')

  rmSync(OUT_ROOT, { recursive: true, force: true })
  mkdirSync(PACKAGE_DIR, { recursive: true })

  log('Preparing npm package directory...')
  copyIfExists('bin')
  copyIfExists('dist-electron')
  copyResources()
  copyIfExists('packages/contex-relay/dist')
  copyIfExists('README.md')
  copyIfExists('LICENSE')

  const publishManifest = sanitizeManifest(rootManifest)
  writeFileSync(
    join(PACKAGE_DIR, 'package.json'),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
    'utf8',
  )

  if (skipPack) {
    log(`Prepared npm package at ${PACKAGE_DIR}`)
    return
  }

  log('Packing npm tarball...')
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', OUT_ROOT], {
    cwd: PACKAGE_DIR,
  })

  const tarballs = statSync(OUT_ROOT).isDirectory()
    ? readdirSync(OUT_ROOT).filter(name => name.endsWith('.tgz'))
    : []

  if (tarballs.length === 0) {
    fail('npm pack did not produce a tarball')
  }

  log(`Created ${join(OUT_ROOT, tarballs[0])}`)
}

main()
