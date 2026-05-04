import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

export const BUILTIN_COMMAND_SKILLS = [
  { id: 'command:/compact', name: '/compact', description: 'Compact conversation.', scope: 'command', kind: 'command', rootKind: 'builtin-command', displayPath: 'builtin:/compact' },
  { id: 'command:/clear', name: '/clear', description: 'Clear conversation.', scope: 'command', kind: 'command', rootKind: 'builtin-command', displayPath: 'builtin:/clear' },
  { id: 'command:/model', name: '/model', description: 'Switch model.', scope: 'command', kind: 'command', rootKind: 'builtin-command', displayPath: 'builtin:/model' },
  { id: 'command:/mode', name: '/mode', description: 'Switch mode (plan, build, etc.).', scope: 'command', kind: 'command', rootKind: 'builtin-command', displayPath: 'builtin:/mode' },
  { id: 'command:/help', name: '/help', description: 'Show help.', scope: 'command', kind: 'command', rootKind: 'builtin-command', displayPath: 'builtin:/help' },
  { id: 'command:/init', name: '/init', description: 'Initialize workspace.', scope: 'command', kind: 'command', rootKind: 'builtin-command', displayPath: 'builtin:/init' },
  { id: 'command:/export-notes', name: '/export-notes', description: 'Copy all attached block notes to the clipboard.', scope: 'command', kind: 'command', rootKind: 'builtin-command', displayPath: 'builtin:/export-notes' },
]

const DEFAULT_COMPAT_LOCATION_LINES = [
  '$HOME/.claude/commands',
  '$WORKSPACE/.claude/commands',
  '$HOME/.claude/skills',
  '$WORKSPACE/.claude/skills',
  '$HOME/.config/opencode/skills',
  '$WORKSPACE/.opencode/skills',
  '$WORKSPACE/.cursor/rules',
  '$WORKSPACE/.continue/prompts',
]

const SKILL_FILE_PATTERNS = [/^skill\.md$/i, /^skill\.(txt|mdc)$/i]
const TOP_LEVEL_SKILL_EXTENSIONS = new Set(['.md', '.txt', '.mdc'])

function normalizeDir(value) {
  const trimmed = String(value ?? '').trim()
  return trimmed ? resolve(trimmed) : null
}

function normalizeText(value) {
  const text = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .trim()
  return text || null
}

function stripSkillContent(skill) {
  const { content, ...rest } = skill
  return rest
}

function uniqueStrings(values) {
  const seen = new Set()
  const result = []
  for (const value of Array.isArray(values) ? values : []) {
    const text = String(value ?? '').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
  }
  return result
}

async function pathExists(path) {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function displayPath(filePath, { userHomeDir, workspaceDir }) {
  const resolvedFile = normalizeDir(filePath)
  if (!resolvedFile) return String(filePath ?? '')
  const resolvedWorkspace = normalizeDir(workspaceDir)
  if (resolvedWorkspace && (resolvedFile === resolvedWorkspace || resolvedFile.startsWith(`${resolvedWorkspace}${sep}`))) {
    const rel = relative(resolvedWorkspace, resolvedFile)
    return rel || basename(resolvedFile)
  }
  const resolvedHome = normalizeDir(userHomeDir)
  if (resolvedHome && (resolvedFile === resolvedHome || resolvedFile.startsWith(`${resolvedHome}${sep}`))) {
    const rel = relative(resolvedHome, resolvedFile)
    return rel ? `~/${rel}` : '~'
  }
  return resolvedFile
}

function basenameWithoutKnownExtension(name) {
  return String(name ?? '').replace(/\.(md|txt|mdc)$/i, '')
}

function parseSkillFrontmatter(content, fallbackName, fallbackDescription) {
  const normalized = normalizeText(content) ?? ''
  const nameMatch = normalized.match(/^---[\s\S]*?name:\s*(.+?)$/m)
  const descriptionMatch = normalized.match(/^---[\s\S]*?description:\s*(.+?)$/m)
  return {
    name: nameMatch?.[1]?.trim() || fallbackName,
    description: descriptionMatch?.[1]?.trim() || fallbackDescription,
    content: normalized,
  }
}

function inferCompatRootKind(dirPath, workspaceDir) {
  const normalizedDir = normalizeDir(dirPath)
  const normalizedWorkspace = normalizeDir(workspaceDir)
  if (!normalizedDir) return 'directory'
  if (normalizedDir.endsWith(`${sep}.claude${sep}commands`)) return 'claude-commands'
  if (normalizedDir.endsWith(`${sep}.claude${sep}skills`)) return 'claude-skills'
  if (normalizedDir.endsWith(`${sep}.config${sep}opencode${sep}skills`)) return 'opencode-skills'
  if (normalizedDir.endsWith(`${sep}.opencode${sep}skills`)) return 'opencode-skills'
  if (normalizedDir.endsWith(`${sep}.cursor${sep}rules`)) return 'cursor-rules'
  if (normalizedDir.endsWith(`${sep}.continue${sep}prompts`)) return 'continue-prompts'
  if (normalizedWorkspace && (normalizedDir === normalizedWorkspace || normalizedDir.startsWith(`${normalizedWorkspace}${sep}`))) return 'workspace-location'
  return 'directory'
}

function rootLabel(kind) {
  switch (kind) {
    case 'codesurf': return 'CodeSurf skills'
    case 'customisation-skills': return 'Saved custom skills'
    case 'claude-commands': return 'Claude commands'
    case 'claude-skills': return 'Claude skills'
    case 'opencode-skills': return 'OpenCode skills'
    case 'cursor-rules': return 'Cursor rules'
    case 'continue-prompts': return 'Continue prompts'
    default: return 'Skill location'
  }
}

function buildRoot({ path, scope, kind, userHomeDir, workspaceDir, exists, sourceType = 'directory' }) {
  return {
    id: `${scope}:${kind}:${normalizeDir(path) ?? path}`,
    path: normalizeDir(path) ?? String(path ?? ''),
    displayPath: displayPath(path, { userHomeDir, workspaceDir }),
    scope,
    kind,
    label: rootLabel(kind),
    exists: exists === true,
    sourceType,
  }
}

function dedupeRoots(roots) {
  const seen = new Set()
  return roots.filter(root => {
    const key = `${root.sourceType}:${root.path}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function resolveLocationLines(raw, userHomeDir, workspaceDir) {
  return String(raw ?? '')
    .split('\n')
    .map(line => {
      let value = line.trim()
      if (!value) return ''
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      return value.replace(/\\([ \t()'"\\])/g, '$1')
    })
    .filter(Boolean)
    .filter(line => workspaceDir || !line.startsWith('$WORKSPACE'))
    .map(line => line.replace(/^\$HOME/, userHomeDir).replace(/^\$WORKSPACE/, workspaceDir ?? ''))
    .map(line => normalizeDir(line))
    .filter(Boolean)
}

async function readCustomLocationText(filePath) {
  if (!filePath) return ''
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    if (!raw.trim()) return ''
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed === 'string') return parsed
      return ''
    } catch {
      return raw
    }
  } catch {
    return ''
  }
}

async function loadSavedCustomSkills(filePath, context, includeContent) {
  const skills = []
  const entries = await readJson(filePath, [])
  if (!Array.isArray(entries)) return skills
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!id || !name) continue
    const description = normalizeText(entry.description) ?? 'Saved workspace skill.'
    const content = typeof entry.content === 'string' ? entry.content : String(entry.content ?? '')
    skills.push({
      id,
      name,
      description,
      scope: 'workspace',
      kind: 'skill',
      rootKind: 'customisation-skills',
      path: filePath,
      displayPath: displayPath(filePath, context),
      sourcePath: filePath,
      ...(includeContent ? { content } : {}),
    })
  }
  return skills
}

function buildDiscoveredSkill(filePath, content, dirPath, metadata, includeContent) {
  return {
    id: `discovered-${filePath}`,
    name: metadata.name,
    description: metadata.description,
    scope: metadata.scope,
    kind: 'skill',
    rootKind: metadata.rootKind,
    path: filePath,
    displayPath: metadata.displayPath,
    sourcePath: filePath,
    ...(includeContent ? { content } : {}),
  }
}

async function scanSkillDirectory(rootPath, metadata, includeContent) {
  if (!(await pathExists(rootPath))) return []
  const skills = []
  const entries = await fs.readdir(rootPath, { withFileTypes: true })
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name)
    if (entry.isDirectory()) {
      const subEntries = await fs.readdir(entryPath, { withFileTypes: true }).catch(() => [])
      const skillFile = subEntries.find(item => !item.isDirectory() && SKILL_FILE_PATTERNS.some(pattern => pattern.test(item.name)))
      if (!skillFile) continue
      const skillPath = join(entryPath, skillFile.name)
      const content = await fs.readFile(skillPath, 'utf8').catch(() => '')
      const parsed = parseSkillFrontmatter(content, entry.name, `From ${displayPath(rootPath, metadata)}`)
      skills.push(buildDiscoveredSkill(skillPath, content, rootPath, {
        ...metadata,
        displayPath: displayPath(skillPath, metadata),
        name: parsed.name,
        description: parsed.description,
      }, includeContent))
      continue
    }
    if (!entry.isFile()) continue
    const extension = extname(entry.name).toLowerCase()
    if (!TOP_LEVEL_SKILL_EXTENSIONS.has(extension)) continue
    const content = await fs.readFile(entryPath, 'utf8').catch(() => '')
    const parsed = parseSkillFrontmatter(content, basenameWithoutKnownExtension(entry.name), `From ${displayPath(rootPath, metadata)}`)
    skills.push(buildDiscoveredSkill(entryPath, content, rootPath, {
      ...metadata,
      displayPath: displayPath(entryPath, metadata),
      name: parsed.name,
      description: parsed.description,
    }, includeContent))
  }
  return skills
}

async function readTileSkillSelection(workspaceDir, cardId) {
  const normalizedWorkspace = normalizeDir(workspaceDir)
  const normalizedCardId = String(cardId ?? '').trim()
  if (!normalizedWorkspace || !normalizedCardId) {
    return { enabledIds: [], disabledIds: [] }
  }
  const candidates = [
    join(normalizedWorkspace, '.contex', normalizedCardId, 'skills.json'),
    join(normalizedWorkspace, '.collab', normalizedCardId, 'skills.json'),
  ]
  for (const candidate of candidates) {
    const parsed = await readJson(candidate, null)
    if (!parsed || typeof parsed !== 'object') continue
    return {
      enabledIds: uniqueStrings(parsed.enabled),
      disabledIds: uniqueStrings(parsed.disabled),
    }
  }
  return { enabledIds: [], disabledIds: [] }
}

export function buildSkillSelectionPrompt({ skills, selection }) {
  const availableSkills = Array.isArray(skills) ? skills : []
  const enabledIds = uniqueStrings(selection?.enabledIds)
  const disabledIds = uniqueStrings(selection?.disabledIds)
  const disabledSet = new Set(disabledIds)
  const byId = new Map(availableSkills.map(skill => [skill.id, stripSkillContent(skill)]))
  const resolved = []
  const unresolvedIds = []
  for (const id of enabledIds) {
    if (disabledSet.has(id)) continue
    const skill = byId.get(id)
    if (!skill) {
      unresolvedIds.push(id)
      continue
    }
    resolved.push(skill)
  }
  if (resolved.length === 0) {
    return {
      enabledIds,
      disabledIds,
      resolved: [],
      unresolvedIds,
      summary: undefined,
      prompt: undefined,
    }
  }
  const previewNames = resolved.slice(0, 4).map(skill => skill.name)
  const suffix = resolved.length > 4 ? ` +${resolved.length - 4} more` : ''
  return {
    enabledIds,
    disabledIds,
    resolved,
    unresolvedIds,
    summary: `Included ${resolved.length} skill${resolved.length === 1 ? '' : 's'}: ${previewNames.join(', ')}${suffix}`,
    prompt: [
      '## Included Skills',
      'Use these selected skills/tools when relevant. They are metadata summaries sourced by the daemon.',
      '',
      ...resolved.map(skill => `- @${skill.name} [${skill.scope}] — ${skill.description}`),
    ].join('\n').trim(),
  }
}

function runCommand(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else rejectPromise(new Error(`${command} ${args.join(' ')} failed (code ${code}): ${stderr || stdout}`))
    })
  })
}

async function listZipEntries(zipPath) {
  const { stdout } = await runCommand('/usr/bin/unzip', ['-Z1', zipPath])
  return stdout.split('\n').map(line => line.trim()).filter(Boolean)
}

async function readZipEntry(zipPath, entryName) {
  const { stdout } = await runCommand('/usr/bin/unzip', ['-p', zipPath, entryName])
  return stdout
}

function inferTopFolder(entries) {
  const folders = new Set()
  for (const entry of entries) {
    const first = entry.split('/')[0]
    if (first) folders.add(first)
  }
  if (folders.size !== 1) return null
  return Array.from(folders)[0] ?? null
}

async function readSkillArchiveManifest(zipPath) {
  const entries = await listZipEntries(zipPath)
  const topFolder = inferTopFolder(entries) ?? basename(zipPath, extname(zipPath))
  const skillEntry = entries.find(entry => /(^|\/)skill\.md$/i.test(entry))
  let content = ''
  if (skillEntry) {
    content = await readZipEntry(zipPath, skillEntry)
  }
  const parsed = parseSkillFrontmatter(content, topFolder, '')
  return {
    topFolder,
    name: parsed.name,
    description: parsed.description,
    content,
    entries,
  }
}

async function extractSkillArchive(zipPath, targetDir, overwrite) {
  await fs.mkdir(targetDir, { recursive: true })
  const manifest = await readSkillArchiveManifest(zipPath)
  const installedPath = join(targetDir, manifest.topFolder)
  if (await pathExists(installedPath)) {
    if (!overwrite) {
      throw new Error(`Skill already installed at ${installedPath}. Pass overwrite=true to replace.`)
    }
    await fs.rm(installedPath, { recursive: true, force: true })
  }
  await runCommand('/usr/bin/unzip', ['-o', '-qq', zipPath, '-d', targetDir])
  return {
    manifest,
    installedPath,
  }
}

export function createSkillsIndex({ homeDir, userHomeDir }) {
  const normalizedHome = normalizeDir(homeDir)
  const normalizedUserHome = normalizeDir(userHomeDir) ?? normalizedHome

  async function collectIndex({ workspaceDir, cardId, includeContent = false } = {}) {
    const normalizedWorkspace = normalizeDir(workspaceDir)
    const context = {
      userHomeDir: normalizedUserHome,
      workspaceDir: normalizedWorkspace,
    }
    const roots = []
    const skills = []

    const globalCodesurfRoot = join(normalizedHome, 'skills')
    roots.push(buildRoot({
      path: globalCodesurfRoot,
      scope: 'global',
      kind: 'codesurf',
      exists: await pathExists(globalCodesurfRoot),
      ...context,
    }))
    skills.push(...await scanSkillDirectory(globalCodesurfRoot, {
      scope: 'global',
      rootKind: 'codesurf',
      ...context,
    }, includeContent))

    if (normalizedWorkspace) {
      const workspaceCodesurfRoot = join(normalizedWorkspace, '.codesurf', 'skills')
      roots.push(buildRoot({
        path: workspaceCodesurfRoot,
        scope: 'workspace',
        kind: 'codesurf',
        exists: await pathExists(workspaceCodesurfRoot),
        ...context,
      }))
      skills.push(...await scanSkillDirectory(workspaceCodesurfRoot, {
        scope: 'workspace',
        rootKind: 'codesurf',
        ...context,
      }, includeContent))

      const savedSkillsFile = join(normalizedWorkspace, '.contex', 'customisation', 'skills.json')
      roots.push(buildRoot({
        path: savedSkillsFile,
        scope: 'workspace',
        kind: 'customisation-skills',
        exists: await pathExists(savedSkillsFile),
        sourceType: 'file',
        ...context,
      }))
      skills.push(...await loadSavedCustomSkills(savedSkillsFile, context, includeContent))

      const skillsLocationsText = await readCustomLocationText(join(normalizedWorkspace, '.contex', 'customisation', 'locations-skills.json'))
      const promptLocationsText = await readCustomLocationText(join(normalizedWorkspace, '.contex', 'customisation', 'locations-prompts.json'))
      const mergedLocationText = [skillsLocationsText, promptLocationsText].filter(text => text && text.trim()).join('\n') || DEFAULT_COMPAT_LOCATION_LINES.join('\n')
      const compatLocations = resolveLocationLines(mergedLocationText, normalizedUserHome, normalizedWorkspace)
      const seenCompat = new Set()
      for (const location of compatLocations) {
        if (!location || seenCompat.has(location)) continue
        seenCompat.add(location)
        const rootKind = inferCompatRootKind(location, normalizedWorkspace)
        roots.push(buildRoot({
          path: location,
          scope: location.startsWith(`${normalizedWorkspace}${sep}`) ? 'workspace' : 'global',
          kind: rootKind,
          exists: await pathExists(location),
          ...context,
        }))
        skills.push(...await scanSkillDirectory(location, {
          scope: location.startsWith(`${normalizedWorkspace}${sep}`) ? 'workspace' : 'global',
          rootKind,
          ...context,
        }, includeContent))
      }
    }

    for (const command of BUILTIN_COMMAND_SKILLS) {
      skills.push(command)
    }

    const selection = buildSkillSelectionPrompt({
      skills,
      selection: await readTileSkillSelection(normalizedWorkspace, cardId),
    })

    return {
      workspaceDir: normalizedWorkspace,
      roots: dedupeRoots(roots),
      skills: includeContent ? skills : skills.map(stripSkillContent),
      selection,
    }
  }

  async function listSkills(args = {}) {
    return await collectIndex({
      workspaceDir: args.workspaceDir,
      cardId: args.cardId,
      includeContent: false,
    })
  }

  async function getSkill(args = {}) {
    const skillId = String(args.skillId ?? '').trim()
    if (!skillId) {
      throw new Error('skillId is required')
    }
    const index = await collectIndex({
      workspaceDir: args.workspaceDir,
      cardId: args.cardId,
      includeContent: true,
    })
    const skill = index.skills.find(entry => entry.id === skillId)
    if (!skill) return null
    return skill
  }

  async function installSkill(args = {}) {
    const zipPath = String(args.zipPath ?? '').trim()
    if (!zipPath || !zipPath.toLowerCase().endsWith('.skill')) {
      throw new Error('zipPath must point to a .skill archive')
    }
    const scope = args.scope === 'workspace' ? 'workspace' : 'global'
    const normalizedWorkspace = normalizeDir(args.workspaceDir)
    if (scope === 'workspace' && !normalizedWorkspace) {
      throw new Error('workspaceDir is required for workspace installs')
    }
    const targetRoot = scope === 'workspace'
      ? join(normalizedWorkspace, '.codesurf', 'skills')
      : join(normalizedHome, 'skills')
    const { installedPath, manifest } = await extractSkillArchive(zipPath, targetRoot, args.overwrite === true)
    const skillId = `discovered-${join(installedPath, 'SKILL.md')}`
    const skill = await getSkill({ workspaceDir: normalizedWorkspace, skillId })
    return {
      ok: true,
      scope,
      targetRoot,
      installedPath,
      skill: skill ?? {
        id: skillId,
        name: manifest.name,
        description: manifest.description,
        scope,
        kind: 'skill',
        rootKind: 'codesurf',
        path: join(installedPath, 'SKILL.md'),
        displayPath: displayPath(join(installedPath, 'SKILL.md'), { userHomeDir: normalizedUserHome, workspaceDir: normalizedWorkspace }),
        content: manifest.content,
      },
    }
  }

  return {
    listSkills,
    getSkill,
    installSkill,
  }
}
