import { promises as fs } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

export type CanonicalResourceResolution =
  | { ok: true; path: string; status: 200 }
  | { ok: false; status: 403 | 404 }

/**
 * Resolve both sides of an extension resource boundary before authorizing a
 * read. Root symlinks are canonicalized; child symlinks may not escape it.
 */
export async function resolveCanonicalResourcePath(
  extensionRoot: string,
  candidatePath: string,
): Promise<CanonicalResourceResolution> {
  let canonicalRoot: string
  let canonicalCandidate: string
  try {
    canonicalRoot = await fs.realpath(extensionRoot)
    canonicalCandidate = await fs.realpath(candidatePath)
  } catch {
    return { ok: false, status: 404 }
  }

  const rel = relative(canonicalRoot, canonicalCandidate)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, status: 403 }
  }

  const info = await fs.stat(canonicalCandidate).catch(() => null)
  if (!info?.isFile()) {
    return { ok: false, status: 404 }
  }

  return { ok: true, path: canonicalCandidate, status: 200 }
}
