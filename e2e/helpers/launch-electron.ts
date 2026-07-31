import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { createDaemonManager } from '../../packages/codesurf-daemon/src/manager.ts'
import { runIsolatedElectronCleanup, withCleanupTimeout } from './cleanup-steps'
import { resolveElectronExecutable } from './electron-path'

const REPO_ROOT = join(__dirname, '../..')
const MAIN_ENTRY = join(REPO_ROOT, 'dist-electron/main/index.js')
const DAEMON_ENTRY = join(REPO_ROOT, 'bin/codesurfd.mjs')
const APP_CLOSE_TIMEOUT_MS = 15_000
const APP_PROCESS_EXIT_TIMEOUT_MS = 5_000
const DAEMON_STOP_TIMEOUT_MS = 10_000

export interface LaunchedElectronApp {
  app: ElectronApplication
  page: Page
  homeDir: string
}

export type LaunchCodeSurfOptions = {
  seedSettings?: Record<string, unknown>
}

async function waitForProcessExit(
  process: ReturnType<ElectronApplication['process']>,
  timeoutMs: number,
): Promise<boolean> {
  if (process.exitCode !== null || process.signalCode !== null) return true
  return await new Promise<boolean>(resolve => {
    const onExit = () => {
      clearTimeout(timeout)
      resolve(true)
    }
    const timeout = setTimeout(() => {
      process.off('exit', onExit)
      resolve(process.exitCode !== null || process.signalCode !== null)
    }, timeoutMs)
    process.once('exit', onExit)
  })
}

async function terminateElectronProcess(app: ElectronApplication): Promise<void> {
  const process = app.process()
  if (process.exitCode !== null || process.signalCode !== null) return
  process.kill('SIGTERM')
  if (await waitForProcessExit(process, APP_PROCESS_EXIT_TIMEOUT_MS)) return
  process.kill('SIGKILL')
  if (!(await waitForProcessExit(process, APP_PROCESS_EXIT_TIMEOUT_MS))) {
    throw new Error(`Electron E2E process ${process.pid ?? 'unknown'} did not exit`)
  }
}

async function closeElectronApplication(app: ElectronApplication): Promise<void> {
  try {
    await withCleanupTimeout(app.close(), APP_CLOSE_TIMEOUT_MS, 'Electron E2E app close')
  } catch (error) {
    await terminateElectronProcess(app)
    throw error
  }
}

async function stopIsolatedDaemon(homeDir: string): Promise<void> {
  const manager = createDaemonManager({
    homeDir: join(homeDir, '.codesurf'),
    getAppVersion: () => 'e2e-cleanup',
    resolveDaemonScriptPath: () => DAEMON_ENTRY,
  })
  await withCleanupTimeout(manager.stopDaemon(), DAEMON_STOP_TIMEOUT_MS, 'Electron E2E daemon stop')
  const status = await manager.getDaemonStatus()
  if (status.running) {
    throw new Error(`Electron E2E daemon ${status.info?.pid ?? 'unknown'} is still running`)
  }
}

async function cleanupLaunch(app: ElectronApplication | null, homeDir: string): Promise<void> {
  await runIsolatedElectronCleanup({
    homeDir,
    closeApp: app ? () => closeElectronApplication(app) : undefined,
    stopDaemon: () => stopIsolatedDaemon(homeDir),
    removeHome: () => rm(homeDir, { recursive: true, force: true }),
  })
}

export async function launchCodeSurfElectron(options?: LaunchCodeSurfOptions): Promise<LaunchedElectronApp> {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-e2e-home-'))
  let app: ElectronApplication | null = null
  try {
    if (options?.seedSettings) {
      const contexHome = join(homeDir, '.codesurf')
      await mkdir(contexHome, { recursive: true })
      await writeFile(
        join(contexHome, 'settings.json'),
        JSON.stringify({ version: 1, settings: options.seedSettings }, null, 2),
      )
    }

    app = await electron.launch({
      executablePath: resolveElectronExecutable(),
      cwd: REPO_ROOT,
      args: [MAIN_ENTRY],
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        CODESURF_E2E: '1',
      },
      timeout: 60_000,
    })

    const page = await app.firstWindow({ timeout: 45_000 })
    await page.waitForLoadState('domcontentloaded')

    return { app, page, homeDir }
  } catch (error) {
    try {
      await cleanupLaunch(app, homeDir)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Electron E2E launch and cleanup failed')
    }
    throw error
  }
}

export async function closeCodeSurfElectron(launch: LaunchedElectronApp): Promise<void> {
  await cleanupLaunch(launch.app, launch.homeDir)
}

export async function quitCodeSurfElectron(launch: LaunchedElectronApp): Promise<void> {
  await closeElectronApplication(launch.app)
}
