/**
 * Dev loop for the Native SDK desktop shell (Agensis pattern).
 *
 * 1. Ensure codesurfd + web-host (fixed host API for renderer)
 * 2. Hand off to `zig build dev` which starts Vite (via app.zon) and launches
 *    the native WebView against http://127.0.0.1:5173
 *
 * Electron path (`npm run dev`) is untouched.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { requireNativeSdkPath } from './resolve-native-sdk.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktopDir = path.join(root, 'desktop')
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'
const HOST_URL = process.env.CODESURF_WEB_HOST_URL || 'http://127.0.0.1:4177'
const HOST_HEALTH = `${HOST_URL}/host/health`

let shuttingDown = false
const children = []

function killProcess(child) {
  if (!child || child.killed) return
  try {
    child.kill('SIGTERM')
  } catch {
    // ignore
  }
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) killProcess(child)
}

async function isUp(url) {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function waitForServer(url, timeoutMs = 45_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isUp(url)) return
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`Timed out waiting for ${url}`)
}

function spawnTracked(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: opts.cwd ?? root,
    stdio: 'inherit',
    env: { ...process.env, ...opts.env },
  })
  children.push(child)
  child.on('exit', (code) => {
    if (!shuttingDown && opts.fatal) {
      console.error(`[desktop:dev] ${opts.label || cmd} exited with code ${code ?? 'unknown'}`)
      shutdown()
      process.exit(code ?? 1)
    }
  })
  return child
}

async function main() {
  const nativeSdk = requireNativeSdkPath()
  console.log(`[desktop:dev] NATIVE_SDK_PATH=${nativeSdk}`)

  if (!(await isUp(HOST_HEALTH))) {
    console.log('[desktop:dev] starting web-host (+ codesurfd)…')
    spawnTracked(process.execPath, [path.join(root, 'scripts/web-host.mjs')], {
      label: 'web-host',
      fatal: true,
    })
    await waitForServer(HOST_HEALTH)
  } else {
    console.log('[desktop:dev] web-host already running')
  }

  const cleanup = () => shutdown()
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('exit', cleanup)

  // zig build dev → builds shell, starts Vite from app.zon, launches WebView
  const nativeProcess = spawnTracked('zig', [
    'build',
    'dev',
    `-Dnative-sdk-path=${nativeSdk}`,
  ], {
    cwd: desktopDir,
    label: 'native',
    fatal: true,
    env: {
      BROWSER: 'none',
      NATIVE_SDK_PATH: nativeSdk,
      VITE_CODESURF_HOST: HOST_URL,
      CODESURF_WEB_HOST_URL: HOST_URL,
    },
  })

  nativeProcess.on('exit', (code) => {
    shutdown()
    process.exit(code ?? 0)
  })
}

main().catch((error) => {
  console.error('[desktop:dev] Failed to start Native SDK desktop shell')
  console.error(error)
  shutdown()
  process.exit(1)
})
