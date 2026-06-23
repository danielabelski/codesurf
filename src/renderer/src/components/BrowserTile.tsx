import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Activity, ArrowLeft, ArrowRight, Bug, ClipboardCheck, ClipboardList, Crosshair, Globe, Home, Monitor, RotateCcw, RotateCw, Smartphone, Trash2 } from 'lucide-react'
import { useTheme } from '../ThemeContext'
import { useAppFonts } from '../FontContext'
import { dispatchOpenLink } from '../utils/links'
import { dispatchCreateTile, dispatchOpenChatSurface } from '../utils/appLaunchRequests'
import {
  appendBrowserEvidence,
  createBrowserEvidenceEvent,
  createBrowserEvidenceSnapshot,
  createBrowserPageHealth,
  formatBrowserEvidenceReport,
  summarizeBrowserEvidence,
  type BrowserEvidenceEvent,
  type BrowserEvidenceInput,
  type BrowserEvidenceViewport,
} from '../../../shared/browserEvidence'
import { coerceBusEventType } from '../../../shared/busEventTypes'
import {
  HOMEPAGE,
  DESKTOP_UA,
  MOBILE_UA,
  getWebviewParkingRoot,
  getOrCreateManagedWebview,
  scheduleManagedWebviewDisposal,
  safeLoadURL,
  createBusBridgeScript,
  createClusoInjectScript,
  createClusoSetActiveScript,
  isAllowedBrowserUrl,
  shouldInjectHostBridge,
  normalizeUrl,
} from './browser/webviewManager'
import clusoEmbedJs from '../assets/cluso/cluso-embed.js?raw'
import clusoEmbedCss from '../assets/cluso/cluso-embed.css?raw'




// ---------------------------------------------------------------------------
// ToolbarButton
// ---------------------------------------------------------------------------
function ToolbarButton({
  label,
  title,
  disabled,
  active,
  onClick,
  children
}: {
  label?: string
  title: string
  disabled?: boolean
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const handleMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (disabled) return
    e.preventDefault()
    onClick()
  }

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    // Keyboard activation still dispatches click with detail=0.
    if (!disabled && e.detail === 0) onClick()
  }

  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      style={{
        width: 26,
        height: 26,
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: disabled ? theme.text.disabled : active ? theme.accent.hover : theme.text.secondary,
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: fonts.secondarySize
      }}
      onMouseEnter={e => {
        if (disabled || active) return
        e.currentTarget.style.color = theme.text.primary
      }}
      onMouseLeave={e => {
        if (disabled || active) return
        e.currentTarget.style.color = theme.text.secondary
      }}
    >
      {children}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface Props {
  tileId: string
  workspaceId?: string
  initialUrl?: string
  width: number
  height: number
  zIndex: number
  isInteracting?: boolean
  isVisible?: boolean
  connectedPeers?: string[]
  hideNavbar?: boolean
}

type BrowserMode = 'desktop' | 'mobile'
type BrowserEvidenceFilter = 'all' | 'issues' | 'console' | 'load-failure' | 'lifecycle'

const BROWSER_EVIDENCE_FILTERS: Array<{ id: BrowserEvidenceFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'issues', label: 'Issues' },
  { id: 'console', label: 'Console' },
  { id: 'load-failure', label: 'Loads' },
  { id: 'lifecycle', label: 'Lifecycle' },
]

function matchesEvidenceFilter(event: BrowserEvidenceEvent, filter: BrowserEvidenceFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'issues') return event.severity === 'error' || event.severity === 'warning'
  return event.kind === filter
}


// ---------------------------------------------------------------------------
// BrowserTile
// ---------------------------------------------------------------------------
export function BrowserTile({ tileId, workspaceId, initialUrl, width, height, zIndex: _zIndex, isInteracting, isVisible = true, connectedPeers = [], hideNavbar = false }: Props): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const browserBackground = theme.surface.panel
  const browserToolbarBackground = theme.surface.titlebar
  const browserBorder = theme.border.default
  const browserBackgroundRef = useRef(browserBackground)
  browserBackgroundRef.current = browserBackground
  const wvContainerRef = useRef<HTMLDivElement>(null)
  const wvRef = useRef<Electron.WebviewTag | null>(null)
  const wvReadyRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  const bridgeTokenRef = useRef(crypto.randomUUID())
  const clusoToggleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const peerRelayUnsubscribeRef = useRef<(() => void) | null>(null)
  const mcpCommandUnsubscribeRef = useRef<(() => void) | null>(null)
  const browserEvidenceRef = useRef<BrowserEvidenceEvent[]>([])

  // Track component mount state for async cleanup
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (clusoToggleTimerRef.current !== null) {
        clearTimeout(clusoToggleTimerRef.current)
        clusoToggleTimerRef.current = null
      }
    }
  }, [])

  const initialSrc = useRef(normalizeUrl(initialUrl ?? ''))
  const startUrl = initialSrc.current

  const [addressBar, setAddressBar] = useState(startUrl)
  const [currentUrl, setCurrentUrl] = useState(startUrl)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [mode, setMode] = useState<BrowserMode>('desktop')
  const [isClusoReady, setIsClusoReady] = useState(false)
  const [isClusoActive, setIsClusoActive] = useState(false)
  const [isToolbarHovered, setIsToolbarHovered] = useState(false)
  const [isAddressFocused, setIsAddressFocused] = useState(false)
  const [stateLoaded, setStateLoaded] = useState(!workspaceId)
  const [pageTitle, setPageTitle] = useState('')
  const [browserEvidence, setBrowserEvidence] = useState<BrowserEvidenceEvent[]>([])
  const [isEvidenceDrawerOpen, setIsEvidenceDrawerOpen] = useState(false)
  const [evidenceFilter, setEvidenceFilter] = useState<BrowserEvidenceFilter>('issues')
  const [copyStatus, setCopyStatus] = useState('')
  const [lastSnapshotAt, setLastSnapshotAt] = useState<number | null>(null)
  const browserPageStateRef = useRef({ url: startUrl, title: '', isLoading: false, mode: 'desktop' as BrowserMode })
  browserPageStateRef.current = { url: currentUrl, title: pageTitle, isLoading, mode }

  // Stable ref so getCurrentViewport doesn't close over changing width/height state —
  // prevents the webview-mount effect from re-running on every resize step.
  const sizeRef = useRef({ width, height })
  sizeRef.current = { width, height }

  const getCurrentViewport = useCallback((): BrowserEvidenceViewport | undefined => {
    const rect = wvContainerRef.current?.getBoundingClientRect()
    const viewportWidth = rect && rect.width > 0 ? rect.width : sizeRef.current.width
    const viewportHeight = rect && rect.height > 0 ? rect.height : sizeRef.current.height
    const roundedWidth = Math.max(1, Math.round(viewportWidth))
    const roundedHeight = Math.max(1, Math.round(viewportHeight))
    return {
      width: roundedWidth,
      height: roundedHeight,
      deviceScaleFactor: window.devicePixelRatio || 1,
    }
  }, []) // stable — reads size via sizeRef

  const createCurrentEvidenceSnapshot = useCallback((events = browserEvidenceRef.current) => {
    const page = browserPageStateRef.current
    return createBrowserEvidenceSnapshot({
      tileId,
      url: page.url,
      title: page.title,
      isLoading: page.isLoading,
      mode: page.mode,
      viewport: getCurrentViewport(),
      events,
    })
  }, [getCurrentViewport, tileId])

  const publishEvidenceSnapshot = useCallback((reason: string, events = browserEvidenceRef.current) => {
    const snapshot = createCurrentEvidenceSnapshot(events)
    const report = formatBrowserEvidenceReport(snapshot)
    setLastSnapshotAt(snapshot.capturedAt)
    window.electron?.bus?.publish(
      `tile:${tileId}`,
      'browser.evidence.snapshot',
      `browser:${tileId}`,
      { reason, snapshot, report },
    )
    window.electron?.bus?.publish(
      `tile:${tileId}`,
      'browser.page_health',
      `browser:${tileId}`,
      {
        reason,
        health: snapshot.health,
        page: snapshot.page,
        summary: snapshot.summary,
        ...(snapshot.viewport ? { viewport: snapshot.viewport } : {}),
      },
    )
    return snapshot
  }, [createCurrentEvidenceSnapshot, tileId])

  const recordBrowserEvidence = useCallback((input: Omit<BrowserEvidenceInput, 'tileId'>) => {
    const event = createBrowserEvidenceEvent({ tileId, ...input })
    const next = appendBrowserEvidence(browserEvidenceRef.current, event)
    browserEvidenceRef.current = next
    setBrowserEvidence(next)
    const snapshot = createCurrentEvidenceSnapshot(next)
    window.electron?.bus?.publish(
      `tile:${tileId}`,
      'browser.evidence',
      `browser:${tileId}`,
      {
        event,
        summary: snapshot.summary,
        health: snapshot.health,
        page: snapshot.page,
        ...(snapshot.viewport ? { viewport: snapshot.viewport } : {}),
      },
    )
    window.electron?.bus?.publish(
      `tile:${tileId}`,
      'browser.page_health',
      `browser:${tileId}`,
      {
        reason: 'evidence-recorded',
        health: snapshot.health,
        page: snapshot.page,
        summary: snapshot.summary,
        ...(snapshot.viewport ? { viewport: snapshot.viewport } : {}),
      },
    )
  }, [createCurrentEvidenceSnapshot, tileId])

  const browserEvidenceSummary = summarizeBrowserEvidence(browserEvidence)
  const browserPageHealth = createBrowserPageHealth(browserEvidenceSummary, isLoading)
  const filteredBrowserEvidence = browserEvidence
    .filter(event => matchesEvidenceFilter(event, evidenceFilter))
    .slice()
    .reverse()
  const issueBadgeCount = browserEvidenceSummary.errorCount || browserEvidenceSummary.warningCount || browserEvidenceSummary.total
  const evidenceHealthColor = browserPageHealth.status === 'error'
    ? theme.status.danger
    : browserPageHealth.status === 'warning'
      ? theme.status.warning
      : browserPageHealth.status === 'loading'
        ? theme.accent.base
        : theme.status.success

  useEffect(() => {
    setStateLoaded(!workspaceId)
    if (!workspaceId) return
    window.electron.canvas.loadTileState(workspaceId, tileId).then((saved: any) => {
      if (!saved) return
      if (typeof saved.addressBar === 'string') setAddressBar(saved.addressBar)
      if (typeof saved.currentUrl === 'string') {
        setCurrentUrl(saved.currentUrl)
        initialSrc.current = saved.currentUrl
        prevInitialUrl.current = saved.currentUrl
        if (wvRef.current) {
          if (wvReadyRef.current) safeLoadURL(wvRef.current, saved.currentUrl)
          else wvRef.current.src = saved.currentUrl
        }
      }
      if (typeof saved.canGoBack === 'boolean') setCanGoBack(saved.canGoBack)
      if (typeof saved.canGoForward === 'boolean') setCanGoForward(saved.canGoForward)
      if (typeof saved.isLoading === 'boolean') setIsLoading(saved.isLoading)
      if (saved.mode === 'desktop' || saved.mode === 'mobile') setMode(saved.mode)
    }).catch(() => {}).finally(() => {
      setStateLoaded(true)
    })
  }, [workspaceId, tileId])

  useEffect(() => {
    if (!workspaceId || !stateLoaded) return
    window.electron.canvas.saveTileState(workspaceId, tileId, {
      addressBar,
      currentUrl,
      canGoBack,
      canGoForward,
      isLoading,
      mode,
    }).catch(() => {})
  }, [workspaceId, tileId, addressBar, currentUrl, canGoBack, canGoForward, isLoading, mode])

  useEffect(() => {
    if (!workspaceId || !window.electron?.tileContext) return
    const latestSnapshot = createCurrentEvidenceSnapshot(browserEvidence)
    const contextSnapshot = latestSnapshot.events.length > 20
      ? {
        ...latestSnapshot,
        events: browserEvidence.slice(-20),
      }
      : latestSnapshot
    void Promise.allSettled([
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:url', currentUrl),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:title', pageTitle),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:mode', mode),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:loading', isLoading),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:evidence_summary', browserEvidenceSummary),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:page_health', browserPageHealth),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:viewport', contextSnapshot.viewport ?? null),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:evidence_snapshot', contextSnapshot),
      window.electron.tileContext.set(workspaceId, tileId, 'ctx:browser:navigation', {
        currentUrl,
        title: pageTitle,
        canGoBack,
        canGoForward,
        isLoading,
        mode,
      }),
    ])
  }, [workspaceId, tileId, currentUrl, pageTitle, mode, isLoading, canGoBack, canGoForward, browserEvidence, browserEvidenceSummary.total, browserEvidenceSummary.errorCount, browserEvidenceSummary.warningCount, browserPageHealth.status, createCurrentEvidenceSnapshot])

  // Fan-out bus traffic from this browser tile to canvas peers (unrelated to ContexRelay mailbox).
  useEffect(() => {
    const peers = new Set(connectedPeers)
    if (!window.electron?.bus || peers.size === 0) {
      if (peerRelayUnsubscribeRef.current) {
        peerRelayUnsubscribeRef.current()
        peerRelayUnsubscribeRef.current = null
      }
      return
    }

    if (peerRelayUnsubscribeRef.current) {
      peerRelayUnsubscribeRef.current()
      peerRelayUnsubscribeRef.current = null
    }

    const unsubscribe = window.electron.bus.subscribe(`tile:${tileId}`, `browser:${tileId}:relay`, (evt) => {
      // Forward only traffic that originated from this browser's web content to peers.
      // This prevents unrelated channel traffic from being mirrored infinitely.
      if (!String(evt.source || '').startsWith(`browser:${tileId}`)) {
        return
      }

      for (const peerId of peers) {
        if (peerId === tileId) continue
        window.electron.bus.publish(
          `tile:${peerId}`,
          evt.type,
          `browser-relay:${tileId}`,
          {
            ...evt.payload,
            fromTile: tileId,
            relayFrom: String(evt.source || '').replace(`browser:${tileId}`, 'browser'),
            originChannel: evt.channel,
          }
        )
      }
    })

    peerRelayUnsubscribeRef.current = unsubscribe
    return () => {
      if (peerRelayUnsubscribeRef.current) {
        peerRelayUnsubscribeRef.current()
        peerRelayUnsubscribeRef.current = null
      }
    }
  }, [connectedPeers, tileId])

  // Cluso embed assets — loaded once on mount
  const clusoAssetsRef = useRef<{ js: string | null; css: string | null }>({
    js: clusoEmbedJs || null,
    css: clusoEmbedCss || null,
  })

  // Stable setter refs — avoid re-adding event listeners when state changes
  const setCurrentUrlRef = useRef(setCurrentUrl)
  setCurrentUrlRef.current = setCurrentUrl
  const setPageTitleRef = useRef(setPageTitle)
  setPageTitleRef.current = setPageTitle
  const setAddressBarRef = useRef(setAddressBar)
  setAddressBarRef.current = setAddressBar
  const setCanGoBackRef = useRef(setCanGoBack)
  setCanGoBackRef.current = setCanGoBack
  const setCanGoForwardRef = useRef(setCanGoForward)
  setCanGoForwardRef.current = setCanGoForward
  const setIsLoadingRef = useRef(setIsLoading)
  setIsLoadingRef.current = setIsLoading
  const setIsClusoReadyRef = useRef(setIsClusoReady)
  setIsClusoReadyRef.current = setIsClusoReady
  const setIsClusoActiveRef = useRef(setIsClusoActive)
  setIsClusoActiveRef.current = setIsClusoActive

  const executeInWebview = useCallback((script: string): Promise<unknown> => {
    const webview = wvRef.current
    if (!webview || !mountedRef.current) return Promise.reject(new Error('Webview unavailable'))

    if (wvReadyRef.current) {
      return webview.executeJavaScript(script)
    }

    return new Promise((resolve, reject) => {
      const onReady = () => {
        if (!mountedRef.current || !wvReadyRef.current) {
          cleanup()
          reject(new Error('Webview became unavailable before ready'))
          return
        }
        webview.executeJavaScript(script).then(resolve).catch(reject).finally(cleanup)
      }

      const cleanup = () => {
        clearTimeout(timeout)
        webview.removeEventListener('dom-ready', onReady)
      }

      const timeout = setTimeout(() => {
        cleanup()
        reject(new Error('Webview ready timeout'))
      }, 5000)

      webview.addEventListener('dom-ready', onReady)
    })
  }, [])

  // Inject cluso into the webview — called after each page load
  const injectCluso = useCallback(() => {
    const { js, css } = clusoAssetsRef.current
    if (!js || !css) {
      console.warn('[Cluso] Assets not loaded yet — skipping injection')
      return
    }
    setIsClusoReadyRef.current(false)
    setIsClusoActiveRef.current(false)
    executeInWebview(createClusoInjectScript(js, css))
      .then(result => {
        if (typeof result === 'string' && result.includes('ERROR')) console.error('[Cluso] Injection error:', result)
      })
      .catch(err => console.error('[Cluso] Injection failed:', err))
  }, [executeInWebview]) // stable — reads assets via ref

  // Load bundled cluso embed assets (once per mount)
  useEffect(() => {
    clusoAssetsRef.current = {
      js: clusoEmbedJs || null,
      css: clusoEmbedCss || null,
    }

    if (!clusoAssetsRef.current.js || !clusoAssetsRef.current.css) {
      console.warn('[Cluso] Bundled embed assets are missing — inspector will not work')
      return
    }

    // The page can finish loading before the component mount effect runs.
    // If that happened, retry injection now instead of waiting for another navigation.
    if (mountedRef.current && wvReadyRef.current) injectCluso()
  }, [injectCluso])

  // Create or reattach the webview imperatively so page state survives view switches
  useEffect(() => {
    // Wait for persisted tile state before creating a fresh webview, otherwise
    // remounts can briefly boot to HOMEPAGE and then navigate back.
    if (!stateLoaded) return

    const container = wvContainerRef.current
    if (!container) return

    const { webview, reused } = getOrCreateManagedWebview(tileId, initialSrc.current, browserBackground)

    wvRef.current = webview
    wvReadyRef.current = false

    // Sync webview background with current theme so it doesn't flash white
    webview.style.background = browserBackground

    // ---- helpers --------------------------------------------------------
    const updateNav = () => {
      if (!wvRef.current || !wvReadyRef.current) return
      try {
        const url = wvRef.current.getURL()
        if (url) {
          setCurrentUrlRef.current(url)
          if (document.activeElement !== inputRef.current) {
            setAddressBarRef.current(url)
          }
          window.electron?.bus?.publish(
            `tile:${tileId}`,
            'activity',
            `browser:${tileId}`,
            { kind: 'navigation', event: 'navigated', url }
          )
        }
        const title = wvRef.current.getTitle?.() || ''
        setPageTitleRef.current(title)
        setCanGoBackRef.current(wvRef.current.canGoBack())
        setCanGoForwardRef.current(wvRef.current.canGoForward())
        setIsLoadingRef.current(wvRef.current.isLoading())
      } catch {
        wvReadyRef.current = false
      }
    }

    // ---- dark mode background injection -----------------------------------
    // Inject a low-specificity dark background into the webview content so
    // pages that don't set their own background (about:blank, loading states)
    // don't flash white.  Real pages override this with their own styles.
    const injectDarkBackground = () => {
      if (!webview || !wvReadyRef.current) return
      const bg = browserBackgroundRef.current
      webview.insertCSS(
        `html:not([style*="background"]):not([class]) { background-color: ${bg} !important; }` +
        `body:not([style*="background"]):not([class]) { background-color: ${bg} !important; }`
      ).catch(() => { /* webview may not be ready yet */ })
    }

    // ---- event handlers -------------------------------------------------
    const onDomReady = () => {
      wvReadyRef.current = true
      injectDarkBackground()
      updateNav()
    }

    const onStartLoad = () => setIsLoadingRef.current(true)

    const onStopLoad = () => {
      setIsLoadingRef.current(false)
      updateNav()
      // Reset cluso state and re-inject after each page load
      setIsClusoReadyRef.current(false)
      setIsClusoActiveRef.current(false)
      injectCluso()
      // Inject bus bridge so webview content can publish to the EventBus
      if (shouldInjectHostBridge(webview.getURL())) {
        executeInWebview(createBusBridgeScript(tileId, bridgeTokenRef.current))
          .catch(err => console.warn('[BrowserTile] Bus bridge injection failed:', err))
      }
    }

    const onFrameFinishLoad = (e: Event) => {
      const ev = e as Event & { isMainFrame?: boolean }
      if (ev.isMainFrame === false) return
      updateNav()
      recordBrowserEvidence({
        kind: 'lifecycle',
        message: 'Frame finished loading',
        url: webview.getURL(),
        details: {
          title: webview.getTitle?.() || '',
          isLoading: webview.isLoading(),
        },
      })
    }

    const onFailLoad = (e: Event) => {
      setIsLoadingRef.current(false)
      setIsClusoReadyRef.current(false)
      setIsClusoActiveRef.current(false)

      const ev = e as Event & {
        errorCode?: number
        errorDescription?: string
        validatedURL?: string
        url?: string
        isMainFrame?: boolean
      }
      recordBrowserEvidence({
        kind: 'load-failure',
        message: ev.errorDescription || `Load failed${typeof ev.errorCode === 'number' ? ` (${ev.errorCode})` : ''}`,
        url: ev.validatedURL || ev.url || webview.getURL(),
        errorCode: ev.errorCode,
        details: typeof ev.isMainFrame === 'boolean' ? { isMainFrame: ev.isMainFrame } : undefined,
      })
    }

    const onNavigate = () => updateNav()
    const onNavigateInPage = () => updateNav()
    const onWillNavigate = (e: Event) => {
      const ev = e as Event & { url?: string }
      if (!ev.url || isAllowedBrowserUrl(ev.url)) return
      e.preventDefault()
      void webview.loadURL(HOMEPAGE)
    }

    // The `new-window` DOM webview event was removed in Electron 22.
    // window.open / target=_blank is now intercepted in the main process via
    // setWindowOpenHandler and forwarded here as an IPC event (webview:new-window).
    // The subscription is set up outside this effect (see onNewWindowCleanup below).

    // ---- console message handler (bus bridge + cluso) -------------------
    const onConsoleMessage = (e: Electron.ConsoleMessageEvent) => {
      const consoleEvent = e as Electron.ConsoleMessageEvent & {
        level?: string | number
        sourceId?: string
        line?: number
        column?: number
      }
      const { message } = consoleEvent

      if (message.startsWith('{"__contex"')) {
        if (!shouldInjectHostBridge(webview.getURL())) return
        try {
          const data = JSON.parse(message) as {
            __contex?: boolean
            token?: string
            type?: string
            channel?: string
            payload?: Record<string, unknown>
          }
          if (
            data.__contex
            && data.token === bridgeTokenRef.current
            && (data.channel === `browser:${tileId}` || data.channel === `tile:${tileId}`)
          ) {
            const eventType = coerceBusEventType(data.type)
            const payload = data.payload && typeof data.payload === 'object' ? data.payload : {}
            window.electron?.bus?.publish(
              `browser:${tileId}`,
              eventType,
              `browser:${tileId}`,
              eventType === 'data' && data.type && data.type !== 'data'
                ? { ...payload, eventType: data.type }
                : payload,
            )
          }
        } catch { /* not valid JSON — ignore */ }
        return
      }

      if (!message.startsWith('__CLUSO_')) {
        recordBrowserEvidence({
          kind: 'console',
          message,
          level: consoleEvent.level,
          source: consoleEvent.sourceId,
          line: consoleEvent.line,
          column: consoleEvent.column,
          url: webview.getURL(),
        })
        return
      }

      if (message.startsWith('__CLUSO_READY__')) {
        setIsClusoReadyRef.current(true)
        const payloadText = message.startsWith('__CLUSO_READY__:')
          ? message.slice('__CLUSO_READY__:'.length)
          : null
        if (payloadText) {
          try {
            const payload = JSON.parse(payloadText) as { active?: boolean }
            if (typeof payload.active === 'boolean') {
              setIsClusoActiveRef.current(payload.active)
            }
          } catch { /* ignore malformed */ }
        }
        console.log('[BrowserTile] Cluso ready')
        return
      }

      if (message.startsWith('__CLUSO_ACTIVE__:')) {
        try {
          const payload = JSON.parse(message.slice('__CLUSO_ACTIVE__:'.length)) as { active?: boolean }
          setIsClusoActiveRef.current(Boolean(payload.active))
        } catch { /* ignore */ }
        return
      }

      if (message.startsWith('__CLUSO_ERROR__')) {
        console.error('[BrowserTile] Cluso error:', message)
        return
      }
    }

    // ---- register -------------------------------------------------------
    webview.addEventListener('dom-ready', onDomReady)
    webview.addEventListener('did-start-loading', onStartLoad)
    webview.addEventListener('did-stop-loading', onStopLoad)
    webview.addEventListener('did-frame-finish-load', onFrameFinishLoad)
    webview.addEventListener('did-fail-load', onFailLoad)
    webview.addEventListener('will-navigate', onWillNavigate)
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigateInPage)
    // NOTE: 'new-window' DOM event is removed in Electron 22+; handled via IPC below.
    webview.addEventListener('console-message', onConsoleMessage)

    // Sync Chrome cookies into this tile's session before the webview starts loading.
    // Only for fresh webviews — reused ones already have cookies from their previous session.
    const attachWebview = () => {
      if (!mountedRef.current || wvRef.current !== webview) return
      if (!container.contains(webview)) container.appendChild(webview)
    }

    if (!reused && !container.contains(webview)) {
      // Attempt Chrome cookie sync (async, best-effort)
      window.electron?.settings?.get().then((settings: any) => {
        if (!settings?.chromeSyncEnabled || !settings?.chromeSyncProfileDir) {
          attachWebview()
          return
        }
        const partition = `persist:browser-tile-${tileId}`
        window.electron?.chromeSync?.syncCookies(settings.chromeSyncProfileDir, partition)
          .then(() => attachWebview())
          .catch(() => attachWebview())
      }).catch(() => attachWebview())
    } else if (!container.contains(webview)) {
      container.appendChild(webview)
    }

    if (reused) {
      requestAnimationFrame(() => {
        if (!mountedRef.current || wvRef.current !== webview) return
        wvReadyRef.current = true
        updateNav()
        // Replayed webviews do not emit a fresh page-load cycle, so restore the
        // host-side bridge state explicitly on reattach.
        // Ensure assets are available before injecting — they load async from disk
        const tryInject = (attempt: number) => {
          const { js, css } = clusoAssetsRef.current
          if (js && css) {
            injectCluso()
          } else if (attempt < 20 && mountedRef.current) {
            setTimeout(() => tryInject(attempt + 1), 100)
          }
        }
        tryInject(0)
        // Reused webviews may not be re-attached to the DOM on this rAF tick yet,
        // so getURL() (→ getWebContentsId) can throw. Mirror updateNav()'s guard:
        // skip silently — the bus bridge reinjects on the next dom-ready/navigate.
        let reattachUrl: string | null = null
        try {
          reattachUrl = webview.getURL()
        } catch {
          reattachUrl = null
        }
        if (reattachUrl && shouldInjectHostBridge(reattachUrl)) {
          executeInWebview(createBusBridgeScript(tileId, bridgeTokenRef.current))
            .catch(err => console.warn('[BrowserTile] Bus bridge reinjection failed:', err))
        }
      })
    }

    return () => {
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('did-start-loading', onStartLoad)
      webview.removeEventListener('did-stop-loading', onStopLoad)
      webview.removeEventListener('did-frame-finish-load', onFrameFinishLoad)
      webview.removeEventListener('did-fail-load', onFailLoad)
      webview.removeEventListener('will-navigate', onWillNavigate)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigateInPage)
      // 'new-window' DOM listener was removed — cleanup handled by onNewWindowCleanup effect
      webview.removeEventListener('console-message', onConsoleMessage)
      // Park the live webview offscreen instead of detaching it outright.
      // Reusing a parked guest preserves page/session state across view switches.
      const parkingRoot = getWebviewParkingRoot()
      if (container.contains(webview) || webview.parentElement !== parkingRoot) {
        parkingRoot.appendChild(webview)
      }
      wvRef.current = null
      wvReadyRef.current = false
      scheduleManagedWebviewDisposal(tileId, webview)
    }
  }, [tileId, injectCluso, recordBrowserEvidence, stateLoaded])

  // Handle window.open / target=_blank from the guest webview.
  // The `new-window` DOM event was removed in Electron 22; the main process now
  // intercepts via setWindowOpenHandler and forwards via 'webview:new-window' IPC.
  // This effect is stable (no resize deps) so it never triggers a webview remount.
  useEffect(() => {
    const unsubscribe = window.electron?.browserTile?.onNewWindow?.((evt: { url: string }) => {
      if (evt.url) void dispatchOpenLink(evt.url)
    })
    return () => { unsubscribe?.() }
  }, [])

  // Keep webview background in sync with theme (avoids white flash on theme change)
  useEffect(() => {
    const webview = wvRef.current
    if (webview) webview.style.background = browserBackground
  }, [browserBackground])

  // Navigate when initialUrl prop changes (e.g. opened from sidebar)
  const prevInitialUrl = useRef(startUrl)
  useEffect(() => {
    const next = normalizeUrl(initialUrl ?? '')
    if (next !== prevInitialUrl.current) {
      prevInitialUrl.current = next
      setAddressBar(next)
      setCurrentUrl(next)
      if (wvReadyRef.current && wvRef.current) {
        safeLoadURL(wvRef.current, next)
      }
    }
  }, [initialUrl])

  // Electron webviews are their own compositor surface. During drag/resize
  // interactions, hiding the surface is more reliable than pointer-events:none
  // for keeping dock/drop gestures on the host document.
  useEffect(() => {
    const webview = wvRef.current
    const container = wvContainerRef.current
    if (!webview) return

    const blockPointerCapture = Boolean(!isVisible || isToolbarHovered || isAddressFocused || isInteracting)
    const hideWebviewSurface = Boolean(!isVisible || isInteracting)

    webview.style.pointerEvents = blockPointerCapture ? 'none' : 'auto'
    webview.style.visibility = hideWebviewSurface ? 'hidden' : 'visible'
    webview.style.opacity = hideWebviewSurface ? '0' : '1'

    if (container) {
      container.style.pointerEvents = blockPointerCapture ? 'none' : 'auto'
    }
  }, [isToolbarHovered, isAddressFocused, isInteracting, isVisible])

  // ---- navigation actions -----------------------------------------------
  const navigate = useCallback((rawUrl: string) => {
    const next = normalizeUrl(rawUrl)
    setAddressBar(next)
    setCurrentUrl(next)
    setIsLoading(true)
    if (wvReadyRef.current && wvRef.current) safeLoadURL(wvRef.current, next)
  }, [])

  const goBack = useCallback(() => {
    if (wvReadyRef.current && wvRef.current) wvRef.current.goBack()
  }, [])

  const goForward = useCallback(() => {
    if (wvReadyRef.current && wvRef.current) wvRef.current.goForward()
  }, [])

  const reload = useCallback(() => {
    if (wvReadyRef.current && wvRef.current) {
      setIsLoading(true)
      wvRef.current.reload()
    }
  }, [])

  const stop = useCallback(() => {
    if (wvReadyRef.current && wvRef.current) wvRef.current.stop()
  }, [])

  const goHome = useCallback(() => navigate(HOMEPAGE), [navigate])

  // Switch mobile / desktop UA and reload
  const switchMode = useCallback((next: BrowserMode) => {
    setMode(next)
    if (wvReadyRef.current && wvRef.current) {
      wvRef.current.setUserAgent(next === 'mobile' ? MOBILE_UA : DESKTOP_UA)
      wvRef.current.reload()
    }
  }, [])

  const captureEvidenceSnapshot = useCallback(() => {
    publishEvidenceSnapshot('user-capture')
  }, [publishEvidenceSnapshot])

  const clearBrowserEvidence = useCallback(() => {
    browserEvidenceRef.current = []
    setBrowserEvidence([])
    setCopyStatus('Evidence cleared')
    publishEvidenceSnapshot('user-clear', [])
  }, [publishEvidenceSnapshot])

  const copyEvidenceReport = useCallback(() => {
    const snapshot = publishEvidenceSnapshot('copy-report')
    const report = formatBrowserEvidenceReport(snapshot)
    if (!navigator.clipboard?.writeText) {
      setCopyStatus('Clipboard unavailable')
      return
    }
    navigator.clipboard.writeText(report)
      .then(() => setCopyStatus('Report copied'))
      .catch(() => setCopyStatus('Copy failed'))
  }, [publishEvidenceSnapshot])

  const openQaWorkbench = useCallback(() => {
    publishEvidenceSnapshot('open-qa-workbench')
    dispatchCreateTile({ type: 'ext:qa-workbench', focus: true, sourceTileId: tileId })
    setCopyStatus('Opening QA Workbench')
  }, [publishEvidenceSnapshot, tileId])

  const attachQaReportToChat = useCallback(() => {
    publishEvidenceSnapshot('attach-qa-report')
    dispatchOpenChatSurface({ extId: 'qa-workbench', surfaceId: 'qa-report', sourceTileId: tileId })
    setCopyStatus('Opening QA Report in chat')
  }, [publishEvidenceSnapshot, tileId])

  // ---- MCP/peer command bridge -----------------------------------------
  useEffect(() => {
    if (!window.electron?.bus) return

    if (mcpCommandUnsubscribeRef.current) {
      mcpCommandUnsubscribeRef.current()
      mcpCommandUnsubscribeRef.current = null
    }

    const unsubscribe = window.electron.bus.subscribe(`tile:${tileId}`, `browser:${tileId}:mcp`, (evt) => {
      if (!evt?.type?.startsWith('mcp_') && !String(evt.source || '').startsWith('mcp:')) return
      const payload = (evt.payload as Record<string, unknown>) || {}
      const command = typeof payload.command === 'string' ? payload.command : ''
      if (!command) return
      if (command === 'browser_navigate' && typeof payload.url === 'string') {
        navigate(payload.url)
        return
      }
      if (command === 'browser_reload') {
        reload()
        return
      }
      if (command === 'browser_back') {
        goBack()
        return
      }
      if (command === 'browser_forward') {
        goForward()
        return
      }
      if (command === 'browser_set_mode' && (payload.mode === 'desktop' || payload.mode === 'mobile')) {
        switchMode(payload.mode)
        return
      }
      if (command === 'browser_get_evidence' || command === 'browser_capture_snapshot') {
        publishEvidenceSnapshot(command)
      }
    })

    mcpCommandUnsubscribeRef.current = unsubscribe

    return () => {
      if (mcpCommandUnsubscribeRef.current) {
        mcpCommandUnsubscribeRef.current()
        mcpCommandUnsubscribeRef.current = null
      }
    }
  }, [tileId, navigate, reload, goBack, goForward, switchMode, publishEvidenceSnapshot])

  // Toggle cluso element selector.
  // Uses a retry loop outside the webview (via setTimeout) so that:
  //  - the attempts counter always increments
  //  - the timer is cleaned up if the component unmounts mid-polling
  const handleToggleCluso = useCallback(() => {
    const MAX_ATTEMPTS = 30
    const RETRY_DELAY_MS = 100
    const nextActive = !isClusoActive
    const toggleScript = createClusoSetActiveScript(nextActive)

    const tryToggle = (attempt: number) => {
      const webview = wvRef.current
      if (!webview || !wvReadyRef.current || !mountedRef.current) return

      executeInWebview(toggleScript).then((result: unknown) => {
        const status = typeof result === 'string' ? result : String(result ?? '')
        if ((status === '__CLUSO_NOT_READY__' || status === '__CLUSO_PENDING__') && attempt < MAX_ATTEMPTS && mountedRef.current) {
          clusoToggleTimerRef.current = setTimeout(() => tryToggle(attempt + 1), RETRY_DELAY_MS)
          return
        }

        if (status === '__CLUSO_TOGGLED__') {
          setIsClusoActiveRef.current(nextActive)
          return
        }

        if (status.startsWith('__CLUSO_TOGGLE_ERROR__')) {
          console.error('[BrowserTile] Failed to toggle Cluso:', status)
        }
      }).catch((err: unknown) => {
        console.error('[BrowserTile] Failed to toggle Cluso:', err)
      })
    }

    // If the page loaded before the embed assets were ready, injection may not
    // have happened yet. Retry it here before polling for the host bridge.
    if (!isClusoReady) injectCluso()
    tryToggle(0)
  }, [injectCluso, executeInWebview, isClusoReady, isClusoActive])

  const focusAddressInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      const pos = input.value.length
      input.setSelectionRange(pos, pos)
    })
  }, [])

  // ---- toolbar -----------------------------------------------------------
  const toolbar = (
    <form
      onSubmit={e => {
        e.preventDefault()
        navigate(addressBar)
      }}
      onMouseEnter={() => setIsToolbarHovered(true)}
      onMouseLeave={() => setIsToolbarHovered(false)}
      onMouseDown={e => {
        e.stopPropagation()
        setIsToolbarHovered(true)
      }}
      onClick={e => e.stopPropagation()}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
        paddingRight: 6
      }}
    >
      {/* Nav buttons */}
      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
        <ToolbarButton label="Back" title="Back" disabled={!canGoBack} onClick={goBack}>
          <ArrowLeft size={12} />
        </ToolbarButton>
        <ToolbarButton label="Forward" title="Forward" disabled={!canGoForward} onClick={goForward}>
          <ArrowRight size={12} />
        </ToolbarButton>
        <ToolbarButton
          label={isLoading ? 'Stop' : 'Reload'}
          title={isLoading ? 'Stop' : 'Reload'}
          onClick={isLoading ? stop : reload}
        >
          {isLoading ? <RotateCcw size={12} /> : <RotateCw size={12} />}
        </ToolbarButton>
        <ToolbarButton label="Home" title="Home" onClick={goHome}>
          <Home size={12} />
        </ToolbarButton>
      </div>

      {/* Address bar */}
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <input
          ref={inputRef}
          aria-label="Address"
          value={addressBar}
          onFocus={() => setIsAddressFocused(true)}
          onBlur={() => setIsAddressFocused(false)}
          onChange={e => setAddressBar(e.target.value)}
          onMouseDown={e => {
            e.stopPropagation()
            setIsToolbarHovered(true)
            focusAddressInput()
          }}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur()
          }}
          style={{
            width: '100%',
            height: 22,
            borderRadius: 6,
            border: `1px solid ${theme.border.default}`,
            background: theme.surface.input,
            color: theme.text.primary,
            padding: '0 8px 0 24px',
            fontSize: fonts.secondarySize,
            outline: 'none',
            boxSizing: 'border-box'
          }}
          spellCheck={false}
        />
        <div
          style={{
            position: 'absolute',
            left: 7,
            top: '50%',
            transform: 'translateY(-50%)',
            color: currentUrl.startsWith('https://') ? theme.status.success : theme.text.muted,
            display: 'flex',
            alignItems: 'center',
            pointerEvents: 'none'
          }}
        >
          <Globe size={10} />
        </div>
      </div>

      {/* Viewport mode + cluso indicator */}
      <div style={{ display: 'flex', gap: 4, flexShrink: 0, alignItems: 'center' }}>
        <ToolbarButton
          label="Desktop"
          title="Desktop mode"
          active={mode === 'desktop'}
          onClick={() => switchMode('desktop')}
        >
          <Monitor size={12} />
        </ToolbarButton>
        <ToolbarButton
          label="Mobile"
          title="Mobile mode"
          active={mode === 'mobile'}
          onClick={() => switchMode('mobile')}
        >
          <Smartphone size={12} />
        </ToolbarButton>
        <ToolbarButton
          label="Cluso"
          title={isClusoActive ? 'Finish selection' : isClusoReady ? 'Select elements for chat context' : 'Load selector'}
          active={isClusoActive}
          disabled={!isClusoReady && !currentUrl}
          onClick={handleToggleCluso}
        >
          <Crosshair size={12} />
        </ToolbarButton>
        <ToolbarButton
          label="Browser evidence"
          title={`Browser evidence: ${browserPageHealth.label}`}
          active={isEvidenceDrawerOpen}
          onClick={() => setIsEvidenceDrawerOpen(prev => !prev)}
        >
          <span style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Activity size={12} />
            {issueBadgeCount > 0 && (
              <span
                aria-label={`${issueBadgeCount} evidence events`}
                style={{
                  position: 'absolute',
                  right: -7,
                  top: -7,
                  minWidth: 12,
                  height: 12,
                  padding: '0 3px',
                  borderRadius: 99,
                  background: evidenceHealthColor,
                  color: theme.text.inverse,
                  fontSize: 8,
                  lineHeight: '12px',
                  fontWeight: 700,
                  boxShadow: `0 0 0 1px ${browserToolbarBackground}`,
                }}
              >
                {issueBadgeCount > 99 ? '99+' : issueBadgeCount}
              </span>
            )}
          </span>
        </ToolbarButton>

      </div>
    </form>
  )

  // ---- render -----------------------------------------------------------
  return (
    <div style={{ position: 'absolute', inset: 0, background: browserBackground }}>
      {/* Toolbar — explicit top/height so compositor knows exact rect; zIndex above webview */}
      {!hideNavbar && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 34,
          display: 'flex', alignItems: 'center', padding: '0 6px',
          background: browserToolbarBackground, borderBottom: `1px solid ${browserBorder}`,
          zIndex: 2,
        }}>
          {toolbar}
        </div>
      )}

      {isEvidenceDrawerOpen && !hideNavbar && (
        <div
          aria-label="Evidence drawer"
          onMouseDown={e => {
            e.stopPropagation()
            setIsToolbarHovered(true)
          }}
          onClick={e => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: 42,
            right: 8,
            width: Math.min(Math.max(width - 24, 260), 430),
            maxHeight: Math.max(160, height - 54),
            zIndex: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            padding: 10,
            borderRadius: 12,
            border: `1px solid ${theme.border.strong}`,
            background: theme.surface.panelElevated,
            boxShadow: theme.shadow.modal,
            color: theme.text.primary,
            fontSize: fonts.secondarySize,
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700 }}>
                <span style={{ width: 8, height: 8, borderRadius: 99, background: evidenceHealthColor }} />
                Browser evidence
              </div>
              <div style={{ color: theme.text.muted, fontSize: fonts.secondarySize - 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {browserPageHealth.label} · {browserEvidenceSummary.total} events · {pageTitle || currentUrl || 'No page title'}
              </div>
            </div>
            <button
              type="button"
              aria-label="Close evidence drawer"
              onClick={() => setIsEvidenceDrawerOpen(false)}
              style={{
                border: 'none',
                borderRadius: 6,
                background: theme.surface.hover,
                color: theme.text.secondary,
                cursor: 'pointer',
                padding: '3px 7px',
                fontSize: fonts.secondarySize,
              }}
            >
              Close
            </button>
          </div>

          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {BROWSER_EVIDENCE_FILTERS.map(filter => (
              <button
                key={filter.id}
                type="button"
                onClick={() => setEvidenceFilter(filter.id)}
                style={{
                  border: `1px solid ${evidenceFilter === filter.id ? theme.border.accent : theme.border.default}`,
                  borderRadius: 999,
                  background: evidenceFilter === filter.id ? theme.surface.selection : 'transparent',
                  color: evidenceFilter === filter.id ? theme.text.primary : theme.text.secondary,
                  cursor: 'pointer',
                  padding: '3px 8px',
                  fontSize: fonts.secondarySize - 1,
                }}
              >
                {filter.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              title="Capture snapshot"
              onClick={captureEvidenceSnapshot}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                border: `1px solid ${theme.border.default}`,
                borderRadius: 8,
                background: theme.surface.input,
                color: theme.text.secondary,
                cursor: 'pointer',
                padding: '6px 7px',
                fontSize: fonts.secondarySize - 1,
              }}
            >
              <ClipboardList size={12} />
              Capture snapshot
            </button>
            <button
              type="button"
              title="Copy report"
              onClick={copyEvidenceReport}
              style={{
                border: `1px solid ${theme.border.default}`,
                borderRadius: 8,
                background: theme.surface.input,
                color: theme.text.secondary,
                cursor: 'pointer',
                padding: '6px 7px',
                fontSize: fonts.secondarySize - 1,
              }}
            >
              Copy report
            </button>
            <button
              type="button"
              title="Open QA Workbench"
              onClick={openQaWorkbench}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                border: `1px solid ${theme.border.default}`,
                borderRadius: 8,
                background: theme.surface.input,
                color: theme.text.secondary,
                cursor: 'pointer',
                padding: '6px 7px',
                fontSize: fonts.secondarySize - 1,
              }}
            >
              <Bug size={12} />
              Workbench
            </button>
            <button
              type="button"
              title="Attach QA report to chat"
              onClick={attachQaReportToChat}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                border: `1px solid ${theme.border.default}`,
                borderRadius: 8,
                background: theme.surface.input,
                color: theme.text.secondary,
                cursor: 'pointer',
                padding: '6px 7px',
                fontSize: fonts.secondarySize - 1,
              }}
            >
              <ClipboardCheck size={12} />
              Attach to chat
            </button>
            <button
              type="button"
              title="Clear evidence"
              onClick={clearBrowserEvidence}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                border: `1px solid ${theme.border.default}`,
                borderRadius: 8,
                background: theme.surface.input,
                color: theme.text.secondary,
                cursor: 'pointer',
                padding: '6px 7px',
                fontSize: fonts.secondarySize - 1,
              }}
            >
              <Trash2 size={12} />
              Clear evidence
            </button>
          </div>

          {(copyStatus || lastSnapshotAt) && (
            <div style={{ color: theme.text.muted, fontSize: fonts.secondarySize - 1 }}>
              {copyStatus || 'Snapshot captured'}{lastSnapshotAt ? ` · ${new Date(lastSnapshotAt).toLocaleTimeString()}` : ''}
            </div>
          )}

          <div style={{ overflow: 'auto', minHeight: 72, borderTop: `1px solid ${theme.border.subtle}`, paddingTop: 8 }}>
            {filteredBrowserEvidence.length === 0 ? (
              <div style={{ color: theme.text.muted, padding: '12px 4px' }}>
                No browser evidence matches this filter yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                {filteredBrowserEvidence.slice(0, 50).map(event => (
                  <div
                    key={event.id}
                    style={{
                      border: `1px solid ${theme.border.subtle}`,
                      borderLeft: `3px solid ${event.severity === 'error' ? theme.status.danger : event.severity === 'warning' ? theme.status.warning : theme.border.accent}`,
                      borderRadius: 8,
                      background: theme.surface.panel,
                      padding: '7px 8px',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ color: event.severity === 'error' ? theme.status.danger : event.severity === 'warning' ? theme.status.warning : theme.text.secondary, fontWeight: 700 }}>
                        {event.kind} · {event.severity}
                      </span>
                      <span style={{ color: theme.text.muted, fontSize: fonts.secondarySize - 2 }}>
                        {new Date(event.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={{ marginTop: 4, color: theme.text.primary, lineHeight: 1.35, wordBreak: 'break-word' }}>
                      {event.message}
                    </div>
                    {(event.url || event.source || typeof event.line === 'number') && (
                      <div style={{ marginTop: 4, color: theme.text.muted, fontSize: fonts.secondarySize - 1, lineHeight: 1.3, wordBreak: 'break-word' }}>
                        {event.url || event.source}{typeof event.line === 'number' ? `:${event.line}` : ''}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Webview container — starts below toolbar (or fills entire tile when navbar hidden) */}
      <div
        ref={wvContainerRef}
        style={{ position: 'absolute', top: hideNavbar ? 0 : 34, left: 0, right: 0, bottom: 0, zIndex: 1, background: browserBackground }}
      />

      {/* Invisible overlay during drag/resize — blocks mouse events from reaching webview */}
      {isInteracting && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            pointerEvents: 'auto',
            background: 'transparent',
            zIndex: 9999
          }}
        />
      )}

      {(width < 260 || height < 170) && (
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            right: 8,
            fontSize: fonts.secondarySize - 1,
            background: theme.surface.panelElevated,
            border: `1px solid ${theme.border.default}`,
            color: theme.text.muted,
            padding: '2px 6px',
            borderRadius: 4,
            pointerEvents: 'none'
          }}
        >
          Small blocks may hide browser controls
        </div>
      )}
    </div>
  )
}
