import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CanonicalResourceOpen } from './resource-path.ts'
import {
  MAX_EXTENSION_IDENTITY_FILE_BYTES,
  captureExtensionMediaRoot,
  type ExtensionMediaResourceAttestation,
  type ExtensionMediaRootBinding,
} from './media-identity.ts'

const READ_CHUNK_BYTES = 64 * 1024

export type AttestedResourceRead =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: 'changed' }

function sameRootBinding(
  left: ExtensionMediaRootBinding,
  right: ExtensionMediaRootBinding,
): boolean {
  return left.lexicalRoot === right.lexicalRoot
    && left.canonicalRoot === right.canonicalRoot
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
}

function sameResource(
  info: Awaited<ReturnType<typeof fs.lstat>>,
  expected: ExtensionMediaResourceAttestation,
): boolean {
  return info.isFile()
    && !info.isSymbolicLink()
    && info.dev === expected.dev
    && info.ino === expected.ino
    && info.mode === expected.mode
    && info.size === expected.size
    && info.mtimeMs === expected.mtimeMs
    && info.ctimeMs === expected.ctimeMs
    && info.birthtimeMs === expected.birthtimeMs
}

export function extensionMediaResourceKey(
  root: ExtensionMediaRootBinding,
  candidatePath: string,
): string | undefined {
  const lexicalRoot = resolve(root.lexicalRoot)
  const candidate = resolve(candidatePath)
  const rel = relative(lexicalRoot, candidate)
  if (
    !rel
    || rel === '..'
    || rel.startsWith(`..${sep}`)
    || isAbsolute(rel)
  ) return undefined
  return rel.split(sep).join('/')
}

/**
 * Reads the exact retained file handle into a bounded immutable response body.
 *
 * Both the handle and the lexical path are checked against the scan-time
 * attestation before and after the read. Callers must never rewind and stream
 * the live file after this succeeds; only `bytes` are authorized to leave the
 * process.
 */
export async function readAttestedExtensionResource(
  resource: Extract<CanonicalResourceOpen, { ok: true }>,
  root: ExtensionMediaRootBinding,
  resourceKey: string,
  expected: ExtensionMediaResourceAttestation,
): Promise<AttestedResourceRead> {
  try {
    if (
      expected.size > MAX_EXTENSION_IDENTITY_FILE_BYTES
      || resource.size !== expected.size
    ) return { ok: false, reason: 'changed' }

    const expectedPath = join(
      root.canonicalRoot,
      ...resourceKey.split('/').filter(Boolean),
    )
    if (resource.path !== expectedPath) {
      return { ok: false, reason: 'changed' }
    }

    const currentRoot = await captureExtensionMediaRoot(root.lexicalRoot)
    if (!sameRootBinding(currentRoot, root)) {
      return { ok: false, reason: 'changed' }
    }

    const opened = await resource.handle.stat()
    if (!sameResource(opened, expected)) {
      return { ok: false, reason: 'changed' }
    }

    const bytes = Buffer.allocUnsafe(expected.size)
    const digest = createHash('sha256')
    let offset = 0
    while (offset < bytes.byteLength) {
      const length = Math.min(READ_CHUNK_BYTES, bytes.byteLength - offset)
      const { bytesRead } = await resource.handle.read(
        bytes,
        offset,
        length,
        offset,
      )
      if (bytesRead <= 0) return { ok: false, reason: 'changed' }
      digest.update(bytes.subarray(offset, offset + bytesRead))
      offset += bytesRead
    }
    const extra = Buffer.allocUnsafe(1)
    if ((await resource.handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
      return { ok: false, reason: 'changed' }
    }

    const after = await resource.handle.stat()
    if (!sameResource(after, expected)) {
      return { ok: false, reason: 'changed' }
    }
    const pathInfo = await fs.lstat(expectedPath).catch(() => null)
    const canonicalPath = await fs.realpath(expectedPath).catch(() => null)
    if (
      !pathInfo
      || canonicalPath !== expectedPath
      || !sameResource(pathInfo, expected)
      || !sameRootBinding(await captureExtensionMediaRoot(root.lexicalRoot), root)
      || `sha256:${digest.digest('hex')}` !== expected.digest
    ) {
      return { ok: false, reason: 'changed' }
    }
    return { ok: true, bytes }
  } catch {
    return { ok: false, reason: 'changed' }
  } finally {
    await resource.handle.close().catch(() => undefined)
  }
}
