import { constants as fsConstants, promises as fs } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { buildContextBucketBundle, getIncludedContextBuckets } from './context-buckets.mjs'
import {
  MAX_CONTEXT_FILE_BYTES,
  MAX_IMPORT_DEPTH,
  MAX_IMPORT_TRAVERSAL_ATTEMPTS,
  MAX_INSTRUCTION_SECTIONS,
  budgetInstructionFragments,
  formatInstructionBudgetNotice,
  truncateUtf8Buffer,
  utf8ByteLength,
} from './context-budget.mjs'

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
  const includedBuckets = getIncludedContextBuckets(executionTarget)
  // Apply the outbound privacy policy before opening files, following imports,
  // or consuming any traversal/budget accounting. Cloud runs must not let
  // local-only candidates suppress visible remote-safe instructions.
  const candidates = memoryCandidates({
    homeDir: normalizedHome,
    workspaceDir: normalizedWorkspace,
    projectPaths: orderedProjectPaths,
  }).filter(candidate => includedBuckets.includes(candidate.bucket))
  const traversal = {
    visited: new Set(),
    omittedVisits: new Set(),
    selectedSectionCount: 0,
    importTraversalAttempts: 0,
    importTraversalLimitReported: false,
    omissions: [],
    includedBuckets,
    rootCandidatePaths: new Set(candidates.map(candidate => candidate.path)),
    sections,
  }

  // Later root candidates have higher precedence. Traverse from high to low so
  // the I/O cap is allocated the same way as the final content budget.
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]
    if (traversal.selectedSectionCount >= MAX_INSTRUCTION_SECTIONS) break
    await readMemorySections(candidate, traversal, {
      orderKey: [index],
    })
  }

  sections.sort((left, right) => compareOrderKeys(left.orderKey, right.orderKey))
  for (let index = 0; index < sections.length; index += 1) {
    sections[index].precedence = index
    delete sections[index].orderKey
  }

  // `sections` contains only successfully loaded, non-empty, visible content.
  // The shared allocator therefore applies its count cap to real sections,
  // never to candidate paths that did not exist.
  const budget = budgetInstructionFragments(sections, {
    reservedBytes: memoryPromptReservedBytes(sections),
  })
  const omittedByDepth = traversal.omissions.filter(item => item.truncationReason?.startsWith('maximum import depth')).length
  const omittedByTraversalAttempts = traversal.omissions.filter(item => item.truncationReason?.startsWith('maximum import traversal attempts')).length
  const importedSectionSources = new Set(
    sections
      .filter(section => section.importedFrom)
      .map(section => section.source),
  )
  const untraversedImportCount = traversal.omissions.filter(item =>
    item.importedFrom
    && item.truncationReason?.startsWith('maximum included instruction sections'),
  ).length
  const omittedByImportCount = budget.omitted.filter(item => importedSectionSources.has(item.source)).length
    + untraversedImportCount
  const extraNotices = []
  if (omittedByDepth > 0) {
    extraNotices.push(`${omittedByDepth} import${omittedByDepth === 1 ? '' : 's'} omitted by maximum import depth (${MAX_IMPORT_DEPTH}).`)
  }
  if (omittedByTraversalAttempts > 0) {
    extraNotices.push(`Lower-precedence import traversal stopped after maximum import traversal attempts (${MAX_IMPORT_TRAVERSAL_ATTEMPTS}).`)
  }
  if (omittedByImportCount > 0) {
    extraNotices.push(`${omittedByImportCount} lower-precedence import branch${omittedByImportCount === 1 ? '' : 'es'} omitted or not traversed after maximum included instruction sections (${MAX_INSTRUCTION_SECTIONS}).`)
  }
  const notice = formatInstructionBudgetNotice(budget, extraNotices)
  const notices = notice ? [notice] : []
  const prompt = buildMemoryPrompt({
    sections: budget.fragments,
    notices,
  })
  const contextBuckets = buildContextBucketBundle({
    executionTarget,
    includedBuckets,
    sections: budget.fragments,
  }, prompt)
  const result = {
    executionTarget,
    includedBuckets,
    sections,
    includedSections: budget.fragments,
    prompt,
    budget: {
      ...budget,
      omissions: [...budget.omitted, ...traversal.omissions],
      omittedByDepth,
      omittedByTraversalAttempts,
      omittedByImportCount,
      untraversedImportCount,
      maxFileBytes: MAX_CONTEXT_FILE_BYTES,
      maxImportDepth: MAX_IMPORT_DEPTH,
      maxImportTraversalAttempts: MAX_IMPORT_TRAVERSAL_ATTEMPTS,
    },
    ...(notices.length > 0 ? { notices } : {}),
  }
  const inspect = describeMemoryContextForTool(result, prompt)
  return {
    ...result,
    contextBuckets: {
      ...contextBuckets,
      ...(inspect.summary || inspect.input ? { inspect } : {}),
    },
  }
}

export function buildMemoryPrompt(context) {
  const inputSections = Array.isArray(context?.sections)
    ? context.sections.filter(section => section && typeof section.content === 'string' && section.content.trim())
    : []
  const budget = budgetInstructionFragments(inputSections, {
    reservedBytes: memoryPromptReservedBytes(inputSections),
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
    lines.push(`### ${sectionTitle(section.scope)} [${section.bucket}] (${section.displayPath})`)
    lines.push(section.content)
    lines.push('')
  }

  for (const notice of notices) lines.push(notice)

  return lines.join('\n').trim()
}

export function describeMemoryContextForTool(context, promptOverride) {
  const input = String(promptOverride ?? context?.prompt ?? '').trim() || undefined
  const visibleSections = Array.isArray(context?.includedSections)
    ? context.includedSections
    : Array.isArray(context?.sections) && Array.isArray(context?.includedBuckets)
      ? context.sections.filter(section => context.includedBuckets.includes(section.bucket))
    : []
  const omittedCount = Number(context?.budget?.omittedSectionCount ?? 0)
    + Number(context?.budget?.omittedByDepth ?? 0)
    + Number(context?.budget?.omittedByTraversalAttempts ?? 0)
    + Number(context?.budget?.untraversedImportCount ?? 0)
  const truncatedCount = visibleSections.filter(section => section.truncated).length
  const budgetSuffix = omittedCount > 0 || truncatedCount > 0
    ? `; ${truncatedCount} truncated, ${omittedCount} omitted by context budgets`
    : ''

  if (visibleSections.length > 0) {
    const paths = visibleSections.slice(0, 3).map(section => section.displayPath)
    const suffix = visibleSections.length > 3 ? ` +${visibleSections.length - 3} more` : ''
    return {
      summary: `Loaded ${visibleSections.length} instruction section${visibleSections.length === 1 ? '' : 's'} (${context.includedBuckets.join(', ')}): ${paths.join(', ')}${suffix}${budgetSuffix}`,
      input,
    }
  }

  if (input) {
    return {
      summary: `Loaded workspace instructions for this run${budgetSuffix}.`,
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

function memoryPromptReservedBytes(sections) {
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
    return total + utf8ByteLength(`### ${sectionTitle(section.scope)} [${section.bucket}] (${section.displayPath})\n\n`)
  }, 0)
  // Budget notices are bounded aggregate counters, but reserve enough room for
  // their deterministic markers so they never push the provider prompt over
  // the advertised aggregate ceiling.
  return fixed + sectionChrome + 2 * 1024
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
      scope: scopeLocal,
      scopeRemote,
      scopeLocal,
      bucket: 'local-only',
      displayPath: `${relativePrefix}.codesurf/DREAMING.md`,
      path: join(projectPath, '.codesurf', 'DREAMING.md'),
      rootPath: projectPath,
      disallowSymlink: true,
    })
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

async function readMemorySections(candidate, traversal, {
  importedFrom = null,
  depth = 0,
  orderKey = [],
} = {}) {
  // An imported path can change buckets relative to its parent. Reject it
  // before visit/depth accounting so cloud runs neither touch local-only files
  // nor reveal their existence through omission counts.
  if (!traversal.includedBuckets.includes(candidate.bucket)) return []

  const visitKey = candidate.path
  if (traversal.visited.has(visitKey)) return []
  // Root candidates own their canonical scope/bucket. A cross-import that
  // points at one is deduplicated here and the normal root pass loads it with
  // stable classification independent of the high-precedence selection pass.
  if (importedFrom && traversal.rootCandidatePaths.has(visitKey)) return []

  if (traversal.selectedSectionCount >= MAX_INSTRUCTION_SECTIONS) {
    if (importedFrom && !traversal.omittedVisits.has(visitKey)) {
      traversal.omittedVisits.add(visitKey)
      traversal.omissions.push(contextOmissionMetadata({
        ...candidate,
        importedFrom,
        reason: `maximum included instruction sections (${MAX_INSTRUCTION_SECTIONS}); lower-precedence import branch not traversed`,
      }))
    }
    return []
  }

  if (depth > MAX_IMPORT_DEPTH) {
    traversal.omissions.push(contextOmissionMetadata({
      ...candidate,
      importedFrom,
      reason: `maximum import depth (${MAX_IMPORT_DEPTH})`,
    }))
    return []
  }

  if (importedFrom) {
    if (traversal.importTraversalAttempts >= MAX_IMPORT_TRAVERSAL_ATTEMPTS) {
      if (!traversal.importTraversalLimitReported) {
        traversal.importTraversalLimitReported = true
        traversal.omissions.push(contextOmissionMetadata({
          source: 'memory-import-traversal',
          displayPath: 'additional lower-precedence visible imports',
          scope: candidate.scope,
          bucket: candidate.bucket,
          importedFrom,
          reason: `maximum import traversal attempts (${MAX_IMPORT_TRAVERSAL_ATTEMPTS}); additional lower-precedence import branches not traversed`,
        }))
      }
      return []
    }
    traversal.importTraversalAttempts += 1
  }

  traversal.visited.add(visitKey)

  const loaded = await readMemoryFile(candidate)
  if (!loaded) return []

  const { content, imports } = parseInstructionImports(loaded.content)

  // Imports override their parent section, later imports override earlier
  // imports, and descendants override their importing section. Visit this
  // precedence tree in reverse while retaining an explicit forward order key
  // for deterministic rendering after selection.
  for (let index = imports.length - 1; index >= 0; index -= 1) {
    const importPath = imports[index]
    const importedCandidate = resolveImportCandidate(candidate, importPath)
    await readMemorySections(importedCandidate, traversal, {
      importedFrom: candidate.displayPath,
      depth: depth + 1,
      orderKey: [...orderKey, index + 1],
    })
  }

  if (content) {
    traversal.sections.push({
      scope: candidate.scope,
      bucket: candidate.bucket,
      displayPath: candidate.displayPath,
      path: candidate.path,
      source: candidate.path,
      importedFrom,
      orderKey: [...orderKey, 0],
      content,
      originalBytes: loaded.originalBytes,
      includedBytes: utf8ByteLength(content),
      truncated: loaded.truncated,
      truncationReason: loaded.truncationReason,
    })
    if (traversal.selectedSectionCount < MAX_INSTRUCTION_SECTIONS) {
      traversal.selectedSectionCount += 1
    }
  }
}

function compareOrderKeys(left, right) {
  const leftKey = Array.isArray(left) ? left : []
  const rightKey = Array.isArray(right) ? right : []
  const length = Math.max(leftKey.length, rightKey.length)
  for (let index = 0; index < length; index += 1) {
    if (leftKey[index] === undefined) return -1
    if (rightKey[index] === undefined) return 1
    if (leftKey[index] !== rightKey[index]) return leftKey[index] - rightKey[index]
  }
  return 0
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
    const openedStat = await handle.stat()

    if (resolvedRootPath) {
      const resolvedCandidatePath = await fs.realpath(candidate.path)
      if (!isWithinRoot(resolvedCandidatePath, resolvedRootPath)) {
        throw new Error(`Memory file ${candidate.displayPath} resolves outside the workspace root`)
      }
      const currentStat = await fs.stat(resolvedCandidatePath)
      if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
        throw new Error(`Memory file ${candidate.displayPath} changed during validation`)
      }
    }

    const raw = await readAtMost(handle, MAX_CONTEXT_FILE_BYTES + 1)
    const bounded = truncateUtf8Buffer(raw, MAX_CONTEXT_FILE_BYTES, {
      reason: `maximum context file bytes (${MAX_CONTEXT_FILE_BYTES})`,
      originalBytes: openedStat.size,
    })
    return {
      content: bounded.text,
      originalBytes: openedStat.size,
      truncated: bounded.truncated,
      truncationReason: bounded.truncationReason,
    }
  } catch (error) {
    if ((error?.code === 'ENOENT' || error?.code === 'EPERM' || error?.code === 'EACCES') && handle == null) {
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

function contextOmissionMetadata({
  source,
  path,
  displayPath,
  scope,
  bucket,
  precedence,
  importedFrom,
  reason,
}) {
  return {
    source: String(source ?? path ?? displayPath ?? 'context'),
    displayPath: String(displayPath ?? source ?? path ?? 'context'),
    scope: String(scope ?? 'workspace'),
    bucket: String(bucket ?? 'remote-safe'),
    precedence: Number.isFinite(precedence) ? Number(precedence) : 0,
    ...(importedFrom ? { importedFrom: String(importedFrom) } : {}),
    originalBytes: 0,
    includedBytes: 0,
    truncated: true,
    truncationReason: String(reason ?? 'context budget'),
  }
}

function isWithinRoot(candidatePath, rootPath) {
  const normalizedRoot = resolve(rootPath)
  const normalizedCandidate = resolve(candidatePath)
  const rootWithSeparator = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(rootWithSeparator)
}
