/**
 * Multi-target host detection.
 *
 * - electron: preload installed `window.electron` (full IPC)
 * - native:   Vercel Native SDK WebView (`window.zero`)
 * - web:      plain browser
 */

export type CodesurfPlatform = 'electron' | 'native' | 'web'

export function detectPlatform(): CodesurfPlatform {
  if (typeof window === 'undefined') return 'web'
  // Electron preload always wins — never replace full IPC with daemon bridge.
  if (window.electron) return 'electron'
  const w = window as Window & { zero?: unknown; __CODESURF_PLATFORM__?: CodesurfPlatform }
  if (w.__CODESURF_PLATFORM__ === 'electron' || w.__CODESURF_PLATFORM__ === 'native' || w.__CODESURF_PLATFORM__ === 'web') {
    return w.__CODESURF_PLATFORM__
  }
  if (w.zero) return 'native'
  return 'web'
}

export function isElectronHost(): boolean {
  return detectPlatform() === 'electron'
}

export function isDaemonBackedHost(): boolean {
  const p = detectPlatform()
  return p === 'web' || p === 'native'
}
