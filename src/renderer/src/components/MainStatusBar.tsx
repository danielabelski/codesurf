import React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Cpu, Activity, ArrowUpRight, RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { Tooltip } from './Tooltip'

type MemoryStats = {
  rss: number
  heapTotal: number
  heapUsed: number
  heapLimit: number
  external: number
  arrayBuffers: number
  bus: { channels: number; events: number; subscriptions: number; readCursors: number }
}

type DaemonStatus = {
  running: boolean
  info: {
    pid: number
    port: number
    startedAt: string
    protocolVersion: number
    appVersion: string | null
  } | null
}

type DaemonSummary = DaemonStatus & {
  jobs: {
    total: number
    active: number
    backgroundActive: number
    completed: number
    failed: number
    cancelled: number
    other: number
    recent: Array<{
      id: string
      taskLabel: string | null
      status: string
      runMode: string | null
      workspaceId: string | null
      cardId: string | null
      provider: string | null
      model: string | null
      workspaceDir: string | null
      sessionId: string | null
      initialPrompt: string | null
      updatedAt: string | null
      requestedAt: string | null
      lastSequence: number
      error: string | null
    }>
  }
}

type DaemonTaskRow = DaemonSummary['jobs']['recent'][number] & {
  runCount: number
}

const REFRESH_MS = 1500
const DAEMON_REFRESH_MS = 5000

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

function formatRelativeTime(value: string | null): string {
  if (!value) return 'Unknown'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const diffSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (diffSeconds < 5) return 'just now'
  if (diffSeconds < 60) return `${diffSeconds}s ago`
  const minutes = Math.floor(diffSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function statusBadgeTheme(theme: ReturnType<typeof useTheme>, status: string): { color: string; background: string; border: string } {
  if (status === 'running' || status === 'starting' || status === 'queued' || status === 'reconnecting') {
    return {
      color: theme.status.success,
      background: `${theme.status.success}18`,
      border: `${theme.status.success}33`,
    }
  }
  if (status === 'completed') {
    return {
      color: theme.text.secondary,
      background: theme.surface.panelMuted,
      border: theme.border.subtle,
    }
  }
  if (status === 'cancelled') {
    return {
      color: theme.status.warning,
      background: `${theme.status.warning}18`,
      border: `${theme.status.warning}33`,
    }
  }
  if (status === 'failed' || status === 'lost') {
    return {
      color: theme.status.danger,
      background: `${theme.status.danger}18`,
      border: `${theme.status.danger}33`,
    }
  }
  return {
    color: theme.text.disabled,
    background: theme.surface.panelMuted,
    border: theme.border.subtle,
  }
}

function jobGroupKey(job: DaemonSummary['jobs']['recent'][number]): string {
  const sessionKey = String(job.sessionId ?? '').trim()
  if (sessionKey) return `session:${sessionKey}`

  const taskLabel = String(job.taskLabel ?? job.initialPrompt ?? '').trim().toLowerCase()
  const provider = String(job.provider ?? '').trim().toLowerCase()
  const model = String(job.model ?? '').trim().toLowerCase()
  const workspaceDir = String(job.workspaceDir ?? '').trim().toLowerCase()
  return `task:${taskLabel}::${provider}::${model}::${workspaceDir}`
}

function summarizeDaemonTaskRows(items: DaemonSummary['jobs']['recent']): DaemonTaskRow[] {
  const grouped = new Map<string, DaemonTaskRow>()

  for (const job of items) {
    const key = jobGroupKey(job)
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, { ...job, runCount: 1 })
      continue
    }

    existing.runCount += 1
    const existingTime = Date.parse(existing.updatedAt ?? existing.requestedAt ?? '') || 0
    const nextTime = Date.parse(job.updatedAt ?? job.requestedAt ?? '') || 0
    if (nextTime > existingTime) {
      grouped.set(key, { ...job, runCount: existing.runCount })
    }
  }

  return [...grouped.values()].sort((a, b) => {
    const aActive = a.status === 'running' || a.status === 'starting' || a.status === 'queued' || a.status === 'reconnecting' ? 1 : 0
    const bActive = b.status === 'running' || b.status === 'starting' || b.status === 'queued' || b.status === 'reconnecting' ? 1 : 0
    if (aActive !== bActive) return bActive - aActive
    const aTime = Date.parse(a.updatedAt ?? a.requestedAt ?? '') || 0
    const bTime = Date.parse(b.updatedAt ?? b.requestedAt ?? '') || 0
    return bTime - aTime
  })
}

interface MainStatusBarProps {
  onOpenDaemonTask?: (task: DaemonSummary['jobs']['recent'][number]) => void
  /** 'compact' (default) shows a dot + HEALTH label with hover detail.
   *  'verbose' renders the full heap bar + numbers inline. */
  health?: 'compact' | 'verbose'
}

export function MainStatusBar({ onOpenDaemonTask, health = 'compact' }: MainStatusBarProps): React.JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null)
  const [daemonSummary, setDaemonSummary] = useState<DaemonSummary | null>(null)
  const [showDaemonSummary, setShowDaemonSummary] = useState(false)
  const [daemonRestarting, setDaemonRestarting] = useState(false)
  const [daemonRestartConfirm, setDaemonRestartConfirm] = useState(false)
  const daemonRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    let cancelled = false

    const load = () => {
      window.electron.system.daemonStatus().then(next => {
        if (!cancelled) setDaemon(next)
      }).catch(() => {
        if (!cancelled) setDaemon({ running: false, info: null })
      })
    }

    load()
    const interval = window.setInterval(load, DAEMON_REFRESH_MS)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = () => {
      window.electron.system.daemonSummary().then(next => {
        if (!cancelled) setDaemonSummary(next)
      }).catch(() => {
        if (!cancelled) setDaemonSummary(null)
      })
    }

    load()
    const interval = window.setInterval(load, DAEMON_REFRESH_MS)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  useEffect(() => {
    if (!showDaemonSummary) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!daemonRef.current?.contains(event.target as Node)) {
        setShowDaemonSummary(false)
        setDaemonRestartConfirm(false)
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowDaemonSummary(false)
        setDaemonRestartConfirm(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [showDaemonSummary])

  useEffect(() => {
    if (!daemonRestartConfirm) return
    const timeout = window.setTimeout(() => setDaemonRestartConfirm(false), 2500)
    return () => window.clearTimeout(timeout)
  }, [daemonRestartConfirm])

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
  const title = stats
    ? `Main heap ${formatBytes(usage.heapUsed)} / ${formatBytes(usage.heapLimit || usage.heapTotal)} - RSS ${formatBytes(stats.rss)} - external ${formatBytes(stats.external)}`
    : 'Loading memory stats'
  const daemonColor = daemon == null
    ? theme.text.disabled
    : daemon.running
      ? theme.text.secondary
      : theme.status.danger
  const daemonDot = daemon == null
    ? theme.text.disabled
    : daemon.running
      ? theme.status.success
      : theme.status.danger
  const daemonActiveJobCount = daemonSummary?.jobs.active ?? 0
  const daemonBackgroundJobCount = daemonSummary?.jobs.backgroundActive ?? 0
  const daemonStatusLabel = daemon?.running
    ? (daemonActiveJobCount > 0 ? 'ACTIVE' : 'READY')
    : daemon == null
      ? 'DAEMON'
      : 'OFFLINE'
  const daemonStatusDetail = daemon?.running && daemonBackgroundJobCount > 0
    ? `${daemonBackgroundJobCount} BG`
    : null
  const summarizedTasks = useMemo(() => summarizeDaemonTaskRows(daemonSummary?.jobs.recent ?? []), [daemonSummary?.jobs.recent])
  const daemonStatusTextColor = daemon?.running && daemonActiveJobCount > 0
    ? theme.text.primary
    : daemonColor
  const daemonFailedJobCount = daemonSummary?.jobs.failed ?? 0
  const daemonCompletedJobCount = daemonSummary?.jobs.completed ?? 0
  const daemonTotalJobCount = daemonSummary?.jobs.total ?? 0
  const daemonSummaryLine = daemonSummary?.running
    ? [
        `${daemonActiveJobCount} active`,
        daemonBackgroundJobCount > 0 ? `${daemonBackgroundJobCount} bg` : null,
        daemonFailedJobCount > 0 ? `${daemonFailedJobCount} failed` : null,
        daemonCompletedJobCount > 0 ? `${daemonCompletedJobCount} done` : null,
        daemonTotalJobCount > 0 && daemonActiveJobCount === 0 && daemonFailedJobCount === 0 && daemonCompletedJobCount === 0 ? `${daemonTotalJobCount} jobs` : null,
      ].filter(Boolean).join(' · ')
    : 'No active daemon connection'
  const daemonTitle = daemon?.running
    ? `CodeSurf daemon ${daemonActiveJobCount > 0 ? 'active' : 'ready'}${daemonBackgroundJobCount > 0 ? ` - ${daemonBackgroundJobCount} background task${daemonBackgroundJobCount === 1 ? '' : 's'}` : ''} - PID ${daemon.info?.pid ?? 'unknown'} - port ${daemon.info?.port ?? 'unknown'}`
    : 'CodeSurf daemon offline'

  return (
    <div
      title={title}
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'flex-end',
        padding: '0 16px',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          minWidth: 0,
          width: 'min(760px, 100%)',
          justifyContent: 'flex-end',
          color: theme.text.secondary,
          fontFamily: fonts.secondary,
          fontSize: fonts.secondarySize,
          fontWeight: fonts.secondaryWeight,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: 0.2,
        }}
      >
        <div
          ref={daemonRef}
          title={daemonTitle}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            whiteSpace: 'nowrap',
            minWidth: 0,
            position: 'relative',
            pointerEvents: 'auto',
          }}
        >
          <button
            type="button"
            onMouseEnter={() => {
              window.electron.system.daemonSummary().then(setDaemonSummary).catch(() => {})
            }}
            onClick={() => {
              if (!showDaemonSummary) {
                window.electron.system.daemonSummary().then(setDaemonSummary).catch(() => {})
              }
              if (showDaemonSummary) setDaemonRestartConfirm(false)
              setShowDaemonSummary(current => !current)
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              whiteSpace: 'nowrap',
              minWidth: 0,
              background: showDaemonSummary ? theme.surface.panelMuted : 'transparent',
              border: `1px solid ${showDaemonSummary ? theme.border.default : 'transparent'}`,
              color: daemonColor,
              borderRadius: 999,
              padding: '4px 8px',
              cursor: 'pointer',
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: daemonDot,
                boxShadow: daemon?.running ? `0 0 8px ${daemonDot}66` : 'none',
                flexShrink: 0,
              }}
            />
            <Cpu
              size={15}
              strokeWidth={2}
              aria-label={daemonTitle}
              style={{ color: daemonStatusTextColor, flexShrink: 0 }}
            />
            {daemonStatusDetail && (
              <span style={{ color: theme.text.secondary, fontWeight: 600, letterSpacing: 0.3, fontSize: fonts.secondarySize }}>
                {daemonStatusDetail}
              </span>
            )}
          </button>
          {showDaemonSummary && (
            <div
              style={{
                position: 'absolute',
                right: 0,
                bottom: 'calc(100% + 10px)',
                width: 340,
                maxWidth: 'min(340px, calc(100vw - 24px))',
                background: theme.surface.panel,
                border: `1px solid ${theme.border.default}`,
                borderRadius: 14,
                boxShadow: theme.mode === 'light'
                  ? '0 18px 40px rgba(0,0,0,0.12)'
                  : '0 18px 40px rgba(0,0,0,0.45)',
                padding: '8px 8px 10px',
                pointerEvents: 'auto',
                zIndex: 5,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, padding: '4px 4px 0' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          fontSize: fonts.secondarySize,
                          color: daemonSummary?.running ? theme.status.success : theme.status.danger,
                          background: daemonSummary?.running ? `${theme.status.success}14` : `${theme.status.danger}12`,
                          border: `1px solid ${daemonSummary?.running ? `${theme.status.success}26` : `${theme.status.danger}24`}`,
                          borderRadius: 999,
                          padding: '2px 7px',
                          letterSpacing: 0.55,
                          textTransform: 'uppercase',
                          fontWeight: 700,
                        }}
                      >
                        {daemonSummary?.running ? 'Live' : 'Offline'}
                      </span>
                      <span style={{ fontSize: fonts.secondarySize, color: theme.text.muted }}>
                        {daemonSummaryLine}
                      </span>
                    </div>
                    <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, fontFamily: fonts.mono }}>
                      {daemonSummary?.running
                        ? `PID ${daemonSummary.info?.pid ?? '—'} · port ${daemonSummary.info?.port ?? '—'}`
                        : 'No active daemon connection'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => {
                        if (daemonRestarting) return
                        if (!daemonRestartConfirm) {
                          setDaemonRestartConfirm(true)
                          return
                        }
                        setDaemonRestartConfirm(false)
                        setDaemonRestarting(true)
                        window.electron.system.restartDaemon()
                          .then(next => {
                            setDaemon(next)
                            return window.electron.system.daemonSummary()
                          })
                          .then(setDaemonSummary)
                          .catch(() => {})
                          .finally(() => setDaemonRestarting(false))
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 24,
                        height: 24,
                        borderRadius: 999,
                        background: daemonRestartConfirm ? `${theme.status.danger}16` : theme.surface.panelElevated,
                        border: `1px solid ${daemonRestartConfirm ? `${theme.status.danger}40` : theme.border.subtle}`,
                        color: daemonRestartConfirm ? theme.status.danger : theme.text.muted,
                        cursor: daemonRestarting ? 'wait' : 'pointer',
                        flexShrink: 0,
                        opacity: daemonRestarting ? 0.6 : 1,
                      }}
                      title={daemonRestartConfirm ? 'Click again to confirm daemon restart' : 'Restart daemon'}
                    >
                      <RotateCcw size={11} strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        window.electron.system.daemonSummary().then(setDaemonSummary).catch(() => {})
                      }}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 24,
                        height: 24,
                        borderRadius: 999,
                        background: theme.surface.panelElevated,
                        border: `1px solid ${theme.border.subtle}`,
                        color: theme.text.muted,
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                      title="Refresh daemon summary"
                    >
                      <RefreshCw size={11} strokeWidth={2} />
                    </button>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '0 4px' }}>
                  <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, textTransform: 'uppercase', letterSpacing: 1.1, fontWeight: 700 }}>
                    Recent tasks
                  </div>
                  <div
                    style={{
                      fontSize: fonts.secondarySize,
                      color: theme.text.muted,
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {summarizedTasks.length}
                  </div>
                </div>
                {summarizedTasks.length ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto', paddingRight: 2 }}>
                    {summarizedTasks.map(job => {
                      const statusColor = statusBadgeTheme(theme, job.status).color
                      return (
                        <button
                          type="button"
                          key={job.id}
                          onClick={() => {
                            onOpenDaemonTask?.(job)
                            setShowDaemonSummary(false)
                          }}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            borderRadius: 8,
                            padding: '8px 8px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 4,
                            width: '100%',
                            textAlign: 'left',
                            cursor: onOpenDaemonTask ? 'pointer' : 'default',
                            appearance: 'none',
                            font: 'inherit',
                          }}
                          onMouseEnter={e => {
                            e.currentTarget.style.background = theme.surface.hover
                          }}
                          onMouseLeave={e => {
                            e.currentTarget.style.background = 'transparent'
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
                              <span
                                style={{
                                  fontSize: fonts.size,
                                  color: theme.text.primary,
                                  fontWeight: 650,
                                  minWidth: 0,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                                title={job.taskLabel ?? job.id}
                              >
                                {job.taskLabel ?? `${job.provider ?? 'Unknown'} task`}
                              </span>
                              <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {[job.provider, job.model].filter(Boolean).join(' · ') || 'Unknown provider'}
                              </div>
                              <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {job.runCount > 1 ? `${job.runCount} runs` : '1 run'} · {formatRelativeTime(job.updatedAt ?? job.requestedAt)}
                              </div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                              <span style={{ fontSize: fonts.secondarySize, color: statusColor, textTransform: 'capitalize', fontWeight: 500 }}>
                                {job.status}
                              </span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: theme.text.muted }}>
                                <span style={{ fontSize: fonts.secondarySize, fontWeight: 500 }}>
                                  Open
                                </span>
                                <ArrowUpRight size={12} strokeWidth={2} />
                              </div>
                            </div>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <div
                    style={{
                      padding: '8px 12px',
                      fontSize: fonts.secondarySize,
                      color: theme.text.disabled,
                    }}
                  >
                    No daemon jobs recorded yet.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {health === 'verbose' ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1, maxWidth: 240, overflow: 'hidden' }}>
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

            <span style={{ whiteSpace: 'nowrap', color: theme.text.secondary }}>
              RSS {formatBytes(stats?.rss ?? 0)}
            </span>

            <span style={{ whiteSpace: 'nowrap', color: theme.text.secondary }}>
              {Math.round(usage.ratio * 100)}%
            </span>
          </>
        ) : (
          <div style={{ pointerEvents: 'auto' }}>
            <Tooltip
              side="top"
              align="end"
              maxWidth={320}
              delay={150}
              content={
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 220, color: theme.text.primary }}>
                  <div style={{ fontWeight: 700, letterSpacing: 0.5, color: theme.text.primary }}>MEMORY HEALTH</div>
                  <div
                    style={{
                      position: 'relative',
                      height: 6,
                      borderRadius: 999,
                      overflow: 'hidden',
                      background: theme.surface.panelMuted,
                      border: `1px solid ${theme.border.subtle}`,
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: `${usage.committedRatio * 100}%`,
                        background: theme.border.default,
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
                      }}
                    />
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 2, fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ color: theme.text.muted }}>Heap</span>
                    <span>{formatBytes(usage.heapUsed)} / {formatBytes(usage.heapLimit || usage.heapTotal)} ({Math.round(usage.ratio * 100)}%)</span>
                    <span style={{ color: theme.text.muted }}>Committed</span>
                    <span>{formatBytes(usage.heapTotal)}</span>
                    <span style={{ color: theme.text.muted }}>RSS</span>
                    <span>{formatBytes(stats?.rss ?? 0)}</span>
                    <span style={{ color: theme.text.muted }}>External</span>
                    <span>{formatBytes(stats?.external ?? 0)}</span>
                  </div>
                </div>
              }
            >
              <div
                role="status"
                aria-label={`Memory health ${Math.round(usage.ratio * 100)} percent, resident ${formatBytes(stats?.rss ?? 0)}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  whiteSpace: 'nowrap',
                  background: 'transparent',
                  border: `1px solid transparent`,
                  borderRadius: 999,
                  padding: '4px 8px',
                  color: theme.text.secondary,
                  cursor: 'default',
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    background: fillColor,
                    boxShadow: `0 0 6px ${fillColor}88`,
                    flexShrink: 0,
                  }}
                />
                <Activity size={13} strokeWidth={2} style={{ color: theme.text.secondary, flexShrink: 0 }} />
              </div>
            </Tooltip>
          </div>
        )}
      </div>
    </div>
  )
}

export default MainStatusBar
