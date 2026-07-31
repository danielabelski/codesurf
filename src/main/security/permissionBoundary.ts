import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  session,
  systemPreferences,
  webContents as electronWebContents,
  type DesktopCapturerSource,
  type Session,
  type WebContents,
  type WebFrameMain,
} from 'electron'
import { pathToFileURL } from 'node:url'
import {
  createPermissionBoundary,
  type BrowserWindowLike,
  type ExtensionPermissionDescriptor,
  type FrameLike,
  type PermissionBoundary,
  type PermissionBoundaryRuntime,
  type PermissionSession,
  type WebContentsLike,
} from './permissionBoundaryCore'
import {
  ExtensionMediaConsentManager,
  ExtensionMediaConsentStore,
} from './extensionMediaConsent'
import type { SensitiveMediaCapability } from '../../shared/extension-sensitive-media'

export interface ElectronPermissionBoundaryOptions {
  readonly developmentRendererUrl?: string
  readonly productionRendererFilePath: string
}

export interface ElectronPermissionBoundary {
  readonly ready: Promise<void>
  revokeExtensionMedia(extensionId: string): Promise<void>
  registerAppWindow(window: BrowserWindow): void
  setExtensionAuthorizer(authorizer: ElectronExtensionMediaAuthorizer): void
}

export interface ElectronExtensionMediaAuthorizer {
  getExtensionMediaPermission(extensionId: string): ExtensionPermissionDescriptor | undefined
}

const MAX_DISPLAY_SOURCE_CHOICES = 20
let installedBoundary: ElectronPermissionBoundary | undefined

function asFrame(frame: WebFrameMain): FrameLike {
  return frame as unknown as FrameLike
}

function asWebContents(contents: WebContents): WebContentsLike {
  return contents as unknown as WebContentsLike
}

function asBrowserWindow(window: BrowserWindow): BrowserWindowLike {
  return window as unknown as BrowserWindowLike
}

function sameElectronFrame(
  left: WebFrameMain | null | undefined,
  right: WebFrameMain | null | undefined,
): boolean {
  return Boolean(left && right
    && left.frameTreeNodeId === right.frameTreeNodeId
    && left.processId === right.processId
    && left.routingId === right.routingId)
}

export function installElectronPermissionBoundary(
  options: ElectronPermissionBoundaryOptions,
): ElectronPermissionBoundary {
  if (installedBoundary) return installedBoundary

  let extensionAuthorizer: ElectronExtensionMediaAuthorizer | undefined
  const consentManager = new ExtensionMediaConsentManager(
    new ExtensionMediaConsentStore(),
    async request => {
      const owner = request.owner as BrowserWindow | undefined
      if (!owner || owner.isDestroyed()) return false
      const kindLabel: Record<SensitiveMediaCapability, string> = {
        microphone: 'microphone',
        camera: 'camera',
        'display-capture': 'screen or window',
      }
      const result = await dialog.showMessageBox(owner, {
        type: 'question',
        title: 'Extension media permission',
        message: `${request.extensionName} wants to use your ${kindLabel[request.kind]}`,
        detail: `Allow extension "${request.extensionId}" to use this capability? You can revoke access by disabling the extension.`,
        buttons: ['Allow', 'Deny'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      })
      return result.response === 0
    },
  )
  const sessionAdapters = new WeakMap<Session, PermissionSession<DesktopCapturerSource>>()
  const adaptSession = (electronSession: Session): PermissionSession<DesktopCapturerSource> => {
    const cached = sessionAdapters.get(electronSession)
    if (cached) return cached

    const adapted: PermissionSession<DesktopCapturerSource> = {
      setPermissionCheckHandler(handler): void {
        electronSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
          return handler(
            contents ? asWebContents(contents) : null,
            permission,
            requestingOrigin,
            details,
          )
        })
      },
      setPermissionRequestHandler(handler): void {
        electronSession.setPermissionRequestHandler((contents, permission, callback, details) => {
          handler(
            asWebContents(contents),
            permission,
            callback,
            details,
          )
        })
      },
      setDisplayMediaRequestHandler(handler): void {
        electronSession.setDisplayMediaRequestHandler((request, callback) => {
          handler(
            {
              ...request,
              frame: request.frame ? asFrame(request.frame) : null,
            },
            callback,
          )
        })
      },
      setDevicePermissionHandler(handler): void {
        electronSession.setDevicePermissionHandler(() => handler())
      },
    }
    sessionAdapters.set(electronSession, adapted)
    return adapted
  }

  const runtime: PermissionBoundaryRuntime<DesktopCapturerSource> = {
    platform: process.platform,
    whenReady: () => app.whenReady(),
    getDefaultSession: () => adaptSession(session.defaultSession),
    getDisplaySources: () => desktopCapturer.getSources({
      types: ['screen', 'window'],
      fetchWindowIcons: true,
      thumbnailSize: { width: 0, height: 0 },
    }),
    getOwnerWindow: contents => {
      const owner = BrowserWindow.fromWebContents(contents as unknown as WebContents)
      return owner ? asBrowserWindow(owner) : undefined
    },
    getSession: contents => {
      return adaptSession((contents as unknown as WebContents).session)
    },
    getExtensionPermission: extensionId => {
      return extensionAuthorizer?.getExtensionMediaPermission(extensionId)
    },
    hasDirectChildFrame: (contents, url, origin) => {
      const electronContents = contents as unknown as WebContents
      const mainFrame = electronContents.mainFrame
      return mainFrame.framesInSubtree.some(frame => {
        return !frame.isDestroyed()
          && !frame.detached
          && frame.url === url
          && frame.origin === origin
          && sameElectronFrame(frame.parent, mainFrame)
          && sameElectronFrame(frame.top, mainFrame)
      })
    },
    hasExtensionConsent: (extensionId, kind) => {
      return consentManager.hasConsent(extensionId, kind)
    },
    getWebContentsForFrame: frame => {
      const contents = electronWebContents.fromFrame(frame as unknown as WebFrameMain)
      return contents ? asWebContents(contents) : undefined
    },
    onSessionCreated: listener => {
      app.on('session-created', createdSession => {
        listener(adaptSession(createdSession))
      })
    },
    onWebContentsCreated: listener => {
      app.on('web-contents-created', (_event, contents) => {
        listener(asWebContents(contents))
      })
    },
    onWebContentsNavigation: (contents, listener) => {
      const electronContents = contents as unknown as WebContents
      electronContents.on('did-frame-navigate', listener)
      electronContents.on('did-navigate-in-page', listener)
    },
    requestExtensionConsent: (extension, kind, owner) => {
      return consentManager.requestConsent({
        extensionId: extension.id,
        extensionName: extension.name,
        kind,
        owner: owner as unknown as BrowserWindow,
      })
    },
    requestMediaAccess: async kind => {
      if (process.platform !== 'darwin') return true
      try {
        return await systemPreferences.askForMediaAccess(kind)
      } catch (error) {
        console.warn(`[Permissions] Failed requesting ${kind} access:`, error)
        return false
      }
    },
    selectDisplaySource: async ({ owner, sources }) => {
      const choices = sources.slice(0, MAX_DISPLAY_SOURCE_CHOICES)
      if (choices.length === 0) return undefined
      const cancelId = choices.length
      const result = await dialog.showMessageBox(
        owner as unknown as BrowserWindow,
        {
          type: 'question',
          title: 'Share a screen or window',
          message: 'Choose what CodeSurf may share',
          detail: sources.length > choices.length
            ? `Showing the first ${choices.length} available sources.`
            : 'Nothing is shared until you choose a source.',
          buttons: [
            ...choices.map((source, index) => source.name.trim() || `Source ${index + 1}`),
            'Cancel',
          ],
          defaultId: cancelId,
          cancelId,
          noLink: true,
        },
      )
      return result.response >= 0 && result.response < choices.length
        ? choices[result.response]
        : undefined
    },
    warn: (message, error) => {
      console.warn(`[Permissions] ${message}:`, error)
    },
  }

  const boundary: PermissionBoundary<DesktopCapturerSource> = createPermissionBoundary(
    runtime,
    {
      developmentRendererUrl: options.developmentRendererUrl,
      productionRendererUrl: pathToFileURL(options.productionRendererFilePath).href,
    },
  )

  installedBoundary = {
    ready: Promise.all([boundary.ready, consentManager.ready]).then(() => undefined),
    revokeExtensionMedia: async extensionId => {
      boundary.clearExtensionGrants(extensionId)
      await consentManager.revokeExtension(extensionId)
    },
    registerAppWindow: window => boundary.registerAppWindow(asBrowserWindow(window)),
    setExtensionAuthorizer: authorizer => {
      extensionAuthorizer = authorizer
    },
  }
  return installedBoundary
}
