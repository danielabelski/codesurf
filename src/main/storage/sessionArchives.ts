import { promises as fs } from 'fs'
import { dirname } from 'path'

interface SessionArchiveState {
  version: 1
  archivedSessionIds: string[]
}

export function normalizeArchivedSessionIds(value: unknown): string[] {
  const normalized = new Set<string>()
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== 'string') continue
    const sessionId = entry.trim()
    if (!sessionId) continue
    normalized.add(sessionId)
  }
  return Array.from(normalized).sort((a, b) => a.localeCompare(b))
}

export async function readArchivedSessionIds(paths: string[]): Promise<Set<string>> {
  const archived = new Set<string>()
  for (const path of paths) {
    try {
      const raw = JSON.parse(await fs.readFile(path, 'utf8')) as Partial<SessionArchiveState>
      for (const sessionId of normalizeArchivedSessionIds(raw?.archivedSessionIds)) {
        archived.add(sessionId)
      }
    } catch {
      // ignore missing or malformed archive files and continue
    }
  }
  return archived
}

export async function writeArchivedSessionIds(path: string, archivedSessionIds: Iterable<string>): Promise<void> {
  const normalized = normalizeArchivedSessionIds(Array.from(archivedSessionIds))
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify({
    version: 1,
    archivedSessionIds: normalized,
  }, null, 2))
}
