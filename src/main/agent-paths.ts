/**
 * Agent binary detection + persistence.
 *
 * On startup, resolves full paths for claude, codex, opencode.
 * Persists to ~/.contex/agent-paths.json so the packaged app knows where they are.
 * Exports getAgentPath(id) for use by chat.ts and anywhere else.
 */

import { ipcMain } from 'electron'
import { execFileSync, execSync } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { CONTEX_HOME } from './paths'

const PATHS_FILE = join(CONTEX_HOME, 'agent-paths.json')

export interface AgentPathEntry {
  path: string | null
  version: string | null
  detectedAt: string
  confirmed: boolean
}

export interface AgentPathsConfig {
  claude: AgentPathEntry
  codex: AgentPathEntry
  opencode: AgentPathEntry
  openclaw: AgentPathEntry
  hermes: AgentPathEntry
  shellPath: string | null
  updatedAt: string
}

// In-memory cache
let cachedPaths: AgentPathsConfig | null = null

/** Get the user's real shell PATH (packaged Electron gets a minimal one) */
function resolveShellPath(): string {
  const isWin = process.platform === 'win32'

  if (!isWin) {
    try {
      const shell = process.env.SHELL || '/bin/zsh'
      // -ilc loads the user's full login profile
      return execFileSync(shell, ['-ilc', 'echo -n "$PATH"'], {
        timeout: 5000,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    } catch { /* fall through to fallback */ }
  }

  if (isWin) {
    // On Windows, process.env.PATH is usually already correct
    if (process.env.PATH) return process.env.PATH
    const home = homedir()
    return [
      join(home, 'AppData', 'Roaming', 'npm'),
      join(home, '.bun', 'bin'),
      join(home, 'go', 'bin'),
      join(home, '.cargo', 'bin'),
      'C:\\Program Files\\nodejs',
    ].join(';')
  }

  // Unix fallback
  return [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    `${homedir()}/.bun/bin`,
    `${homedir()}/.npm-global/bin`,
    `${homedir()}/.local/bin`,
    `${homedir()}/.nvm/versions/node`,
    `${homedir()}/go/bin`,
    `${homedir()}/.yarn/bin`,
  ].join(':')
}

// Cache the resolved PATH once
let _shellPath: string | null = null
function getShellPath(): string {
  if (!_shellPath) _shellPath = resolveShellPath()
  return _shellPath
}

/** Simple `which`/`where` using the real shell PATH */
function whichSync(cmd: string): string | null {
  try {
    const whichCmd = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`
    const result = execSync(whichCmd, {
      timeout: 3000,
      encoding: 'utf8',
      env: { ...process.env, PATH: getShellPath() },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (!result || result.includes('not found') || result.includes('Could not find')) return null
    // `where` on Windows may return multiple lines; take the first
    return result.split(/\r?\n/)[0]?.trim() || null
  } catch {
    return null
  }
}

/** Check if a file exists and is executable */
async function isExecutable(filePath: string): Promise<boolean> {
  // Try the exact path first
  try {
    await fs.access(filePath)
    return true
  } catch { /* continue */ }

  // On Windows, try common executable extensions if no extension provided
  if (process.platform === 'win32' && !/\.\w+$/.test(filePath)) {
    for (const ext of ['.exe', '.cmd', '.bat', '.ps1']) {
      try {
        await fs.access(filePath + ext)
        return true
      } catch { /* continue */ }
    }
  }

  return false
}

/** Resolve a path to its actual file, adding .exe/.cmd on Windows if needed */
async function resolveExecutablePath(filePath: string): Promise<string | null> {
  // On Windows, prefer .exe even when a bare file or .cmd exists in the same
  // directory — Node's spawn() can only execute .exe directly; .cmd and .bat
  // require shell:true which the Claude SDK doesn't set.
  if (process.platform === 'win32' && !/\.\w+$/.test(filePath)) {
    for (const ext of ['.exe', '.cmd', '.bat', '.ps1']) {
      try {
        await fs.access(filePath + ext)
        return filePath + ext
      } catch { /* continue */ }
    }
  }

  try {
    await fs.access(filePath)
    return filePath
  } catch { /* continue */ }

  return null
}

/** Walk nvm versions dir to find a binary */
async function findInNvm(cmd: string): Promise<string | null> {
  const nvmBase = join(homedir(), '.nvm', 'versions', 'node')
  try {
    const versions = await fs.readdir(nvmBase)
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    for (const ver of versions) {
      const binPath = join(nvmBase, ver, 'bin', cmd)
      if (await isExecutable(binPath)) return binPath
    }
  } catch { /* nvm not installed */ }
  return null
}

/** Get version string from a binary */
function getVersionSync(binPath: string): string | null {
  try {
    const out = execFileSync(binPath, ['--version'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const match = out.match(/[\d]+\.[\d]+[\d.]*/)
    return match ? match[0] : out.trim().split('\n')[0]?.substring(0, 40) || null
  } catch {
    return null
  }
}

// Fallback paths if `which`/`where` fails
const isWin = process.platform === 'win32'
const ext = isWin ? '.cmd' : ''

function buildFallbackPaths(cmd: string, extras: string[] = []): string[] {
  const home = homedir()
  if (isWin) {
    return [
      join(home, 'AppData', 'Roaming', 'npm', `${cmd}${ext}`),
      join(home, '.bun', 'bin', `${cmd}.exe`),
      join(home, '.local', 'bin', `${cmd}.exe`),
      join(home, 'go', 'bin', `${cmd}.exe`),
      join(home, '.cargo', 'bin', `${cmd}.exe`),
      ...extras,
    ]
  }
  return [
    `/usr/local/bin/${cmd}`,
    `/opt/homebrew/bin/${cmd}`,
    `${home}/.bun/bin/${cmd}`,
    `${home}/.npm-global/bin/${cmd}`,
    `${home}/.local/bin/${cmd}`,
    `${home}/.yarn/bin/${cmd}`,
    ...extras,
  ]
}

const FALLBACK_PATHS: Record<string, string[]> = {
  claude: buildFallbackPaths('claude'),
  codex: buildFallbackPaths('codex'),
  opencode: buildFallbackPaths('opencode', isWin ? [] : [`${homedir()}/go/bin/opencode`]),
  openclaw: buildFallbackPaths('openclaw', isWin ? [] : [`${homedir()}/.cargo/bin/openclaw`]),
  hermes: buildFallbackPaths('hermes', [
    ...(isWin ? [] : [`${homedir()}/.hermes/bin/hermes`]),
    join(homedir(), 'Documents', 'GitHub', 'hermes-agent', isWin ? 'hermes.exe' : 'hermes'),
  ]),
}

/** Detect a single agent binary */
async function detectBinary(agentId: string): Promise<AgentPathEntry> {
  const now = new Date().toISOString()

  // 1. `which` with the real shell PATH — simplest and most reliable
  const found = whichSync(agentId)
  if (found) {
    const version = getVersionSync(found)
    return { path: found, version, detectedAt: now, confirmed: false }
  }

  // 2. Check nvm dirs (common for npm-global installs)
  const nvmPath = await findInNvm(agentId)
  if (nvmPath) {
    const version = getVersionSync(nvmPath)
    return { path: nvmPath, version, detectedAt: now, confirmed: false }
  }

  // 3. Hardcoded fallback paths
  for (const p of FALLBACK_PATHS[agentId] ?? []) {
    const resolved = await resolveExecutablePath(p)
    if (resolved) {
      const version = getVersionSync(resolved)
      return { path: resolved, version, detectedAt: now, confirmed: false }
    }
  }

  return { path: null, version: null, detectedAt: now, confirmed: false }
}

/** Load saved paths from disk */
async function loadSavedPaths(): Promise<AgentPathsConfig | null> {
  try {
    const raw = await fs.readFile(PATHS_FILE, 'utf8')
    return JSON.parse(raw) as AgentPathsConfig
  } catch {
    return null
  }
}

/** Prime in-memory cache from disk without probing binaries or shell PATH */
export async function initializeAgentPathsCache(): Promise<AgentPathsConfig | null> {
  if (cachedPaths) return cachedPaths
  const saved = await loadSavedPaths()
  if (!saved) return null

  // Re-resolve each saved path so stale entries (e.g. a Windows npm shim) get
  // promoted to a spawn-able native binary on the next app launch. Node's
  // spawn() on Windows can only execute a native .exe directly; .cmd/.bat
  // require shell:true, which most SDKs (e.g. Claude) don't set — so if the
  // saved path isn't already an .exe, re-query PATH to look for one.
  let mutated = false
  for (const key of ['claude', 'codex', 'opencode', 'openclaw', 'hermes'] as const) {
    const entry = saved[key]
    if (!entry?.path) continue

    const resolved = await resolveExecutablePath(entry.path)
    let best = resolved && resolved !== entry.path ? resolved : null

    if (process.platform === 'win32' && (!resolved || !/\.exe$/i.test(resolved))) {
      const fromWhich = whichSync(key)
      if (fromWhich && /\.exe$/i.test(fromWhich)) best = fromWhich
    }

    if (best && best !== entry.path) {
      entry.path = best
      mutated = true
    }
  }

  cachedPaths = saved
  if (mutated) await savePaths(saved).catch(() => { /* best-effort */ })
  return cachedPaths
}

/** Save paths to disk */
async function savePaths(config: AgentPathsConfig): Promise<void> {
  await fs.mkdir(CONTEX_HOME, { recursive: true })
  await fs.writeFile(PATHS_FILE, JSON.stringify(config, null, 2))
  cachedPaths = config
}

/** Run full detection for all agents */
export async function detectAllAgents(): Promise<AgentPathsConfig> {
  console.log('[AgentPaths] Detecting agent binaries...')
  const shellPath = getShellPath()

  const [claude, codex, opencode, openclaw, hermes] = await Promise.all([
    detectBinary('claude'),
    detectBinary('codex'),
    detectBinary('opencode'),
    detectBinary('openclaw'),
    detectBinary('hermes'),
  ])

  // Merge with any previously confirmed paths
  const saved = await loadSavedPaths()

  const merge = (detected: AgentPathEntry, savedEntry?: AgentPathEntry): AgentPathEntry => {
    if (savedEntry?.confirmed && savedEntry.path) {
      return { ...detected, path: savedEntry.path, confirmed: true }
    }
    return detected
  }

  const config: AgentPathsConfig = {
    claude: merge(claude, saved?.claude),
    codex: merge(codex, saved?.codex),
    opencode: merge(opencode, saved?.opencode),
    openclaw: merge(openclaw, saved?.openclaw),
    hermes: merge(hermes, saved?.hermes),
    shellPath,
    updatedAt: new Date().toISOString(),
  }

  // Re-verify confirmed paths still exist
  for (const key of ['claude', 'codex', 'opencode', 'openclaw', 'hermes'] as const) {
    const entry = config[key]
    if (entry.path && entry.confirmed) {
      const resolved = await resolveExecutablePath(entry.path)
      if (!resolved) {
        console.log(`[AgentPaths] Previously confirmed ${key} at ${entry.path} no longer exists, re-detecting`)
        config[key] = await detectBinary(key)
      } else if (resolved !== entry.path) {
        // Update path if it resolved to a different name (e.g. added .exe)
        entry.path = resolved
      }
    }
  }

  await savePaths(config)

  const found = [
    config.claude.path ? `claude=${config.claude.path}` : null,
    config.codex.path ? `codex=${config.codex.path}` : null,
    config.opencode.path ? `opencode=${config.opencode.path}` : null,
    config.openclaw.path ? `openclaw=${config.openclaw.path}` : null,
    config.hermes.path ? `hermes=${config.hermes.path}` : null,
  ].filter(Boolean).join(', ')
  console.log(`[AgentPaths] Detection complete: ${found || 'none found'}`)

  return config
}

/** Get the resolved path for an agent, or null */
export function getAgentPath(agentId: 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes'): string | null {
  return cachedPaths?.[agentId]?.path ?? null
}

/** Get the real shell PATH for spawning subprocesses */
export function getShellEnvPath(): string | null {
  return cachedPaths?.shellPath ?? null
}

/** Get the full config (for renderer) */
export function getAgentPathsConfig(): AgentPathsConfig | null {
  return cachedPaths
}

/** Register IPC handlers */
export function registerAgentPathsIPC(): void {
  ipcMain.handle('agentPaths:get', () => cachedPaths)

  ipcMain.handle('agentPaths:detect', async () => detectAllAgents())

  ipcMain.handle('agentPaths:set', async (_, agentId: string, inputPath: string | null) => {
    if (!cachedPaths) return null
    const key = agentId as 'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes'
    if (!(key in cachedPaths)) return null

    let resolvedPath: string | null = null
    let version: string | null = null
    if (inputPath) {
      // Normalize path separators
      const normalized = inputPath.replace(/\//g, process.platform === 'win32' ? '\\' : '/')
      resolvedPath = await resolveExecutablePath(normalized)
      if (!resolvedPath) {
        return { error: `Not found: ${inputPath}` }
      }
      version = getVersionSync(resolvedPath)
    }

    cachedPaths[key] = {
      path: resolvedPath,
      version,
      detectedAt: new Date().toISOString(),
      confirmed: true,
    }
    cachedPaths.updatedAt = new Date().toISOString()
    await savePaths(cachedPaths)
    return cachedPaths
  })

  ipcMain.handle('agentPaths:needsSetup', () => {
    if (!cachedPaths) return true
    const { claude, codex, opencode, openclaw, hermes } = cachedPaths
    return !claude.confirmed && !codex.confirmed && !opencode.confirmed && !openclaw.confirmed && !hermes.confirmed
  })

  ipcMain.handle('agentPaths:confirmAll', async () => {
    if (!cachedPaths) return null
    for (const key of ['claude', 'codex', 'opencode', 'openclaw', 'hermes'] as const) {
      cachedPaths[key].confirmed = true
    }
    cachedPaths.updatedAt = new Date().toISOString()
    await savePaths(cachedPaths)
    return cachedPaths
  })
}
