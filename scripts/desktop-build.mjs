/**
 * Package CodeSurf as a Native SDK desktop app (thin shell over web dist + host).
 *
 * Electron packaging (`npm run dist:mac` etc.) is unchanged.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireNativeSdkPath } from './resolve-native-sdk.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = path.join(root, 'desktop')
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'

function packageTarget() {
  const flag = process.argv.find(arg => arg.startsWith('--target='))
  if (flag) return flag.slice('--target='.length)
  const idx = process.argv.indexOf('--target')
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return 'linux'
}

function run(cmd, args, { cwd = root, env = {} } = {}) {
  const label = `${cmd} ${args.join(' ')}`
  console.log(`\n[desktop:build] ${label}`)
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false,
  })
  if (result.status !== 0) {
    console.error(`[desktop:build] step failed: ${label}`)
    process.exit(result.status ?? 1)
  }
}

const target = packageTarget()
const nativeSdk = requireNativeSdkPath()
console.log(`[desktop:build] package target=${target}`)
console.log(`[desktop:build] NATIVE_SDK_PATH=${nativeSdk}`)

// 1. web bundle (renderer-only, shared with browser)
run(npmCmd, ['run', 'build:web'])
// 2. native package
run('zig', [
  'build',
  'package',
  `-Dpackage-target=${target}`,
  `-Dnative-sdk-path=${nativeSdk}`,
  '-Doptimize=ReleaseFast',
], { cwd: desktopDir, env: { NATIVE_SDK_PATH: nativeSdk } })

console.log('\n[desktop:build] done — output in desktop/zig-out/package/')
