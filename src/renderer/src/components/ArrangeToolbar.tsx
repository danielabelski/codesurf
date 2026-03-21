import React, { useState } from 'react'
import { Settings } from 'lucide-react'
import type { TileState } from '../../../shared/types'



const GAP = 40

type Mode = 'grid' | 'column' | 'row'

interface Props {
  tiles: TileState[]
  onArrange: (updated: TileState[], mode: Mode) => void
  zoom: number
  onZoomToggle: () => void
  onToggleTabs: () => void
  onOpenSettings: () => void
  isTabbedView?: boolean
  activeCanvasMode?: Mode | null
}

// ─── Grid layout ────────────────────────────────────────────────────────────
function arrangeGrid(tiles: TileState[]): TileState[] {
  if (tiles.length === 0) return tiles

  const sorted = [...tiles].sort((a, b) => (b.height * b.width) - (a.height * a.width))
  const originX = Math.min(...tiles.map(t => t.x))
  const originY = Math.min(...tiles.map(t => t.y))
  const totalArea = tiles.reduce((sum, t) => sum + (t.width * t.height), 0)
  const targetRowWidth = Math.max(
    Math.max(...tiles.map(t => t.width)),
    Math.round(Math.sqrt(totalArea) * 1.35)
  )

  let cursorX = originX
  let cursorY = originY
  let rowHeight = 0

  const placed = new Map<string, TileState>()

  for (const tile of sorted) {
    const nextWidth = cursorX === originX ? tile.width : (cursorX - originX) + GAP + tile.width
    if (nextWidth > targetRowWidth && cursorX !== originX) {
      cursorX = originX
      cursorY += rowHeight + GAP
      rowHeight = 0
    }

    placed.set(tile.id, {
      ...tile,
      x: cursorX,
      y: cursorY,
    })

    cursorX += tile.width + GAP
    rowHeight = Math.max(rowHeight, tile.height)
  }

  return tiles.map(tile => placed.get(tile.id) ?? tile)
}

// ─── Column layout ──────────────────────────────────────────────────────────
function arrangeColumn(tiles: TileState[]): TileState[] {
  if (tiles.length === 0) return tiles
  const sorted = [...tiles].sort((a, b) => a.y - b.y)
  const originX = Math.min(...tiles.map(t => t.x))
  let cursor = Math.min(...tiles.map(t => t.y))
  return sorted.map(t => {
    const placed = { ...t, x: originX, y: cursor }
    cursor += t.height + GAP
    return placed
  })
}

// ─── Row layout ─────────────────────────────────────────────────────────────
function arrangeRow(tiles: TileState[]): TileState[] {
  if (tiles.length === 0) return tiles
  const sorted = [...tiles].sort((a, b) => a.x - b.x)
  const originY = Math.min(...tiles.map(t => t.y))
  let cursor = Math.min(...tiles.map(t => t.x))
  return sorted.map(t => {
    const placed = { ...t, x: cursor, y: originY }
    cursor += t.width + GAP
    return placed
  })
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
        width: 29, height: 29, borderRadius: 9,
        border: `1px solid ${active ? 'rgba(90,170,255,0.42)' : '#2d2d2d'}`,
        background: active
          ? 'linear-gradient(180deg, rgba(74,158,255,0.20) 0%, rgba(74,158,255,0.10) 100%)'
          : 'rgba(30,30,30,0.9)',
        color: active ? '#d7ebff' : '#888',
        cursor: loading ? 'wait' : 'pointer',
        transition: 'all 0.12s ease',
        fontSize: 13,
        opacity: loading ? 0.5 : 1,
        boxShadow: active
          ? 'inset 0 1px 0 rgba(255,255,255,0.14), 0 8px 24px rgba(24,84,160,0.28), 0 0 0 1px rgba(74,158,255,0.08)'
          : 'none',
        backdropFilter: active ? 'blur(14px)' : 'none',
        WebkitBackdropFilter: active ? 'blur(14px)' : 'none',
      }}
      onMouseEnter={e => {
        if (!active) {
          e.currentTarget.style.background = 'rgba(74,158,255,0.08)'
          e.currentTarget.style.color = '#aaa'
        }
      }}
      onMouseLeave={e => {
        if (!active) {
          e.currentTarget.style.background = 'rgba(30,30,30,0.9)'
          e.currentTarget.style.color = '#888'
        }
      }}
    >
      {label}
    </button>
  )
}

// ─── SVG icons ───────────────────────────────────────────────────────────────
const TabsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="5" width="14" height="10" rx="1"/>
    <rect x="1" y="2" width="4" height="4" rx="1"/>
    <rect x="6" y="2" width="4" height="4" rx="1"/>
  </svg>
)

const GridIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="1" width="6" height="6" rx="1"/>
    <rect x="9" y="1" width="6" height="6" rx="1"/>
    <rect x="1" y="9" width="6" height="6" rx="1"/>
    <rect x="9" y="9" width="6" height="6" rx="1"/>
  </svg>
)

const ColumnIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="2" y="1" width="12" height="4" rx="1"/>
    <rect x="2" y="6" width="12" height="4" rx="1"/>
    <rect x="2" y="11" width="12" height="4" rx="1"/>
  </svg>
)

const RowIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <rect x="1" y="2" width="4" height="12" rx="1"/>
    <rect x="6" y="2" width="4" height="12" rx="1"/>
    <rect x="11" y="2" width="4" height="12" rx="1"/>
  </svg>
)

// ─── Toolbar ─────────────────────────────────────────────────────────────────
export function ArrangeToolbar({ tiles, onArrange, zoom, onZoomToggle, onToggleTabs, onOpenSettings, isTabbedView = false, activeCanvasMode = null }: Props): JSX.Element {
  const [loading, setLoading] = useState(false)

  const run = (mode: Mode) => {
    if (tiles.length < 2 || loading) return
    setLoading(true)
    try {
      let updated: TileState[]
      if (mode === 'grid') updated = arrangeGrid(tiles)
      else if (mode === 'column') updated = arrangeColumn(tiles)
      else updated = arrangeRow(tiles)
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
      }}
    >
      <button
        onClick={onOpenSettings}
        title="Settings"
        style={{
          width: 29,
          height: 29,
          borderRadius: 9,
          background: 'rgba(20,20,20,0.92)',
          border: '1px solid #2d2d2d',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#888',
          transition: 'all 0.12s ease',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        }}
        onMouseEnter={e => {
          e.currentTarget.style.background = 'rgba(74,158,255,0.08)'
          e.currentTarget.style.color = '#ccc'
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
        }}
        onMouseLeave={e => {
          e.currentTarget.style.background = 'rgba(20,20,20,0.92)'
          e.currentTarget.style.color = '#888'
          e.currentTarget.style.borderColor = '#2d2d2d'
        }}
      >
        <Settings size={14} />
      </button>

      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: '4px 6px',
          background: 'rgba(20,20,20,0.92)',
          border: '1px solid #2d2d2d',
          borderRadius: 8,
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          alignItems: 'center',
        }}
      >
        <Btn label={<TabsIcon />}   title="Tabbed view"              active={isTabbedView}                              loading={false}   onClick={onToggleTabs} />
        <div style={{ width: 1, height: 18, background: '#2d2d2d', margin: '0 1px' }} />
        <Btn label={<GridIcon />}   title="Grid layout (auto-wrap)"  active={!isTabbedView && activeCanvasMode === 'grid'}   loading={loading} onClick={() => run('grid')} />
        <Btn label={<ColumnIcon />} title="Stack in column"          active={!isTabbedView && activeCanvasMode === 'column'} loading={loading} onClick={() => run('column')} />
        <Btn label={<RowIcon />}    title="Arrange in row"           active={!isTabbedView && activeCanvasMode === 'row'}    loading={loading} onClick={() => run('row')} />
        <div style={{ width: 1, height: 18, background: '#2d2d2d', margin: '0 1px' }} />
        <button
          onClick={onZoomToggle}
          title="Toggle zoom to 100%"
          style={{
            fontSize: 10,
            color: zoom === 1 ? '#4a9eff' : '#888',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: '4px 5px',
            borderRadius: 4,
            userSelect: 'none',
            fontFamily: 'inherit',
            whiteSpace: 'nowrap',
            fontVariantNumeric: 'tabular-nums',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = '#ccc' }}
          onMouseLeave={e => { e.currentTarget.style.color = zoom === 1 ? '#4a9eff' : '#888' }}
        >
          {Math.round(zoom * 100)}%
        </button>
      </div>
    </div>
  )
}
