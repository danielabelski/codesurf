/**
 * Browser dev loop (Agensis-style web):
 *  - codesurfd via web-host
 *  - Vite renderer on :5173 with VITE_CODESURF_HOST pointing at web-host
 *
 * Same UI as desktop:dev Native shell; no Electron.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWindows = process.platform === 'win32'
const npmCmd = isWindows ? 'npm.cmd' : 'npm'
const HOST_URL = process.env.CODESURF_WEB_HOST_URL || 'http://127.0.0.1:4177'
const HOST_HEALTH = `${HOST_URL}/host/health`
const VITE_URL = 'http://127.0.0.1:5173/'

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
      console.error(`[web:dev] ${opts.label || cmd} exited (${code ?? '?'})`)
      shutdown()
      process.exit(code ?? 1)
    }
  })
  return child
}

async function main() {
  if (!(await isUp(HOST_HEALTH))) {
    console.log('[web:dev] starting web-host (+ codesurfd)…')
    spawnTracked(process.execPath, [path.join(root, 'scripts/web-host.mjs')], {
      label: 'web-host',
      fatal: true,
    })
    await waitForServer(HOST_HEALTH)
  }

  const cleanup = () => shutdown()
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('exit', cleanup)

  console.log('[web:dev] starting Vite renderer…')
  console.log(`[web:dev] open ${VITE_URL}`)
  console.log(`[web:dev] host API ${HOST_URL}`)

  const vite = spawnTracked(npmCmd, [
    'run',
    'web:vite',
    '--',
    '--host',
    '127.0.0.1',
    '--port',
    '5173',
    '--strictPort',
  ], {
    label: 'vite',
    fatal: true,
    env: {
      BROWSER: process.env.BROWSER ?? 'none',
      VITE_CODESURF_HOST: HOST_URL,
      CODESURF_WEB_HOST_URL: HOST_URL,
    },
  })

  vite.on('exit', (code) => {
    shutdown()
    process.exit(code ?? 0)
  })
}

main().catch((error) => {
  console.error('[web:dev] failed', error)
  shutdown()
  process.exit(1)
})
