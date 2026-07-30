import { constants as fsConstants, promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  MAX_CONTEXT_FILE_BYTES,
  MAX_INSTRUCTION_SECTIONS,
  budgetInstructionFragments,
  formatInstructionBudgetNotice,
  truncateUtf8Buffer,
  utf8ByteLength,
} from './context-budget.mjs'

export async function loadInstructionContext({ homeDir, workspaceDir, executionTarget = 'local' } = {}) {
  const sections = []

  for (const candidate of instructionCandidates({ homeDir, workspaceDir, executionTarget })) {
    const loaded = await readInstructionFile(candidate)
    if (!loaded?.content) continue
    sections.push({
      scope: candidate.scope,
      bucket: candidate.bucket,
      displayPath: candidate.displayPath,
      path: candidate.path,
      source: candidate.path,
      precedence: sections.length,
      content: loaded.content,
      originalBytes: loaded.originalBytes,
      includedBytes: utf8ByteLength(loaded.content),
      truncated: loaded.truncated,
      truncationReason: loaded.truncationReason,
    })
  }

  const budget = budgetInstructionFragments(sections, {
    reservedBytes: instructionPromptReservedBytes(sections),
  })
  const notice = formatInstructionBudgetNotice(budget)
  return {
    sections: budget.fragments,
    budget,
    ...(notice ? { notices: [notice] } : {}),
  }
}

export function buildInstructionPrompt(context) {
  const inputSections = Array.isArray(context?.sections)
    ? context.sections.filter(section => section && typeof section.content === 'string' && section.content.trim().length > 0)
    : []
  const budget = budgetInstructionFragments(inputSections, {
    reservedBytes: instructionPromptReservedBytes(inputSections),
  })
  const sections = budget.fragments
  const notices = Array.isArray(context?.notices)
    ? context.notices.map(value => String(value ?? '').trim()).filter(Boolean)
    : []
  const generatedNotice = formatInstructionBudgetNotice(budget)
  if (generatedNotice && !notices.includes(generatedNotice)) notices.push(generatedNotice)
  if (sections.length === 0 && notices.length === 0) return undefined

  const lines = [
    '## Workspace Instructions',
    'Follow these layered instructions in addition to the user request. If they conflict, later sections override earlier ones.',
    '',
  ]

  for (const section of sections) {
    lines.push(`### ${sectionTitle(section.scope)} (${section.displayPath})`)
    lines.push(section.content)
    lines.push('')
  }

  for (const notice of notices) lines.push(notice)

  return lines.join('\n').trim()
}

function instructionCandidates({ homeDir, workspaceDir, executionTarget }) {
  const normalizedHome = normalizeDir(homeDir)
  const normalizedWorkspace = normalizeDir(workspaceDir)
  const candidates = []

  if (executionTarget !== 'cloud' && normalizedHome) {
    candidates.push({
      scope: 'user',
      bucket: 'local-only',
      displayPath: '~/.codesurf/AGENTS.md',
      path: join(normalizedHome, '.codesurf', 'AGENTS.md'),
      disallowSymlink: false,
    })
  }

  if (normalizedWorkspace) {
    candidates.push({
      scope: 'workspace',
      bucket: 'remote-safe',
      displayPath: 'AGENTS.md',
      path: join(normalizedWorkspace, 'AGENTS.md'),
      rootPath: normalizedWorkspace,
      disallowSymlink: true,
    })
    if (executionTarget !== 'cloud') {
      candidates.push({
        scope: 'workspace-local',
        bucket: 'local-only',
        displayPath: '.codesurf/AGENTS.md',
        path: join(normalizedWorkspace, '.codesurf', 'AGENTS.md'),
        rootPath: normalizedWorkspace,
        disallowSymlink: true,
      })
    }
  }

  return candidates
}

function sectionTitle(scope) {
  switch (scope) {
    case 'user':
      return 'User Instructions'
    case 'workspace-local':
      return 'Workspace Local Instructions'
    case 'workspace':
    default:
      return 'Workspace Instructions'
  }
}

function instructionPromptReservedBytes(sections) {
  const ranked = (Array.isArray(sections) ? sections : [])
    .map((section, index) => ({
      section,
      index,
      precedence: Number.isFinite(section?.precedence) ? Number(section.precedence) : index,
    }))
    .sort((left, right) => right.precedence - left.precedence || right.index - left.index)
    .slice(0, MAX_INSTRUCTION_SECTIONS)
    .sort((left, right) => left.index - right.index)
  const fixed = utf8ByteLength([
    '## Workspace Instructions',
    'Follow these layered instructions in addition to the user request. If they conflict, later sections override earlier ones.',
    '',
  ].join('\n'))
  const sectionChrome = ranked.reduce((total, { section }) => {
    return total + utf8ByteLength(`### ${sectionTitle(section.scope)} (${section.displayPath})\n\n`)
  }, 0)
  return fixed + sectionChrome + 2 * 1024
}

function normalizeDir(value) {
  const text = String(value ?? '').trim()
  return text ? resolve(text) : null
}

async function readInstructionFile(candidate) {
  let handle = null

  try {
    const resolvedRootPath = candidate.rootPath
      ? await fs.realpath(candidate.rootPath)
      : null
    const openFlags = candidate.disallowSymlink && Number.isInteger(fsConstants.O_NOFOLLOW)
      ? (fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      : 'r'

    handle = await fs.open(candidate.path, openFlags)
    const openedStat = await handle.stat()

    if (resolvedRootPath) {
      const resolvedCandidatePath = await fs.realpath(candidate.path)
      if (!isWithinRoot(resolvedCandidatePath, resolvedRootPath)) {
        throw new Error(`Instruction file ${candidate.displayPath} resolves outside the workspace root`)
      }
      const currentStat = await fs.stat(resolvedCandidatePath)
      if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
        throw new Error(`Instruction file ${candidate.displayPath} changed during validation`)
      }
    }

    const raw = await readAtMost(handle, MAX_CONTEXT_FILE_BYTES + 1)
    const bounded = truncateUtf8Buffer(raw, MAX_CONTEXT_FILE_BYTES, {
      reason: `maximum context file bytes (${MAX_CONTEXT_FILE_BYTES})`,
      originalBytes: openedStat.size,
    })
    const content = normalizeInstructionContent(bounded.text)
    if (!content) return null
    return {
      content,
      originalBytes: openedStat.size,
      truncated: bounded.truncated,
      truncationReason: bounded.truncationReason,
    }
  } catch (error) {
    if (error?.code === 'ENOENT' && handle == null) {
      return null
    }
    if (candidate.disallowSymlink && error?.code === 'ELOOP') {
      throw new Error(`Instruction file ${candidate.displayPath} must not be a symlink`)
    }
    if (error instanceof Error && /(must not be a symlink|outside the workspace root|changed during validation)/i.test(error.message)) {
      throw error
    }
    throw new Error(`Failed to read instruction file ${candidate.displayPath}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function readAtMost(handle, byteCount) {
  const buffer = Buffer.allocUnsafe(byteCount)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  return buffer.subarray(0, offset)
}

function isWithinRoot(candidatePath, rootPath) {
  const normalizedRoot = resolve(rootPath)
  const normalizedCandidate = resolve(candidatePath)
  const rootWithSeparator = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSeparator)
}

function normalizeInstructionContent(value) {
  const normalized = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim()
  return normalized || null
}
