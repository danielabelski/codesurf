import { promises as fs } from 'node:fs'
import { join, resolve } from 'node:path'

export async function loadInstructionContext({ homeDir, workspaceDir, executionTarget = 'local' } = {}) {
  const sections = []

  for (const candidate of instructionCandidates({ homeDir, workspaceDir, executionTarget })) {
    const content = await readInstructionFile(candidate.path)
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
    })
  }

  if (normalizedWorkspace) {
    candidates.push({
      scope: 'workspace',
      displayPath: 'AGENTS.md',
      path: join(normalizedWorkspace, 'AGENTS.md'),
    })
    candidates.push({
      scope: 'workspace-local',
      displayPath: '.codesurf/AGENTS.md',
      path: join(normalizedWorkspace, '.codesurf', 'AGENTS.md'),
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

async function readInstructionFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return normalizeInstructionContent(raw)
  } catch {
    return null
  }
}

function normalizeInstructionContent(value) {
  const normalized = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim()
  return normalized || null
}
