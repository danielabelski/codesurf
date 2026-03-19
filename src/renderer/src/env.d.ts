/// <reference types="vite/client" />

import type { Workspace } from '../../shared/types'

interface ElectronAPI {
  workspace: {
    list(): Promise<Workspace[]>
    create(name: string): Promise<Workspace>
    setActive(id: string): Promise<void>
    getActive(): Promise<Workspace | null>
    delete(id: string): Promise<void>
  }
  fs: {
    readDir(path: string): Promise<Array<{ name: string; path: string; isDir: boolean; ext: string }>>
    readFile(path: string): Promise<string>
    writeFile(path: string, content: string): Promise<void>
    createFile(path: string): Promise<void>
    createDir(path: string): Promise<void>
    deleteFile(path: string): Promise<void>
    delete(path: string): Promise<void>
    rename(oldPath: string, newPath: string): Promise<void>
    renameFile(oldPath: string, newPath: string): Promise<void>
    basename(path: string): Promise<string>
    revealInFinder?(path: string): Promise<void>
    writeBrief(cardId: string, content: string): Promise<string>
    watch(dirPath: string, callback: () => void): () => void
  }
  git?: {
    status(dirPath: string): Promise<{ isRepo: boolean; root: string; files: Array<{ path: string; status: string }> }>
  }
  stream?: {
    start(req: { cardId: string; agentId: string; url: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<void>
    stop(cardId: string): Promise<void>
    onChunk(cb: (event: { cardId: string; type: string; text?: string; toolName?: string; error?: string }) => void): () => void
  }
  mcp?: {
    getPort(): Promise<number>
    getConfig(): Promise<unknown>
    saveServers(servers: Record<string, unknown>): Promise<void>
    getWorkspaceServers(workspaceId: string): Promise<Record<string, unknown>>
    saveWorkspaceServers(workspaceId: string, servers: Record<string, unknown>): Promise<void>
    getMergedConfig(workspaceId: string): Promise<unknown>
    onKanban(cb: (event: string, data: unknown) => void): () => void
    onInject(cb: (cardId: string, message: string, appendNewline: boolean) => void): () => void
    inject(cardId: string, message: string): Promise<void>
  }
  shell?: {
    openExternal(url: string): Promise<void>
  }
  window?: {
    new(): Promise<void>
    newTab(): Promise<void>
  }
  canvas: {
    load(workspaceId: string): Promise<import('../../shared/types').CanvasState | null>
    save(workspaceId: string, state: import('../../shared/types').CanvasState): Promise<void>
  }
  kanban?: {
    load(workspaceId: string, tileId: string): Promise<{ columns: Array<{ id: string; title: string }>; cards: import('./components/KanbanCard').KanbanCardData[] } | null>
    save(workspaceId: string, tileId: string, state: { columns: Array<{ id: string; title: string }>; cards: import('./components/KanbanCard').KanbanCardData[] }): Promise<void>
  }
  terminal: {
    create(tileId: string, workspaceDir: string, launchBin?: string, launchArgs?: string[]): Promise<{ cols: number; rows: number }>
    write(tileId: string, data: string): Promise<void>
    resize(tileId: string, cols: number, rows: number): Promise<void>
    destroy(tileId: string): Promise<void>
    onData(tileId: string, cb: (data: string) => void): () => void
    onActive(tileId: string, cb: () => void): () => void
  }
  browserTile: {
    sync(payload: { tileId: string; url: string; mode: 'desktop' | 'mobile'; zIndex: number; visible: boolean; bounds: { left: number; top: number; width: number; height: number } }): Promise<unknown>
    command(payload: { tileId: string; command: 'back' | 'forward' | 'reload' | 'stop' | 'home' | 'navigate' | 'mode'; url?: string; mode?: 'desktop' | 'mobile' }): Promise<unknown>
    destroy(tileId: string): Promise<void>
    onEvent(cb: (event: { tileId: string; currentUrl: string; canGoBack: boolean; canGoForward: boolean; isLoading: boolean; mode: 'desktop' | 'mobile' }) => void): () => void
  }
  agents: {
    detect(): Promise<Array<{ id: string; label: string; cmd: string; path?: string; version?: string; available: boolean }>>
  }
  updater: {
    check(): Promise<void>
    download(): Promise<void>
  }
  settings: {
    get(): Promise<import('../../shared/types').AppSettings>
    set(settings: import('../../shared/types').AppSettings): Promise<import('../../shared/types').AppSettings>
  }
  bus: {
    publish(channel: string, type: string, source: string, payload: Record<string, unknown>): Promise<import('../../shared/types').BusEvent>
    subscribe(channel: string, subscriberId: string, callback: (event: import('../../shared/types').BusEvent) => void): () => void
    unsubscribeAll(subscriberId: string): Promise<void>
    history(channel: string, limit?: number): Promise<import('../../shared/types').BusEvent[]>
    channelInfo(channel: string): Promise<import('../../shared/types').ChannelInfo>
    unreadCount(channel: string, subscriberId: string): Promise<number>
    markRead(channel: string, subscriberId: string): Promise<void>
    onEvent(callback: (event: import('../../shared/types').BusEvent) => void): () => void
  }
}

declare global {
  interface Window {
    electron: ElectronAPI
  }

  // Allow <webview> tag in JSX (Electron webview)
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        useragent?: string
        partition?: string
        allowpopups?: string | boolean
        ref?: React.Ref<Electron.WebviewTag>
        style?: React.CSSProperties
      }
    }
  }
}
