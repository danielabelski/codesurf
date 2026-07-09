/**
 * Resolve web-host base URL for browser / Native shells.
 *
 * Priority:
 * 1. window.__CODESURF_HOST__ (injected)
 * 2. import.meta.env.VITE_CODESURF_HOST (build/dev)
 * 3. same-origin (vite proxy or production reverse proxy)
 * 4. default localhost:4177
 */

export function resolveHostBase(): string {
  if (typeof window !== 'undefined') {
    const injected = (window as Window & { __CODESURF_HOST__?: string }).__CODESURF_HOST__
    if (typeof injected === 'string' && injected.trim()) return injected.replace(/\/$/, '')
  }

  try {
    const envHost = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_CODESURF_HOST
    if (typeof envHost === 'string' && envHost.trim()) return envHost.replace(/\/$/, '')
  } catch {
    // ignore
  }

  if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
    // Dev: Vite proxies /host and /d to web-host — prefer relative same-origin.
    if (window.location.port === '5173') return ''
  }

  return 'http://127.0.0.1:4177'
}

export function hostUrl(path: string): string {
  const base = resolveHostBase()
  const p = path.startsWith('/') ? path : `/${path}`
  return `${base}${p}`
}
