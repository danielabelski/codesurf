import type {
  BrowserWindowLike,
  FrameLike,
  PermissionBoundary,
  PermissionBoundaryOptions,
  PermissionBoundaryRuntime,
  PermissionCheckDetails,
  PermissionRequestDetails,
  PermissionSession,
  RequestedMediaType,
  WebContentsLike,
} from './permissionBoundaryTypes.ts'

export type {
  BrowserWindowLike,
  DisplayMediaRequest,
  DisplaySourceSelection,
  DisplayStreams,
  FrameLike,
  MediaAccessKind,
  PermissionBoundary,
  PermissionBoundaryOptions,
  PermissionBoundaryRuntime,
  PermissionCheckDetails,
  PermissionRequestDetails,
  PermissionSession,
  RequestedMediaType,
  WebContentsLike,
} from './permissionBoundaryTypes.ts'

type AllowedRenderer = {
  readonly fileUrl: boolean
  readonly origin: string
  readonly url: URL
}

const boundariesByRuntime = new WeakMap<object, PermissionBoundary<unknown>>()

function getAllowedRenderer(options: PermissionBoundaryOptions): AllowedRenderer {
  const rawUrl = options.developmentRendererUrl ?? options.productionRendererUrl
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
    throw new Error(`Unsupported renderer URL protocol: ${url.protocol}`)
  }
  return {
    fileUrl: url.protocol === 'file:',
    origin: url.origin,
    url,
  }
}

function sameFrame(left: FrameLike | null | undefined, right: FrameLike | null | undefined): boolean {
  if (!left || !right) return false
  return left.frameTreeNodeId === right.frameTreeNodeId
    && left.processId === right.processId
    && left.routingId === right.routingId
}

function once<T>(callback: (value: T) => void): (value: T) => void {
  let called = false
  return value => {
    if (called) return
    called = true
    callback(value)
  }
}

export function createPermissionBoundary<DisplaySource>(
  runtime: PermissionBoundaryRuntime<DisplaySource>,
  options: PermissionBoundaryOptions,
): PermissionBoundary<DisplaySource> {
  const cached = boundariesByRuntime.get(runtime as object)
  if (cached) return cached as PermissionBoundary<DisplaySource>

  const allowedRenderer = getAllowedRenderer(options)
  const installedSessions = new WeakSet<object>()
  const registeredContents = new WeakSet<object>()
  const trustedOwners = new WeakMap<object, BrowserWindowLike>()
  const mediaGrants = new WeakMap<object, Set<RequestedMediaType>>()

  const isAllowedUrl = (rawUrl: string | undefined): boolean => {
    if (!rawUrl) return false
    try {
      const candidate = new URL(rawUrl)
      if (allowedRenderer.fileUrl) {
        const expected = new URL(allowedRenderer.url.href)
        candidate.search = ''
        candidate.hash = ''
        expected.search = ''
        expected.hash = ''
        return candidate.href === expected.href
      }
      return candidate.origin === allowedRenderer.origin
        && candidate.username === allowedRenderer.url.username
        && candidate.password === allowedRenderer.url.password
        && candidate.pathname === allowedRenderer.url.pathname
    } catch {
      return false
    }
  }

  const isAllowedOrigin = (origin: string | undefined): boolean => {
    if (!origin) return false
    if (allowedRenderer.fileUrl) {
      return origin === 'file://' || origin === 'file:///' || origin === 'null'
    }
    return origin === allowedRenderer.origin
  }

  const getTrustedOwner = (
    session: PermissionSession<DisplaySource>,
    webContents: WebContentsLike | null | undefined,
  ): BrowserWindowLike | undefined => {
    if (!webContents || webContents.isDestroyed() || webContents.getType() !== 'window') return undefined
    if (runtime.getSession(webContents) !== session) return undefined
    const owner = trustedOwners.get(webContents as object)
    if (!owner || owner.isDestroyed() || owner.webContents !== webContents) return undefined
    if (runtime.getOwnerWindow(webContents) !== owner) return undefined
    const frame = webContents.mainFrame
    if (
      frame.isDestroyed()
      || frame.detached
      || frame.parent !== null
      || !sameFrame(frame, frame.top)
    ) {
      return undefined
    }
    if (
      !isAllowedUrl(webContents.getURL())
      || !isAllowedUrl(frame.url)
      || !isAllowedOrigin(frame.origin)
    ) {
      return undefined
    }
    return owner
  }

  const getTrustedRequestOwner = (
    session: PermissionSession<DisplaySource>,
    webContents: WebContentsLike | null | undefined,
    details: PermissionCheckDetails | PermissionRequestDetails,
    requestingOrigin?: string,
  ): BrowserWindowLike | undefined => {
    if (details.isMainFrame !== true) return undefined
    const hasAllowedRequestUrl = isAllowedUrl(details.requestingUrl)
      || (!details.requestingUrl && isAllowedUrl(details.embeddingOrigin))
    if (!hasAllowedRequestUrl) return undefined
    if (requestingOrigin !== undefined) {
      const allowedEmptyFileOrigin = allowedRenderer.fileUrl
        && requestingOrigin === ''
        && isAllowedUrl(details.embeddingOrigin)
      if (!allowedEmptyFileOrigin && !isAllowedOrigin(requestingOrigin)) return undefined
    }
    if (details.securityOrigin !== undefined && !isAllowedOrigin(details.securityOrigin)) return undefined
    return getTrustedOwner(session, webContents)
  }

  const installSession = (session: PermissionSession<DisplaySource>): void => {
    if (installedSessions.has(session as object)) return
    installedSessions.add(session as object)

    session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      if (!getTrustedRequestOwner(session, webContents, details, requestingOrigin)) return false
      if (permission === 'clipboard-sanitized-write') return true
      if (permission !== 'media') return false
      if (details.mediaType !== 'audio' && details.mediaType !== 'video') return false
      return mediaGrants.get(webContents as object)?.has(details.mediaType) === true
    })

    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const finish = once(callback)
      const owner = getTrustedRequestOwner(session, webContents, details)
      if (!owner) {
        finish(false)
        return
      }
      if (permission === 'clipboard-sanitized-write') {
        finish(true)
        return
      }
      // Electron 41 gates getDisplayMedia behind a permission request before
      // invoking setDisplayMediaRequestHandler. This boolean only advances to
      // that handler; the trusted frame, gesture, and explicit source are still
      // required there before any stream can be returned.
      if (
        permission === 'display-capture'
        || (
          permission === 'media'
          && Array.isArray(details.mediaTypes)
          && details.mediaTypes.length === 0
          && isAllowedOrigin(details.securityOrigin)
        )
      ) {
        finish(true)
        return
      }
      if (permission !== 'media') {
        finish(false)
        return
      }

      const mediaTypes = [...new Set(details.mediaTypes ?? [])]
      if (
        mediaTypes.length === 0
        || mediaTypes.some(type => type !== 'audio' && type !== 'video')
        || !isAllowedOrigin(details.securityOrigin)
      ) {
        finish(false)
        return
      }

      void Promise.all(
        mediaTypes.map(type => runtime.requestMediaAccess(type === 'audio' ? 'microphone' : 'camera')),
      ).then(results => {
        const stillTrusted = getTrustedRequestOwner(session, webContents, details)
        const granted = Boolean(stillTrusted) && results.every(Boolean)
        if (granted) {
          let grants = mediaGrants.get(webContents as object)
          if (!grants) {
            grants = new Set()
            mediaGrants.set(webContents as object, grants)
          }
          for (const mediaType of mediaTypes) grants.add(mediaType)
        }
        finish(granted)
      }).catch(error => {
        runtime.warn('Media permission request failed', error)
        finish(false)
      })
    })

    session.setDisplayMediaRequestHandler((request, callback) => {
      const finish = once(callback)
      const frame = request.frame
      const webContents = frame ? runtime.getWebContentsForFrame(frame) : undefined
      const owner = getTrustedOwner(session, webContents)
      if (
        !frame
        || !webContents
        || !owner
        || frame.isDestroyed()
        || frame.detached
        || frame.parent !== null
        || !sameFrame(frame, frame.top)
        || !sameFrame(frame, webContents.mainFrame)
        || !isAllowedUrl(frame.url)
        || !isAllowedOrigin(frame.origin)
        || !isAllowedOrigin(request.securityOrigin)
        || request.userGesture !== true
        || request.videoRequested !== true
        || (request.audioRequested && runtime.platform !== 'win32')
      ) {
        finish({})
        return
      }

      void runtime.getDisplaySources().then(async sources => {
        if (sources.length === 0) return undefined
        const selected = await runtime.selectDisplaySource({ owner, sources })
        return selected && sources.includes(selected) ? selected : undefined
      }).then(selected => {
        const currentContents = request.frame
          ? runtime.getWebContentsForFrame(request.frame)
          : undefined
        const stillTrusted = request.frame
          && currentContents === webContents
          && sameFrame(request.frame, webContents.mainFrame)
          && getTrustedOwner(session, webContents)
        if (!selected || !stillTrusted) {
          finish({})
          return
        }
        finish({
          video: selected,
          ...(request.audioRequested ? { audio: 'loopback' as const } : {}),
        })
      }).catch(error => {
        runtime.warn('Display media request failed', error)
        finish({})
      })
    })

    session.setDevicePermissionHandler(() => false)
  }

  const registerAppWindow = (window: BrowserWindowLike): void => {
    const webContents = window.webContents
    if (
      window.isDestroyed()
      || webContents.isDestroyed()
      || webContents.getType() !== 'window'
      || runtime.getOwnerWindow(webContents) !== window
    ) {
      return
    }
    installSession(runtime.getSession(webContents))
    trustedOwners.set(webContents as object, window)
    if (!registeredContents.has(webContents as object)) {
      registeredContents.add(webContents as object)
      webContents.once('destroyed', () => {
        trustedOwners.delete(webContents as object)
        mediaGrants.delete(webContents as object)
      })
    }
  }

  runtime.onSessionCreated(installSession)
  runtime.onWebContentsCreated(webContents => {
    installSession(runtime.getSession(webContents))
  })

  const ready = runtime.whenReady().then(() => {
    const defaultSession = runtime.getDefaultSession()
    if (defaultSession) installSession(defaultSession)
  }).catch(error => {
    runtime.warn('Unable to install default-session permission handlers', error)
  })
  const boundary: PermissionBoundary<DisplaySource> = {
    installSession,
    ready,
    registerAppWindow,
  }

  boundariesByRuntime.set(runtime as object, boundary as PermissionBoundary<unknown>)
  return boundary
}
