#!/usr/bin/env node

import { access, readFile, readdir, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { ROOT as EXTENSIONS_ROOT, startHarnessServer } from '../examples/extensions/_harness/server.mjs'

const HELP = `Validate Contex example extensions.

Usage:
  node scripts/validate-extension.mjs --all
  node scripts/validate-extension.mjs examples/extensions/pomodoro
  npm run validate-extension -- --all

Options:
  --all      Validate every extension under examples/extensions/
  --help     Show this message
`

const args = process.argv.slice(2)

if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP)
  process.exit(0)
}

const targetArgs = args.filter(arg => arg !== '--all')
const validateAll = args.includes('--all') || targetArgs.length === 0
const targetDirs = await resolveTargets(validateAll ? [] : targetArgs)

if (targetDirs.length === 0) {
  console.error('No extensions matched the requested targets.')
  process.exit(1)
}

const { server, url } = await startHarnessServer(0, { quiet: true })

try {
  await assertHarnessReachable(url)
  const discovered = await fetchJson(`${url}/api/extensions`)
  const discoveredDirs = new Set(
    Array.isArray(discovered)
      ? discovered.map(entry => entry?.dir).filter(value => typeof value === 'string')
      : [],
  )

  console.log(`Validating ${targetDirs.length} extension${targetDirs.length === 1 ? '' : 's'} against manifest rules and the harness...`)

  let failures = 0
  let warningCount = 0

  for (const extDir of targetDirs) {
    const result = await validateExtension(extDir, url, discoveredDirs)
    warningCount += result.warnings.length
    if (result.errors.length > 0) failures += 1

    const icon = result.errors.length === 0 ? 'OK' : 'FAIL'
    console.log(`\n[${icon}] ${result.label}`)

    for (const warning of result.warnings) {
      console.log(`  warning: ${warning}`)
    }

    for (const error of result.errors) {
      console.log(`  error: ${error}`)
    }

    if (result.errors.length === 0 && result.warnings.length === 0) {
      console.log('  manifest + harness checks passed')
    }
  }

  console.log(`\nSummary: ${targetDirs.length - failures} passed, ${failures} failed, ${warningCount} warning${warningCount === 1 ? '' : 's'}`)
  process.exitCode = failures === 0 ? 0 : 1
} finally {
  await new Promise(resolvePromise => {
    server.close(() => resolvePromise())
  })
}

async function resolveTargets(rawTargets) {
  if (validateAll) {
    return await listAllExtensions()
  }

  const seen = new Set()
  const resolved = []
  for (const target of rawTargets) {
    const extDir = await resolveExtensionDir(target)
    if (seen.has(extDir)) continue
    seen.add(extDir)
    resolved.push(extDir)
  }
  return resolved.sort()
}

async function listAllExtensions() {
  const entries = await readdir(EXTENSIONS_ROOT, { withFileTypes: true })
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
    .map(entry => join(EXTENSIONS_ROOT, entry.name))
    .sort()
}

async function resolveExtensionDir(target) {
  const absTarget = resolve(process.cwd(), target)
  const targetStat = await stat(absTarget).catch(() => null)

  if (!targetStat) {
    throw new Error(`Target not found: ${target}`)
  }

  const extDir = targetStat.isFile() ? dirname(absTarget) : absTarget
  const manifestPath = targetStat.isFile() ? absTarget : join(absTarget, 'extension.json')

  if (basename(manifestPath) !== 'extension.json') {
    throw new Error(`Target must be an extension directory or extension.json file: ${target}`)
  }

  await access(manifestPath).catch(() => {
    throw new Error(`Missing extension.json in ${target}`)
  })

  if (!isWithin(EXTENSIONS_ROOT, extDir)) {
    throw new Error(`Target must live under ${relative(process.cwd(), EXTENSIONS_ROOT) || 'examples/extensions'}: ${target}`)
  }

  return extDir
}

async function assertHarnessReachable(baseUrl) {
  const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) {
    throw new Error(`Harness root returned ${response.status}`)
  }
}

async function validateExtension(extDir, baseUrl, discoveredDirs) {
  const label = relative(EXTENSIONS_ROOT, extDir).split(sep).join('/')
  const manifestPath = join(extDir, 'extension.json')
  const warnings = []
  const errors = []

  let manifest = null
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (err) {
    errors.push(`extension.json is not valid JSON: ${formatError(err)}`)
    return { label, warnings, errors }
  }

  if (!isObject(manifest)) {
    errors.push('extension.json must contain an object at the top level')
    return { label, warnings, errors }
  }

  const tileRecords = []
  const tileTypes = new Set()
  const settingKeys = new Set()
  const actionNames = new Set()
  const toolNames = new Set()

  requireString(manifest, 'id', errors)
  requireString(manifest, 'name', errors)
  requireString(manifest, 'version', errors)
  optionalString(manifest, 'description', errors)
  optionalString(manifest, 'author', errors)

  if (manifest.tier !== 'safe' && manifest.tier !== 'power') {
    errors.push('tier must be "safe" or "power"')
  }

  if (manifest.ui !== undefined) {
    if (!isObject(manifest.ui)) {
      errors.push('ui must be an object when provided')
    } else if (manifest.ui.mode !== undefined && manifest.ui.mode !== 'native' && manifest.ui.mode !== 'custom') {
      errors.push('ui.mode must be "native" or "custom"')
    }
  }

  if (manifest.main !== undefined) {
    if (typeof manifest.main !== 'string' || manifest.main.trim() === '') {
      errors.push('main must be a non-empty string when provided')
    } else {
      await validateFilePath(extDir, manifest.main, 'main', errors)
    }
  }

  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions) || manifest.permissions.some(value => typeof value !== 'string' || value.trim() === '')) {
      errors.push('permissions must be an array of non-empty strings')
    }
  }

  const contributes = manifest.contributes
  if (contributes !== undefined && !isObject(contributes)) {
    errors.push('contributes must be an object when provided')
  }

  if (Array.isArray(contributes?.tiles)) {
    for (const [index, tile] of contributes.tiles.entries()) {
      const base = `contributes.tiles[${index}]`
      if (!isObject(tile)) {
        errors.push(`${base} must be an object`)
        continue
      }

      const type = requireString(tile, 'type', errors, base)
      const entry = requireString(tile, 'entry', errors, base)
      requireString(tile, 'label', errors, base)
      optionalString(tile, 'icon', errors, base)
      validateSize(tile.defaultSize, `${base}.defaultSize`, errors)
      validateSize(tile.minSize, `${base}.minSize`, errors)

      const normalizedType = typeof type === 'string' && type.trim() !== ''
        ? (type.startsWith('ext:') ? type : `ext:${type}`)
        : null

      if (normalizedType) {
        if (tileTypes.has(normalizedType)) {
          errors.push(`${base}.type duplicates ${normalizedType}`)
        } else {
          tileTypes.add(normalizedType)
        }
      }

      if (typeof entry === 'string' && entry.trim() !== '') {
        await validateFilePath(extDir, entry, `${base}.entry`, errors)
        tileRecords.push({ type: normalizedType, entry })
      }
    }
  } else if (contributes?.tiles !== undefined) {
    errors.push('contributes.tiles must be an array when provided')
  }

  if (tileRecords.length === 0) {
    warnings.push('no tile entries declared; harness load checks skipped')
  }

  if (Array.isArray(contributes?.contextMenu)) {
    for (const [index, item] of contributes.contextMenu.entries()) {
      const base = `contributes.contextMenu[${index}]`
      if (!isObject(item)) {
        errors.push(`${base} must be an object`)
        continue
      }

      requireString(item, 'label', errors, base)
      const action = requireString(item, 'action', errors, base)
      const tileType = item.tileType
      if (tileType !== undefined && (typeof tileType !== 'string' || tileType.trim() === '')) {
        errors.push(`${base}.tileType must be a non-empty string when provided`)
      }
      optionalString(item, 'extId', errors, base)

      if (action === 'createTile') {
        if (typeof tileType !== 'string' || tileType.trim() === '') {
          errors.push(`${base}.tileType is required when action is createTile`)
        } else {
          const normalizedTileType = tileType.startsWith('ext:') ? tileType : `ext:${tileType}`
          if (!tileTypes.has(normalizedTileType)) {
            errors.push(`${base}.tileType references unknown tile type ${tileType}`)
          }
        }
      }
    }
  } else if (contributes?.contextMenu !== undefined) {
    errors.push('contributes.contextMenu must be an array when provided')
  }

  if (Array.isArray(contributes?.settings)) {
    for (const [index, item] of contributes.settings.entries()) {
      const base = `contributes.settings[${index}]`
      if (!isObject(item)) {
        errors.push(`${base} must be an object`)
        continue
      }

      const key = requireString(item, 'key', errors, base)
      requireString(item, 'label', errors, base)
      const type = item.type
      if (type !== 'string' && type !== 'number' && type !== 'boolean') {
        errors.push(`${base}.type must be string, number, or boolean`)
      }
      if (typeof key === 'string') {
        if (settingKeys.has(key)) errors.push(`${base}.key duplicates ${key}`)
        settingKeys.add(key)
      }
    }
  } else if (contributes?.settings !== undefined) {
    errors.push('contributes.settings must be an array when provided')
  }

  if (Array.isArray(contributes?.actions)) {
    for (const [index, item] of contributes.actions.entries()) {
      const base = `contributes.actions[${index}]`
      if (!isObject(item)) {
        errors.push(`${base} must be an object`)
        continue
      }

      const name = requireString(item, 'name', errors, base)
      requireString(item, 'description', errors, base)
      if (typeof name === 'string') {
        if (actionNames.has(name)) errors.push(`${base}.name duplicates ${name}`)
        actionNames.add(name)
      }
    }
  } else if (contributes?.actions !== undefined) {
    errors.push('contributes.actions must be an array when provided')
  }

  if (Array.isArray(contributes?.mcpTools)) {
    for (const [index, item] of contributes.mcpTools.entries()) {
      const base = `contributes.mcpTools[${index}]`
      if (!isObject(item)) {
        errors.push(`${base} must be an object`)
        continue
      }

      const name = requireString(item, 'name', errors, base)
      requireString(item, 'description', errors, base)
      if (!isObject(item.inputSchema)) {
        errors.push(`${base}.inputSchema must be an object`)
      }
      if (typeof name === 'string') {
        if (toolNames.has(name)) errors.push(`${base}.name duplicates ${name}`)
        toolNames.add(name)
      }
    }
  } else if (contributes?.mcpTools !== undefined) {
    errors.push('contributes.mcpTools must be an array when provided')
  }

  if (contributes?.context !== undefined) {
    if (!isObject(contributes.context)) {
      errors.push('contributes.context must be an object when provided')
    } else {
      validateStringArray(contributes.context.produces, 'contributes.context.produces', errors)
      validateStringArray(contributes.context.consumes, 'contributes.context.consumes', errors)
    }
  }

  if (!discoveredDirs.has(label)) {
    errors.push('harness discovery did not include this extension')
  }

  if (errors.length === 0) {
    for (const tile of tileRecords) {
      const tileUrl = buildTileUrl(baseUrl, label, tile.entry)
      const response = await fetch(tileUrl, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) {
        errors.push(`harness returned ${response.status} for ${tile.entry}`)
        continue
      }

      const contentType = response.headers.get('content-type') ?? ''
      if (!contentType.includes('text/html')) {
        errors.push(`harness served ${tile.entry} as ${contentType || 'unknown content-type'}`)
        continue
      }

      const html = await response.text()
      if (!/<(html|body|script|div)\b/i.test(html)) {
        errors.push(`harness served ${tile.entry}, but it does not look like HTML`)
      }
    }
  }

  return { label, warnings, errors }
}

function buildTileUrl(baseUrl, label, entry) {
  const path = `${label}/${entry}`
  const encoded = path
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
  return `${baseUrl}/${encoded}`
}

function requireString(object, key, errors, prefix = '') {
  const value = object[key]
  const path = prefix ? `${prefix}.${key}` : key
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${path} must be a non-empty string`)
    return null
  }
  return value
}

function optionalString(object, key, errors, prefix = '') {
  const value = object[key]
  const path = prefix ? `${prefix}.${key}` : key
  if (value !== undefined && typeof value !== 'string') {
    errors.push(`${path} must be a string when provided`)
  }
}

function validateStringArray(value, label, errors) {
  if (value === undefined) return
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    errors.push(`${label} must be an array of non-empty strings`)
  }
}

function validateSize(value, label, errors) {
  if (value === undefined) return
  if (!isObject(value)) {
    errors.push(`${label} must be an object with numeric w/h`)
    return
  }
  if (!isPositiveNumber(value.w) || !isPositiveNumber(value.h)) {
    errors.push(`${label} must contain positive numeric w/h values`)
  }
}

async function validateFilePath(extDir, candidate, label, errors) {
  const absPath = resolve(extDir, candidate)
  if (!isWithin(extDir, absPath)) {
    errors.push(`${label} must stay inside the extension directory`)
    return
  }

  const fileStat = await stat(absPath).catch(() => null)
  if (!fileStat?.isFile()) {
    errors.push(`${label} points to a missing file: ${candidate}`)
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isWithin(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`)
  }
  return await response.json()
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
