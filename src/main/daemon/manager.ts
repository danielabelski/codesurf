import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { CONTEX_HOME } from '../paths'

export interface DaemonStatusInfo {
  pid: number
  port: number
  token: string
  startedAt: string
  protocolVersion: number
  appVersion: string | null
}

const DAEMON_DIR = join(CONTEX_HOME, 'daemon')
const DAEMON_PID_PATH = join(DAEMON_DIR, 'pid.json')
const DAEMON_LOG_PATH = join(DAEMON_DIR, 'daemon.log')
const DAEMON_LOCK_PATH = join(DAEMON_DIR, 'startup.lock')
const DAEMON_HEALTH_TIMEOUT_MS = 15_000
const DAEMON_STARTUP_GRACE_MS = 1_200
const DAEMON_POLL_INTERVAL_MS = 150
const DAEMON_LOCK_STALE_MS = 30_000
const DAEMON_STOP_TIMEOUT_MS = 5_000
const DAEMON_KILL_TIMEOUT_MS = 2_000

let cachedInfo: DaemonStatusInfo | null = null
let startupPromise: Promise<DaemonStatusInfo> | null = null

function ensureDaemonDir(): void {
  mkdirSync(DAEMON_DIR, { recursive: true })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function resolveAppVersion(): string {
  const version = app.getVersion?.()
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : '0.0.0'
}

function readPidInfo(): DaemonStatusInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(DAEMON_PID_PATH, 'utf8')) as Partial<DaemonStatusInfo> & {
      version?: number
      protocolVersion?: number
      appVersion?: string | null
    }
    const protocolVersion = typeof parsed.protocolVersion === 'number'
      ? parsed.protocolVersion
      : (typeof parsed.version === 'number' ? parsed.version : null)
    if (
      typeof parsed.pid !== 'number'
      || typeof parsed.port !== 'number'
      || typeof parsed.token !== 'string'
      || typeof parsed.startedAt !== 'string'
      || typeof protocolVersion !== 'number'
    ) {
      return null
    }
    return {
      pid: parsed.pid,
      port: parsed.port,
      token: parsed.token,
      startedAt: parsed.startedAt,
      protocolVersion,
      appVersion: typeof parsed.appVersion === 'string' && parsed.appVersion.trim().length > 0
        ? parsed.appVersion.trim()
        : null,
    }
  } catch {
    return null
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
    return code === 'EPERM'
  }
}

async function healthcheck(info: DaemonStatusInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(2_000),
      headers: {
        Authorization: `Bearer ${info.token}`,
      },
    })
    if (!response.ok) return false
    const parsed = await response.json() as { ok?: boolean }
    return parsed.ok === true
  } catch {
    return false
  }
}

function clearDaemonCache(): void {
  cachedInfo = null
}

function removeFileIfPresent(filePath: string): void {
  try {
    rmSync(filePath, { force: true })
  } catch {
    // ignore
  }
}

function cleanupStalePidFile(): void {
  const info = readPidInfo()
  if (!info || !isProcessAlive(info.pid)) {
    removeFileIfPresent(DAEMON_PID_PATH)
  }
}

function tailDaemonLog(lines = 20): string {
  try {
    const content = readFileSync(DAEMON_LOG_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-lines)
      .join('\n')
    return content.trim()
  } catch {
    return ''
  }
}

function lockLooksStale(): boolean {
  try {
    return (Date.now() - statSync(DAEMON_LOCK_PATH).mtimeMs) > DAEMON_LOCK_STALE_MS
  } catch {
    return false
  }
}

function resolveDaemonScriptPath(): string {
  const appPath = app.getAppPath()
  const candidates = [
    join(appPath, 'bin', 'codesurfd.mjs'),
    join(appPath, '..', 'app.asar.unpacked', 'bin', 'codesurfd.mjs'),
    join(process.cwd(), 'bin', 'codesurfd.mjs'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error('Unable to locate codesurfd.mjs')
}

async function waitForDaemonReady(): Promise<DaemonStatusInfo> {
  const start = Date.now()
  while ((Date.now() - start) < DAEMON_HEALTH_TIMEOUT_MS) {
    const info = readPidInfo()
    if (info && isProcessAlive(info.pid) && await healthcheck(info)) {
      cachedInfo = info
      return info
    }
    await new Promise(resolve => setTimeout(resolve, DAEMON_POLL_INTERVAL_MS))
  }
  const recentLogs = tailDaemonLog()
  throw new Error(
    recentLogs
      ? `CodeSurf daemon did not become healthy in time.\n\nRecent daemon logs:\n${recentLogs}`
      : 'CodeSurf daemon did not become healthy in time',
  )
}

async function waitForChildStartupGrace(child: ChildProcess): Promise<void> {
  const exitedEarly = await new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const timer = setTimeout(() => finish(false), DAEMON_STARTUP_GRACE_MS)
    child.once('error', () => {
      clearTimeout(timer)
      finish(true)
    })
    child.once('exit', () => {
      clearTimeout(timer)
      finish(true)
    })
  })

  if (!exitedEarly) return

  const recentLogs = tailDaemonLog()
  throw new Error(
    recentLogs
      ? `CodeSurf daemon exited during startup.\n\nRecent daemon logs:\n${recentLogs}`
      : 'CodeSurf daemon exited during startup',
  )
}

function spawnDaemonProcess(): ChildProcess {
  ensureDaemonDir()
  const out = openSync(DAEMON_LOG_PATH, 'a')
  const daemonScriptPath = resolveDaemonScriptPath()
  const child = spawn(process.execPath, [daemonScriptPath], {
    detached: true,
    stdio: ['ignore', out, out],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CODESURF_HOME: CONTEX_HOME,
      CODESURF_DAEMON_PID_PATH: DAEMON_PID_PATH,
      CODESURF_APP_VERSION: resolveAppVersion(),
    },
  })
  child.unref()
  closeSync(out)
  return child
}

async function withStartupLock(work: () => Promise<DaemonStatusInfo>): Promise<DaemonStatusInfo> {
  ensureDaemonDir()
  const deadline = Date.now() + DAEMON_HEALTH_TIMEOUT_MS

  while (Date.now() < deadline) {
    cleanupStalePidFile()
    try {
      const fd = openSync(DAEMON_LOCK_PATH, 'wx')
      try {
        return await work()
      } finally {
        closeSync(fd)
        removeFileIfPresent(DAEMON_LOCK_PATH)
      }
    } catch (error) {
      const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
      if (code !== 'EEXIST') throw error

      const existing = readPidInfo()
      if (existing && isProcessAlive(existing.pid) && await healthcheck(existing)) {
        cachedInfo = existing
        return existing
      }

      if (lockLooksStale()) {
        removeFileIfPresent(DAEMON_LOCK_PATH)
        continue
      }

      await sleep(DAEMON_POLL_INTERVAL_MS)
    }
  }

  throw new Error('Timed out acquiring CodeSurf daemon startup lock')
}

function signalProcessSafely(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  try {
    process.kill(pid, signal)
    return true
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function signalProcessGroupSafely(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === 'win32') {
    return signalProcessSafely(pid, signal)
  }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false
  try {
    process.kill(-pid, signal)
    return true
  } catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code ?? '') : ''
    if (code === 'ESRCH') return signalProcessSafely(pid, signal)
    if (code === 'EPERM') return true
    throw error
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(DAEMON_POLL_INTERVAL_MS)
  }
  return !isProcessAlive(pid)
}

async function stopDaemonProcess(info: DaemonStatusInfo | null): Promise<void> {
  if (!info || !isProcessAlive(info.pid)) {
    removeFileIfPresent(DAEMON_PID_PATH)
    return
  }

  signalProcessSafely(info.pid, 'SIGTERM')
  let stopped = await waitForPidExit(info.pid, DAEMON_STOP_TIMEOUT_MS)
  if (!stopped) {
    signalProcessGroupSafely(info.pid, 'SIGKILL')
    stopped = await waitForPidExit(info.pid, DAEMON_KILL_TIMEOUT_MS)
  }

  if (!stopped) {
    throw new Error(`Timed out stopping CodeSurf daemon PID ${info.pid}`)
  }

  removeFileIfPresent(DAEMON_PID_PATH)
}

export async function ensureDaemonRunning(options?: { forceRestart?: boolean }): Promise<DaemonStatusInfo> {
  const forceRestart = options?.forceRestart === true
  const appVersion = resolveAppVersion()

  if (cachedInfo && isProcessAlive(cachedInfo.pid) && await healthcheck(cachedInfo)) {
    if (!forceRestart && (!cachedInfo.appVersion || cachedInfo.appVersion === appVersion)) {
      return cachedInfo
    }
  }

  if (startupPromise) return startupPromise

  startupPromise = (async () => {
    const existing = readPidInfo()
    if (forceRestart) {
      await stopDaemonProcess(existing)
      clearDaemonCache()
    } else if (
      existing
      && isProcessAlive(existing.pid)
      && await healthcheck(existing)
      && (!existing.appVersion || existing.appVersion === appVersion)
    ) {
      cachedInfo = existing
      return existing
    }

    return await withStartupLock(async () => {
      const lockedExisting = readPidInfo()
      if (
        !forceRestart
        && lockedExisting
        && isProcessAlive(lockedExisting.pid)
        && await healthcheck(lockedExisting)
        && (!lockedExisting.appVersion || lockedExisting.appVersion === appVersion)
      ) {
        cachedInfo = lockedExisting
        return lockedExisting
      }

      if (forceRestart && lockedExisting) {
        await stopDaemonProcess(lockedExisting)
        clearDaemonCache()
      }

      const child = spawnDaemonProcess()
      await waitForChildStartupGrace(child)
      return await waitForDaemonReady()
    })
  })()

  try {
    return await startupPromise
  } finally {
    startupPromise = null
  }
}

export async function getDaemonStatus(): Promise<{ running: boolean; info: DaemonStatusInfo | null }> {
  const info = readPidInfo()
  if (!info || !isProcessAlive(info.pid) || !(await healthcheck(info))) {
    clearDaemonCache()
    return { running: false, info: null }
  }
  cachedInfo = info
  return { running: true, info }
}

export function invalidateDaemonCache(): void {
  clearDaemonCache()
}

export async function restartDaemon(): Promise<DaemonStatusInfo> {
  invalidateDaemonCache()
  return await ensureDaemonRunning({ forceRestart: true })
}
