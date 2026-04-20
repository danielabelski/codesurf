import { homedir } from 'os'
import { join } from 'path'

export const APP_NAME = 'CodeSurf'
export const APP_ID = 'com.huggiapps.codesurf'
export const CONTEX_HOME_DIRNAME = '.codesurf'
export const LEGACY_HOME_DIRNAME = '.contex'
export const TILE_CONTEXT_DIRNAME = '.contex'
export const LEGACY_TILE_CONTEXT_DIRNAME = '.collab'

export const CONTEX_HOME = join(homedir(), CONTEX_HOME_DIRNAME)
export const LEGACY_HOME = join(homedir(), LEGACY_HOME_DIRNAME)
export const WORKSPACES_DIR = join(CONTEX_HOME, 'workspaces')
export const JOBS_DIR = join(CONTEX_HOME, 'jobs')
export const TIMELINES_DIR = join(CONTEX_HOME, 'timelines')

export function workspaceTileDir(workspacePath: string, tileId: string): string {
  return join(workspacePath, TILE_CONTEXT_DIRNAME, tileId)
}

export function legacyWorkspaceTileDir(workspacePath: string, tileId: string): string {
  return join(workspacePath, LEGACY_TILE_CONTEXT_DIRNAME, tileId)
}

export function workspaceTileContextDir(workspacePath: string, tileId: string): string {
  return join(workspaceTileDir(workspacePath, tileId), 'context')
}

export function legacyWorkspaceTileContextDir(workspacePath: string, tileId: string): string {
  return join(legacyWorkspaceTileDir(workspacePath, tileId), 'context')
}

export function workspaceTileMessagesDir(workspacePath: string, tileId: string): string {
  return join(workspaceTileDir(workspacePath, tileId), 'messages')
}

export function workspaceTileMessageMailboxDir(workspacePath: string, tileId: string, mailbox: string): string {
  return join(workspaceTileMessagesDir(workspacePath, tileId), mailbox)
}
