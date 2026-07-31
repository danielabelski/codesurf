import { randomUUID } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ActivityRecord } from '../shared/activity-types.ts'
import { capActivityRecords } from './activity-cap.ts'
import {
  ACTIVITY_DOCUMENT_VERSION,
  ActivityValidationError,
  MAX_ACTIVITY_FILE_BYTES,
  parseActivityDocument,
  recoverActivityDocument,
  validateActivityWorkspaceId,
} from './activity-validation.ts'
import { resolveInside } from './security/pathSegments.ts'

export interface LoadedActivityRecords {
  records: ActivityRecord[]
  needsRewrite: boolean
}

export interface ActivityPersistence {
  load(workspaceId: string): Promise<LoadedActivityRecords>
  save(workspaceId: string, records: ActivityRecord[]): Promise<void>
}

export interface FileActivityPersistenceOptions {
  homeDir: string
  maxFileBytes?: number
  readHooks?: {
    afterOpen?: (filePath: string) => void | Promise<void>
  }
}

export const ACTIVITY_QUARANTINE_PREFIX = 'activity.quarantine-'

export class ActivityPersistenceError extends Error {
  readonly code: string
  readonly path: string

  constructor(code: string, message: string, path: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ActivityPersistenceError'
    this.code = code
    this.path = path
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function persistenceError(code: string, message: string, path: string, cause?: unknown): ActivityPersistenceError {
  return new ActivityPersistenceError(code, message, path, cause === undefined ? undefined : { cause })
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
  )
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

interface ActivityReadBoundary {
  paths: string[]
  identities: BigIntStats[]
  canonicalRoot: string
}

interface ActivityWriteBoundary extends ActivityReadBoundary {
  directoryHandle: Awaited<ReturnType<typeof fs.open>>
}

async function captureReadBoundary(filePath: string): Promise<ActivityReadBoundary | null> {
  const activityDir = dirname(filePath)
  const workspaceDir = dirname(activityDir)
  const workspacesDir = dirname(workspaceDir)
  const paths = [workspacesDir, workspaceDir, activityDir]
  const identities: BigIntStats[] = []

  for (const path of paths) {
    let info: BigIntStats
    try {
      info = await fs.lstat(path, { bigint: true })
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return null
      throw persistenceError('unsafe_path', 'Unable to verify the activity storage path', filePath, error)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw persistenceError('unsafe_path', 'Activity storage ancestors must be real directories', filePath)
    }
    identities.push(info)
  }

  const [canonicalRoot, canonicalWorkspace, canonicalActivityDir] = await Promise.all(
    paths.map(path => fs.realpath(path)),
  )
  if (
    !isContained(canonicalRoot, canonicalWorkspace)
    || !isContained(canonicalWorkspace, canonicalActivityDir)
  ) {
    throw persistenceError('unsafe_path', 'Activity storage path escapes its workspace root', filePath)
  }
  return { paths, identities, canonicalRoot }
}

async function verifyReadBoundary(boundary: ActivityReadBoundary, filePath: string): Promise<void> {
  for (let index = 0; index < boundary.paths.length; index += 1) {
    const info = await fs.lstat(boundary.paths[index], { bigint: true }).catch(() => null)
    if (
      !info
      || info.isSymbolicLink()
      || !info.isDirectory()
      || !sameIdentity(info, boundary.identities[index])
    ) {
      throw persistenceError('path_changed', 'Activity storage path changed during access', filePath)
    }
  }
  const canonicalActivityDir = await fs.realpath(boundary.paths.at(-1)!).catch(() => null)
  if (!canonicalActivityDir || !isContained(boundary.canonicalRoot, canonicalActivityDir)) {
    throw persistenceError('path_changed', 'Activity storage path changed during access', filePath)
  }
}

async function prepareWriteBoundary(filePath: string): Promise<ActivityWriteBoundary> {
  const activityDir = dirname(filePath)
  const workspaceDir = dirname(activityDir)
  const workspacesDir = dirname(workspaceDir)
  const homeDir = dirname(workspacesDir)
  const paths = [homeDir, workspacesDir, workspaceDir, activityDir]

  await fs.mkdir(homeDir, { recursive: true, mode: 0o700 })
  const identities: BigIntStats[] = []
  for (const [index, path] of paths.entries()) {
    if (index > 0) {
      try {
        await fs.mkdir(path, { mode: 0o700 })
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error
      }
    }
    const info = await fs.lstat(path, { bigint: true })
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw persistenceError('unsafe_path', 'Activity storage ancestors must be real directories', filePath)
    }
    identities.push(info)
  }

  const canonicalPaths = await Promise.all(paths.map(path => fs.realpath(path)))
  for (let index = 1; index < canonicalPaths.length; index += 1) {
    if (!isContained(canonicalPaths[index - 1], canonicalPaths[index])) {
      throw persistenceError('unsafe_path', 'Activity storage path escapes its workspace root', filePath)
    }
  }

  const directoryHandle = await fs.open(
    activityDir,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const directoryInfo = await directoryHandle.stat({ bigint: true })
    if (!sameIdentity(directoryInfo, identities.at(-1)!)) {
      throw persistenceError('path_changed', 'Activity storage path changed during setup', filePath)
    }
    await directoryHandle.chmod(0o700)
    const boundary = {
      paths,
      identities,
      canonicalRoot: canonicalPaths[0],
      directoryHandle,
    }
    await verifyReadBoundary(boundary, filePath)
    return boundary
  } catch (error) {
    await directoryHandle.close().catch(() => {})
    throw error
  }
}

export function activityStorePath(homeDirValue: string, workspaceIdValue: unknown): string {
  const homeDir = resolve(homeDirValue)
  const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
  const workspacesDir = resolveInside(homeDir, 'workspaces')
  return resolveInside(workspacesDir, workspaceId, '.codesurf', 'activity.json')
}

export function serializeActivityDocument(workspaceIdValue: unknown, recordsValue: ActivityRecord[]): string {
  const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
  const parsed = parseActivityDocument({
    version: ACTIVITY_DOCUMENT_VERSION,
    records: recordsValue,
  }, workspaceId)
  return `${JSON.stringify({
    version: ACTIVITY_DOCUMENT_VERSION,
    records: parsed.records,
  }, null, 2)}\n`
}

async function syncDirectoryHandle(handle: ActivityWriteBoundary['directoryHandle']): Promise<void> {
  try {
    await handle.sync()
  } catch (error) {
    if (
      !isNodeError(error)
      || !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR', 'EBADF'].includes(error.code ?? '')
    ) {
      throw error
    }
  }
}

async function durableAtomicWrite(filePath: string, content: string | Uint8Array): Promise<void> {
  const boundary = await prepareWriteBoundary(filePath)
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  let handle
  let temporaryIdentity: BigIntStats | null = null
  let renamed = false
  try {
    await verifyReadBoundary(boundary, filePath)
    const existing = await fs.lstat(filePath, { bigint: true }).catch(error => {
      if (isNodeError(error) && error.code === 'ENOENT') return null
      throw error
    })
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw persistenceError('unsafe_path', 'Activity store must be a regular file', filePath)
    }

    handle = await fs.open(temporaryPath, 'wx', 0o600)
    const openedTemporaryIdentity = await handle.stat({ bigint: true })
    temporaryIdentity = openedTemporaryIdentity
    await verifyReadBoundary(boundary, filePath)
    const temporaryPathInfo = await fs.lstat(temporaryPath, { bigint: true })
    if (temporaryPathInfo.isSymbolicLink() || !sameIdentity(openedTemporaryIdentity, temporaryPathInfo)) {
      throw persistenceError('path_changed', 'Activity temporary file changed during access', filePath)
    }
    if (typeof content === 'string') await handle.writeFile(content, 'utf8')
    else await handle.writeFile(content)
    await handle.sync()
    await handle.close()
    handle = undefined

    await verifyReadBoundary(boundary, filePath)
    const beforeRename = await fs.lstat(filePath, { bigint: true }).catch(error => {
      if (isNodeError(error) && error.code === 'ENOENT') return null
      throw error
    })
    if (
      beforeRename?.isSymbolicLink()
      || (existing === null && beforeRename !== null)
      || (existing !== null && (beforeRename === null || !sameIdentity(existing, beforeRename)))
    ) {
      throw persistenceError('path_changed', 'Activity store changed before commit', filePath)
    }
    await fs.rename(temporaryPath, filePath)
    renamed = true
    await verifyReadBoundary(boundary, filePath)
    const committedInfo = await fs.lstat(filePath, { bigint: true })
    if (
      committedInfo.isSymbolicLink()
      || !committedInfo.isFile()
      || !temporaryIdentity
      || !sameIdentity(temporaryIdentity, committedInfo)
    ) {
      throw persistenceError('path_changed', 'Activity store changed during commit', filePath)
    }
    await syncDirectoryHandle(boundary.directoryHandle)
  } catch (error) {
    await handle?.close().catch(() => {})
    if (!renamed && temporaryIdentity) {
      const current = await fs.lstat(temporaryPath, { bigint: true }).catch(() => null)
      if (current && sameIdentity(current, temporaryIdentity)) {
        await fs.unlink(temporaryPath).catch(() => {})
      }
    }
    throw error
  } finally {
    await boundary.directoryHandle.close().catch(() => {})
  }
}

async function quarantineActivityBytes(filePath: string, bytes: Uint8Array): Promise<string> {
  const quarantinePath = join(
    dirname(filePath),
    `${ACTIVITY_QUARANTINE_PREFIX}${Date.now()}-${randomUUID()}.json`,
  )
  await durableAtomicWrite(quarantinePath, bytes)
  return quarantinePath
}

async function loadActivityFile(
  filePath: string,
  workspaceId: string,
  maxFileBytes: number,
  hooks?: FileActivityPersistenceOptions['readHooks'],
): Promise<LoadedActivityRecords> {
  const boundary = await captureReadBoundary(filePath)
  if (!boundary) return { records: [], needsRewrite: false }

  let pathInfo: BigIntStats
  try {
    pathInfo = await fs.lstat(filePath, { bigint: true })
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { records: [], needsRewrite: false }
    throw persistenceError('read_failed', 'Unable to inspect the activity store', filePath, error)
  }
  if (pathInfo.isSymbolicLink()) {
    throw persistenceError('unsafe_path', 'Activity store cannot be a symbolic link', filePath)
  }
  if (!pathInfo.isFile()) {
    throw persistenceError('not_a_file', 'Activity store path is not a regular file', filePath)
  }

  let handle
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { records: [], needsRewrite: false }
    throw persistenceError('read_failed', 'Unable to open the activity store', filePath, error)
  }

  try {
    const openedInfo = await handle.stat({ bigint: true })
    await hooks?.afterOpen?.(filePath)
    await verifyReadBoundary(boundary, filePath)
    const verifiedPathInfo = await fs.lstat(filePath, { bigint: true }).catch(() => null)
    if (
      !openedInfo.isFile()
      || !verifiedPathInfo?.isFile()
      || verifiedPathInfo.isSymbolicLink()
      || !sameIdentity(openedInfo, pathInfo)
      || !sameIdentity(openedInfo, verifiedPathInfo)
    ) {
      throw persistenceError('path_changed', 'Activity store changed during access', filePath)
    }
    if (!openedInfo.isFile()) {
      throw persistenceError('not_a_file', 'Activity store path is not a regular file', filePath)
    }
    if (openedInfo.size > BigInt(maxFileBytes)) {
      throw persistenceError('file_too_large', `Activity store exceeds ${maxFileBytes} bytes`, filePath)
    }
    const needsPermissionRepair = (openedInfo.mode & 0o777n) !== 0o600n
    const bytes = await handle.readFile()
    if (bytes.byteLength > maxFileBytes) {
      throw persistenceError('file_too_large', `Activity store exceeds ${maxFileBytes} bytes`, filePath)
    }
    const finalInfo = await handle.stat({ bigint: true })
    const finalPathInfo = await fs.lstat(filePath, { bigint: true }).catch(() => null)
    await verifyReadBoundary(boundary, filePath)
    if (
      !finalPathInfo?.isFile()
      || finalPathInfo.isSymbolicLink()
      || !sameSnapshot(openedInfo, finalInfo)
      || !sameIdentity(openedInfo, finalPathInfo)
    ) {
      throw persistenceError('path_changed', 'Activity store changed while it was being read', filePath)
    }

    let value: unknown
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch {
      await quarantineActivityBytes(filePath, bytes)
      return { records: [], needsRewrite: true }
    }

    try {
      const recovered = recoverActivityDocument(value, workspaceId)
      if (recovered.requiresQuarantine) {
        await quarantineActivityBytes(filePath, bytes)
      }
      const capped = capActivityRecords(recovered.records)
      return {
        records: capped,
        needsRewrite: needsPermissionRepair || recovered.needsRewrite || capped !== recovered.records,
      }
    } catch (error) {
      if (error instanceof ActivityValidationError && error.code === 'future_document_version') {
        throw persistenceError(
          'future_document_version',
          'Activity store was written by a newer CodeSurf version',
          filePath,
          error,
        )
      }
      throw persistenceError('invalid_document', 'Activity store schema is invalid or unsupported', filePath, error)
    }
  } finally {
    await handle.close().catch(() => {})
  }
}

export function createFileActivityPersistence(options: FileActivityPersistenceOptions): ActivityPersistence {
  const homeDir = resolve(options.homeDir)
  const maxFileBytes = options.maxFileBytes ?? MAX_ACTIVITY_FILE_BYTES
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new TypeError('maxFileBytes must be a positive integer')
  }

  return {
    async load(workspaceIdValue) {
      const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
      return loadActivityFile(
        activityStorePath(homeDir, workspaceId),
        workspaceId,
        maxFileBytes,
        options.readHooks,
      )
    },
    async save(workspaceIdValue, records) {
      const workspaceId = validateActivityWorkspaceId(workspaceIdValue)
      const filePath = activityStorePath(homeDir, workspaceId)
      const serialized = serializeActivityDocument(workspaceId, records)
      if (Buffer.byteLength(serialized, 'utf8') > maxFileBytes) {
        throw persistenceError('file_too_large', `Activity store exceeds ${maxFileBytes} bytes`, filePath)
      }
      try {
        await durableAtomicWrite(filePath, serialized)
      } catch (error) {
        if (error instanceof ActivityPersistenceError) throw error
        throw persistenceError('write_failed', 'Unable to persist the activity store', filePath, error)
      }
    },
  }
}
