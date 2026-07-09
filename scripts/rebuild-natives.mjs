/**
 * Rebuild native modules for the installed Electron version.
 *
 * Fixes a recurring failure mode where a stale node-pty/build/Makefile
 * references `node_modules/node-gyp/addon.gypi` after npm has hoisted/removed
 * top-level node-gyp:
 *
 *   make: *** No rule to make target `../../node-gyp/addon.gypi' ...
 *
 * Strategy:
 * 1. Ensure node-gyp is resolvable from the package root
 * 2. Drop stale gyp output under native packages
 * 3. electron-rebuild better-sqlite3 then node-pty
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'

function log(msg) {
  console.log(`[rebuild-natives] ${msg}`)
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: isWindows,
  })
  if (result.status !== 0) {
    const err = new Error(`${cmd} ${args.join(' ')} failed with code ${result.status ?? 'unknown'}`)
    err.code = result.status ?? 1
    throw err
  }
}

function ensureNodeGyp() {
  try {
    const pkg = require.resolve('node-gyp/package.json')
    log(`node-gyp ok (${dirname(pkg)})`)
    return
  } catch {
    // continue
  }

  log('node-gyp missing at package root — installing as devDependency')
  run(npmCmd, ['install', '-D', 'node-gyp@^11', '--no-fund', '--no-audit'])

  try {
    require.resolve('node-gyp/package.json')
    return
  } catch {
    // Last resort: link the copy bundled with @electron/rebuild
  }

  const nested = join(root, 'node_modules/@electron/rebuild/node_modules/node-gyp')
  const target = join(root, 'node_modules/node-gyp')
  if (existsSync(nested) && !existsSync(target)) {
    log(`linking node-gyp from @electron/rebuild → ${target}`)
    symlinkSync(nested, target, isWindows ? 'junction' : 'dir')
    return
  }

  throw new Error(
    'node-gyp is not installed. Run: npm install -D node-gyp\n'
    + 'Then: npm run rebuild',
  )
}

function cleanStaleNativeBuilds() {
  const dirs = [
    join(root, 'node_modules/node-pty/build'),
    join(root, 'node_modules/better-sqlite3/build'),
  ]
  for (const dir of dirs) {
    if (existsSync(dir)) {
      log(`removing stale build: ${dir}`)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function electronRebuild(moduleName) {
  log(`electron-rebuild -f -o ${moduleName}`)
  const bin = join(root, 'node_modules/.bin/electron-rebuild')
  const cmd = existsSync(bin) ? bin : 'electron-rebuild'
  run(cmd, ['-f', '-o', moduleName])
}

function main() {
  const patch = join(root, 'scripts/patch-node-pty-win.js')
  if (existsSync(patch)) {
    run(process.execPath, [patch])
  }

  ensureNodeGyp()
  cleanStaleNativeBuilds()
  electronRebuild('better-sqlite3')
  electronRebuild('node-pty')
  log('done')
}

try {
  main()
} catch (err) {
  console.error('[rebuild-natives] FAILED')
  console.error(err?.message || err)
  process.exit(typeof err?.code === 'number' ? err.code : 1)
}
