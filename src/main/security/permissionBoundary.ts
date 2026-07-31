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
  type FrameLike,
  type PermissionBoundary,
  type PermissionBoundaryRuntime,
  type PermissionSession,
  type WebContentsLike,
} from './permissionBoundaryCore'

export interface ElectronPermissionBoundaryOptions {
  readonly developmentRendererUrl?: string
  readonly productionRendererFilePath: string
}

export interface ElectronPermissionBoundary {
  readonly ready: Promise<void>
  registerAppWindow(window: BrowserWindow): void
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

export function installElectronPermissionBoundary(
  options: ElectronPermissionBoundaryOptions,
): ElectronPermissionBoundary {
  if (installedBoundary) return installedBoundary

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
    ready: boundary.ready,
    registerAppWindow: window => boundary.registerAppWindow(asBrowserWindow(window)),
  }
  return installedBoundary
}
