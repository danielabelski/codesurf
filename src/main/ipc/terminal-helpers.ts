import { homedir } from 'os'
import { join } from 'path'
import { CODESURF_HOME } from '../paths.ts'

// --- Security: binary allowlist for pty spawn (SEC-04) ---
export const ALLOWED_SHELLS = new Set([
  '/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/bash', '/usr/bin/zsh',
  '/usr/local/bin/bash', '/usr/local/bin/zsh', '/usr/local/bin/fish',
  '/opt/homebrew/bin/bash', '/opt/homebrew/bin/zsh', '/opt/homebrew/bin/fish',
])

// Windows shells
if (process.platform === 'win32') {
  ALLOWED_SHELLS.add('powershell.exe')
  ALLOWED_SHELLS.add('pwsh.exe')
  ALLOWED_SHELLS.add('cmd.exe')
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  ALLOWED_SHELLS.add(`${sysRoot}\\System32\\cmd.exe`)
  ALLOWED_SHELLS.add(`${sysRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
  // Add pwsh if installed
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  ALLOWED_SHELLS.add(`${programFiles}\\PowerShell\\7\\pwsh.exe`)
}

// Also allow the user's default shell
const userShell = process.env.SHELL || (process.platform === 'win32' ? process.env.COMSPEC : undefined)
if (userShell) ALLOWED_SHELLS.add(userShell)

// Known agent CLIs that are allowed to be spawned directly
export const ALLOWED_AGENT_BINS = ['claude', 'codex', 'aider', 'opencode', 'openclaw', 'hermes']

export function isAllowedBinary(bin: string): boolean {
  // Allow known shells
  if (ALLOWED_SHELLS.has(bin)) return true
  // Allow known agent CLIs (matched by basename, handle both / and \ separators,
  // strip any Windows shim extension so .exe / .cmd / .bat / .ps1 all match)
  const base = (bin.split(/[/\\]/).pop() || '').replace(/\.(exe|cmd|bat|ps1)$/i, '')
  if (ALLOWED_AGENT_BINS.includes(base)) return true
  return false
}

export function expandHome(arg: string): string {
  if (!arg.startsWith('~')) return arg
  const home = homedir()
  if (arg === '~') return home

  // Resolve legacy ~/.codesurf/ and current ~/.codesurf/ paths to CODESURF_HOME
  if (arg.startsWith('~/.codesurf/')) {
    return join(CODESURF_HOME, arg.slice('~/.codesurf/'.length))
  }
  if (arg.startsWith('~\\.codesurf\\')) {
    return join(CODESURF_HOME, arg.slice('~\\.codesurf\\'.length))
  }
  if (arg.startsWith('~/.codesurf/')) {
    return join(CODESURF_HOME, arg.slice('~/.codesurf/'.length))
  }

  if (arg.startsWith('~/') || arg.startsWith('~\\')) return join(home, arg.slice(2))
  return arg
}

// Build a sanitized spawn environment — keep essential vars, strip known secrets.
// This prevents leaking API keys and tokens from the Electron main process to
// every spawned terminal and agent subprocess.
export const SPAWN_ENV_ALLOWLIST = new Set([
  'PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TEMP', 'TMP', 'DISPLAY', 'EDITOR', 'VISUAL',
  'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'NODE_PATH', 'NVM_DIR', 'NVM_BIN', 'FNM_DIR', 'VOLTA_HOME',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'SSH_AUTH_SOCK', 'GPG_AGENT_INFO',
  // Platform essentials
  ...(process.platform === 'win32' ? [
    'SystemRoot', 'COMSPEC', 'ProgramFiles', 'ProgramFiles(x86)',
    'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'USERNAME', 'COMPUTERNAME',
    'HOMEDRIVE', 'HOMEPATH', 'PATHEXT', 'WINDIR',
  ] : []),
])
export const SPAWN_ENV_DENYLIST_RE = /(_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY|_CREDENTIALS)$/i

export function buildSafeSpawnEnv(
  extra: Record<string, string> = {},
  sourceEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue
    if (SPAWN_ENV_ALLOWLIST.has(key) && !SPAWN_ENV_DENYLIST_RE.test(key)) {
      env[key] = value
    }
  }
  return { ...env, ...extra }
}
