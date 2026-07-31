import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const REPO_ROOT = join(__dirname, '../..')
const WEB_PREVIEW_ENTRY = join(REPO_ROOT, 'scripts/web-preview.mjs')
const WEB_BUILD_ENTRY = join(REPO_ROOT, 'dist/index.html')
const START_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 15_000
const MAX_LOG_BYTES = 64 * 1024

export interface LaunchedWebPreview {
  url: string
  hostUrl: string
  homeDir: string
  close: () => Promise<void>
}

async function listenOnEphemeralPort(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('Could not reserve a loopback port for built-web E2E')
  }
  return { server, port: address.port }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()))
  })
}

async function reserveDistinctPorts(count: number): Promise<number[]> {
  const reservations: Array<{ server: Server; port: number }> = []
  try {
    for (let index = 0; index < count; index += 1) {
      reservations.push(await listenOnEphemeralPort())
    }
    return reservations.map(({ port }) => port)
  } finally {
    await Promise.all(reservations.map(({ server }) => closeServer(server)))
  }
}

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout)
      resolveExit(true)
    }
    const timeout = setTimeout(() => {
      child.off('exit', onExit)
      resolveExit(child.exitCode !== null || child.signalCode !== null)
    }, timeoutMs)
    child.once('exit', onExit)
  })
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // The process may have left its group while shutting down. Fall back to
      // signalling the preview coordinator directly.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Best effort. The exit wait below determines whether escalation is needed.
  }
}

async function stopPreview(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  terminateProcessTree(child, 'SIGTERM')
  if (await waitForProcessExit(child, STOP_TIMEOUT_MS)) return
  terminateProcessTree(child, 'SIGKILL')
  if (!(await waitForProcessExit(child, STOP_TIMEOUT_MS))) {
    throw new Error(`Built-web preview process ${child.pid ?? 'unknown'} did not exit`)
  }
}

async function waitForPreview(
  url: string,
  child: ChildProcess,
  getLogTail: () => string,
  getSpawnError: () => Error | null,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    const spawnError = getSpawnError()
    if (spawnError) throw spawnError
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Built-web preview exited before becoming ready ` +
          `(code=${child.exitCode}, signal=${child.signalCode}).\n${getLogTail()}`,
      )
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_500) })
      if (response.ok && (await response.text()).includes('<div id="root">')) return
    } catch {
      // Preview, host, and daemon start independently. Retry until the full UI
      // is reachable or the coordinator exits.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
  throw new Error(`Timed out waiting for built-web preview at ${url}.\n${getLogTail()}`)
}

export async function launchBuiltWebPreview(): Promise<LaunchedWebPreview> {
  if (!existsSync(WEB_BUILD_ENTRY)) {
    throw new Error(`Built-web E2E requires ${WEB_BUILD_ENTRY}; run \`npm run build:web\` first`)
  }
  if (!existsSync(WEB_PREVIEW_ENTRY)) {
    throw new Error(`Built-web preview entry is missing: ${WEB_PREVIEW_ENTRY}`)
  }

  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-web-e2e-home-'))
  const codesurfHome = join(homeDir, '.codesurf')
  await mkdir(codesurfHome, { recursive: true })

  const [previewPort, hostPort, runtimeConfigPort, terminalPort] = await reserveDistinctPorts(4)
  const url = `http://127.0.0.1:${previewPort}/`
  const hostUrl = `http://127.0.0.1:${hostPort}`
  const child = spawn(process.execPath, [WEB_PREVIEW_ENTRY], {
    cwd: REPO_ROOT,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      CODESURF_HOME: codesurfHome,
      CODESURF_WEB_HOST_URL: hostUrl,
      CODESURF_WEB_HOST_PORT: String(hostPort),
      CODESURF_WEB_HOST_TOKEN: randomBytes(32).toString('base64url'),
      CODESURF_WEB_PREVIEW_PORT: String(previewPort),
      CODESURF_WEB_PREVIEW_RUNTIME_PORT: String(runtimeConfigPort),
      CODESURF_WEB_PREVIEW_TERMINAL_PORT: String(terminalPort),
      CODESURF_TERMINAL_TOKEN: randomBytes(32).toString('base64url'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let logTail = ''
  let spawnError: Error | null = null
  const appendLog = (chunk: Buffer | string) => {
    logTail += String(chunk)
    if (logTail.length > MAX_LOG_BYTES) logTail = logTail.slice(-MAX_LOG_BYTES)
  }
  child.stdout?.on('data', appendLog)
  child.stderr?.on('data', appendLog)
  child.once('error', (error) => {
    spawnError = error
  })

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    let stopError: unknown = null
    try {
      await stopPreview(child)
    } catch (error) {
      stopError = error
    }
    await rm(homeDir, { recursive: true, force: true })
    if (stopError) throw stopError
  }

  try {
    await waitForPreview(
      url,
      child,
      () => logTail,
      () => spawnError,
    )
    return { url, hostUrl, homeDir, close }
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Built-web preview launch and cleanup failed')
    }
    throw error
  }
}
