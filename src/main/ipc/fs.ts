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

async function canonicalizeAuthorizationRoot(rootPath: string): Promise<string | null> {
  try {
    return (await canonicalizeFromExistingAncestor(path.resolve(rootPath))).canonicalPath
  } catch {
    // A configured root may be temporarily unavailable, unreadable, or a
    // broken symlink. It must not disable another valid root, but it also must
    // never authorize a target. Returning null is therefore fail-closed.
    return null
  }
}

async function canonicalRootsRelevantToTarget(
  resolvedPath: string,
  options?: FsPathScopeOptions,
): Promise<string[]> {
  if (!options?.restrictToWorkspaceRoots) return []

  const lexicalCandidates = [
    CODESURF_HOME,
    ...(options.allowedRoots ?? []),
  ].filter(root => isPathUnderRoot(resolvedPath, root))

  const canonicalRoots: string[] = []
  for (const root of lexicalCandidates) {
    const canonicalRoot = await canonicalizeAuthorizationRoot(root)
    if (canonicalRoot) canonicalRoots.push(canonicalRoot)
  }
  return [...new Set(canonicalRoots)]
}

export interface ValidatedFsPath {
  /** Canonical path used exclusively for kernel filesystem operations. */
  operationPath: string
  /** Normalized lexical identity retained for renderer-facing path contracts. */
  displayPath: string
}

export async function validateCanonicalFsPathDetails(
  filePath: string,
  intent: FsPathIntent,
  options?: FsPathScopeOptions,
): Promise<ValidatedFsPath> {
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

  if (isOpenCodeCarveOut) {
    const canonicalHome = (await canonicalizeFromExistingAncestor(home)).canonicalPath
    // Deliberately compare against the canonical home plus the lexical
    // OpenCode subdirectories. Canonicalizing the subdirectories themselves
    // would let a symlink broaden this read-only carve-out.
    if (!isAllowedReadOnlyOpenCodeConfigPath(target.canonicalPath, canonicalHome)) {
      throw new Error(`Access denied: path "${resolvedPath}" resolves outside allowed OpenCode config roots`)
    }
    if (target.finalIsSymbolicLink) {
      throw new Error(`Access denied: path "${filePath}" is a symbolic link`)
    }
    // The OpenCode carve-out is independent of workspace roots and app state.
    // Do not resolve either here: a broken unrelated configured root or
    // CODESURF_HOME must not disable this explicitly read-only path.
    return {
      operationPath: target.canonicalPath,
      displayPath: resolvedPath,
    }
  } else {
    const canonicalHome = await canonicalizeAuthorizationRoot(home)
    const homeCandidates = canonicalHome
      ? [...new Set([home, canonicalHome])]
      : [home]
    assertPathIsNotSensitive(resolvedPath, filePath, homeCandidates)
    assertPathIsNotSensitive(target.canonicalPath, filePath, homeCandidates)
  }

  if (effectiveOptions.restrictToWorkspaceRoots) {
    const canonicalRoots = await canonicalRootsRelevantToTarget(
      resolvedPath,
      effectiveOptions,
    )
    if (!canonicalRoots.some(root => isPathUnderRoot(target.canonicalPath, root))) {
      throw new Error(
        `Access denied: path "${target.canonicalPath}" resolves outside allowed workspace roots`,
      )
    }
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

  return {
    operationPath: target.canonicalPath,
    displayPath: resolvedPath,
  }
}

export async function validateCanonicalFsPath(
  filePath: string,
  intent: FsPathIntent,
  options?: FsPathScopeOptions,
): Promise<string> {
  return (await validateCanonicalFsPathDetails(filePath, intent, options)).operationPath
}

async function validateFsPathForHandler(
  filePath: string,
  intent: FsPathIntent,
  workspaceId?: string,
  options?: FsPathScopeOptions,
): Promise<ValidatedFsPath> {
  const {
    readSettingsSync,
    getAllWorkspaceProjectPaths,
    getWorkspaceProjectPathsById,
  } = await import('./workspace.ts')
  const { applyNewInstallSecurityDefaults } = await import('../../shared/types.ts')
  const settings = applyNewInstallSecurityDefaults(readSettingsSync())
  if (!settings.security.restrictFsToWorkspaceRoots) {
    return validateCanonicalFsPathDetails(filePath, intent, options)
  }

  const allowedRoots = workspaceId
    ? await getWorkspaceProjectPathsById(workspaceId)
    : await getAllWorkspaceProjectPaths()

  return validateCanonicalFsPathDetails(filePath, intent, {
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

interface FileIdentity {
  dev: number
  ino: number
}

function hasFileIdentity(stats: Stats, identity: FileIdentity): boolean {
  return stats.dev === identity.dev && stats.ino === identity.ino
}

export async function cleanupCreatedCopyIfUnchanged(
  destinationPath: string,
  createdIdentity: FileIdentity,
): Promise<boolean> {
  let currentStats: Stats
  try {
    currentStats = await fs.lstat(destinationPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }

  // The copy target is created with O_EXCL. Only remove that exact inode:
  // never follow or unlink a symlink, and preserve anything that replaced it.
  if (
    currentStats.isSymbolicLink()
    || !hasFileIdentity(currentStats, createdIdentity)
  ) {
    return false
  }

  // Recheck immediately before unlinking to narrow the remaining path-based
  // race. Node does not expose unlinkat(2) for deleting by an open descriptor.
  const confirmedStats = await fs.lstat(destinationPath).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (
    !confirmedStats
    || confirmedStats.isSymbolicLink()
    || !hasFileIdentity(confirmedStats, createdIdentity)
  ) {
    return false
  }

  await fs.unlink(destinationPath)
  return true
}

export interface CopyFileNoFollowOptions {
  afterChunkCopied?: (bytesCopied: number) => void | Promise<void>
}

export async function copyFileNoFollow(
  sourcePath: string,
  destinationPath: string,
  options?: CopyFileNoFollowOptions,
): Promise<void> {
  const { handle: sourceHandle, stats: sourceStats } = await openExistingFileNoFollow(sourcePath)
  if (!sourceStats.isFile()) {
    await sourceHandle.close()
    throw new Error('Only files can be copied into a workspace')
  }

  let destinationHandle: FileHandle | null = null
  let createdDestinationIdentity: FileIdentity | null = null
  try {
    destinationHandle = await fs.open(
      destinationPath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | fsConstants.O_NOFOLLOW,
      sourceStats.mode & 0o777,
    )
    const createdDestinationStats = await destinationHandle.stat()
    createdDestinationIdentity = {
      dev: createdDestinationStats.dev,
      ino: createdDestinationStats.ino,
    }
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
      await options?.afterChunkCopied?.(position)
    }

    await destinationHandle.close()
    destinationHandle = null
  } catch (error) {
    if (destinationHandle) {
      await destinationHandle.close().catch(() => undefined)
      destinationHandle = null
    }
    if (createdDestinationIdentity) {
      // Preserve the original copy failure. Cleanup is best-effort because a
      // concurrent actor may have removed or replaced the destination.
      await cleanupCreatedCopyIfUnchanged(
        destinationPath,
        createdDestinationIdentity,
      ).catch(() => undefined)
    }
    throw error
  } finally {
    await sourceHandle.close()
    if (destinationHandle) await destinationHandle.close()
  }
}

type FsIpcMain = Pick<typeof import('electron')['ipcMain'], 'handle'>
type FsShell = Pick<typeof import('electron')['shell'], 'showItemInFolder'>
type FsPathValidator = (
  filePath: string,
  intent: FsPathIntent,
  workspaceId?: string,
  options?: FsPathScopeOptions,
) => Promise<ValidatedFsPath>

export interface FsIpcRegistrationDependencies {
  ipcMain?: FsIpcMain
  shell?: FsShell
  validatePath?: FsPathValidator
}

export function registerFsIPC(dependencies?: FsIpcRegistrationDependencies): void {
  const electron = dependencies?.ipcMain && dependencies.shell
    ? null
    : getElectron()
  const ipcMain = dependencies?.ipcMain ?? electron!.ipcMain
  const shell = dependencies?.shell ?? electron!.shell
  const validatePath = dependencies?.validatePath ?? validateFsPathForHandler

  ipcMain.handle('fs:readDir', async (_, dirPath: string, workspaceId?: string) => {
    try {
      const validatedDirPath = await validatePath(
        dirPath,
        'directory',
        workspaceId,
        { allowReadOnlyOpenCodeConfig: true },
      )
      // readdir has no portable no-follow descriptor API. Recheck the
      // canonical directory immediately before the path-based operation.
      await assertDirectoryNoFollow(validatedDirPath.operationPath)
      const entries = await fs.readdir(validatedDirPath.operationPath, { withFileTypes: true })
      const result: FsEntry[] = entries.map(e => ({
        name: e.name,
        path: join(validatedDirPath.displayPath, e.name),
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
      const validated = await validatePath(
        filePath,
        'read',
        workspaceId,
        { allowReadOnlyOpenCodeConfig: true },
      )
      return await readUtf8FileNoFollow(validated.operationPath)
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
      const validated = await validatePath(filePath, 'write', workspaceId)
      await writeUtf8FileNoFollow(validated.operationPath, content)
    },
  }, ipcMain)

  handleTyped('fs:createFile', {
    args: [ipcSchemas.boundedString(), ipcSchemas.optionalString] as const,
    handler: async (_evt, filePath, workspaceId) => {
      const validated = await validatePath(filePath, 'create', workspaceId)
      await writeUtf8FileNoFollow(validated.operationPath, '')
    },
  }, ipcMain)

  handleTyped('fs:createDir', {
    args: [ipcSchemas.boundedString(), ipcSchemas.optionalString] as const,
    handler: async (_evt, dirPath, workspaceId) => {
      const validated = await validatePath(dirPath, 'directory', workspaceId)
      // mkdir has no descriptor-relative portable equivalent in Node. The
      // canonical-parent preflight prevents known aliases; the remaining
      // mutation race is bounded to this path-based call.
      await fs.mkdir(validated.operationPath, { recursive: true })
    },
  }, ipcMain)

  handleTyped('fs:deleteFile', {
    args: [ipcSchemas.boundedString(), ipcSchemas.optionalString] as const,
    handler: async (_evt, fspath, workspaceId) => {
      const { operationPath } = await validatePath(fspath, 'write', workspaceId)
      let currentStats: Stats
      try {
        currentStats = await fs.lstat(operationPath)
      } catch (error) {
        // force:true historically made deletion of a missing path a no-op.
        // Canonical validation has already authorized its existing parent.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (currentStats.isSymbolicLink()) throw symbolicLinkAccessError(operationPath)
      // rm has no no-follow file-descriptor variant. The immediate lstat
      // ensures recursive deletion never starts from a known symlink.
      await fs.rm(operationPath, { recursive: true, force: true })
    },
  }, ipcMain)

  handleTyped('fs:renameFile', {
    args: [ipcSchemas.boundedString(), ipcSchemas.boundedString(), ipcSchemas.optionalString] as const,
    handler: async (_evt, oldPath, newPath, workspaceId) => {
      const validatedOldPath = await validatePath(oldPath, 'write', workspaceId)
      const validatedNewPath = await validatePath(newPath, 'create', workspaceId)
      // Node exposes rename only as a two-path operation. Both canonical
      // endpoints are independently preflighted; there is no descriptor-based
      // portable rename API that can close the remaining mutation race.
      await fs.rename(validatedOldPath.operationPath, validatedNewPath.operationPath)
    },
  }, ipcMain)

  handleTyped('fs:revealInFinder', {
    args: [ipcSchemas.boundedString(), ipcSchemas.optionalString] as const,
    handler: async (_evt, filePath, workspaceId) => {
      const validated = await validatePath(filePath, 'read', workspaceId)
      // Electron's shell API accepts only a path, so canonical validation plus
      // this immediate no-link recheck is the strongest available preflight.
      const currentStats = await fs.lstat(validated.operationPath)
      if (currentStats.isSymbolicLink()) {
        throw symbolicLinkAccessError(validated.operationPath)
      }
      shell.showItemInFolder(validated.operationPath)
    },
  }, ipcMain)

  handleTyped('fs:writeBrief', {
    args: [ipcSchemas.boundedString().max(128), ipcSchemas.fileContent] as const,
    handler: async (_evt, cardId, content) => {
      assertSafeCardId(cardId)
      const { join } = await import('path')
      const briefDir = join(CODESURF_HOME, 'briefs')
      const validatedBriefDir = await validatePath(briefDir, 'directory')
      await fs.mkdir(validatedBriefDir.operationPath, { recursive: true })
      const briefPath = await validatePath(
        join(validatedBriefDir.displayPath, `${cardId}.md`),
        'write',
      )
      await writeUtf8FileNoFollow(briefPath.operationPath, content)
      return briefPath.displayPath
    },
  }, ipcMain)

  ipcMain.handle('fs:probeDir', async (_, dirPath: string, workspaceId?: string) => {
    try {
      const validated = await validatePath(
        dirPath,
        'directory',
        workspaceId,
        { allowReadOnlyOpenCodeConfig: true },
      )
      await assertDirectoryNoFollow(validated.operationPath)
      return { ok: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
      return { ok: false, code }
    }
  })

  ipcMain.handle('fs:stat', async (_, filePath: string, workspaceId?: string) => {
    try {
      const validated = await validatePath(
        filePath,
        'read',
        workspaceId,
        { allowReadOnlyOpenCodeConfig: true },
      )
      const stats = await statPathNoFollow(validated.operationPath)
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
    const validated = await validatePath(filePath, 'read', workspaceId)
    const stats = await statPathNoFollow(validated.operationPath)
    if (!stats.isFile()) return false
    return isProbablyTextFile(validated.operationPath)
  })

  ipcMain.handle('fs:copyIntoDir', async (_, sourcePath: string, destDir: string, workspaceId?: string) => {
    const validatedSource = await validatePath(sourcePath, 'read', workspaceId)
    const validatedDestDir = await validatePath(destDir, 'directory', workspaceId)
    await fs.mkdir(validatedDestDir.operationPath, { recursive: true })
    await assertDirectoryNoFollow(validatedDestDir.operationPath)

    const sourceStats = await statPathNoFollow(validatedSource.operationPath)
    if (!sourceStats.isFile()) throw new Error('Only files can be copied into a workspace')

    const sourceName = basename(validatedSource.displayPath)
    const directOperationTarget = join(validatedDestDir.operationPath, sourceName)
    const candidateOperationPath = directOperationTarget === validatedSource.operationPath
      ? validatedSource.operationPath
      : await getUniqueCopyPath(
        validatedDestDir.operationPath,
        validatedSource.displayPath,
      )
    const candidateDisplayPath = candidateOperationPath === validatedSource.operationPath
      ? validatedSource.displayPath
      : join(validatedDestDir.displayPath, basename(candidateOperationPath))
    const destPath = await validatePath(candidateDisplayPath, 'create', workspaceId)

    if (destPath.operationPath !== validatedSource.operationPath) {
      await copyFileNoFollow(validatedSource.operationPath, destPath.operationPath)
    }

    return { path: destPath.displayPath }
  })

  ipcMain.handle('fs:watchStart', async (event, dirPath: string, workspaceId?: string) => {
    const validated = await validatePath(dirPath, 'directory', workspaceId)
    await assertDirectoryNoFollow(validated.operationPath)
    // Reuse an existing watcher for this path and just add this window as a
    // subscriber. Previously a second window watching the same dir was dropped
    // (its events never fired) and the first window's close tore the shared
    // watcher down out from under everyone else.
    const existing = watchers.get(validated.operationPath)
    if (existing) {
      existing.subscribers.set(event.sender, dirPath)
      trackWatchSender(event.sender, validated.operationPath)
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
      entry.watcher = fsWatch(validated.operationPath, { recursive: true }, () => {
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
      watchers.set(validated.operationPath, entry)
      trackWatchSender(event.sender, validated.operationPath)
    } catch { /* ignore */ }
  })

  ipcMain.handle('fs:watchStop', async (event, dirPath: string, workspaceId?: string) => {
    const validated = await validatePath(dirPath, 'directory', workspaceId)
    const entry = watchers.get(validated.operationPath)
    if (!entry) return
    entry.subscribers.delete(event.sender)
    if (entry.subscribers.size === 0) {
      entry.watcher.close()
      if (entry.debounce) clearTimeout(entry.debounce)
      watchers.delete(validated.operationPath)
    }
  })
}
