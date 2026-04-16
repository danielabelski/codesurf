import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import type { ToolPermissionDecisionScope, ToolPermissionGrant, ToolPermissionStore } from '../shared/types'
import { CONTEX_HOME } from './paths'

const PERMISSIONS_PATH = join(CONTEX_HOME, 'permissions.json')
const PERMISSIONS_VERSION = 1

const sessionGrants = new Map<string, ToolPermissionGrant>()

export interface ToolPermissionRequest {
  provider: string
  toolName: string
  title?: string | null
  description?: string | null
  blockedPath?: string | null
  workspaceDir?: string | null
}

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true })
}

function atomicWriteJson(filePath: string, value: unknown): void {
  ensureDir(dirname(filePath))
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tempPath, filePath)
}

function normalizeWorkspaceDir(workspaceDir?: string | null): string | null {
  const trimmed = String(workspaceDir ?? '').trim()
  if (!trimmed) return null
  try {
    return resolve(trimmed)
  } catch {
    return trimmed
  }
}

function normalizeStore(raw: unknown): ToolPermissionStore {
  const grants = Array.isArray((raw as ToolPermissionStore | null)?.grants)
    ? (raw as ToolPermissionStore).grants.filter((grant): grant is ToolPermissionGrant => {
        return Boolean(
          grant
          && typeof grant.id === 'string'
          && grant.id
          && typeof grant.provider === 'string'
          && grant.provider
          && typeof grant.toolName === 'string'
          && grant.toolName
          && grant.action === 'allow'
          && (grant.scope === 'session' || grant.scope === 'today' || grant.scope === 'forever')
          && typeof grant.createdAt === 'string'
        )
      })
    : []

  return {
    version: PERMISSIONS_VERSION,
    grants,
  }
}

function readPersistedStore(): ToolPermissionStore {
  try {
    return normalizeStore(JSON.parse(readFileSync(PERMISSIONS_PATH, 'utf8')))
  } catch {
    return { version: PERMISSIONS_VERSION, grants: [] }
  }
}

function writePersistedStore(store: ToolPermissionStore): void {
  atomicWriteJson(PERMISSIONS_PATH, store)
}

function isGrantExpired(grant: ToolPermissionGrant): boolean {
  if (!grant.expiresAt) return false
  const expiry = Date.parse(grant.expiresAt)
  return Number.isFinite(expiry) && expiry <= Date.now()
}

function pruneExpiredPersistedGrants(store: ToolPermissionStore): ToolPermissionStore {
  const next = {
    ...store,
    grants: store.grants.filter(grant => !isGrantExpired(grant)),
  }
  if (next.grants.length !== store.grants.length) {
    writePersistedStore(next)
  }
  return next
}

function purgeExpiredSessionGrants(): void {
  for (const [key, grant] of sessionGrants.entries()) {
    if (isGrantExpired(grant)) sessionGrants.delete(key)
  }
}

function makeGrantId(): string {
  return `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function endOfTodayIso(): string {
  const end = new Date()
  end.setHours(23, 59, 59, 999)
  return end.toISOString()
}

function matchesGrant(grant: ToolPermissionGrant, request: ToolPermissionRequest): boolean {
  if (grant.provider !== request.provider) return false
  if (grant.toolName !== request.toolName) return false
  const requestedWorkspace = normalizeWorkspaceDir(request.workspaceDir)
  return (grant.workspaceDir ?? null) === requestedWorkspace
}

function buildGrant(request: ToolPermissionRequest, scope: Exclude<ToolPermissionDecisionScope, 'once'>): ToolPermissionGrant {
  return {
    id: makeGrantId(),
    provider: request.provider,
    toolName: request.toolName,
    action: 'allow',
    scope,
    workspaceDir: normalizeWorkspaceDir(request.workspaceDir),
    title: request.title ?? null,
    description: request.description ?? null,
    blockedPath: request.blockedPath ?? null,
    createdAt: new Date().toISOString(),
    expiresAt: scope === 'today' ? endOfTodayIso() : null,
  }
}

function persistGrant(request: ToolPermissionRequest, scope: Exclude<ToolPermissionDecisionScope, 'once' | 'session'>): ToolPermissionGrant {
  const store = pruneExpiredPersistedGrants(readPersistedStore())
  const nextGrant = buildGrant(request, scope)
  const filtered = store.grants.filter(grant => !matchesGrant(grant, request))
  const nextStore = { ...store, grants: [nextGrant, ...filtered] }
  writePersistedStore(nextStore)
  return nextGrant
}

function storeSessionGrant(request: ToolPermissionRequest): ToolPermissionGrant {
  const nextGrant = buildGrant(request, 'session')
  const key = `${nextGrant.provider}::${nextGrant.toolName}::${nextGrant.workspaceDir ?? ''}`
  sessionGrants.set(key, nextGrant)
  return nextGrant
}

export function listPermissionGrants(): ToolPermissionGrant[] {
  purgeExpiredSessionGrants()
  const persisted = pruneExpiredPersistedGrants(readPersistedStore()).grants
  const session = Array.from(sessionGrants.values())
  return [...session, ...persisted].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

export function clearPermissionGrant(id: string): ToolPermissionGrant[] {
  for (const [key, grant] of sessionGrants.entries()) {
    if (grant.id === id) {
      sessionGrants.delete(key)
    }
  }

  const store = readPersistedStore()
  const nextStore = {
    ...store,
    grants: store.grants.filter(grant => grant.id !== id),
  }
  if (nextStore.grants.length !== store.grants.length) {
    writePersistedStore(nextStore)
  }

  return listPermissionGrants()
}

export function clearAllPermissionGrants(): ToolPermissionGrant[] {
  sessionGrants.clear()
  writePersistedStore({ version: PERMISSIONS_VERSION, grants: [] })
  return []
}

export function resolveStoredPermission(request: ToolPermissionRequest): boolean {
  purgeExpiredSessionGrants()
  const persisted = pruneExpiredPersistedGrants(readPersistedStore()).grants
  const grant = [...sessionGrants.values(), ...persisted].find(candidate => matchesGrant(candidate, request))
  return Boolean(grant)
}

async function promptForPermission(request: ToolPermissionRequest): Promise<ToolPermissionDecisionScope | 'deny'> {
  const detailLines = [
    request.description?.trim() || '',
    request.blockedPath ? `Path: ${request.blockedPath}` : '',
    normalizeWorkspaceDir(request.workspaceDir) ? `Workspace: ${normalizeWorkspaceDir(request.workspaceDir)}` : '',
  ].filter(Boolean)

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed()) ?? null
  const dialogOptions: MessageBoxOptions = {
    type: 'question',
    buttons: ['Deny', 'Allow Once', 'This Session', 'All Day', 'Always'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
    title: 'Tool Permission',
    message: request.title?.trim() || `${request.provider} wants to run ${request.toolName}`,
    detail: detailLines.join('\n'),
  }
  const { response } = win
    ? await dialog.showMessageBox(win, dialogOptions)
    : await dialog.showMessageBox(dialogOptions)

  switch (response) {
    case 1: return 'once'
    case 2: return 'session'
    case 3: return 'today'
    case 4: return 'forever'
    default: return 'deny'
  }
}

export async function requestToolPermission(request: ToolPermissionRequest, interactive: boolean): Promise<boolean> {
  if (resolveStoredPermission(request)) return true
  if (!interactive) return false

  const decision = await promptForPermission(request)
  if (decision === 'deny') return false
  if (decision === 'session') {
    storeSessionGrant(request)
  } else if (decision === 'today' || decision === 'forever') {
    persistGrant(request, decision)
  }
  return true
}

export function getPermissionsStorePath(): string {
  if (!existsSync(dirname(PERMISSIONS_PATH))) ensureDir(dirname(PERMISSIONS_PATH))
  return PERMISSIONS_PATH
}
