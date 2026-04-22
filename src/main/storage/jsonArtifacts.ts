import { promises as fs } from 'fs'
import { dirname } from 'path'

type ParsedJsonArtifact<T> = {
  value: T
  recovered: boolean
}

function extractBalancedJsonPrefix(raw: string): string | null {
  const trimmed = raw.trimStart()
  const opener = trimmed[0]
  if (opener !== '{' && opener !== '[') return null

  const closer = opener === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escapeNext = false

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i]

    if (inString) {
      if (escapeNext) {
        escapeNext = false
        continue
      }
      if (char === '\\') {
        escapeNext = true
        continue
      }
      if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === opener) {
      depth += 1
      continue
    }
    if (char === closer) {
      depth -= 1
      if (depth === 0) {
        return trimmed.slice(0, i + 1)
      }
    }
  }

  return null
}

export function parseJsonArtifact<T>(raw: string): ParsedJsonArtifact<T> | null {
  try {
    return { value: JSON.parse(raw) as T, recovered: false }
  } catch {
    const candidate = extractBalancedJsonPrefix(raw)
    if (!candidate) return null
    try {
      return { value: JSON.parse(candidate) as T, recovered: true }
    } catch {
      return null
    }
  }
}

export async function readJsonArtifact<T>(filePath: string): Promise<ParsedJsonArtifact<T> | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return parseJsonArtifact<T>(raw)
  } catch {
    return null
  }
}

export async function writeJsonArtifactAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tempPath, filePath)
}
