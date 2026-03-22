import React, { useState } from 'react'
import { Settings } from 'lucide-react'
import type { TileState, GroupState } from '../../../shared/types'

const GAP = 50
const GROUP_PAD = 20
const SLIDEOUT_RESERVE_WIDTH = 272

type Mode = 'grid' | 'column' | 'row'

interface Props {
  tiles: TileState[]
  groups: GroupState[]
  onArrange: (updated: TileState[], mode: Mode) => void
  zoom: number
  onZoomToggle: () => void
  onToggleTabs: () => void
  onOpenSettings: () => void
  isTabbedView?: boolean
  activeCanvasMode?: Mode | null
}

function getArrangeWidth(tile: TileState): number {
  const reserve = tile.type === 'terminal' || tile.type === 'chat' ? SLIDEOUT_RESERVE_WIDTH : 0
  return tile.width + reserve
}

// ─── Pure-math layouts ───────────────────────────────────────────────────────

function arrangeTiles(
  tiles: TileState[],
  _groups: GroupState[],
  mode: Mode
): TileState[] {
  if (tiles.length === 0) return tiles

  if (mode === 'column') {
    let y = 0
    return tiles.map(t => {
      const out = { ...t, x: 0, y }
      y += t.height + GAP
      return out
    })
  }

  if (mode === 'row') {
    let x = 0
    return tiles.map(t => {
      const w = getArrangeWidth(t)
      const out = { ...t, x, y: 0 }
      x += w + GAP
      return out
    })
  }

  // Grid: keep each tile's natural size, pack into rows
  const cols = Math.max(1, Math.round(Math.sqrt(tiles.length * 1.6)))
  // Use a uniform column width so tiles align, but keep individual heights
  const colW = Math.max(...tiles.map(t => t.width))

  const result: TileState[] = []
  let y = 0
  for (let row = 0; row * cols < tiles.length; row++) {
    const rowTiles = tiles.slice(row * cols, (row + 1) * cols)
    const rowH = Math.max(...rowTiles.map(t => t.height))
    for (let col = 0; col < rowTiles.length; col++) {
      result.push({
        ...rowTiles[col],
        x: col * (colW + GAP),
        y,
      })
    }
    y += rowH + GAP
  }
  return result
}

// ─── Button ──────────────────────────────────────────────────────────────────
function Btn({ label, title, active, loading, onClick }: {
  label: React.ReactNode
  title: string
  active: boolean
  loading: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={loading}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 23, height: 23, borderRadius: 7,
        border: 'none',
        // @ts-ignore
        WebkitAppRegion: 'no-drag',
        background: 'transparent',
        color: active ? '#edf6ff' : '#9ca6b3',
        cursor: loading ? 'wait' : 'pointer',
        transition: 'color 0.12s ease, opacity 0.12s ease, transform 0.12s ease',
        fontSize: 12,
        opacity: loading ? 0.45 : active ? 1 : 0.82,
        padding: 0,
        boxShadow: 'none',
      }}
      onMouseEnter={e => {
        if (!active) {
          e.currentTarget.style.color = '#dde5ee'
          e.currentTarget.style.opacity = '1'
        }
      }}
      onMouseLeave={e => {
        if (!active) {
          e.currentTarget.style.color = '#9ca6b3'
          e.currentTarget.style.opacity = loading ? '0.45' : '0.82'
        }
      }}
    >
      {label}
    </button>
  )
}

// ─── SVG icons ───────────────────────────────────────────────────────────────
const TabsIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="5" width="14" height="10" rx="1"/>
    <rect x="1" y="2" width="4" height="4" rx="1"/>
    <rect x="6" y="2" width="4" height="4" rx="1"/>
  </svg>
)

const GridIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="6" height="6" rx="1"/>
    <rect x="9" y="1" width="6" height="6" rx="1"/>
    <rect x="1" y="9" width="6" height="6" rx="1"/>
    <rect x="9" y="9" width="6" height="6" rx="1"/>
  </svg>
)

const ColumnIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="1" width="12" height="4" rx="1"/>
    <rect x="2" y="6" width="12" height="4" rx="1"/>
    <rect x="2" y="11" width="12" height="4" rx="1"/>
  </svg>
)

const RowIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="2" width="4" height="12" rx="1"/>
    <rect x="6" y="2" width="4" height="12" rx="1"/>
    <rect x="11" y="2" width="4" height="12" rx="1"/>
  </svg>
)

// ─── Toolbar ─────────────────────────────────────────────────────────────────
export function ArrangeToolbar({ tiles, groups, onArrange, zoom, onZoomToggle, onToggleTabs, onOpenSettings, isTabbedView = false, activeCanvasMode = null }: Props): JSX.Element {
  const [loading, setLoading] = useState(false)

  const run = async (mode: Mode) => {
    if (tiles.length < 2 || loading) return
    setLoading(true)
    try {
      const updated = arrangeTiles(tiles, groups, mode)
      onArrange(updated, mode)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 6,
        right: 16,
        display: 'flex',
        gap: 6,
        pointerEvents: 'all',
        zIndex: 1000,
        alignItems: 'center',
        // @ts-ignore
        WebkitAppRegion: 'no-drag',
      }}
    >
      <button
        onClick={onOpenSettings}
        title="Settings"
        style={{
          width: 26,
          height: 26,
          borderRadius: 7,
          background: 'transparent',
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#9ca6b3',
          transition: 'color 0.12s ease, opacity 0.12s ease',
          opacity: 0.82,
          padding: 0,
        }}
        onMouseEnter={e => {
          e.currentTarget.style.color = '#e1e6ec'
          e.currentTarget.style.opacity = '1'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.color = '#9ca6b3'
          e.currentTarget.style.opacity = '0.82'
        }}
      >
        <Settings size={14} />
      </button>

      <div
        style={{
          display: 'flex',
          gap: 4,
          height: 29,
          padding: '2px 0',
          background: 'transparent',
          // @ts-ignore
          WebkitAppRegion: 'no-drag',
          border: 'none',
          borderRadius: 9,
          alignItems: 'center',
        }}
      >
        <Btn label={<TabsIcon />}   title="Tabbed view"              active={isTabbedView}                              loading={false}   onClick={onToggleTabs} />
        <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)', margin: '0 2px' }} />
        <Btn label={<GridIcon />}   title="Grid layout (ELK)"        active={!isTabbedView && activeCanvasMode === 'grid'}   loading={loading} onClick={() => run('grid')} />
        <Btn label={<ColumnIcon />} title="Stack in column (ELK)"    active={!isTabbedView && activeCanvasMode === 'column'} loading={loading} onClick={() => run('column')} />
        <Btn label={<RowIcon />}    title="Arrange in row (ELK)"     active={!isTabbedView && activeCanvasMode === 'row'}    loading={loading} onClick={() => run('row')} />
        <div style={{ width: 1, height: 14, background: 'rgba(255,255,255,0.08)', margin: '0 2px' }} />
        <button
          onClick={onZoomToggle}
          title="Toggle zoom to 100%"
          style={{
            fontSize: 10,
            color: zoom === 1 ? '#69afff' : '#a3abb6',
            background: 'rgba(20,20,20,0.56)',
            display: 'flex',
            alignItems: 'center',
            height: '100%',
            // @ts-ignore
            WebkitAppRegion: 'no-drag',
            border: '1px solid rgba(255,255,255,0.08)',
            cursor: 'pointer',
            padding: '0 8px',
            borderRadius: 8,
            userSelect: 'none',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.color = '#e1e6ec'
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.14)'
            e.currentTarget.style.background = 'rgba(20,20,20,0.68)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.color = zoom === 1 ? '#69afff' : '#a3abb6'
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'
            e.currentTarget.style.background = 'rgba(20,20,20,0.56)'
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
      </div>
    </div>
  )
}
