import { constants as fsConstants, promises as fs } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { buildContextBucketBundle, getIncludedContextBuckets } from './context-buckets.mjs'

export async function loadMemoryContext({
  homeDir,
  workspaceDir,
  projectPaths = [],
  executionTarget = 'local',
} = {}) {
  const normalizedHome = normalizeDir(homeDir)
  const normalizedWorkspace = normalizeDir(workspaceDir)
  const orderedProjectPaths = orderProjectPaths(normalizedWorkspace, projectPaths)
  const sections = []
  const visited = new Set()

  for (const candidate of memoryCandidates({
    homeDir: normalizedHome,
    workspaceDir: normalizedWorkspace,
    projectPaths: orderedProjectPaths,
  })) {
    const loaded = await readMemorySections(candidate, visited)
    if (loaded.length > 0) sections.push(...loaded)
  }

  const includedBuckets = getIncludedContextBuckets(executionTarget)
  const prompt = buildMemoryPrompt({
    sections: sections.filter(section => includedBuckets.includes(section.bucket)),
  })
  const contextBuckets = buildContextBucketBundle({
    executionTarget,
    includedBuckets,
    sections,
  }, prompt)

  return {
    executionTarget,
    includedBuckets,
    sections,
    prompt,
    contextBuckets,
  }
}

export function buildMemoryPrompt(context) {
  const sections = Array.isArray(context?.sections)
    ? context.sections.filter(section => section && typeof section.content === 'string' && section.content.trim())
    : []
  if (sections.length === 0) return undefined

  const lines = [
    '## Workspace Instructions',
    'Follow these layered instructions in addition to the user request. If they conflict, later sections override earlier ones.',
    '',
  ]

  for (const section of sections) {
    lines.push(`### ${sectionTitle(section.scope)} [${section.bucket}] (${section.displayPath})`)
    lines.push(section.content)
    lines.push('')
  }

  return lines.join('\n').trim()
}

export function describeMemoryContextForTool(context, promptOverride) {
  const input = String(promptOverride ?? context?.prompt ?? '').trim() || undefined
  const visibleSections = Array.isArray(context?.sections) && Array.isArray(context?.includedBuckets)
    ? context.sections.filter(section => context.includedBuckets.includes(section.bucket))
    : []

  if (visibleSections.length > 0) {
    const paths = visibleSections.slice(0, 3).map(section => section.displayPath)
    const suffix = visibleSections.length > 3 ? ` +${visibleSections.length - 3} more` : ''
    return {
      summary: `Loaded ${visibleSections.length} instruction section${visibleSections.length === 1 ? '' : 's'} (${context.includedBuckets.join(', ')}): ${paths.join(', ')}${suffix}`,
      input,
    }
  }

  if (input) {
    return {
      summary: 'Loaded workspace instructions for this run.',
      input,
    }
  }

  return {
    summary: undefined,
    input: undefined,
  }
}

function joinPromptSections(...sections) {
  const normalized = sections
    .map(section => String(section ?? '').trim())
    .filter(Boolean)
  return normalized.length > 0 ? normalized.join('\n\n') : undefined
}

function normalizeDir(value) {
  const text = String(value ?? '').trim()
  return text ? resolve(text) : null
}

function normalizeInstructionContent(value) {
  const normalized = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim()
  return normalized || null
}

function sectionTitle(scope) {
  switch (scope) {
    case 'user':
      return 'User Instructions'
    case 'workspace-local':
      return 'Workspace Local Instructions'
    case 'nested-workspace':
      return 'Nested Workspace Instructions'
    case 'nested-workspace-local':
      return 'Nested Workspace Local Instructions'
    case 'workspace':
    default:
      return 'Workspace Instructions'
  }
}

function orderProjectPaths(workspaceDir, projectPaths) {
  const normalized = new Set()
  if (workspaceDir) normalized.add(workspaceDir)
  for (const entry of Array.isArray(projectPaths) ? projectPaths : []) {
    const value = normalizeDir(entry)
    if (value) normalized.add(value)
  }
  return [...normalized].sort((a, b) => {
    const depthA = a.split(sep).length
    const depthB = b.split(sep).length
    if (depthA !== depthB) return depthA - depthB
    return a.localeCompare(b)
  })
}

function memoryCandidates({ homeDir, workspaceDir, projectPaths }) {
  const candidates = []

  if (homeDir) {
    const userRoot = join(homeDir, '.codesurf')
    candidates.push({
      scope: 'user',
      scopeRemote: 'user',
      scopeLocal: 'user',
      bucket: 'local-only',
      displayPath: '~/.codesurf/AGENTS.md',
      path: join(userRoot, 'AGENTS.md'),
      rootPath: userRoot,
      disallowSymlink: false,
    })
    const claudeRoot = join(homeDir, '.claude')
    candidates.push({
      scope: 'user',
      scopeRemote: 'user',
      scopeLocal: 'user',
      bucket: 'local-only',
      displayPath: '~/.claude/CLAUDE.md',
      path: join(claudeRoot, 'CLAUDE.md'),
      rootPath: claudeRoot,
      disallowSymlink: false,
    })
  }

  const primaryWorkspace = workspaceDir ?? projectPaths[0] ?? null
  for (const projectPath of projectPaths) {
    const relativePrefix = primaryWorkspace && projectPath !== primaryWorkspace
      ? `${relative(primaryWorkspace, projectPath).replace(/\\/g, '/')}/`
      : ''
    const nested = Boolean(relativePrefix)
    const scopeRemote = nested ? 'nested-workspace' : 'workspace'
    const scopeLocal = nested ? 'nested-workspace-local' : 'workspace-local'
    candidates.push({
      scope: scopeRemote,
      scopeRemote,
      scopeLocal,
      bucket: 'remote-safe',
      displayPath: `${relativePrefix}AGENTS.md`,
      path: join(projectPath, 'AGENTS.md'),
      rootPath: projectPath,
      disallowSymlink: true,
    })
    candidates.push({
      scope: scopeRemote,
      scopeRemote,
      scopeLocal,
      bucket: 'remote-safe',
      displayPath: `${relativePrefix}CLAUDE.md`,
      path: join(projectPath, 'CLAUDE.md'),
      rootPath: projectPath,
      disallowSymlink: true,
    })
    candidates.push({
      scope: scopeLocal,
      scopeRemote,
      scopeLocal,
      bucket: 'local-only',
      displayPath: `${relativePrefix}.codesurf/AGENTS.md`,
      path: join(projectPath, '.codesurf', 'AGENTS.md'),
      rootPath: projectPath,
      disallowSymlink: true,
    })
    candidates.push({
      scope: scopeLocal,
      scopeRemote,
      scopeLocal,
      bucket: 'local-only',
      displayPath: `${relativePrefix}.claude/CLAUDE.md`,
      path: join(projectPath, '.claude', 'CLAUDE.md'),
      rootPath: projectPath,
      disallowSymlink: true,
    })
  }

  return candidates
}

async function readMemorySections(candidate, visited, importedFrom = null) {
  const visitKey = candidate.path
  if (visited.has(visitKey)) return []
  visited.add(visitKey)

  const raw = await readMemoryFile(candidate)
  if (!raw) return []

  const { content, imports } = parseInstructionImports(raw)
  const sections = []
  if (content) {
    sections.push({
      scope: candidate.scope,
      bucket: candidate.bucket,
      displayPath: candidate.displayPath,
      path: candidate.path,
      importedFrom,
      content,
    })
  }

  for (const importPath of imports) {
    const importedCandidate = resolveImportCandidate(candidate, importPath)
    const importedSections = await readMemorySections(importedCandidate, visited, candidate.displayPath)
    if (importedSections.length > 0) sections.push(...importedSections)
  }

  return sections
}

function parseInstructionImports(raw) {
  const imports = []
  const contentLines = []
  for (const line of String(raw ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const match = line.match(/^\s*@import\s+(.+?)\s*$/)
    if (match) {
      imports.push(match[1].trim().replace(/^['"]|['"]$/g, ''))
      continue
    }
    contentLines.push(line)
  }
  return {
    content: normalizeInstructionContent(contentLines.join('\n')),
    imports,
  }
}

function resolveImportCandidate(parent, importPath) {
  const candidatePath = resolve(dirname(parent.path), importPath)
  const relativePath = parent.rootPath
    ? relative(parent.rootPath, candidatePath).replace(/\\/g, '/')
    : importPath
  const importedIsLocalOnly = parent.bucket === 'local-only'
    || relativePath === '.codesurf/AGENTS.md'
    || relativePath.startsWith('.codesurf/')
    || relativePath === '.claude/CLAUDE.md'
    || relativePath.startsWith('.claude/')
  return {
    ...parent,
    scope: importedIsLocalOnly ? parent.scopeLocal : parent.scopeRemote,
    bucket: importedIsLocalOnly ? 'local-only' : 'remote-safe',
    path: candidatePath,
    displayPath: relativePath,
  }
}

async function readMemoryFile(candidate) {
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
        throw new Error(`Memory file ${candidate.displayPath} resolves outside the workspace root`)
      }
      const currentStat = await fs.stat(resolvedCandidatePath)
      if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
        throw new Error(`Memory file ${candidate.displayPath} changed during validation`)
      }
    }

    return await handle.readFile({ encoding: 'utf8' })
  } catch (error) {
    if (error?.code === 'ENOENT' && handle == null) {
      return null
    }
    if (candidate.disallowSymlink && error?.code === 'ELOOP') {
      throw new Error(`Memory file ${candidate.displayPath} must not be a symlink`)
    }
    if (error instanceof Error && /(must not be a symlink|outside the workspace root|changed during validation)/i.test(error.message)) {
      throw error
    }
    throw new Error(`Failed to read memory file ${candidate.displayPath}: ${error instanceof Error ? error.message : String(error)}`)
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
