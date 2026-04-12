import React, { useEffect, useMemo, useState } from 'react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'

type MemoryStats = {
  rss: number
  heapTotal: number
  heapUsed: number
  heapLimit: number
  external: number
  arrayBuffers: number
  bus: { channels: number; events: number; subscriptions: number; readCursors: number }
}

const REFRESH_MS = 1500

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

export function MainStatusBar(): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [stats, setStats] = useState<MemoryStats | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = () => {
      window.electron.system.memStats().then(next => {
        if (!cancelled) setStats(next)
      }).catch(() => {})
    }

    load()
    const interval = window.setInterval(load, REFRESH_MS)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  const usage = useMemo(() => {
    const heapLimit = stats?.heapLimit && stats.heapLimit > 0 ? stats.heapLimit : stats?.heapTotal ?? 0
    const heapUsed = stats?.heapUsed ?? 0
    const heapTotal = stats?.heapTotal ?? 0
    const ratio = heapLimit > 0 ? Math.min(1, heapUsed / heapLimit) : 0
    const committedRatio = heapLimit > 0 ? Math.min(1, heapTotal / heapLimit) : 0
    return { heapLimit, heapUsed, heapTotal, ratio, committedRatio }
  }, [stats])

  const fillColor = usage.ratio >= 0.85
    ? theme.status.danger
    : usage.ratio >= 0.7
      ? theme.status.warning
      : theme.accent.base

  const barBackground = theme.mode === 'light' ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.08)'
  const panelBackground = theme.mode === 'light' ? 'rgba(255,255,255,0.72)' : 'rgba(12,14,18,0.7)'
  const title = stats
    ? `Main heap ${formatBytes(usage.heapUsed)} / ${formatBytes(usage.heapLimit || usage.heapTotal)} - RSS ${formatBytes(stats.rss)} - external ${formatBytes(stats.external)}`
    : 'Loading memory stats'

  return (
    <div
      title={title}
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '0 16px',
        borderTop: `1px solid ${theme.border.subtle}`,
        background: panelBackground,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          minWidth: 0,
          width: 'min(520px, 100%)',
          justifyContent: 'flex-end',
          color: theme.text.secondary,
          fontFamily: fonts.secondary,
          fontSize: fonts.secondarySize,
          fontWeight: 500,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: 0.2,
        }}
      >
        <span style={{ color: theme.text.disabled, textTransform: 'uppercase', letterSpacing: 0.8, fontSize: fonts.secondarySize - 1 }}>
          Memory
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, maxWidth: 320 }}>
          <div
            style={{
              position: 'relative',
              flex: 1,
              height: 8,
              borderRadius: 999,
              overflow: 'hidden',
              background: barBackground,
              minWidth: 90,
            }}
          >
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${usage.committedRatio * 100}%`,
                background: theme.border.strong,
                opacity: 0.35,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${usage.ratio * 100}%`,
                background: fillColor,
                boxShadow: `0 0 10px ${fillColor}55`,
              }}
            />
          </div>
          <span style={{ whiteSpace: 'nowrap', color: usage.ratio >= 0.85 ? theme.status.danger : theme.text.secondary }}>
            {formatBytes(usage.heapUsed)} / {formatBytes(usage.heapLimit || usage.heapTotal)}
          </span>
        </div>

        <span style={{ whiteSpace: 'nowrap', color: theme.text.disabled }}>
          RSS {formatBytes(stats?.rss ?? 0)}
        </span>

        <span style={{ whiteSpace: 'nowrap', color: fillColor }}>
          {Math.round(usage.ratio * 100)}%
        </span>
      </div>
    </div>
  )
}

export default MainStatusBar
