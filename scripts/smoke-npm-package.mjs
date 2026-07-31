#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`,
    )
  }
  return result.stdout.trim()
}

function resolveTarball() {
  const outputDir = join(root, 'release', 'npm')
  const tarballs = existsSync(outputDir)
    ? readdirSync(outputDir).filter(name => name.endsWith('.tgz'))
    : []
  if (tarballs.length !== 1) {
    throw new Error(`Expected one npm tarball in ${outputDir}, found ${tarballs.length}`)
  }
  return join(outputDir, tarballs[0])
}

async function waitForDaemon(pidPath, child) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Packaged daemon exited during startup with code ${child.exitCode}`)
    }
    if (existsSync(pidPath)) {
      const info = JSON.parse(readFileSync(pidPath, 'utf8'))
      if (Number.isInteger(info.port) && typeof info.token === 'string') return info
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(`Packaged daemon did not publish ${pidPath}`)
}

async function stopDaemon(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 5_000)),
  ])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise(resolvePromise => child.once('exit', resolvePromise))
  }
}

export async function smokeNpmPackage(tarball = resolveTarball()) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'codesurf-npm-package-smoke-'))
  const cacheDir = mkdtempSync(join(tmpdir(), 'codesurf-npm-package-cache-'))
  const codesurfHome = join(fixtureRoot, 'codesurf-home')
  let daemon = null

  try {
    writeFileSync(
      join(fixtureRoot, 'package.json'),
      `${JSON.stringify({ name: 'codesurf-package-smoke', private: true })}\n`,
      'utf8',
    )
    run(npmCommand, ['install', tarball, '--no-audit', '--no-fund'], {
      cwd: fixtureRoot,
      env: { ...process.env, npm_config_cache: cacheDir },
    })

    const installedRoot = join(fixtureRoot, 'node_modules', 'codesurf')
    const cliOutput = run(
      process.execPath,
      [join(installedRoot, 'bin', 'codesurf.cjs'), '--version'],
      { cwd: fixtureRoot },
    )
    if (!/^codesurf v\d+\.\d+\.\d+$/.test(cliOutput)) {
      throw new Error(`Unexpected packaged CLI version output: ${cliOutput}`)
    }

    const nativeOutput = run(
      process.execPath,
      ['-e', "require('better-sqlite3');require('node-pty');process.stdout.write('native-load-ok')"],
      { cwd: fixtureRoot },
    )
    if (nativeOutput !== 'native-load-ok') {
      throw new Error(`Packaged native dependency smoke failed: ${nativeOutput}`)
    }

    const daemonEntry = join(installedRoot, 'bin', 'codesurfd.mjs')
    daemon = spawn(process.execPath, [daemonEntry], {
      cwd: fixtureRoot,
      env: {
        ...process.env,
        CODESURF_HOME: codesurfHome,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const info = await waitForDaemon(join(codesurfHome, 'daemon', 'pid.json'), daemon)
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { authorization: `Bearer ${info.token}` },
    })
    const health = await response.json()
    if (!response.ok || health.ok !== true || health.pid !== daemon.pid) {
      throw new Error(`Packaged daemon health check failed: ${JSON.stringify(health)}`)
    }

    console.log(`[smoke-npm-package] installed ${basename(tarball)}`)
    console.log(`[smoke-npm-package] ${cliOutput}`)
    console.log('[smoke-npm-package] native modules loaded')
    console.log(`[smoke-npm-package] daemon healthy on protocol ${health.protocolVersion}`)
  } finally {
    if (daemon) await stopDaemon(daemon)
    rmSync(fixtureRoot, { recursive: true, force: true })
    rmSync(cacheDir, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  smokeNpmPackage().catch(error => {
    console.error(`[smoke-npm-package] ${error?.stack || error}`)
    process.exitCode = 1
  })
}
