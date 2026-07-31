import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionManifest } from '../../shared/types.ts'

export const MAX_EXTENSION_IDENTITY_DEPTH = 32
export const MAX_EXTENSION_IDENTITY_ENTRIES = 4096
export const MAX_EXTENSION_IDENTITY_FILES = 2048
export const MAX_EXTENSION_IDENTITY_FILE_BYTES = 16 * 1024 * 1024
export const MAX_EXTENSION_IDENTITY_TOTAL_BYTES = 64 * 1024 * 1024
export const MAX_EXTENSION_IDENTITY_MANIFEST_BYTES = 1024 * 1024
export const MAX_EXTENSION_IDENTITY_SYMLINK_BYTES = 8 * 1024

const MAX_MANIFEST_DEPTH = 32
const MAX_MANIFEST_NODES = 8192

interface ManifestBudget {
  nodes: number
}

export class ExtensionMediaIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtensionMediaIdentityError'
  }
}

function fail(message: string): never {
  throw new ExtensionMediaIdentityError(message)
}

function updateRecord(
  hash: ReturnType<typeof createHash>,
  record: readonly unknown[],
): void {
  hash.update(JSON.stringify(record))
  hash.update('\n')
}

function stableManifestValue(
  value: unknown,
  depth = 0,
  budget: ManifestBudget = { nodes: 0 },
): unknown {
  budget.nodes += 1
  if (budget.nodes > MAX_MANIFEST_NODES || depth > MAX_MANIFEST_DEPTH) {
    fail('Extension manifest exceeds media identity complexity budget')
  }
  if (Array.isArray(value)) {
    return value.map(item => stableManifestValue(item, depth + 1, budget))
  }
  if (!value || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(object)
      .filter(key => key !== '_path' && key !== '_enabled')
      .sort()
      .map(key => [key, stableManifestValue(object[key], depth + 1, budget)]),
  )
}

async function hashDirectory(
  hash: ReturnType<typeof createHash>,
  directory: string,
  relativeDirectory = '',
  activeDirectories = new Set<string>(),
): Promise<void> {
  const canonicalDirectory = await fs.realpath(directory)
  if (activeDirectories.has(canonicalDirectory)) {
    updateRecord(hash, ['directory-cycle', relativeDirectory, canonicalDirectory])
    return
  }
  const directoryBefore = await fs.stat(canonicalDirectory)
  if (!directoryBefore.isDirectory()) {
    throw new Error(`Extension directory changed while computing media identity: ${directory}`)
  }
  activeDirectories.add(canonicalDirectory)
  const entries = await fs.readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)

  try {
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name
      const absolutePath = join(directory, entry.name)
      const before = await fs.lstat(absolutePath)

      if (before.isSymbolicLink()) {
        const linkTarget = await fs.readlink(absolutePath)
        const canonicalTarget = await fs.realpath(absolutePath).catch(() => undefined)
        updateRecord(hash, [
          'symlink',
          relativePath,
          linkTarget,
          canonicalTarget,
          before.dev,
          before.ino,
          before.birthtimeMs,
        ])
        if (!canonicalTarget) continue
        const targetStat = await fs.stat(canonicalTarget)
        if (targetStat.isDirectory()) {
          await hashDirectory(hash, canonicalTarget, relativePath, activeDirectories)
        } else if (targetStat.isFile()) {
          await hashFile(hash, canonicalTarget, relativePath, targetStat)
        }
        continue
      }
      if (before.isDirectory()) {
        updateRecord(hash, [
          'directory',
          relativePath,
          before.dev,
          before.ino,
          before.birthtimeMs,
        ])
        await hashDirectory(hash, absolutePath, relativePath, activeDirectories)
        continue
      }
      if (!before.isFile()) {
        updateRecord(hash, [
          'other',
          relativePath,
          before.mode,
          before.size,
          before.dev,
          before.ino,
          before.birthtimeMs,
        ])
        continue
      }

      await hashFile(hash, absolutePath, relativePath, before)
    }
    const directoryAfter = await fs.stat(canonicalDirectory)
    if (
      !directoryAfter.isDirectory()
      || directoryAfter.dev !== directoryBefore.dev
      || directoryAfter.ino !== directoryBefore.ino
      || directoryAfter.mtimeMs !== directoryBefore.mtimeMs
    ) {
      throw new Error(`Extension directory changed while computing media identity: ${directory}`)
    }
  } finally {
    activeDirectories.delete(canonicalDirectory)
  }
}

async function hashFile(
  hash: ReturnType<typeof createHash>,
  absolutePath: string,
  relativePath: string,
  before: Awaited<ReturnType<typeof fs.stat>>,
): Promise<void> {
  updateRecord(hash, [
    'file',
    relativePath,
    before.mode,
    before.size,
    before.dev,
    before.ino,
    before.birthtimeMs,
  ])
  const stream = createReadStream(absolutePath)
  for await (const chunk of stream) hash.update(chunk)
  const after = await fs.stat(absolutePath)
  if (
    !after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || after.mode !== before.mode
    || after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
  ) {
    throw new Error(`Extension changed while computing media identity: ${absolutePath}`)
  }
}

/**
 * Binds sensitive-media consent to the effective extension installation.
 *
 * The canonical root prevents same-id workspace/global substitutions, the
 * filesystem installation tuple detects a same-path reinstall, and the
 * manifest plus recursive content digest detects updates between rescans.
 */
export async function computeExtensionMediaIdentity(
  extensionRoot: string,
  manifest: ExtensionManifest,
): Promise<string> {
  const canonicalRoot = await fs.realpath(extensionRoot)
  const rootStat = await fs.lstat(canonicalRoot)
  if (!rootStat.isDirectory()) {
    throw new Error(`Extension root is not a directory: ${canonicalRoot}`)
  }

  const stableManifest = stableManifestValue(manifest)
  const serializedManifest = JSON.stringify(stableManifest)
  if (
    Buffer.byteLength(serializedManifest, 'utf8')
    > MAX_EXTENSION_IDENTITY_MANIFEST_BYTES
  ) {
    fail(`Extension manifest exceeds media identity byte budget (${MAX_EXTENSION_IDENTITY_MANIFEST_BYTES})`)
  }

  const hash = createHash('sha256')
  updateRecord(hash, [
    'codesurf-extension-media-identity-v1',
    canonicalRoot,
    rootStat.dev,
    rootStat.ino,
    rootStat.birthtimeMs,
  ])
  updateRecord(hash, ['manifest', stableManifest])
  await hashDirectory(hash, canonicalRoot)
  return `sha256:${hash.digest('hex')}`
}
