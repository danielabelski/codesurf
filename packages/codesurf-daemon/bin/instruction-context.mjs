import { constants as fsConstants, promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'

export async function loadInstructionContext({ homeDir, workspaceDir, executionTarget = 'local' } = {}) {
  const sections = []

  for (const candidate of instructionCandidates({ homeDir, workspaceDir, executionTarget })) {
    const content = await readInstructionFile(candidate)
    if (!content) continue
    sections.push({
      scope: candidate.scope,
      displayPath: candidate.displayPath,
      path: candidate.path,
      content,
    })
  }

  return { sections }
}

export function buildInstructionPrompt(context) {
  const sections = Array.isArray(context?.sections)
    ? context.sections.filter(section => section && typeof section.content === 'string' && section.content.trim().length > 0)
    : []

  if (sections.length === 0) return undefined

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

  return lines.join('\n').trim()
}

function instructionCandidates({ homeDir, workspaceDir, executionTarget }) {
  const normalizedHome = normalizeDir(homeDir)
  const normalizedWorkspace = normalizeDir(workspaceDir)
  const candidates = []

  if (executionTarget !== 'cloud' && normalizedHome) {
    candidates.push({
      scope: 'user',
      displayPath: '~/.codesurf/AGENTS.md',
      path: join(normalizedHome, '.codesurf', 'AGENTS.md'),
      disallowSymlink: false,
    })
  }

  if (normalizedWorkspace) {
    candidates.push({
      scope: 'workspace',
      displayPath: 'AGENTS.md',
      path: join(normalizedWorkspace, 'AGENTS.md'),
      rootPath: normalizedWorkspace,
      disallowSymlink: true,
    })
    candidates.push({
      scope: 'workspace-local',
      displayPath: '.codesurf/AGENTS.md',
      path: join(normalizedWorkspace, '.codesurf', 'AGENTS.md'),
      rootPath: normalizedWorkspace,
      disallowSymlink: true,
    })
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

    if (resolvedRootPath) {
      const openedStat = await handle.stat()
      const resolvedCandidatePath = await fs.realpath(candidate.path)
      if (!isWithinRoot(resolvedCandidatePath, resolvedRootPath)) {
        throw new Error(`Instruction file ${candidate.displayPath} resolves outside the workspace root`)
      }
      const currentStat = await fs.stat(resolvedCandidatePath)
      if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
        throw new Error(`Instruction file ${candidate.displayPath} changed during validation`)
      }
    }

    const raw = await handle.readFile({ encoding: 'utf8' })
    return normalizeInstructionContent(raw)
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
