import { createRequire } from 'node:module'
import type { WebContents } from 'electron'
import {
  constants as fsConstants,
  promises as fs,
  watch as fsWatch,
  type FSWatcher,
  type Stats,
} from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { basename, extname, join, parse } from 'path'
import { homedir } from 'os'
import { CODESURF_HOME, CODESURF_HOME_DIRNAME } from '../paths.ts'
import { SENSITIVE_HOME_DIRS } from '../security/sensitivePaths.ts'
import { handleTyped, ipcSchemas } from './handleTyped.ts'

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
// Denylist shared with the `codesurf-file://` media protocol boundary via
// `security/sensitivePaths.ts` so the two boundaries guarding the home
// directory can't drift apart.

export interface FsPathScopeOptions {
  restrictToWorkspaceRoots?: boolean
  allowedRoots?: string[]
  allowReadOnlyOpenCodeConfig?: boolean
}

export type FsPathIntent = 'read' | 'create' | 'write' | 'delete-link' | 'directory'

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

  // CODESURF_HOME is always allowed when workspace scoping is enabled.
  if (resolvedPath === CODESURF_HOME || resolvedPath.startsWith(CODESURF_HOME + path.sep)) return

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

function findSensitiveHomeDir(candidatePath: string, homes: string[]): string | null {
  for (const home of homes) {
    for (const dir of SENSITIVE_HOME_DIRS) {
      const sensitive = path.join(home, dir)
      if (isPathUnderRoot(candidatePath, sensitive)) return dir
    }
  }
  return null
}

function assertPathIsNotSensitive(
  candidatePath: string,
  displayPath: string,
  homes: string[],
): void {
  const sensitiveDir = findSensitiveHomeDir(candidatePath, homes)
  if (sensitiveDir) {
    throw new Error(`Access denied: path "${displayPath}" targets a sensitive directory (~/${sensitiveDir})`)
  }
}

export function validateFsPath(filePath: string, options?: FsPathScopeOptions): string {
  const resolved = path.resolve(resolveFsPath(filePath))
  const home = resolveHome()
  // Always allow app config paths
  if (resolved.startsWith(CODESURF_HOME + path.sep) || resolved === CODESURF_HOME) return resolved

  if (options?.allowReadOnlyOpenCodeConfig && isAllowedReadOnlyOpenCodeConfigPath(resolved, home)) {
    return resolved
  }

  // Reject paths to sensitive directories
  for (const dir of SENSITIVE_HOME_DIRS) {
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

interface CanonicalPathInfo {
  canonicalPath: string
  exists: boolean
  finalIsSymbolicLink: boolean
}

async function canonicalizeFromExistingAncestor(resolvedPath: string): Promise<CanonicalPathInfo> {
  let currentPath = resolvedPath
  const missingSegments: string[] = []

  while (true) {
    let stats: Stats
    try {
      stats = await fs.lstat(currentPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error

      const parentPath = path.dirname(currentPath)
      if (parentPath === currentPath) {
        throw new Error(`Access denied: no existing ancestor for "${resolvedPath}"`)
      }
      missingSegments.unshift(path.basename(currentPath))
      currentPath = parentPath
      continue
    }

    let canonicalAncestor: string
    try {
      canonicalAncestor = await fs.realpath(currentPath)
    } catch (error) {
      if (stats.isSymbolicLink()) {
        throw new Error(`Access denied: path "${resolvedPath}" contains a broken symbolic link`)
      }
      throw error
    }

    if (missingSegments.length > 0) {
      const followedStats = stats.isSymbolicLink() ? await fs.stat(currentPath) : stats
      if (!followedStats.isDirectory()) {
        const error = new Error(`Path "${resolvedPath}" has a non-directory ancestor`) as NodeJS.ErrnoException
        error.code = 'ENOTDIR'
        throw error
      }
    }

    return {
      canonicalPath: path.resolve(canonicalAncestor, ...missingSegments),
      exists: missingSegments.length === 0,
      finalIsSymbolicLink: missingSegments.length === 0 && stats.isSymbolicLink(),
    }
  }
}

async function canonicalizeFsTarget(
  resolvedPath: string,
  intent: FsPathIntent,
): Promise<CanonicalPathInfo> {
  if (intent === 'delete-link') {
    try {
      const stats = await fs.lstat(resolvedPath)
      if (stats.isSymbolicLink()) {
        const parent = await canonicalizeFromExistingAncestor(path.dirname(resolvedPath))
        if (!parent.exists) {
          throw new Error(`Access denied: parent for "${resolvedPath}" does not exist`)
        }
        return {
          canonicalPath: path.join(parent.canonicalPath, path.basename(resolvedPath)),
          exists: true,
          finalIsSymbolicLink: true,
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  return canonicalizeFromExistingAncestor(resolvedPath)
}

function assertCanonicalPathAllowedForFs(
  canonicalPath: string,
  canonicalCodesurfHome: string,
  canonicalAllowedRoots: string[],
  options?: FsPathScopeOptions,
): void {
  if (!options?.restrictToWorkspaceRoots) return
  if (isPathUnderRoot(canonicalPath, canonicalCodesurfHome)) return

  if (canonicalAllowedRoots.length === 0) {
    throw new Error(
      'Access denied: no workspace project folders configured. Add a project folder or disable filesystem scoping in Settings.',
    )
  }
  if (canonicalAllowedRoots.some(root => isPathUnderRoot(canonicalPath, root))) return

  throw new Error(`Access denied: path "${canonicalPath}" resolves outside allowed workspace roots`)
}

export async function validateCanonicalFsPath(
  filePath: string,
  intent: FsPathIntent,
  options?: FsPathScopeOptions,
): Promise<string> {
  const home = resolveHome()
  const allowReadOnlyOpenCodeConfig = Boolean(
    options?.allowReadOnlyOpenCodeConfig
    && (intent === 'read' || intent === 'directory'),
  )
  const effectiveOptions = {
    ...options,
    allowReadOnlyOpenCodeConfig,
  }

  // Preserve the existing lexical checks as a fast first boundary.
  const resolvedPath = validateFsPath(filePath, effectiveOptions)
  const isOpenCodeCarveOut = allowReadOnlyOpenCodeConfig
    && isAllowedReadOnlyOpenCodeConfigPath(resolvedPath, home)
  const target = await canonicalizeFsTarget(resolvedPath, intent)
  const canonicalHome = (await canonicalizeFromExistingAncestor(home)).canonicalPath

  if (isOpenCodeCarveOut) {
    // Deliberately compare against the canonical home plus the lexical
    // OpenCode subdirectories. Canonicalizing the subdirectories themselves
    // would let a symlink broaden this read-only carve-out.
    if (!isAllowedReadOnlyOpenCodeConfigPath(target.canonicalPath, canonicalHome)) {
      throw new Error(`Access denied: path "${resolvedPath}" resolves outside allowed OpenCode config roots`)
    }
  } else {
    const homeCandidates = [...new Set([home, canonicalHome])]
    assertPathIsNotSensitive(resolvedPath, filePath, homeCandidates)
    assertPathIsNotSensitive(target.canonicalPath, filePath, homeCandidates)
  }

  const canonicalCodesurfHome = (
    await canonicalizeFromExistingAncestor(CODESURF_HOME)
  ).canonicalPath
  const canonicalAllowedRoots = options?.restrictToWorkspaceRoots
    ? await Promise.all(
      (options.allowedRoots ?? []).map(async root => (
        await canonicalizeFromExistingAncestor(path.resolve(root))
      ).canonicalPath),
    )
    : []

  if (!isOpenCodeCarveOut) {
    assertCanonicalPathAllowedForFs(
      target.canonicalPath,
      canonicalCodesurfHome,
      canonicalAllowedRoots,
      effectiveOptions,
    )
  }

  const isExplicitDirectoryRoot = intent === 'directory' && (
    resolvedPath === path.resolve(CODESURF_HOME)
    || Boolean(
      options?.restrictToWorkspaceRoots
      && (options.allowedRoots ?? []).some(root => resolvedPath === path.resolve(root)),
    )
  )
  if (
    target.finalIsSymbolicLink
    && intent !== 'delete-link'
    && !isExplicitDirectoryRoot
  ) {
    throw new Error(`Access denied: path "${filePath}" is a symbolic link`)
  }

  return target.canonicalPath
}

async function validateFsPathForHandler(
  filePath: string,
  intent: FsPathIntent,
  workspaceId?: string,
  options?: FsPathScopeOptions,
): Promise<string> {
  const {
    readSettingsSync,
    getAllWorkspaceProjectPaths,
    getWorkspaceProjectPathsById,
  } = await import('./workspace.ts')
  const { applyNewInstallSecurityDefaults } = await import('../../shared/types.ts')
  const settings = applyNewInstallSecurityDefaults(readSettingsSync())
  if (!settings.security.restrictFsToWorkspaceRoots) {
    return validateCanonicalFsPath(filePath, intent, options)
  }

  const allowedRoots = workspaceId
    ? await getWorkspaceProjectPathsById(workspaceId)
    : await getAllWorkspaceProjectPaths()

  return validateCanonicalFsPath(filePath, intent, {
    ...options,
    restrictToWorkspaceRoots: true,
    allowedRoots,
  })
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
  // Support both legacy ~/.codesurf/ and new ~/.codesurf/ paths
  if (rawPath.startsWith('~/.codesurf/')) {
    return join(CODESURF_HOME, rawPath.slice('~/.codesurf/'.length))
  }
  if (rawPath.startsWith('~\\.codesurf\\')) {
    return join(CODESURF_HOME, rawPath.slice('~\\.codesurf\\'.length))
  }
  if (rawPath.startsWith(`~/${CODESURF_HOME_DIRNAME}/`)) {
    return join(CODESURF_HOME, rawPath.slice(`~/${CODESURF_HOME_DIRNAME}/`.length))
  }
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) return join(home, rawPath.slice(2))
  if (rawPath.startsWith('/.codesurf/')) return join(CODESURF_HOME, rawPath.slice('/.codesurf/'.length))
  if (rawPath === '/.codesurf') return CODESURF_HOME
  if (rawPath.startsWith(`/${CODESURF_HOME_DIRNAME}/`)) return join(CODESURF_HOME, rawPath.slice(`/${CODESURF_HOME_DIRNAME}/`.length))
  if (rawPath === `/${CODESURF_HOME_DIRNAME}`) return CODESURF_HOME
  return rawPath
}

function symbolicLinkAccessError(targetPath: string): Error {
  return new Error(`Access denied: path "${targetPath}" is a symbolic link`)
}

async function assertOpenHandleMatchesPath(
  handle: FileHandle,
  targetPath: string,
): Promise<Stats> {
  const [handleStats, pathStats] = await Promise.all([
    handle.stat(),
    fs.lstat(targetPath),
  ])
  if (pathStats.isSymbolicLink()) throw symbolicLinkAccessError(targetPath)
  if (handleStats.dev !== pathStats.dev || handleStats.ino !== pathStats.ino) {
    throw new Error(`Access denied: path "${targetPath}" changed during access`)
  }
  return handleStats
}

async function openExistingFileNoFollow(
  targetPath: string,
  flags: number = fsConstants.O_RDONLY,
): Promise<{ handle: FileHandle; stats: Stats }> {
  const handle = await fs.open(targetPath, flags | fsConstants.O_NOFOLLOW)
  try {
    const stats = await assertOpenHandleMatchesPath(handle, targetPath)
    return { handle, stats }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function readUtf8FileNoFollow(targetPath: string): Promise<string> {
  const { handle } = await openExistingFileNoFollow(targetPath)
  try {
    return await handle.readFile({ encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

async function writeUtf8FileNoFollow(targetPath: string, content: string): Promise<void> {
  let createNew = false
  try {
    const stats = await fs.lstat(targetPath)
    if (stats.isSymbolicLink()) throw symbolicLinkAccessError(targetPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    createNew = true
  }

  const flags = createNew
    ? fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
    : fsConstants.O_WRONLY
  const { handle } = await openExistingFileNoFollow(targetPath, flags)
  try {
    // Open without O_TRUNC so an inode swap is detected before any content is
    // destroyed. Missing files use O_EXCL; existing files use O_NOFOLLOW.
    await handle.truncate(0)
    await handle.writeFile(content, { encoding: 'utf8' })
  } finally {
    await handle.close()
  }
}

async function statPathNoFollow(targetPath: string): Promise<Stats> {
  const pathStats = await fs.lstat(targetPath)
  if (pathStats.isSymbolicLink()) throw symbolicLinkAccessError(targetPath)
  if (!pathStats.isFile()) return pathStats

  const { handle, stats } = await openExistingFileNoFollow(targetPath)
  try {
    return stats
  } finally {
    await handle.close()
  }
}

async function assertDirectoryNoFollow(targetPath: string): Promise<Stats> {
  const stats = await fs.lstat(targetPath)
  if (stats.isSymbolicLink()) throw symbolicLinkAccessError(targetPath)
  if (!stats.isDirectory()) {
    const error = new Error(`Path "${targetPath}" is not a directory`) as NodeJS.ErrnoException
    error.code = 'ENOTDIR'
    throw error
  }
  return stats
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
      await fs.lstat(candidate)
      attempt += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return candidate
    }
  }
}

async function isProbablyTextFile(resolvedPath: string): Promise<boolean> {
  const { handle } = await openExistingFileNoFollow(resolvedPath)
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

async function copyFileNoFollow(sourcePath: string, destinationPath: string): Promise<void> {
  const { handle: sourceHandle, stats: sourceStats } = await openExistingFileNoFollow(sourcePath)
  if (!sourceStats.isFile()) {
    await sourceHandle.close()
    throw new Error('Only files can be copied into a workspace')
  }

  let destinationHandle: FileHandle | null = null
  try {
    destinationHandle = await fs.open(
      destinationPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      sourceStats.mode & 0o777,
    )
    await assertOpenHandleMatchesPath(destinationHandle, destinationPath)

    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break

      let written = 0
      while (written < bytesRead) {
        const result = await destinationHandle.write(
          buffer,
          written,
          bytesRead - written,
          position + written,
        )
        if (result.bytesWritten === 0) {
          throw new Error(`Unable to make progress copying to "${destinationPath}"`)
        }
        written += result.bytesWritten
      }
      position += bytesRead
    }
  } catch (error) {
    if (destinationHandle) {
      await destinationHandle.close().catch(() => undefined)
      destinationHandle = null
    }
    throw error
  } finally {
    await sourceHandle.close()
    if (destinationHandle) await destinationHandle.close()
  }
}

export function registerFsIPC(): void {
  const { ipcMain, shell } = getElectron()

  ipcMain.handle('fs:readDir', async (_, dirPath: string, workspaceId?: string) => {
    try {
      const resolvedDirPath = await validateFsPathForHandler(
        dirPath,
        'directory',
        workspaceId,
        { allowReadOnlyOpenCodeConfig: true },
      )
      // readdir has no portable no-follow descriptor API. Recheck the
      // canonical directory immediately before the path-based operation.
      await assertDirectoryNoFollow(resolvedDirPath)
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
      const resolved = await validateFsPathForHandler(
        filePath,
        'read',
        workspaceId,
        { allowReadOnlyOpenCodeConfig: true },
      )
      return await readUtf8FileNoFollow(resolved)
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

  handleTyped('fs:writeFile', {
    args: [ipcSchemas.boundedString(), ipcSchemas.fileContent, ipcSchemas.optionalString] as const,
    handler: async (_evt, filePath, content, workspaceId) => {
      const resolved = await validateFsPathForHandler(filePath, 'write', workspaceId)
      await writeUtf8FileNoFollow(resolved, content)
    },
  })

  handleTyped('fs:createFile', {
    args: [ipcSchemas.boundedString(), ipcSchemas.optionalString] as const,
    handler: async (_evt, filePath, workspaceId) => {
      const resolved = await validateFsPathForHandler(filePath, 'create', workspaceId)
      await writeUtf8FileNoFollow(resolved, '')
    },
  })

  handleTyped('fs:createDir', {
    args: [ipcSchemas.boundedString(), ipcSchemas.optionalString] as const,
    handler: async (_evt, dirPath, workspaceId) => {
      const resolved = await validateFsPathForHandler(dirPath, 'directory', workspaceId)
      // mkdir has no descriptor-relative portable equivalent in Node. The
      // canonical-parent preflight prevents known aliases; the remaining
      // mutation race is bounded to this path-based call.
      await fs.mkdir(resolved, { recursive: true })
    },
  })

  handleTyped('fs:deleteFile', {
    args: [ipcSchemas.boundedString(), ipcSchemas.optionalString] as const,
    handler: async (_evt, fspath, workspaceId) => {
      const resolved = await validateFsPathForHandler(fspath, 'write', workspaceId)
      let currentStats: Stats
      try {
        currentStats = await fs.lstat(resolved)
      } catch (error) {
        // force:true historically made deletion of a missing path a no-op.
        // Canonical validation has already authorized its existing parent.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (currentStats.isSymbolicLink()) throw symbolicLinkAccessError(resolved)
      // rm has no no-follow file-descriptor variant. The immediate lstat
      // ensures recursive deletion never starts from a known symlink.
      await fs.rm(resolved, { recursive: true, force: true })
    },
  })

  handleTyped('fs:renameFile', {
    args: [ipcSchemas.boundedString(), ipcSchemas.boundedString(), ipcSchemas.optionalString] as const,
    handler: async (_evt, oldPath, newPath, workspaceId) => {
      const resolvedOldPath = await validateFsPathForHandler(oldPath, 'write', workspaceId)
      const resolvedNewPath = await validateFsPathForHandler(newPath, 'create', workspaceId)
      // Node exposes rename only as a two-path operation. Both canonical
      // endpoints are independently preflighted; there is no descriptor-based
      // portable rename API that can close the remaining mutation race.
      await fs.rename(resolvedOldPath, resolvedNewPath)
    },
  })

  handleTyped('fs:revealInFinder', {
    args: [ipcSchemas.boundedString(), ipcSchemas.optionalString] as const,
    handler: async (_evt, filePath, workspaceId) => {
      const resolved = await validateFsPathForHandler(filePath, 'read', workspaceId)
      // Electron's shell API accepts only a path, so canonical validation plus
      // this immediate no-link recheck is the strongest available preflight.
      const currentStats = await fs.lstat(resolved)
      if (currentStats.isSymbolicLink()) throw symbolicLinkAccessError(resolved)
      shell.showItemInFolder(resolved)
    },
  })

  handleTyped('fs:writeBrief', {
    args: [ipcSchemas.boundedString().max(128), ipcSchemas.fileContent] as const,
    handler: async (_evt, cardId, content) => {
      assertSafeCardId(cardId)
      const { join } = await import('path')
      const briefDir = join(CODESURF_HOME, 'briefs')
      const resolvedBriefDir = await validateFsPathForHandler(briefDir, 'directory')
      await fs.mkdir(resolvedBriefDir, { recursive: true })
      const briefPath = await validateFsPathForHandler(
        join(resolvedBriefDir, `${cardId}.md`),
        'write',
      )
      await writeUtf8FileNoFollow(briefPath, content)
      return briefPath
    },
  })

  ipcMain.handle('fs:probeDir', async (_, dirPath: string, workspaceId?: string) => {
    try {
      const resolved = await validateFsPathForHandler(
        dirPath,
        'directory',
        workspaceId,
        { allowReadOnlyOpenCodeConfig: true },
      )
      await assertDirectoryNoFollow(resolved)
      return { ok: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      return { ok: false, code }
    }
  })

  ipcMain.handle('fs:stat', async (_, filePath: string, workspaceId?: string) => {
    try {
      const resolved = await validateFsPathForHandler(
        filePath,
        'read',
        workspaceId,
        { allowReadOnlyOpenCodeConfig: true },
      )
      const stats = await statPathNoFollow(resolved)
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
    const resolved = await validateFsPathForHandler(filePath, 'read', workspaceId)
    const stats = await statPathNoFollow(resolved)
    if (!stats.isFile()) return false
    return isProbablyTextFile(resolved)
  })

  ipcMain.handle('fs:copyIntoDir', async (_, sourcePath: string, destDir: string, workspaceId?: string) => {
    const resolvedSource = await validateFsPathForHandler(sourcePath, 'read', workspaceId)
    const resolvedDestDir = await validateFsPathForHandler(destDir, 'directory', workspaceId)
    await fs.mkdir(resolvedDestDir, { recursive: true })
    await assertDirectoryNoFollow(resolvedDestDir)

    const sourceStats = await statPathNoFollow(resolvedSource)
    if (!sourceStats.isFile()) throw new Error('Only files can be copied into a workspace')

    const directTarget = join(resolvedDestDir, basename(resolvedSource))
    const candidatePath = directTarget === resolvedSource
      ? resolvedSource
      : await getUniqueCopyPath(resolvedDestDir, resolvedSource)
    const destPath = await validateFsPathForHandler(candidatePath, 'create', workspaceId)

    if (destPath !== resolvedSource) {
      await copyFileNoFollow(resolvedSource, destPath)
    }

    return { path: destPath }
  })

  ipcMain.handle('fs:watchStart', async (event, dirPath: string, workspaceId?: string) => {
    const resolved = await validateFsPathForHandler(dirPath, 'directory', workspaceId)
    await assertDirectoryNoFollow(resolved)
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
      // fs.watch accepts only a path. Canonical validation plus the immediate
      // directory lstat above is the available no-link preflight.
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
    const resolved = await validateFsPathForHandler(dirPath, 'directory', workspaceId)
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
