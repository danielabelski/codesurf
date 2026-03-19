import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, ArrowRight, RotateCcw, RotateCw, Home, Globe, Monitor, Smartphone, Crosshair } from 'lucide-react'

const HOMEPAGE = 'https://duckduckgo.com'

const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) @collaborator/electron/0.2.0 Chrome/132.0.6834.159 Safari/537.36'
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const CLUSO_EMBED_JS_PATH = '/Users/jkneen/clawd/agentation-real/dist/assets/cluso-embed.js'
const CLUSO_EMBED_CSS_PATH = '/Users/jkneen/clawd/agentation-real/dist/assets/cluso-embed.css'

// ---------------------------------------------------------------------------
// Cluso injection script — ported verbatim from 1code agent-preview.tsx
// ---------------------------------------------------------------------------

/**
 * CLUSO_INJECTION_SCRIPT generator.
 *
 * Builds a self-executing JS string that, when evaluated inside a webview,
 * polyfills localStorage (for sandboxed contexts), creates an isolated
 * shadow-DOM-like mount point, injects the Cluso embed CSS/JS, and wires
 * up __CLUSO_HOST__ lifecycle hooks.  The returned string is passed to
 * webview.executeJavaScript() after every page load.
 */
const createClusoInjectScript = (jsContent: string, cssContent: string): string => `
(() => {
  // Polyfill localStorage for sandboxed/blank webviews where access is denied
  try { void window.localStorage; } catch {
    const _memStore = {};
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: (k) => Object.prototype.hasOwnProperty.call(_memStore, k) ? _memStore[k] : null,
        setItem: (k, v) => { _memStore[k] = String(v); },
        removeItem: (k) => { delete _memStore[k]; },
        clear: () => { for (const k in _memStore) delete _memStore[k]; },
        key: (i) => Object.keys(_memStore)[i] ?? null,
        get length() { return Object.keys(_memStore).length; },
      },
      writable: false,
      configurable: true,
    });
  }

  const ROOT_ID = '__huggi_cluso_root__';
  const MOUNT_ID = '__huggi_cluso_mount__';
  const CSS_ID = '__huggi_cluso_css__';
  const SCRIPT_ID = '__huggi_cluso_script__';
  const FLAG = '__huggiClusoBooting__';

  function log(message) {
    try { console.log(message); } catch {}
  }

  function ensureRoot() {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.style.cssText = [
        'position:fixed',
        'inset:0',
        'pointer-events:none',
        'z-index:2147483646',
        'contain:layout style paint',
        'background:transparent'
      ].join(';');
      document.body.appendChild(root);
    }
    return root;
  }

  function ensureMount(root) {
    let mount = document.getElementById(MOUNT_ID);
    if (!mount) {
      mount = document.createElement('div');
      mount.id = MOUNT_ID;
      mount.style.cssText = [
        'position:fixed',
        'inset:0',
        'pointer-events:none',
        'background:transparent'
      ].join(';');
      root.appendChild(mount);
    }
    return mount;
  }

  function ensureCss() {
    if (document.getElementById(CSS_ID)) return;
    const style = document.createElement('style');
    style.id = CSS_ID;
    style.textContent = ${JSON.stringify(cssContent)};
    document.head.appendChild(style);
  }

  const root = ensureRoot();
  const mount = ensureMount(root);
  ensureCss();

  window.__CLUSO_EMBEDDED_CONFIG__ = {
    showToolbar: false,
    defaultActive: false,
    autoExitAfterSubmit: true,
    copyToClipboard: false,
    outputDetail: "forensic",
    visibleControls: {
      pause: false,
      markers: false,
      copy: false,
      send: false,
      clear: false,
      settings: false,
      inspector: false,
      exit: false,
    },
  };

  if (window[FLAG]) {
    return '__CLUSO_ALREADY_BOOTING__';
  }

  if (window.__CLUSO_HOST__) {
    log('__CLUSO_READY__:{"reused":true}');
    return '__CLUSO_ALREADY_READY__';
  }

  if (document.getElementById(SCRIPT_ID)) {
    return '__CLUSO_ALREADY_INJECTED__';
  }

  window[FLAG] = true;

  const originalGetElementById = document.getElementById.bind(document);
  document.getElementById = function(id) {
    if (id === 'root') return mount;
    return originalGetElementById(id);
  };

  const blob = new Blob([${JSON.stringify(jsContent)}], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);

  const script = document.createElement('script');
  script.id = SCRIPT_ID;
  script.src = blobUrl;

  const restore = () => {
    document.getElementById = originalGetElementById;
    window[FLAG] = false;
    setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
  };

  script.onload = () => {
    restore();
  };

  script.onerror = () => {
    restore();
    log('__CLUSO_ERROR__:{"stage":"load"}');
  };

  document.head.appendChild(script);
  return '__CLUSO_INJECTED__';
})();
`

// ---------------------------------------------------------------------------
// Bus bridge injection script — lets webview content publish to the EventBus
// ---------------------------------------------------------------------------

function createBusBridgeScript(tileId: string): string {
  return `
    (function() {
      if (window.__collaboratorBridge) return;
      window.__collaboratorBridge = true;

      // Allow webview content to send events to the host via console.log transport
      window.collaborator = {
        publish: function(type, payload, channel) {
          console.log(JSON.stringify({
            __collaborator: true,
            type: type || 'data',
            channel: channel || 'tile:${tileId}',
            payload: payload || {}
          }));
        },
        notify: function(message, level) {
          this.publish('notification', { message: message, level: level || 'info' });
        },
        progress: function(status, percent) {
          this.publish('progress', { status: status, percent: percent });
        },
        log: function(message) {
          this.publish('activity', { message: message });
        }
      };
    })();
  `
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------
function isLikelyUrl(value: string): boolean {
  if (!value) return false
  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(value)) return true
  if (/^localhost(?::\d+)?(\/|$)/i.test(value)) return true
  if (/^127\.0\.0\.1(?::\d+)?(\/|$)/.test(value)) return true
  if (value.includes('.') && !value.includes(' ')) return true
  return false
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return HOMEPAGE
  if (trimmed === 'about:blank') return trimmed
  if (trimmed.startsWith('file://')) return trimmed
  if (trimmed.startsWith('/')) return trimmed
  if (isLikelyUrl(trimmed)) {
    if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)) return trimmed
    if (/^localhost(?::\d+)?(\/|$)/i.test(trimmed) || /^127\.0\.0\.1(?::\d+)?(\/|$)/.test(trimmed))
      return `http://${trimmed}`
    return `https://${trimmed}`
  }
  return `${HOMEPAGE}/?q=${encodeURIComponent(trimmed)}`
}

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
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 26,
        height: 26,
        borderRadius: 6,
        border: `1px solid ${active ? '#4a9eff55' : '#333'}`,
        background: disabled ? '#222' : active ? '#1e3654' : '#2b2b2b',
        color: disabled ? '#555' : active ? '#9fc7ff' : '#ccc',
        cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: 12
      }}
      onMouseEnter={e => {
        if (disabled || active) return
        e.currentTarget.style.background = '#3a3a3a'
      }}
      onMouseLeave={e => {
        if (disabled || active) return
        e.currentTarget.style.background = '#2b2b2b'
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
  initialUrl?: string
  width: number
  height: number
  zIndex: number
  isInteracting?: boolean
}

type BrowserMode = 'desktop' | 'mobile'

// ---------------------------------------------------------------------------
// BrowserTile
// ---------------------------------------------------------------------------
export function BrowserTile({ tileId, initialUrl, width, height, zIndex: _zIndex, isInteracting }: Props): React.JSX.Element {
  const wvContainerRef = useRef<HTMLDivElement>(null)
  const wvRef = useRef<Electron.WebviewTag | null>(null)
  const wvReadyRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const mountedRef = useRef(true)
  const clusoToggleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // Cluso embed assets — loaded once on mount
  const clusoAssetsRef = useRef<{ js: string | null; css: string | null }>({ js: null, css: null })

  // Stable setter refs — avoid re-adding event listeners when state changes
  const setCurrentUrlRef = useRef(setCurrentUrl)
  setCurrentUrlRef.current = setCurrentUrl
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

  // Load cluso embed assets from filesystem (once)
  useEffect(() => {
    const loadAssets = async () => {
      try {
        const [jsResult, cssResult] = await Promise.all([
          window.electron?.fs?.readFile(CLUSO_EMBED_JS_PATH),
          window.electron?.fs?.readFile(CLUSO_EMBED_CSS_PATH)
        ])
        clusoAssetsRef.current = {
          js: typeof jsResult === 'string' ? jsResult : null,
          css: typeof cssResult === 'string' ? cssResult : null
        }
      } catch (err) {
        console.warn('[BrowserTile] Could not load cluso embed assets:', err)
      }
    }
    loadAssets()
  }, [])

  // Inject cluso into the webview — called after each page load
  const injectCluso = useCallback(() => {
    const webview = wvRef.current
    if (!webview || !wvReadyRef.current) return
    const { js, css } = clusoAssetsRef.current
    if (!js || !css) {
      console.warn('[BrowserTile] Cluso assets not available — skipping injection')
      return
    }
    setIsClusoReadyRef.current(false)
    setIsClusoActiveRef.current(false)
    webview
      .executeJavaScript(createClusoInjectScript(js, css))
      .catch(err => console.error('[BrowserTile] Cluso injection failed:', err))
  }, []) // stable — reads assets via ref

  // Create the webview imperatively (1code pattern)
  useEffect(() => {
    const container = wvContainerRef.current
    if (!container) return

    const webview = document.createElement('webview') as Electron.WebviewTag
    webview.setAttribute('allowpopups', '')
    webview.setAttribute('partition', `persist:browser-tile-${tileId}`)
    webview.setAttribute('useragent', DESKTOP_UA)
    webview.setAttribute('webpreferences', 'devTools=yes')
    // Absolute inset: bypasses Chromium percentage-height bugs and CSS transform clipping
    webview.style.cssText =
      'position: absolute; top: 0; left: 0; right: 0; bottom: 0; border: none; background: #111;'

    wvRef.current = webview
    wvReadyRef.current = false

    // ---- helpers --------------------------------------------------------
    const updateNav = () => {
      if (!wvRef.current) return
      const url = wvRef.current.getURL()
      setCurrentUrlRef.current(url)
      setCanGoBackRef.current(wvRef.current.canGoBack())
      setCanGoForwardRef.current(wvRef.current.canGoForward())
      setIsLoadingRef.current(wvRef.current.isLoading())
      if (document.activeElement !== inputRef.current) {
        setAddressBarRef.current(url)
      }
    }

    // ---- event handlers -------------------------------------------------
    const onDomReady = () => {
      wvReadyRef.current = true
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
      if (wvRef.current) {
        wvRef.current
          .executeJavaScript(createBusBridgeScript(tileId))
          .catch(err => console.warn('[BrowserTile] Bus bridge injection failed:', err))
      }
    }

    const onFailLoad = () => {
      setIsLoadingRef.current(false)
      setIsClusoReadyRef.current(false)
      setIsClusoActiveRef.current(false)
    }

    const onNavigate = () => updateNav()
    const onNavigateInPage = () => updateNav()

    const onNewWindow = (e: Event) => {
      // 'new-window' is deprecated but still fires at runtime; the event
      // carries a `url` property that isn't in the base Event type.
      const ev = e as Event & { url?: string }
      if (ev.url) {
        e.preventDefault()
        window.electron?.shell?.openExternal?.(ev.url)
      }
    }

    // ---- console message handler (bus bridge + cluso) -------------------
    const onConsoleMessage = (e: Electron.ConsoleMessageEvent) => {
      const { message } = e

      // Bridge collaborator postMessage to the EventBus
      if (message.startsWith('{"__collaborator"')) {
        try {
          const data = JSON.parse(message) as {
            __collaborator?: boolean
            type?: string
            channel?: string
            payload?: Record<string, unknown>
          }
          if (data.__collaborator) {
            window.electron?.bus?.publish(
              data.channel || `tile:${tileId}`,
              data.type || 'data',
              `browser:${tileId}`,
              data.payload || {}
            )
          }
        } catch { /* not valid JSON — ignore */ }
        return
      }

      if (!message.startsWith('__CLUSO_')) return

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
    webview.addEventListener('did-fail-load', onFailLoad)
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigateInPage)
    webview.addEventListener('new-window', onNewWindow)
    webview.addEventListener('console-message', onConsoleMessage)

    webview.src = initialSrc.current
    container.appendChild(webview)

    return () => {
      webview.removeEventListener('dom-ready', onDomReady)
      webview.removeEventListener('did-start-loading', onStartLoad)
      webview.removeEventListener('did-stop-loading', onStopLoad)
      webview.removeEventListener('did-fail-load', onFailLoad)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigateInPage)
      webview.removeEventListener('new-window', onNewWindow)
      webview.removeEventListener('console-message', onConsoleMessage)
      if (container.contains(webview)) container.removeChild(webview)
      wvRef.current = null
      wvReadyRef.current = false
    }
  }, [tileId, injectCluso])

  // Navigate when initialUrl prop changes (e.g. opened from sidebar)
  const prevInitialUrl = useRef(startUrl)
  useEffect(() => {
    const next = normalizeUrl(initialUrl ?? '')
    if (next !== prevInitialUrl.current) {
      prevInitialUrl.current = next
      setAddressBar(next)
      setCurrentUrl(next)
      if (wvReadyRef.current && wvRef.current) {
        wvRef.current.loadURL(next)
      }
    }
  }, [initialUrl])

  // ---- navigation actions -----------------------------------------------
  const navigate = useCallback((rawUrl: string) => {
    const next = normalizeUrl(rawUrl)
    setAddressBar(next)
    setCurrentUrl(next)
    setIsLoading(true)
    if (wvReadyRef.current && wvRef.current) wvRef.current.loadURL(next)
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

  // Toggle cluso element selector.
  // Uses a retry loop outside the webview (via setTimeout) so that:
  //  - the attempts counter always increments
  //  - the timer is cleaned up if the component unmounts mid-polling
  const handleToggleCluso = useCallback(() => {
    const TOGGLE_SCRIPT = `
      (() => {
        const host = window.__CLUSO_HOST__;
        if (!host) return '__CLUSO_NOT_READY__';
        try {
          if (typeof host.toggleActive === 'function') {
            host.toggleActive();
          } else if (typeof host.setActive === 'function') {
            const current = host.isActive?.() ?? host.active ?? false;
            host.setActive(!current);
          }
          return '__CLUSO_TOGGLED__';
        } catch {
          return '__CLUSO_TOGGLE_ERROR__';
        }
      })();
    `

    const MAX_ATTEMPTS = 20
    const RETRY_DELAY_MS = 100

    const tryToggle = (attempt: number) => {
      const webview = wvRef.current
      if (!webview || !wvReadyRef.current || !mountedRef.current) return

      webview.executeJavaScript(TOGGLE_SCRIPT).then((result: string) => {
        if (result === '__CLUSO_NOT_READY__' && attempt < MAX_ATTEMPTS && mountedRef.current) {
          clusoToggleTimerRef.current = setTimeout(() => tryToggle(attempt + 1), RETRY_DELAY_MS)
        }
      }).catch((err: unknown) => {
        console.error('[BrowserTile] Failed to toggle Cluso:', err)
      })
    }

    tryToggle(0)
  }, [])

  // ---- portal toolbar ---------------------------------------------------
  const headerSlot =
    typeof document !== 'undefined'
      ? document.getElementById(`tile-header-slot-${tileId}`)
      : null

  const toolbar = (
    <form
      onSubmit={e => {
        e.preventDefault()
        navigate(addressBar)
      }}
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
          onChange={e => setAddressBar(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape') (e.currentTarget as HTMLInputElement).blur()
          }}
          style={{
            width: '100%',
            height: 22,
            borderRadius: 6,
            border: '1px solid #3a3a3a',
            background: '#111',
            color: '#d4d4d4',
            padding: '0 8px 0 24px',
            fontSize: 11,
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
            color: currentUrl.startsWith('https://') ? '#3fb950' : '#888',
            display: 'flex',
            alignItems: 'center'
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

      </div>
    </form>
  )

  // ---- render -----------------------------------------------------------
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#111', overflow: 'hidden' }}>
      {headerSlot && createPortal(toolbar, headerSlot)}

      {/* Imperative webview container — absolute inset avoids CSS transform clipping */}
      <div
        ref={wvContainerRef}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
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
            fontSize: 10,
            background: 'rgba(0,0,0,0.6)',
            border: '1px solid #333',
            color: '#777',
            padding: '2px 6px',
            borderRadius: 4,
            pointerEvents: 'none'
          }}
        >
          Small tiles may hide browser controls
        </div>
      )}
    </div>
  )
}
