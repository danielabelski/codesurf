import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types.ts'

export type ElectrobunInvokeArgs = unknown[]

export interface ElectrobunInvokeCall {
  channel: string
  args: ElectrobunInvokeArgs
}

export type ElectrobunInvoke = (channel: string, args: ElectrobunInvokeArgs) => Promise<unknown>
export type ElectrobunEventHandler = (payload: unknown) => void
export type ElectrobunUnsubscribe = () => void

export interface ElectrobunEventHub {
  on(channel: string, handler: ElectrobunEventHandler): ElectrobunUnsubscribe
  emit(channel: string, payload: unknown): void
}

type EventWithChannel = {
  channel?: string
  payload?: unknown
}

type FacadeOptions = {
  invoke: ElectrobunInvoke
  platform: string
  homedir: string
  eventHub?: ElectrobunEventHub
}

export function createElectrobunEventHub(): ElectrobunEventHub {
  const handlers = new Map<string, Set<ElectrobunEventHandler>>()

  return {
    on(channel, handler) {
      const set = handlers.get(channel) ?? new Set<ElectrobunEventHandler>()
      set.add(handler)
      handlers.set(channel, set)
      return () => {
        set.delete(handler)
        if (set.size === 0) handlers.delete(channel)
      }
    },
    emit(channel, payload) {
      handlers.get(channel)?.forEach(handler => handler(payload))
      if (channel !== '*') handlers.get('*')?.forEach(handler => handler(payload))
    },
  }
}

function cloneDefaultSettings(): AppSettings {
  if (typeof structuredClone === 'function') {
    return structuredClone(DEFAULT_SETTINGS)
  }
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings
}

export function getDefaultElectrobunInvokeResponse(channel: string): unknown {
  if (channel === 'settings:get') return cloneDefaultSettings()
  if (channel === 'settings:set') return cloneDefaultSettings()
  if (channel === 'settings:getRawJson') return JSON.stringify({ version: 1, settings: cloneDefaultSettings() }, null, 2)
  if (channel === 'settings:setRawJson') return { ok: true, settings: cloneDefaultSettings() }
  if (channel === 'settings:validateGenerationProvider') {
    return { ok: false, message: 'Electrobun runtime did not respond to provider validation.', models: [], imageModels: [], videoModels: [] }
  }

  if (
    channel === 'workspace:list'
    || channel === 'workspace:listProjects'
    || channel === 'canvas:listSessions'
    || channel === 'canvas:listCheckpoints'
    || channel === 'canvas:queuedMessages:listActive'
    || channel === 'chat:opencodeModels'
    || channel === 'chat:openclawAgents'
    || channel === 'execution:listHosts'
    || channel === 'dreaming:listRuns'
    || channel === 'extensions:list'
    || channel === 'ext:list'
    || channel === 'ext:list-sidebar'
    || channel === 'ext:list-tiles'
    || channel === 'ext:list-chat-surfaces'
    || channel === 'ext:context-menu-items'
    || channel === 'permissions:list'
  ) return []

  if (
    channel === 'workspace:getActive'
    || channel === 'workspace:openFolder'
    || channel === 'canvas:load'
    || channel === 'canvas:loadTileState'
    || channel === 'canvas:getSessionState'
    || channel === 'mcp:getConfig'
    || channel === 'mcp:getMergedConfig'
    || channel === 'extensions:tileEntry'
    || channel === 'extensions:chatSurfaceEntry'
    || channel === 'ext:tile-entry'
    || channel === 'ext:chat-surface-entry'
  ) return null

  if (channel === 'appearance:shouldUseDark') return true
  if (channel === 'window:isFresh') return false
  if (channel === 'window:list') return []
  if (channel === 'window:getCurrentId') return 1
  if (channel === 'zoom:getLevel') return 0
  if (channel === 'mcp:getPort') return null
  if (channel === 'mcp:getWorkspaceServers') return {}
  if (channel === 'mcp:saveWorkspaceServers') return {}
  if (channel === 'system:memStats') return { heapUsed: 0, heapTotal: 0, rss: 0 }
  if (channel === 'system:daemonStatus') return null
  if (channel === 'system:daemonSummary') return null
  if (channel === 'db:status') return { ok: false, runtime: 'electrobun-fallback', message: 'Electrobun runtime DB handler was unavailable.' }
  if (channel === 'jobs:recent') return { jobs: [], total: 0, limit: 50, offset: 0 }
  if (channel === 'updater:check') return { ok: true, status: 'disabled-electrobun-runtime', updateAvailable: false }
  if (channel === 'chat:send') return { ok: false, error: 'Electrobun runtime chat handler was unavailable.' }
  if (channel === 'chat:writeTempAttachment') return { ok: false, error: 'Electrobun runtime attachment handler was unavailable.' }
  if (channel === 'localProxy:getStatus') return { running: false }
  if (channel === 'localProxy:probeBackends') return []
  if (channel === 'dreaming:status') return { running: false, auto: null, lastRun: null }
  if (channel === 'fs:stat') return null
  if (channel === 'fs:isProbablyTextFile') return false
  if (channel === 'fs:readDir') return []
  if (channel === 'fs:readFile') return ''
  if (channel === 'git:status') return { isRepo: false, root: '', files: [] }
  if (channel === 'git:branches') return { current: null, branches: [] }
  if (channel === 'agents:detect') return []
  if (channel === 'agentPaths:get') return {}
  if (channel === 'agentPaths:detect') return {}
  if (channel === 'agentPaths:needsSetup') return false
  if (channel === 'skills:getDefaultTargetDir') return ''
  if (channel === 'skills:inspect') return { ok: false, error: 'Electrobun runtime skill inspection handler was unavailable.' }

  if (
    channel.startsWith('bus:')
    || channel.startsWith('terminal:')
    || channel.startsWith('canvas:')
    || channel.startsWith('workspace:')
    || channel.startsWith('fs:')
    || channel.startsWith('collab:')
    || channel.startsWith('relay:')
    || channel.startsWith('ext:')
    || channel.startsWith('extensions:')
    || channel.startsWith('tileContext:')
    || channel.startsWith('activity:')
    || channel.startsWith('permissions:')
    || channel.startsWith('execution:')
    || channel.startsWith('dreaming:')
    || channel.startsWith('system:')
    || channel.startsWith('window:')
    || channel.startsWith('appearance:')
    || channel.startsWith('mcp:')
  ) return true

  return null
}

function channelMatches(pattern: string, channel: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith(':*')) return channel.startsWith(pattern.slice(0, -1))
  return pattern === channel
}

function makeInvoker(invoke: ElectrobunInvoke, channel: string) {
  return (...args: ElectrobunInvokeArgs) => invoke(channel, args)
}

function makeEventListener(eventHub: ElectrobunEventHub, channel: string) {
  return (callback: (payload: any) => void) => eventHub.on(channel, payload => callback(payload))
}

function makeFilteredBusListener(eventHub: ElectrobunEventHub, pattern: string, callback: (payload: any) => void) {
  return eventHub.on('bus:event', payload => {
    const event = payload as EventWithChannel
    if (event?.channel && channelMatches(pattern, event.channel)) callback(event)
  })
}

export function createElectrobunElectronFacade(options: FacadeOptions): any {
  const eventHub = options.eventHub ?? createElectrobunEventHub()
  const invoke = options.invoke
  let zoomLevel = 0

  return {
    appearance: {
      shouldUseDark: makeInvoker(invoke, 'appearance:shouldUseDark'),
      setThemeSource: makeInvoker(invoke, 'appearance:setThemeSource'),
      onUpdated: makeEventListener(eventHub, 'appearance:updated'),
    },
    workspace: {
      list: makeInvoker(invoke, 'workspace:list'),
      listProjects: makeInvoker(invoke, 'workspace:listProjects'),
      create: makeInvoker(invoke, 'workspace:create'),
      createWithPath: makeInvoker(invoke, 'workspace:createWithPath'),
      createFromFolder: makeInvoker(invoke, 'workspace:createFromFolder'),
      addProjectFolder: makeInvoker(invoke, 'workspace:addProjectFolder'),
      removeProjectFolder: makeInvoker(invoke, 'workspace:removeProjectFolder'),
      renameProject: makeInvoker(invoke, 'workspace:renameProject'),
      createProjectWorktree: makeInvoker(invoke, 'workspace:createProjectWorktree'),
      openFolder: makeInvoker(invoke, 'workspace:openFolder'),
      delete: makeInvoker(invoke, 'workspace:delete'),
      setActive: makeInvoker(invoke, 'workspace:setActive'),
      getActive: makeInvoker(invoke, 'workspace:getActive'),
    },
    fs: {
      readDir: makeInvoker(invoke, 'fs:readDir'),
      readFile: makeInvoker(invoke, 'fs:readFile'),
      writeFile: makeInvoker(invoke, 'fs:writeFile'),
      createFile: makeInvoker(invoke, 'fs:createFile'),
      createDir: makeInvoker(invoke, 'fs:createDir'),
      deleteFile: makeInvoker(invoke, 'fs:deleteFile'),
      renameFile: makeInvoker(invoke, 'fs:renameFile'),
      watch: (dirPath: string, callback: () => void) => {
        void invoke('fs:watchStart', [dirPath])
        const off = eventHub.on(`fs:watch:${dirPath}`, () => callback())
        return () => {
          off()
          void invoke('fs:watchStop', [dirPath])
        }
      },
      revealInFinder: makeInvoker(invoke, 'fs:revealInFinder'),
      writeBrief: makeInvoker(invoke, 'fs:writeBrief'),
      stat: makeInvoker(invoke, 'fs:stat'),
      isProbablyTextFile: makeInvoker(invoke, 'fs:isProbablyTextFile'),
      copyIntoDir: makeInvoker(invoke, 'fs:copyIntoDir'),
      selectDir: makeInvoker(invoke, 'workspace:openFolder'),
    },
    skills: {
      inspect: makeInvoker(invoke, 'skills:inspect'),
      install: makeInvoker(invoke, 'skills:install'),
      getDefaultTargetDir: makeInvoker(invoke, 'skills:getDefaultTargetDir'),
      ready: makeInvoker(invoke, 'skills:rendererReady'),
      onFileOpened: makeEventListener(eventHub, 'skill:file-opened'),
    },
    tileContext: {
      get: makeInvoker(invoke, 'tileContext:get'),
      getAll: makeInvoker(invoke, 'tileContext:getAll'),
      set: makeInvoker(invoke, 'tileContext:set'),
      delete: makeInvoker(invoke, 'tileContext:delete'),
      onChanged: (tileId: string, callback: (data: any) => void) => eventHub.on('tileContext:changed', payload => {
        const data = payload as { tileId?: string }
        if (data?.tileId === tileId) callback(data)
      }),
    },
    image: {
      edit: makeInvoker(invoke, 'image:edit'),
    },
    extActions: {
      onAction: makeEventListener(eventHub, 'ext:action'),
    },
    canvas: {
      load: makeInvoker(invoke, 'canvas:load'),
      save: makeInvoker(invoke, 'canvas:save'),
      loadTileState: makeInvoker(invoke, 'canvas:loadTileState'),
      saveTileState: makeInvoker(invoke, 'canvas:saveTileState'),
      clearTileState: makeInvoker(invoke, 'canvas:clearTileState'),
      deleteTileArtifacts: makeInvoker(invoke, 'canvas:deleteTileArtifacts'),
      listSessions: makeInvoker(invoke, 'canvas:listSessions'),
      onSessionsChanged: makeEventListener(eventHub, 'canvas:sessionsChanged'),
      getSessionState: makeInvoker(invoke, 'canvas:getSessionState'),
      deleteSession: makeInvoker(invoke, 'canvas:deleteSession'),
      setSessionArchived: makeInvoker(invoke, 'canvas:setSessionArchived'),
      renameSession: makeInvoker(invoke, 'canvas:renameSession'),
      generateSessionTitle: makeInvoker(invoke, 'canvas:generateSessionTitle'),
      listCheckpoints: makeInvoker(invoke, 'canvas:listCheckpoints'),
      restoreCheckpoint: makeInvoker(invoke, 'canvas:restoreCheckpoint'),
      queuedMessages: {
        append: makeInvoker(invoke, 'canvas:queuedMessages:append'),
        listActive: makeInvoker(invoke, 'canvas:queuedMessages:listActive'),
      },
    },
    threads: {
      indexStatus: makeInvoker(invoke, 'threads:indexStatus'),
      reindex: makeInvoker(invoke, 'threads:reindex'),
      onIndexUpdated: makeEventListener(eventHub, 'threads:indexUpdated'),
    },
    kanban: {
      load: makeInvoker(invoke, 'kanban:load'),
      save: makeInvoker(invoke, 'kanban:save'),
    },
    terminal: {
      create: makeInvoker(invoke, 'terminal:create'),
      write: makeInvoker(invoke, 'terminal:write'),
      cd: makeInvoker(invoke, 'terminal:cd'),
      resize: makeInvoker(invoke, 'terminal:resize'),
      destroy: makeInvoker(invoke, 'terminal:destroy'),
      detach: makeInvoker(invoke, 'terminal:detach'),
      updatePeers: makeInvoker(invoke, 'terminal:update-peers'),
      onData: (tileId: string, callback: (data: string) => void) => eventHub.on(`terminal:data:${tileId}`, payload => callback(String(payload ?? ''))),
      onActive: (tileId: string, callback: () => void) => eventHub.on(`terminal:active:${tileId}`, () => callback()),
    },
    agents: {
      detect: makeInvoker(invoke, 'agents:detect'),
    },
    agentPaths: {
      get: makeInvoker(invoke, 'agentPaths:get'),
      detect: makeInvoker(invoke, 'agentPaths:detect'),
      set: makeInvoker(invoke, 'agentPaths:set'),
      needsSetup: makeInvoker(invoke, 'agentPaths:needsSetup'),
      confirmAll: makeInvoker(invoke, 'agentPaths:confirmAll'),
    },
    chat: {
      send: makeInvoker(invoke, 'chat:send'),
      resumeJob: makeInvoker(invoke, 'chat:resumeJob'),
      steer: makeInvoker(invoke, 'chat:steer'),
      stop: makeInvoker(invoke, 'chat:stop'),
      clearSession: makeInvoker(invoke, 'chat:clearSession'),
      opencodeModels: makeInvoker(invoke, 'chat:opencodeModels'),
      onOpencodeModelsUpdated: makeEventListener(eventHub, 'chat:opencodeModelsUpdated'),
      openclawAgents: makeInvoker(invoke, 'chat:openclawAgents'),
      selectFiles: makeInvoker(invoke, 'chat:selectFiles'),
      writeTempAttachment: makeInvoker(invoke, 'chat:writeTempAttachment'),
      answerUserQuestion: makeInvoker(invoke, 'chat:answerUserQuestion'),
      answerToolPermission: makeInvoker(invoke, 'chat:answerToolPermission'),
      setPermissionMode: makeInvoker(invoke, 'chat:setPermissionMode'),
      loadSessionHistory: makeInvoker(invoke, 'chat:loadSessionHistory'),
    },
    stream: {
      start: makeInvoker(invoke, 'stream:start'),
      stop: makeInvoker(invoke, 'stream:stop'),
      onChunk: makeEventListener(eventHub, 'agent:stream'),
    },
    git: {
      status: makeInvoker(invoke, 'git:status'),
      branches: makeInvoker(invoke, 'git:branches'),
      checkoutBranch: makeInvoker(invoke, 'git:checkoutBranch'),
      createBranch: makeInvoker(invoke, 'git:createBranch'),
    },
    window: {
      new: makeInvoker(invoke, 'window:new'),
      newTab: makeInvoker(invoke, 'window:newTab'),
      list: makeInvoker(invoke, 'window:list'),
      getCurrentId: makeInvoker(invoke, 'window:getCurrentId'),
      setTitle: makeInvoker(invoke, 'window:setTitle'),
      focusById: makeInvoker(invoke, 'window:focusById'),
      closeById: makeInvoker(invoke, 'window:closeById'),
      setSidebarCollapsed: makeInvoker(invoke, 'window:setSidebarCollapsed'),
      onListChanged: makeEventListener(eventHub, 'window:list-changed'),
      isFresh: makeInvoker(invoke, 'window:isFresh'),
      onNewTab: (callback: () => void) => eventHub.on('workspace:newTab', () => callback()),
    },
    app: {
      relaunch: makeInvoker(invoke, 'app:relaunch'),
    },
    execution: {
      listHosts: makeInvoker(invoke, 'execution:listHosts'),
      upsertHost: makeInvoker(invoke, 'execution:upsertHost'),
      deleteHost: makeInvoker(invoke, 'execution:deleteHost'),
      resolveTarget: makeInvoker(invoke, 'execution:resolveTarget'),
    },
    dreaming: {
      status: makeInvoker(invoke, 'dreaming:status'),
      listRuns: makeInvoker(invoke, 'dreaming:listRuns'),
      run: makeInvoker(invoke, 'dreaming:run'),
      cancel: makeInvoker(invoke, 'dreaming:cancel'),
    },
    shell: {
      openExternal: makeInvoker(invoke, 'shell:openExternal'),
    },
    browserTile: {
      sync: makeInvoker(invoke, 'browserTile:sync'),
      command: makeInvoker(invoke, 'browserTile:command'),
      destroy: makeInvoker(invoke, 'browserTile:destroy'),
      onEvent: makeEventListener(eventHub, 'browserTile:event'),
    },
    chromeSync: {
      listProfiles: makeInvoker(invoke, 'chromeSync:listProfiles'),
      getStatus: makeInvoker(invoke, 'chromeSync:getStatus'),
      syncCookies: makeInvoker(invoke, 'chromeSync:syncCookies'),
      getBookmarks: makeInvoker(invoke, 'chromeSync:getBookmarks'),
      searchHistory: makeInvoker(invoke, 'chromeSync:searchHistory'),
    },
    localProxy: {
      start: makeInvoker(invoke, 'localProxy:start'),
      stop: makeInvoker(invoke, 'localProxy:stop'),
      getStatus: makeInvoker(invoke, 'localProxy:getStatus'),
      probeBackends: makeInvoker(invoke, 'localProxy:probeBackends'),
    },
    settings: {
      get: makeInvoker(invoke, 'settings:get'),
      set: makeInvoker(invoke, 'settings:set'),
      getRawJson: makeInvoker(invoke, 'settings:getRawJson'),
      setRawJson: makeInvoker(invoke, 'settings:setRawJson'),
      validateGenerationProvider: makeInvoker(invoke, 'settings:validateGenerationProvider'),
    },
    permissions: {
      list: makeInvoker(invoke, 'permissions:list'),
      clear: makeInvoker(invoke, 'permissions:clear'),
      clearAll: makeInvoker(invoke, 'permissions:clearAll'),
    },
    jobs: {
      recent: makeInvoker(invoke, 'jobs:recent'),
    },
    updater: {
      check: makeInvoker(invoke, 'updater:check'),
      download: makeInvoker(invoke, 'updater:download'),
      quitAndInstall: makeInvoker(invoke, 'updater:quitAndInstall'),
    },
    mcp: {
      getPort: makeInvoker(invoke, 'mcp:getPort'),
      getConfig: makeInvoker(invoke, 'mcp:getConfig'),
      saveServers: makeInvoker(invoke, 'mcp:saveServers'),
      getWorkspaceServers: makeInvoker(invoke, 'mcp:getWorkspaceServers'),
      saveWorkspaceServers: makeInvoker(invoke, 'mcp:saveWorkspaceServers'),
      getMergedConfig: makeInvoker(invoke, 'mcp:getMergedConfig'),
      onKanban: (callback: (event: string, data: unknown) => void) => eventHub.on('mcp:kanban', payload => {
        const msg = payload as { event?: string, data?: unknown }
        callback(String(msg?.event ?? ''), msg?.data)
      }),
      onInject: (callback: (cardId: string, message: string, appendNewline: boolean) => void) => eventHub.on('mcp:inject', payload => {
        const msg = payload as { cardId?: string, message?: string, appendNewline?: boolean }
        callback(String(msg?.cardId ?? ''), String(msg?.message ?? ''), Boolean(msg?.appendNewline))
      }),
      inject: (cardId: string, message: string) => invoke('terminal:write', [cardId, `${message}\r`]),
    },
    activity: {
      upsert: makeInvoker(invoke, 'activity:upsert'),
      query: makeInvoker(invoke, 'activity:query'),
      byTile: makeInvoker(invoke, 'activity:byTile'),
      delete: makeInvoker(invoke, 'activity:delete'),
      clearTile: makeInvoker(invoke, 'activity:clearTile'),
      byAgent: makeInvoker(invoke, 'activity:byAgent'),
    },
    collab: {
      ensureDir: makeInvoker(invoke, 'collab:ensureDir'),
      writeObjective: makeInvoker(invoke, 'collab:writeObjective'),
      readObjective: makeInvoker(invoke, 'collab:readObjective'),
      writeSkills: makeInvoker(invoke, 'collab:writeSkills'),
      readSkills: makeInvoker(invoke, 'collab:readSkills'),
      writeState: makeInvoker(invoke, 'collab:writeState'),
      readState: makeInvoker(invoke, 'collab:readState'),
      addContext: makeInvoker(invoke, 'collab:addContext'),
      removeContext: makeInvoker(invoke, 'collab:removeContext'),
      listContext: makeInvoker(invoke, 'collab:listContext'),
      readContext: makeInvoker(invoke, 'collab:readContext'),
      listMessages: makeInvoker(invoke, 'collab:listMessages'),
      readMessage: makeInvoker(invoke, 'collab:readMessage'),
      sendMessage: makeInvoker(invoke, 'collab:sendMessage'),
      updateMessageStatus: makeInvoker(invoke, 'collab:updateMessageStatus'),
      moveMessage: makeInvoker(invoke, 'collab:moveMessage'),
      watchState: makeInvoker(invoke, 'collab:watchState'),
      unwatchState: makeInvoker(invoke, 'collab:unwatchState'),
      watchMessages: makeInvoker(invoke, 'collab:watchMessages'),
      unwatchMessages: makeInvoker(invoke, 'collab:unwatchMessages'),
      removeTileDir: makeInvoker(invoke, 'collab:removeTileDir'),
      pruneOrphanedTileDirs: makeInvoker(invoke, 'collab:pruneOrphanedTileDirs'),
      onStateChanged: makeEventListener(eventHub, 'collab:stateChanged'),
      onMessageChanged: makeEventListener(eventHub, 'collab:messageChanged'),
    },
    relay: {
      init: makeInvoker(invoke, 'relay:init'),
      syncWorkspace: makeInvoker(invoke, 'relay:syncWorkspace'),
      listParticipants: makeInvoker(invoke, 'relay:listParticipants'),
      listChannels: makeInvoker(invoke, 'relay:listChannels'),
      listCentralFeed: makeInvoker(invoke, 'relay:listCentralFeed'),
      listMessages: makeInvoker(invoke, 'relay:listMessages'),
      readMessage: makeInvoker(invoke, 'relay:readMessage'),
      sendDirectMessage: makeInvoker(invoke, 'relay:sendDirectMessage'),
      sendChannelMessage: makeInvoker(invoke, 'relay:sendChannelMessage'),
      updateMessageStatus: makeInvoker(invoke, 'relay:updateMessageStatus'),
      moveMessage: makeInvoker(invoke, 'relay:moveMessage'),
      setWorkContext: makeInvoker(invoke, 'relay:setWorkContext'),
      analyzeRelationships: makeInvoker(invoke, 'relay:analyzeRelationships'),
      spawnAgent: makeInvoker(invoke, 'relay:spawnAgent'),
      stopAgent: makeInvoker(invoke, 'relay:stopAgent'),
      waitForReady: makeInvoker(invoke, 'relay:waitForReady'),
      waitForAny: makeInvoker(invoke, 'relay:waitForAny'),
      onEvent: makeEventListener(eventHub, 'relay:event'),
    },
    extensions: {
      list: makeInvoker(invoke, 'ext:list'),
      listSidebar: makeInvoker(invoke, 'ext:list-sidebar'),
      listTiles: makeInvoker(invoke, 'ext:list-tiles'),
      listChatSurfaces: makeInvoker(invoke, 'ext:list-chat-surfaces'),
      tileEntry: makeInvoker(invoke, 'ext:tile-entry'),
      chatSurfaceEntry: makeInvoker(invoke, 'ext:chat-surface-entry'),
      getBridgeScript: makeInvoker(invoke, 'ext:get-bridge-script'),
      enable: makeInvoker(invoke, 'ext:enable'),
      disable: makeInvoker(invoke, 'ext:disable'),
      refresh: makeInvoker(invoke, 'ext:refresh'),
      invoke: (extId: string, method: string, ...args: unknown[]) => invoke(`ext:${extId}:${method}`, args),
      getSettings: makeInvoker(invoke, 'ext:settings-get'),
      setSettings: makeInvoker(invoke, 'ext:settings-set'),
      contextMenuItems: makeInvoker(invoke, 'ext:context-menu-items'),
    },
    bus: {
      publish: makeInvoker(invoke, 'bus:publish'),
      subscribe: (channel: string, subscriberId: string, callback: (event: any) => void) => {
        void invoke('bus:subscribe', [channel, subscriberId])
        const off = makeFilteredBusListener(eventHub, channel, callback)
        return () => {
          off()
          void invoke('bus:unsubscribeAll', [subscriberId])
        }
      },
      unsubscribeAll: makeInvoker(invoke, 'bus:unsubscribeAll'),
      history: makeInvoker(invoke, 'bus:history'),
      channelInfo: makeInvoker(invoke, 'bus:channelInfo'),
      unreadCount: makeInvoker(invoke, 'bus:unreadCount'),
      markRead: makeInvoker(invoke, 'bus:markRead'),
      onEvent: (callback: (event: any) => void) => eventHub.on('bus:event', payload => callback(payload)),
    },
    db: {
      status: makeInvoker(invoke, 'db:status'),
      reset: makeInvoker(invoke, 'db:reset'),
    },
    system: {
      cleanupTile: makeInvoker(invoke, 'system:cleanupTile'),
      gc: makeInvoker(invoke, 'system:gc'),
      memStats: makeInvoker(invoke, 'system:memStats'),
      daemonStatus: makeInvoker(invoke, 'system:daemonStatus'),
      daemonSummary: makeInvoker(invoke, 'system:daemonSummary'),
      restartDaemon: makeInvoker(invoke, 'system:restartDaemon'),
      onGcRequested: (callback: () => void) => eventHub.on('system:gc-requested', () => callback()),
    },
    homedir: options.homedir,
    platform: options.platform,
    getPathForFile: (file: File & { path?: string }) => file?.path ?? '',
    zoom: {
      getLevel: () => zoomLevel,
      setLevel: async (level: number) => {
        zoomLevel = Number.isFinite(level) ? level : 0
        await invoke('ui:setZoomLevel', [zoomLevel])
      },
    },
  }
}

export function detectPlatformFromUserAgent(userAgent: string): string {
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'darwin'
  if (/Windows/i.test(userAgent)) return 'win32'
  if (/Linux/i.test(userAgent)) return 'linux'
  return 'browser'
}
