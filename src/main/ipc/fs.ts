import { createRequire } from 'node:module'
import type { WebContents } from 'electron'
import { promises as fs, watch as fsWatch, type FSWatcher } from 'fs'
import path from 'node:path'
import { basename, extname, join, parse } from 'path'
import { homedir } from 'os'
import { CONTEX_HOME, CONTEX_HOME_DIRNAME } from '../paths.ts'

const requireElectron = createRequire(import.meta.url)

function getElectron(): typeof import('electron') {
  return requireElectron('electron') as typeof import('electron')
}

interface WatchEntry {
  watcher: FSWatcher
  // Each subscribing renderer plus the raw dirPath it passed. The renderer keys
  // its listener on `fs:watch:${dirPath}`, so we must echo that exact string —
  // and we must broadcast to ALL subscribers, not just the first one.
  subscribers: Map<WebContents, string>
  debounce: ReturnType<typeof setTimeout> | null
}
const watchers = new Map<string, WatchEntry>()
const senderWatchPaths = new WeakMap<WebContents, Set<string>>()
const senderWatchCleanupAttached = new WeakSet<WebContents>()

function trackWatchSender(sender: WebContents, resolvedPath: string): void {
  const existing = senderWatchPaths.get(sender)
  if (existing) existing.add(resolvedPath)
  else senderWatchPaths.set(sender, new Set([resolvedPath]))

  if (senderWatchCleanupAttached.has(sender)) return
  senderWatchCleanupAttached.add(sender)
  sender.once('destroyed', () => {
    const watchedPaths = senderWatchPaths.get(sender)
    if (watchedPaths) {
      for (const watchedPath of watchedPaths) {
        const entry = watchers.get(watchedPath)
        if (entry) {
          entry.subscribers.delete(sender)
          // Only tear down the shared watcher once the last window drops it.
          if (entry.subscribers.size === 0) {
            entry.watcher.close()
            if (entry.debounce) clearTimeout(entry.debounce)
            watchers.delete(watchedPath)
          }
        }
      }
    }
    senderWatchPaths.delete(sender)
    senderWatchCleanupAttached.delete(sender)
  })
}

// --- Security: path validation (SEC-03) ---
const SENSITIVE_DIRS = ['.ssh', '.gnupg', '.aws', '.config']

export interface FsPathScopeOptions {
  restrictToWorkspaceRoots?: boolean
  allowedRoots?: string[]
  allowReadOnlyOpenCodeConfig?: boolean
}

export function isPathUnderRoot(candidatePath: string, rootPath: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath)
  const resolvedRoot = path.resolve(rootPath)
  if (resolvedCandidate === resolvedRoot) return true
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep
  return resolvedCandidate.startsWith(prefix)
}

export function assertPathAllowedForFs(
  resolvedPath: string,
  options?: FsPathScopeOptions,
): void {
  if (!options?.restrictToWorkspaceRoots) return

  // CONTEX_HOME is always allowed when workspace scoping is enabled.
  if (resolvedPath === CONTEX_HOME || resolvedPath.startsWith(CONTEX_HOME + path.sep)) return

  const allowedRoots = options.allowedRoots ?? []
  if (allowedRoots.length === 0) {
    throw new Error(
      'Access denied: no workspace project folders configured. Add a project folder or disable filesystem scoping in Settings.',
    )
  }
  for (const root of allowedRoots) {
    if (isPathUnderRoot(resolvedPath, root)) return
  }

  throw new Error(`Access denied: path "${resolvedPath}" is outside allowed workspace roots`)
}

function isAllowedReadOnlyOpenCodeConfigPath(resolvedPath: string, home: string): boolean {
  const allowedRoots = [
    path.join(home, '.config', 'opencode', 'skills'),
    path.join(home, '.config', 'opencode', 'prompts'),
    path.join(home, '.config', 'opencode', 'agents'),
  ]
  return allowedRoots.some(root => isPathUnderRoot(resolvedPath, root))
}

async function validateReadOnlyOpenCodeConfigRealPath(resolvedPath: string, home: string): Promise<void> {
  try {
    const realPath = await fs.realpath(resolvedPath)
    if (!isAllowedReadOnlyOpenCodeConfigPath(realPath, home)) {
      throw new Error(`Access denied: path "${resolvedPath}" resolves outside allowed OpenCode config roots`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}

export function validateFsPath(filePath: string, options?: FsPathScopeOptions): string {
  const resolved = path.resolve(resolveFsPath(filePath))
  const home = resolveHome()
  // Always allow app config paths
  if (resolved.startsWith(CONTEX_HOME + path.sep) || resolved === CONTEX_HOME) return resolved

  if (options?.allowReadOnlyOpenCodeConfig && isAllowedReadOnlyOpenCodeConfigPath(resolved, home)) {
    return resolved
  }

  // Reject paths to sensitive directories
  for (const dir of SENSITIVE_DIRS) {
    const sensitive = path.join(home, dir)
    if (resolved.startsWith(sensitive + path.sep) || resolved === sensitive) {
      throw new Error(`Access denied: path "${filePath}" targets a sensitive directory (~/${dir})`)
    }
  }

  // Reject if resolved path still contains traversal (shouldn't after resolve, but defense-in-depth)
  if (resolved.includes(`${path.sep}..${path.sep}`) || resolved.endsWith(`${path.sep}..`)) {
    throw new Error(`Path "${filePath}" contains directory traversal`)
  }

  assertPathAllowedForFs(resolved, options)

  // Note: when workspace scoping is off, paths outside the home directory are
  // allowed — users legitimately open projects on other drives (common on
  // Windows where home is C:\ and projects live on D:\ or G:\).
  return resolved
}

async function validateFsPathForHandler(filePath: string, workspaceId?: string, options?: FsPathScopeOptions): Promise<string> {
  const {
    readSettingsSync,
    getAllWorkspaceProjectPaths,
    getWorkspaceProjectPathsById,
  } = await import('./workspace.ts')
  const { applyNewInstallSecurityDefaults } = await import('../../shared/types.ts')
  const settings = applyNewInstallSecurityDefaults(readSettingsSync())
  if (!settings.security.restrictFsToWorkspaceRoots) {
    const resolved = validateFsPath(filePath, options)
    if (options?.allowReadOnlyOpenCodeConfig && isAllowedReadOnlyOpenCodeConfigPath(resolved, resolveHome())) {
      await validateReadOnlyOpenCodeConfigRealPath(resolved, resolveHome())
    }
    return resolved
  }

  const allowedRoots = workspaceId
    ? await getWorkspaceProjectPathsById(workspaceId)
    : await getAllWorkspaceProjectPaths()

  const resolved = validateFsPath(filePath, {
    ...options,
    restrictToWorkspaceRoots: true,
    allowedRoots,
  })
  if (options?.allowReadOnlyOpenCodeConfig && isAllowedReadOnlyOpenCodeConfigPath(resolved, resolveHome())) {
    await validateReadOnlyOpenCodeConfigRealPath(resolved, resolveHome())
  }
  return resolved
}

export function assertSafeCardId(cardId: string): void {
  if (!cardId || !/^[a-zA-Z0-9-]+$/.test(cardId)) {
    throw new Error(`Unsafe card ID: ${cardId}`)
  }
}

const resolveHome = (): string => {
  try {
    const { app } = getElectron()
    if (app?.getPath) return app.getPath('home') || process.env.HOME || process.env.USERPROFILE || homedir()
  } catch {
    // Not running in Electron main (e.g. unit tests importing pure helpers).
  }
  return process.env.HOME || process.env.USERPROFILE || homedir()
}

function resolveFsPath(rawPath: string): string {
  const home = resolveHome()
  if (rawPath === '~') return home
  // Support both legacy ~/.contex/ and new ~/.codesurf/ paths
  if (rawPath.startsWith('~/.contex/')) {
    return join(CONTEX_HOME, rawPath.slice('~/.contex/'.length))
  }
  if (rawPath.startsWith('~\\.contex\\')) {
    return join(CONTEX_HOME, rawPath.slice('~\\.contex\\'.length))
  }
  if (rawPath.startsWith(`~/${CONTEX_HOME_DIRNAME}/`)) {
    return join(CONTEX_HOME, rawPath.slice(`~/${CONTEX_HOME_DIRNAME}/`.length))
  }
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) return join(home, rawPath.slice(2))
  if (rawPath.startsWith('/.contex/')) return join(CONTEX_HOME, rawPath.slice('/.contex/'.length))
  if (rawPath === '/.contex') return CONTEX_HOME
  if (rawPath.startsWith(`/${CONTEX_HOME_DIRNAME}/`)) return join(CONTEX_HOME, rawPath.slice(`/${CONTEX_HOME_DIRNAME}/`.length))
  if (rawPath === `/${CONTEX_HOME_DIRNAME}`) return CONTEX_HOME
  return rawPath
}

export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
}

async function getUniqueCopyPath(destDir: string, sourcePath: string): Promise<string> {
  const resolvedDir = resolveFsPath(destDir)
  const parsed = parse(resolveFsPath(sourcePath))
  let attempt = 0

  while (true) {
    const suffix = attempt === 0 ? '' : ` ${attempt + 1}`
    const candidate = join(resolvedDir, `${parsed.name}${suffix}${parsed.ext}`)
    try {
      await fs.access(candidate)
      attempt += 1
    } catch {
      return candidate
    }
  }
}

async function isProbablyTextFile(resolvedPath: string): Promise<boolean> {
  const resolved = resolvedPath
  const handle = await fs.open(resolved, 'r')
  try {
    const sampleSize = 8192
    const buffer = Buffer.alloc(sampleSize)
    const { bytesRead } = await handle.read(buffer, 0, sampleSize, 0)
    if (bytesRead === 0) return true

    let suspicious = 0
    for (let i = 0; i < bytesRead; i += 1) {
      const byte = buffer[i]
      if (byte === 0) return false
      const isAllowedControl = byte === 9 || byte === 10 || byte === 13 || byte === 12 || byte === 8
      const isPrintableAscii = byte >= 32 && byte <= 126
      const isExtended = byte >= 128
      if (!isAllowedControl && !isPrintableAscii && !isExtended) suspicious += 1
    }

    return suspicious / bytesRead < 0.1
  } finally {
    await handle.close()
  }
}

export function registerFsIPC(): void {
  const { ipcMain, shell } = getElectron()

  ipcMain.handle('fs:readDir', async (_, dirPath: string, workspaceId?: string) => {
    try {
      const resolvedDirPath = await validateFsPathForHandler(dirPath, workspaceId, { allowReadOnlyOpenCodeConfig: true })
      const entries = await fs.readdir(resolvedDirPath, { withFileTypes: true })
      const result: FsEntry[] = entries.map(e => ({
        name: e.name,
        path: `${resolvedDirPath}/${e.name}`,
        isDir: e.isDirectory(),
        ext: e.isDirectory() ? '' : extname(e.name).toLowerCase()
      }))
      // Dirs first, then files, both alphabetical
      result.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return result
    } catch (error) {
      // Return empty array only for directories that don't exist yet; all
      // other errors (permission denied, I/O errors) propagate so callers
      // know something went wrong rather than silently seeing an empty list.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  })

  ipcMain.handle('fs:readFile', async (_, filePath: string, workspaceId?: string) => {
    try {
      return await fs.readFile(await validateFsPathForHandler(filePath, workspaceId, { allowReadOnlyOpenCodeConfig: true }), 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Access-denied errors must propagate: returning '' would let a
      // subsequent save overwrite a real file with empty content.
      if (code === 'EACCES' || code === 'EPERM') throw error
      // File simply doesn't exist — treat as empty (common for optional config files).
      if (code === 'ENOENT') return ''
      throw error
    }
  })

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string, workspaceId?: string) => {
    await fs.writeFile(await validateFsPathForHandler(filePath, workspaceId), content, 'utf8')
  })

  ipcMain.handle('fs:createFile', async (_, filePath: string, workspaceId?: string) => {
    await fs.writeFile(await validateFsPathForHandler(filePath, workspaceId), '', 'utf8')
  })

  ipcMain.handle('fs:createDir', async (_, dirPath: string, workspaceId?: string) => {
    await fs.mkdir(await validateFsPathForHandler(dirPath, workspaceId), { recursive: true })
  })

  ipcMain.handle('fs:deleteFile', async (_, fspath: string, workspaceId?: string) => {
    await fs.rm(await validateFsPathForHandler(fspath, workspaceId), { recursive: true, force: true })
  })

  ipcMain.handle('fs:renameFile', async (_, oldPath: string, newPath: string, workspaceId?: string) => {
    await fs.rename(
      await validateFsPathForHandler(oldPath, workspaceId),
      await validateFsPathForHandler(newPath, workspaceId),
    )
  })

  ipcMain.handle('fs:revealInFinder', async (_, filePath: string, workspaceId?: string) => {
    shell.showItemInFolder(await validateFsPathForHandler(filePath, workspaceId))
  })

  ipcMain.handle('fs:writeBrief', async (_, cardId: string, content: string) => {
    assertSafeCardId(cardId)
    const { join } = await import('path')
    const briefDir = join(CONTEX_HOME, 'briefs')
    await fs.mkdir(briefDir, { recursive: true })
    const briefPath = join(briefDir, `${cardId}.md`)
    await fs.writeFile(briefPath, content, 'utf8')
    return briefPath
  })

  ipcMain.handle('fs:probeDir', async (_, dirPath: string, workspaceId?: string) => {
    try {
      const resolved = await validateFsPathForHandler(dirPath, workspaceId, { allowReadOnlyOpenCodeConfig: true })
      const stats = await fs.stat(resolved)
      if (!stats.isDirectory()) return { ok: false, code: 'ENOTDIR' }
      return { ok: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      return { ok: false, code }
    }
  })

  ipcMain.handle('fs:stat', async (_, filePath: string, workspaceId?: string) => {
    try {
      const stats = await fs.stat(await validateFsPathForHandler(filePath, workspaceId, { allowReadOnlyOpenCodeConfig: true }))
      return {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        isFile: stats.isFile(),
        isDir: stats.isDirectory(),
      }
    } catch (error) {
      // Probes for optional config files are common — return null for "not found"
      // instead of throwing, so the main console isn't spammed with handler errors.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  })

  ipcMain.handle('fs:isProbablyTextFile', async (_, filePath: string, workspaceId?: string) => {
    const resolved = await validateFsPathForHandler(filePath, workspaceId)
    const stats = await fs.stat(resolved)
    if (!stats.isFile()) return false
    return isProbablyTextFile(resolved)
  })

  ipcMain.handle('fs:copyIntoDir', async (_, sourcePath: string, destDir: string, workspaceId?: string) => {
    const resolvedSource = await validateFsPathForHandler(sourcePath, workspaceId)
    const resolvedDestDir = await validateFsPathForHandler(destDir, workspaceId)
    await fs.mkdir(resolvedDestDir, { recursive: true })

    const sourceStats = await fs.stat(resolvedSource)
    if (!sourceStats.isFile()) throw new Error('Only files can be copied into a workspace')

    const directTarget = join(resolvedDestDir, basename(resolvedSource))
    const destPath = directTarget === resolvedSource ? resolvedSource : await getUniqueCopyPath(resolvedDestDir, resolvedSource)

    if (destPath !== resolvedSource) {
      await fs.copyFile(resolvedSource, destPath)
    }

    return { path: destPath }
  })

  ipcMain.handle('fs:watchStart', async (event, dirPath: string, workspaceId?: string) => {
    const resolved = await validateFsPathForHandler(dirPath, workspaceId)
    // Reuse an existing watcher for this path and just add this window as a
    // subscriber. Previously a second window watching the same dir was dropped
    // (its events never fired) and the first window's close tore the shared
    // watcher down out from under everyone else.
    const existing = watchers.get(resolved)
    if (existing) {
      existing.subscribers.set(event.sender, dirPath)
      trackWatchSender(event.sender, resolved)
      return
    }
    try {
      const entry: WatchEntry = {
        watcher: undefined as unknown as FSWatcher,
        subscribers: new Map([[event.sender, dirPath]]),
        debounce: null,
      }
      entry.watcher = fsWatch(resolved, { recursive: true }, () => {
        if (entry.debounce) clearTimeout(entry.debounce)
        entry.debounce = setTimeout(() => {
          for (const [sender, rawPath] of entry.subscribers) {
            if (sender.isDestroyed()) {
              entry.subscribers.delete(sender)
              continue
            }
            sender.send(`fs:watch:${rawPath}`)
          }
        }, 200)
      })
      watchers.set(resolved, entry)
      trackWatchSender(event.sender, resolved)
    } catch { /* ignore */ }
  })

  ipcMain.handle('fs:watchStop', async (event, dirPath: string, workspaceId?: string) => {
    const resolved = await validateFsPathForHandler(dirPath, workspaceId)
    const entry = watchers.get(resolved)
    if (!entry) return
    entry.subscribers.delete(event.sender)
    if (entry.subscribers.size === 0) {
      entry.watcher.close()
      if (entry.debounce) clearTimeout(entry.debounce)
      watchers.delete(resolved)
    }
  })
}
