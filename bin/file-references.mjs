import { promises as fs } from 'node:fs'
import { resolve, relative, sep } from 'node:path'

const ATTACHMENT_MARKER = 'Attached file paths:'
const DEFAULT_MAX_REFERENCES = 6
const DEFAULT_MAX_BYTES_PER_FILE = 16 * 1024

export async function expandFileReferences({
  message,
  workspaceDir,
  executionTarget = 'local',
  maxReferences = DEFAULT_MAX_REFERENCES,
  maxBytesPerFile = DEFAULT_MAX_BYTES_PER_FILE,
} = {}) {
  const normalizedWorkspaceDir = normalizeWorkspaceDir(workspaceDir)
  const normalizedMessage = normalizeMessageText(message)

  if (!normalizedWorkspaceDir || !normalizedMessage) {
    return {
      changed: false,
      message: normalizedMessage,
      references: [],
      summaryText: undefined,
      inputText: undefined,
    }
  }

  const parsed = parseReferenceMentions(normalizedMessage)
  if (parsed.references.length === 0) {
    return {
      changed: false,
      message: normalizedMessage,
      references: [],
      summaryText: undefined,
      inputText: undefined,
    }
  }

  const resolvedWorkspaceDir = await fs.realpath(normalizedWorkspaceDir)
  const collected = []
  const seenPaths = new Set()

  for (const reference of parsed.references) {
    if (collected.length >= maxReferences) break
    const loaded = await loadWorkspaceReference(reference, resolvedWorkspaceDir, maxBytesPerFile)
    if (seenPaths.has(loaded.resolvedPath)) continue
    seenPaths.add(loaded.resolvedPath)
    collected.push(loaded)
  }

  if (collected.length === 0) {
    return {
      changed: false,
      message: normalizedMessage,
      references: [],
      summaryText: undefined,
      inputText: undefined,
    }
  }

  const messageText = buildExpandedMessage({
    bodyText: parsed.bodyText,
    executionTarget,
    references: collected,
  })

  return {
    changed: messageText !== normalizedMessage,
    message: messageText,
    references: collected.map(reference => ({
      source: reference.source,
      displayPath: reference.displayPath,
      byteCount: reference.byteCount,
      truncated: reference.truncated,
    })),
    summaryText: buildSummaryText(collected),
    inputText: buildInputText(collected),
  }
}

function normalizeWorkspaceDir(value) {
  const text = String(value ?? '').trim()
  return text ? resolve(text) : null
}

function normalizeMessageText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function parseReferenceMentions(message) {
  const { bodyText, attachmentPaths } = splitAttachmentPaths(message)
  const parsedReferences = []
  const explicitRanges = []

  for (const reference of collectExplicitReferences(bodyText)) {
    explicitRanges.push({ start: reference.start, end: reference.end })
    parsedReferences.push(reference)
  }

  for (const reference of collectInlineReferences(bodyText, explicitRanges)) {
    parsedReferences.push(reference)
  }

  for (const attachmentPath of attachmentPaths) {
    parsedReferences.push({
      source: 'attachment',
      candidatePath: attachmentPath,
      start: Number.MAX_SAFE_INTEGER,
      end: Number.MAX_SAFE_INTEGER,
    })
  }

  parsedReferences.sort((a, b) => a.start - b.start)

  return {
    bodyText,
    references: parsedReferences,
  }
}

function splitAttachmentPaths(message) {
  const markerIndex = message.indexOf(ATTACHMENT_MARKER)
  if (markerIndex < 0) {
    return {
      bodyText: message,
      attachmentPaths: [],
    }
  }

  const bodyText = message.slice(0, markerIndex).trim()
  const attachmentText = message.slice(markerIndex + ATTACHMENT_MARKER.length).trim()
  const attachmentPaths = attachmentText
    .split(/\n/)
    .map(line => line.trim())
    .filter(Boolean)

  if (attachmentPaths.length === 0) {
    return {
      bodyText: message,
      attachmentPaths: [],
    }
  }

  return {
    bodyText,
    attachmentPaths,
  }
}

function collectExplicitReferences(text) {
  const references = []
  const pattern = /(^|[^\w@])@(file|path)(?::|\s+)(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'`<>()[\]{}]+))/g

  for (const match of text.matchAll(pattern)) {
    const prefix = match[1] ?? ''
    const pathText = normalizeCandidatePath(match[3] ?? match[4] ?? match[5] ?? '')
    if (!pathText) continue
    const start = (match.index ?? 0) + prefix.length
    const rawSource = String(match[0]).slice(prefix.length)
    references.push({
      source: rawSource,
      candidatePath: pathText,
      start,
      end: start + rawSource.length,
    })
  }

  return references
}

function collectInlineReferences(text, explicitRanges) {
  const references = []
  const pattern = /(^|[^\w@])@((?:\.{1,2}\/)?[^\s"'`<>()[\]{}]+(?:\/[^\s"'`<>()[\]{}]+)+|(?:\.{1,2}\/)?[^\s"'`<>()[\]{}]+\.[^\s"'`<>()[\]{}]+)/g

  for (const match of text.matchAll(pattern)) {
    const prefix = match[1] ?? ''
    const rawCandidate = String(match[2] ?? '')
    const candidatePath = normalizeCandidatePath(rawCandidate)
    if (!candidatePath) continue
    if (/^(?:file|path)$/i.test(candidatePath) || /^(?:file|path):/i.test(candidatePath)) continue
    const start = (match.index ?? 0) + prefix.length
    const source = `@${rawCandidate}`
    const end = start + source.length
    if (rangeOverlaps({ start, end }, explicitRanges)) continue
    references.push({
      source: `@${candidatePath}`,
      candidatePath,
      start,
      end: start + candidatePath.length + 1,
    })
  }

  return references
}

function normalizeCandidatePath(value) {
  let next = String(value ?? '').trim()
  if (!next) return null
  if (next.includes('\u0000')) {
    throw new Error('File references must not contain NUL bytes')
  }
  next = next.replace(/^file:\/\//i, '')
  while (/[),.;:!?]$/.test(next) && !/[\\/]$/.test(next)) {
    next = next.slice(0, -1)
  }
  return next || null
}

function rangeOverlaps(candidate, ranges) {
  return ranges.some(range => candidate.start < range.end && range.start < candidate.end)
}

async function loadWorkspaceReference(reference, workspaceRoot, maxBytesPerFile) {
  const resolvedRequestedPath = resolveReferencePath(reference.candidatePath, workspaceRoot)
  let handle = null

  try {
    handle = await fs.open(resolvedRequestedPath, 'r')
    const openedStat = await handle.stat()
    if (!openedStat.isFile()) {
      throw new Error(`File reference ${reference.source} must point to a file`)
    }

    const resolvedPath = await fs.realpath(resolvedRequestedPath)
    if (!isWithinRoot(resolvedPath, workspaceRoot)) {
      throw new Error(`File reference ${reference.source} resolves outside the workspace root`)
    }

    const currentStat = await fs.stat(resolvedPath)
    if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
      throw new Error(`File reference ${reference.source} changed during validation`)
    }

    const buffer = await handle.readFile()
    if (buffer.includes(0)) {
      throw new Error(`File reference ${reference.source} must point to a UTF-8 text file`)
    }

    const byteCount = buffer.byteLength
    const limitedBuffer = byteCount > maxBytesPerFile
      ? buffer.subarray(0, maxBytesPerFile)
      : buffer

    return {
      source: normalizeReferenceSource(reference.source, getDisplayPath(resolvedPath, workspaceRoot)),
      resolvedPath,
      displayPath: getDisplayPath(resolvedPath, workspaceRoot),
      byteCount,
      truncated: byteCount > maxBytesPerFile,
      content: normalizeFileContent(limitedBuffer.toString('utf8')),
      previewByteCount: limitedBuffer.byteLength,
    }
  } catch (error) {
    if (error?.code === 'ENOENT' && handle == null) {
      throw new Error(`File reference ${reference.source} was not found in the workspace`)
    }
    if (error?.code === 'EISDIR') {
      throw new Error(`File reference ${reference.source} must point to a file`)
    }
    if (error instanceof Error && /(outside the workspace root|changed during validation|must point to a file|UTF-8 text file|was not found)/i.test(error.message)) {
      throw error
    }
    throw new Error(`Failed to read file reference ${reference.source}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await handle?.close().catch(() => {})
  }
}

function resolveReferencePath(candidatePath, workspaceRoot) {
  const trimmed = String(candidatePath ?? '').trim()
  return trimmed.startsWith('/')
    ? resolve(trimmed)
    : resolve(workspaceRoot, trimmed)
}

function isWithinRoot(candidatePath, rootPath) {
  const normalizedRoot = resolve(rootPath)
  const normalizedCandidate = resolve(candidatePath)
  const rootWithSeparator = normalizedRoot.endsWith(sep)
    ? normalizedRoot
    : `${normalizedRoot}${sep}`
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSeparator)
}

function getDisplayPath(filePath, workspaceRoot) {
  const rel = relative(workspaceRoot, filePath)
  return rel || filePath.split(sep).pop() || filePath
}

function normalizeReferenceSource(source, displayPath) {
  return source === 'attachment'
    ? 'attachment'
    : `@${displayPath}`
}

function normalizeFileContent(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trimEnd()
}

function buildExpandedMessage({ bodyText, executionTarget, references }) {
  const lines = [
    '## Referenced workspace files',
    executionTarget === 'cloud'
      ? 'CodeSurf expanded these local workspace file references before cloud execution. Paths are shown relative to the workspace root.'
      : 'CodeSurf expanded these local workspace file references before execution. Paths are shown relative to the workspace root.',
  ]

  for (const reference of references) {
    lines.push('')
    lines.push(`### ${reference.displayPath}`)
    lines.push(`Source: ${reference.source}`)
    lines.push(`<<<BEGIN FILE ${reference.displayPath}>>>`)
    lines.push(reference.content || '(empty file)')
    if (reference.truncated) {
      lines.push(`<<<TRUNCATED: showing first ${reference.previewByteCount} of ${reference.byteCount} bytes>>>`)
    }
    lines.push(`<<<END FILE ${reference.displayPath}>>>`)
  }

  return [bodyText.trim(), lines.join('\n')].filter(Boolean).join('\n\n').trim()
}

function buildSummaryText(references) {
  const paths = references.slice(0, 3).map(reference => reference.displayPath)
  const suffix = references.length > 3 ? ` +${references.length - 3} more` : ''
  return `Expanded ${references.length} workspace file reference${references.length === 1 ? '' : 's'}: ${paths.join(', ')}${suffix}`
}

function buildInputText(references) {
  return references.map(reference => {
    const sourceLabel = reference.source === 'attachment' ? 'attachment' : reference.source
    const suffix = reference.truncated ? ', truncated' : ''
    return `- ${sourceLabel} → ${reference.displayPath} (${formatByteCount(reference.byteCount)}${suffix})`
  }).join('\n')
}

function formatByteCount(value) {
  const bytes = Math.max(0, Number(value) || 0)
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
