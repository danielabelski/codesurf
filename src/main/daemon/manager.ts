import { app } from 'electron'
import { join } from 'node:path'
import {
  createDaemonManager,
  resolveDaemonScriptFromCandidates,
  type DaemonStatusInfo,
} from '@codesurf/daemon/manager'
import { DAEMON_PACKAGE_VERSION } from '@codesurf/daemon/paths'
import { CONTEX_HOME } from '../paths'

export type { DaemonStatusInfo }

/**
 * Report the @codesurf/daemon package version (not Electron's app version) so
 * we don't fight the codesurf TUI for daemon ownership: any host that pins
 * the same daemon package will agree, and the daemon won't force-restart on
 * the boundary between desktop and TUI sessions. Override with
 * `CODESURF_DAEMON_VERSION_PIN` if you need a different value.
 *
 * Kept for diagnostics: `app.getVersion()` is logged via the daemon process
 * env (`CODESURF_HOST_APP_VERSION`).
 */
function resolveAppVersion(): string {
  const pin = process.env.CODESURF_DAEMON_VERSION_PIN?.trim()
  return pin && pin.length > 0 ? pin : DAEMON_PACKAGE_VERSION
}

function resolveHostAppVersion(): string {
  const version = app.getVersion?.()
  return typeof version === 'string' && version.trim().length > 0 ? version.trim() : '0.0.0'
}

function resolveDaemonScriptPath(): string {
  const appPath = app.getAppPath()
  return resolveDaemonScriptFromCandidates([
    // Packaged: bin shipped via electron-builder `files`/`asarUnpack`.
    join(appPath, 'bin', 'codesurfd.mjs'),
    join(appPath, '..', 'app.asar.unpacked', 'bin', 'codesurfd.mjs'),
    // Dev: we run from the source tree.
    join(process.cwd(), 'bin', 'codesurfd.mjs'),
    // Fallback: the package's own bin (used if the launcher shim is removed).
    join(appPath, 'packages', 'codesurf-daemon', 'bin', 'codesurfd.mjs'),
    join(process.cwd(), 'packages', 'codesurf-daemon', 'bin', 'codesurfd.mjs'),
  ])
}

const manager = createDaemonManager({
  homeDir: CONTEX_HOME,
  getAppVersion: resolveAppVersion,
  resolveDaemonScriptPath,
  extraEnv: () => ({ CODESURF_HOST_APP_VERSION: resolveHostAppVersion() }),
})

export const ensureDaemonRunning = manager.ensureDaemonRunning
export const getDaemonStatus = manager.getDaemonStatus
export const invalidateDaemonCache = manager.invalidateDaemonCache
export const restartDaemon = manager.restartDaemon
export const stopDaemon = manager.stopDaemon
