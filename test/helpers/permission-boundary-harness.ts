import assert from 'node:assert/strict'
import {
  createPermissionBoundary,
  type BrowserWindowLike,
  type DisplayMediaRequest,
  type FrameLike,
  type PermissionBoundaryRuntime,
  type PermissionRequestDetails,
  type PermissionSession,
  type WebContentsLike,
} from '../../src/main/security/permissionBoundaryCore.ts'

export type DisplaySource = { id: string; name: string }

export class FakeFrame implements FrameLike {
  detached = false
  parent: FrameLike | null = null
  top: FrameLike = this
  url: string
  origin: string
  frameTreeNodeId: number
  processId: number
  routingId: number

  constructor(
    url: string,
    origin: string,
    frameTreeNodeId = 1,
    processId = 2,
    routingId = 3,
  ) {
    this.url = url
    this.origin = origin
    this.frameTreeNodeId = frameTreeNodeId
    this.processId = processId
    this.routingId = routingId
  }

  isDestroyed(): boolean {
    return false
  }
}

export class FakeSession implements PermissionSession<DisplaySource> {
  checkHandler?: Parameters<PermissionSession<DisplaySource>['setPermissionCheckHandler']>[0]
  requestHandler?: Parameters<PermissionSession<DisplaySource>['setPermissionRequestHandler']>[0]
  displayHandler?: Parameters<PermissionSession<DisplaySource>['setDisplayMediaRequestHandler']>[0]
  deviceHandler?: Parameters<PermissionSession<DisplaySource>['setDevicePermissionHandler']>[0]
  installCounts = { check: 0, request: 0, display: 0, device: 0 }

  setPermissionCheckHandler(handler: NonNullable<typeof this.checkHandler>): void {
    this.installCounts.check += 1
    this.checkHandler = handler
  }

  setPermissionRequestHandler(handler: NonNullable<typeof this.requestHandler>): void {
    this.installCounts.request += 1
    this.requestHandler = handler
  }

  setDisplayMediaRequestHandler(handler: NonNullable<typeof this.displayHandler>): void {
    this.installCounts.display += 1
    this.displayHandler = handler
  }

  setDevicePermissionHandler(handler: NonNullable<typeof this.deviceHandler>): void {
    this.installCounts.device += 1
    this.deviceHandler = handler
  }
}

export class FakeWebContents implements WebContentsLike {
  destroyed = false
  private readonly destroyedListeners = new Set<() => void>()
  id: number
  session: FakeSession
  mainFrame: FakeFrame
  type: string

  constructor(
    id: number,
    session: FakeSession,
    mainFrame: FakeFrame,
    type = 'window',
  ) {
    this.id = id
    this.session = session
    this.mainFrame = mainFrame
    this.type = type
  }

  getType(): string {
    return this.type
  }

  getURL(): string {
    return this.mainFrame.url
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  once(event: 'destroyed', listener: () => void): void {
    if (event === 'destroyed') this.destroyedListeners.add(listener)
  }

  destroy(): void {
    this.destroyed = true
    for (const listener of this.destroyedListeners) listener()
    this.destroyedListeners.clear()
  }
}

class FakeWindow implements BrowserWindowLike {
  destroyed = false
  webContents: FakeWebContents

  constructor(webContents: FakeWebContents) {
    this.webContents = webContents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

export function createHarness(options?: {
  platform?: NodeJS.Platform
  production?: boolean
  withDefaultSession?: boolean
}) {
  const devUrl = 'http://127.0.0.1:5173/'
  const productionUrl = 'file:///Applications/CodeSurf.app/renderer/index.html'
  const appUrl = options?.production ? productionUrl : devUrl
  const sessions = new Set<FakeSession>()
  const defaultSession = options?.withDefaultSession ? new FakeSession() : undefined
  const sessionListeners: Array<(session: PermissionSession<DisplaySource>) => void> = []
  const contentsListeners: Array<(contents: WebContentsLike) => void> = []
  const owners = new Map<WebContentsLike, BrowserWindowLike>()
  const sources: DisplaySource[] = [
    { id: 'screen:1', name: 'Entire Screen' },
    { id: 'window:2', name: 'Editor' },
  ]
  const mediaPrompts: Array<'microphone' | 'camera'> = []
  let mediaResults: Partial<Record<'microphone' | 'camera', boolean>> = {
    microphone: true,
    camera: true,
  }
  let selectedSource: DisplaySource | undefined = sources[1]
  let selectionCount = 0

  const runtime: PermissionBoundaryRuntime<DisplaySource> = {
    platform: options?.platform ?? 'darwin',
    whenReady: async () => undefined,
    getDefaultSession: () => defaultSession,
    onSessionCreated: listener => sessionListeners.push(listener),
    onWebContentsCreated: listener => contentsListeners.push(listener),
    getOwnerWindow: contents => owners.get(contents),
    getSession: contents => (contents as FakeWebContents).session,
    getWebContentsForFrame: frame => {
      for (const owner of owners.values()) {
        if (owner.webContents.mainFrame === frame) return owner.webContents
      }
      return undefined
    },
    requestMediaAccess: async kind => {
      mediaPrompts.push(kind)
      return mediaResults[kind] ?? false
    },
    getDisplaySources: async () => sources,
    selectDisplaySource: async () => {
      selectionCount += 1
      return selectedSource
    },
    warn: () => undefined,
  }

  const boundary = createPermissionBoundary(runtime, {
    developmentRendererUrl: options?.production ? undefined : devUrl,
    productionRendererUrl: productionUrl,
  })

  const makeWindow = (url = appUrl, type = 'window') => {
    const session = new FakeSession()
    sessions.add(session)
    const parsed = new URL(url)
    const origin = parsed.protocol === 'file:' ? 'file://' : parsed.origin
    const contents = new FakeWebContents(
      sessions.size,
      session,
      new FakeFrame(url, origin, sessions.size),
      type,
    )
    const window = new FakeWindow(contents)
    owners.set(contents, window)
    return { session, contents, window }
  }

  return {
    appUrl,
    boundary,
    contentsListeners,
    defaultSession,
    makeWindow,
    mediaPrompts,
    owners,
    productionUrl,
    runtime,
    sessionListeners,
    setMediaResults: (results: typeof mediaResults) => { mediaResults = results },
    setSelectedSource: (source: DisplaySource | undefined) => { selectedSource = source },
    selectionCount: () => selectionCount,
    sources,
  }
}

export function mainFrameDetails(url: string) {
  const parsed = new URL(url)
  return {
    isMainFrame: true,
    requestingUrl: url,
    securityOrigin: parsed.protocol === 'file:' ? 'file://' : parsed.origin,
  }
}

export async function requestPermission(
  session: FakeSession,
  contents: FakeWebContents,
  permission: string,
  details: PermissionRequestDetails,
): Promise<boolean> {
  assert.ok(session.requestHandler)
  return await new Promise(resolve => {
    session.requestHandler?.(contents, permission, resolve, details)
  })
}

export async function requestDisplay(
  session: FakeSession,
  request: DisplayMediaRequest,
): Promise<Record<string, unknown>> {
  assert.ok(session.displayHandler)
  return await new Promise(resolve => {
    session.displayHandler?.(request, resolve)
  })
}
