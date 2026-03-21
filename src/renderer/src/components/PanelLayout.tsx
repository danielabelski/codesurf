import React, { useState, useRef, useCallback, useEffect } from 'react'

// ─── Panel tree types ────────────────────────────────────────────────────────

export interface PanelLeaf {
  type: 'leaf'
  id: string
  tabs: string[]
  activeTab: string
}

export interface PanelSplit {
  type: 'split'
  id: string
  direction: 'horizontal' | 'vertical'
  children: PanelNode[]
  sizes: number[]
}

export type PanelNode = PanelLeaf | PanelSplit

export type DockZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

// ─── Panel element registry ───────────────────────────────────────────────────
// Mouse-event drag needs to know where each panel is on screen.
// Components register their DOM element here on mount.
const _panelElements = new Map<string, HTMLDivElement>()

function registerPanel(id: string, el: HTMLDivElement | null) {
  if (el) _panelElements.set(id, el)
  else _panelElements.delete(id)
}

function getPanelAtPoint(x: number, y: number): string | null {
  for (const [id, el] of _panelElements) {
    const r = el.getBoundingClientRect()
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id
  }
  return null
}

function getZone(x: number, y: number, panelId: string): DockZone {
  const el = _panelElements.get(panelId)
  if (!el) return 'center'
  const r = el.getBoundingClientRect()
  const rx = (x - r.left) / r.width
  const ry = (y - r.top) / r.height
  const edge = 0.25
  if (rx < edge) return 'left'
  if (rx > 1 - edge) return 'right'
  if (ry < edge) return 'top'
  if (ry > 1 - edge) return 'bottom'
  return 'center'
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let panelCounter = 0
export const newPanelId = (): string => `panel-${Date.now()}-${panelCounter++}`

export function createLeaf(tileIds: string[], activeTab?: string): PanelLeaf {
  return { type: 'leaf', id: newPanelId(), tabs: tileIds, activeTab: activeTab ?? tileIds[0] ?? '' }
}

export function findLeafByTileId(node: PanelNode, tileId: string): PanelLeaf | null {
  if (node.type === 'leaf') return node.tabs.includes(tileId) ? node : null
  for (const child of node.children) {
    const found = findLeafByTileId(child, tileId)
    if (found) return found
  }
  return null
}

export function findLeafById(node: PanelNode, panelId: string): PanelLeaf | null {
  if (node.type === 'leaf') return node.id === panelId ? node : null
  for (const child of node.children) {
    const found = findLeafById(child, panelId)
    if (found) return found
  }
  return null
}

export function getAllTileIds(node: PanelNode): string[] {
  if (node.type === 'leaf') return [...node.tabs]
  return node.children.flatMap(getAllTileIds)
}

export function removeTileFromTree(node: PanelNode, tileId: string): PanelNode | null {
  if (node.type === 'leaf') {
    const newTabs = node.tabs.filter(id => id !== tileId)
    if (newTabs.length === 0) return null
    return { ...node, tabs: newTabs, activeTab: node.activeTab === tileId ? newTabs[0] : node.activeTab }
  }
  const newChildren: PanelNode[] = []
  const newSizes: number[] = []
  for (let i = 0; i < node.children.length; i++) {
    const result = removeTileFromTree(node.children[i], tileId)
    if (result) { newChildren.push(result); newSizes.push(node.sizes[i]) }
  }
  if (newChildren.length === 0) return null
  if (newChildren.length === 1) return newChildren[0]
  const total = newSizes.reduce((a, b) => a + b, 0)
  return { ...node, children: newChildren, sizes: newSizes.map(s => (s / total) * 100) }
}

export function addTabToLeaf(node: PanelNode, panelId: string, tileId: string): PanelNode {
  if (node.type === 'leaf') {
    if (node.id !== panelId) return node
    if (node.tabs.includes(tileId)) return { ...node, activeTab: tileId }
    return { ...node, tabs: [...node.tabs, tileId], activeTab: tileId }
  }
  return { ...node, children: node.children.map(c => addTabToLeaf(c, panelId, tileId)) }
}

export function setActiveTab(node: PanelNode, panelId: string, tileId: string): PanelNode {
  if (node.type === 'leaf') return node.id === panelId ? { ...node, activeTab: tileId } : node
  return { ...node, children: node.children.map(c => setActiveTab(c, panelId, tileId)) }
}

export function closeOthersInLeaf(root: PanelNode, panelId: string, keepId: string): PanelNode {
  const update = (n: PanelNode): PanelNode => {
    if (n.type === 'leaf') {
      if (n.id !== panelId) return n
      return { ...n, tabs: [keepId], activeTab: keepId }
    }
    return { ...n, children: n.children.map(update) }
  }
  return update(root)
}

export function closeToRightInLeaf(root: PanelNode, panelId: string, tileId: string): PanelNode {
  const update = (n: PanelNode): PanelNode => {
    if (n.type === 'leaf') {
      if (n.id !== panelId) return n
      const idx = n.tabs.indexOf(tileId)
      if (idx < 0) return n
      const newTabs = n.tabs.slice(0, idx + 1)
      return { ...n, tabs: newTabs, activeTab: newTabs.includes(n.activeTab) ? n.activeTab : tileId }
    }
    return { ...n, children: n.children.map(update) }
  }
  return update(root)
}

export function splitLeaf(node: PanelNode, targetPanelId: string, tileId: string, zone: DockZone): PanelNode {
  if (node.type === 'leaf') {
    if (node.id !== targetPanelId) return node
    if (zone === 'center') return addTabToLeaf(node, targetPanelId, tileId)
    const existingTabs = node.tabs.filter(id => id !== tileId)
    const existingLeaf: PanelLeaf = {
      ...node,
      tabs: existingTabs.length > 0 ? existingTabs : node.tabs,
      activeTab: existingTabs.length > 0 && node.activeTab === tileId ? existingTabs[0] : node.activeTab,
    }
    const newLeaf = createLeaf([tileId])
    const direction: 'horizontal' | 'vertical' = zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical'
    const children: PanelNode[] = zone === 'left' || zone === 'top' ? [newLeaf, existingLeaf] : [existingLeaf, newLeaf]
    return { type: 'split', id: newPanelId(), direction, children, sizes: [50, 50] }
  }
  return { ...node, children: node.children.map(c => splitLeaf(c, targetPanelId, tileId, zone)) }
}

// ─── Dock Overlay ─────────────────────────────────────────────────────────────

function DockOverlay({ zone }: { zone: DockZone | null }): JSX.Element | null {
  if (!zone) return null
  const styles: Record<DockZone, React.CSSProperties> = {
    left:   { position: 'absolute', left: 0, top: 0, width: '50%', height: '100%' },
    right:  { position: 'absolute', right: 0, top: 0, width: '50%', height: '100%' },
    top:    { position: 'absolute', left: 0, top: 0, width: '100%', height: '50%' },
    bottom: { position: 'absolute', left: 0, bottom: 0, width: '100%', height: '50%' },
    center: { position: 'absolute', inset: 0 },
  }
  return (
    <div style={{
      ...styles[zone],
      background: 'rgba(74,158,255,0.15)',
      border: '2px solid rgba(74,158,255,0.5)',
      borderRadius: 4,
      pointerEvents: 'none',
      zIndex: 10,
    }} />
  )
}

// ─── Resize Handle ────────────────────────────────────────────────────────────

function ResizeHandle({ direction, onResize }: { direction: 'horizontal' | 'vertical'; onResize: (delta: number) => void }): JSX.Element {
  const dragging = useRef(false)
  const lastPos = useRef(0)
  // Ref so the mousemove closure always calls the latest onResize,
  // even after re-renders invalidate the original closure.
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY
    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const pos = direction === 'horizontal' ? ev.clientX : ev.clientY
      onResizeRef.current(pos - lastPos.current)
      lastPos.current = pos
    }
    const onUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [direction])

  return (
    <div
      onMouseDown={onMouseDown}
      style={{ flexShrink: 0, [direction === 'horizontal' ? 'width' : 'height']: 4, cursor: direction === 'horizontal' ? 'col-resize' : 'row-resize', background: 'transparent', position: 'relative', zIndex: 5 }}
      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(74,158,255,0.3)')}
      onMouseLeave={e => { if (!dragging.current) e.currentTarget.style.background = 'transparent' }}
    />
  )
}

// ─── Tab Bar ─────────────────────────────────────────────────────────────────

interface TabBarProps {
  tabs: { id: string; label: string }[]
  activeTab: string
  panelId: string
  onActivate: (tileId: string) => void
  onClose: (tileId: string) => void
  onTabMouseDown: (tileId: string, panelId: string, label: string, e: React.MouseEvent) => void
  onExit?: () => void
  getTileType: (tileId: string) => string
  onSplitNew: (panelId: string, tileType: string, zone: DockZone) => void
  onCloseOthers: (panelId: string, tileId: string) => void
  onCloseToRight: (panelId: string, tileId: string) => void
}

interface CtxMenu { tileId: string; tileType: string; x: number; y: number }

function TabBar({ tabs, activeTab, panelId, onActivate, onClose, onTabMouseDown, onExit, getTileType, onSplitNew, onCloseOthers, onCloseToRight }: TabBarProps): JSX.Element {
  const [ctxMenu, setCtxMenu] = useState<CtxMenu | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!ctxMenu) return
    const dismiss = () => setCtxMenu(null)
    document.addEventListener('mousedown', dismiss)
    return () => document.removeEventListener('mousedown', dismiss)
  }, [!!ctxMenu])

  // Scroll active tab into view when it changes (e.g. new tab added)
  useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const el = container.querySelector<HTMLElement>(`[data-tab-id="${activeTab}"]`)
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  }, [activeTab])

  const tabIdx = ctxMenu ? tabs.findIndex(t => t.id === ctxMenu.tileId) : -1
  const hasTabsToRight = tabIdx >= 0 && tabIdx < tabs.length - 1

  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', height: 36,
      background: '#1e1e1e', borderBottom: '1px solid #2d2d2d',
      overflow: 'hidden', flexShrink: 0, zIndex: 1,
    }}>
      {/* Scrollable tab strip */}
      <div ref={scrollRef} style={{
        display: 'flex', alignItems: 'stretch',
        flex: 1, overflowX: 'auto', overflowY: 'hidden',
        scrollbarWidth: 'none',
      }}>
        {tabs.map(tab => {
          const isActive = tab.id === activeTab
          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              onMouseDown={e => {
                if (e.button !== 0) return
                onTabMouseDown(tab.id, panelId, tab.label, e)
              }}
              onClick={() => onActivate(tab.id)}
              onContextMenu={e => {
                e.preventDefault()
                setCtxMenu({ tileId: tab.id, tileType: getTileType(tab.id), x: e.clientX, y: e.clientY })
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '0 12px', cursor: 'grab', userSelect: 'none',
                fontSize: 12, color: isActive ? '#e0e0e0' : '#888',
                background: isActive ? '#252525' : 'transparent',
                borderBottom: isActive ? '2px solid #4a9eff' : '2px solid transparent',
                borderRight: '1px solid #2d2d2d',
                transition: 'background 0.15s, color 0.15s',
                flexShrink: 0, maxWidth: 180,
              }}
              onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = '#2a2a2a' }}
              onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent' }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {tab.label}
              </span>
              <span
                onMouseDown={e => e.stopPropagation()}
                onClick={e => { e.stopPropagation(); onClose(tab.id) }}
                style={{ width: 16, height: 16, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, color: '#666', flexShrink: 0, cursor: 'pointer' }}
                onMouseEnter={e => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.background = 'rgba(255,255,255,0.1)' }}
                onMouseLeave={e => { e.currentTarget.style.color = '#666'; e.currentTarget.style.background = 'transparent' }}
              >
                ×
              </span>
            </div>
          )
        })}
      </div>

      {/* Fixed right actions — never scrolls with tabs */}
      <div style={{
        display: 'flex', alignItems: 'center', flexShrink: 0,
        padding: '0 8px', gap: 4,
        borderLeft: '1px solid #2d2d2d', background: '#1e1e1e',
      }}>
        {onExit && (
          <button
            onMouseDown={e => e.stopPropagation()}
            onClick={e => { e.stopPropagation(); onExit() }}
            title="Back to canvas"
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              color: '#555', display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, borderRadius: 4, flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; e.currentTarget.style.color = '#ccc' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#555' }}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M1 4V1H4M10 1H13V4M13 10V13H10M4 13H1V10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        )}
      </div>

      {/* Context menu — position: fixed to escape overflow clipping */}
      {ctxMenu && (
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'fixed', left: ctxMenu.x, top: ctxMenu.y,
            background: '#1c1c1c', border: '1px solid #2a2a2a',
            borderRadius: 8, padding: 4, zIndex: 999999,
            minWidth: 190, boxShadow: '0 8px 24px rgba(0,0,0,0.7)',
          }}
        >
          {([
            { label: 'Split Left',   zone: 'left'   },
            { label: 'Split Right',  zone: 'right'  },
            { label: 'Split Up',     zone: 'top'    },
            { label: 'Split Down',   zone: 'bottom' },
          ] as { label: string; zone: DockZone }[]).map(item => (
            <CtxItem key={item.zone} label={item.label} onClick={() => {
              onSplitNew(panelId, ctxMenu.tileType, item.zone)
              setCtxMenu(null)
            }} />
          ))}
          <CtxDivider />
          <CtxItem label="Close" onClick={() => { onClose(ctxMenu.tileId); setCtxMenu(null) }} />
          <CtxItem label="Close Others" onClick={() => { onCloseOthers(panelId, ctxMenu.tileId); setCtxMenu(null) }} disabled={tabs.length <= 1} />
          <CtxItem label="Close to Right" onClick={() => { onCloseToRight(panelId, ctxMenu.tileId); setCtxMenu(null) }} disabled={!hasTabsToRight} />
        </div>
      )}
    </div>
  )
}

function CtxItem({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }): JSX.Element {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        padding: '5px 10px', borderRadius: 5, cursor: disabled ? 'default' : 'pointer',
        fontSize: 12, color: disabled ? '#444' : '#ccc', userSelect: 'none',
      }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = '#2a2a2a' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
    >
      {label}
    </div>
  )
}

function CtxDivider(): JSX.Element {
  return <div style={{ height: 1, background: '#2a2a2a', margin: '3px 0' }} />
}

// ─── Empty Panel ─────────────────────────────────────────────────────────────

const QUICK_ACTIONS = [
  { type: 'terminal', label: 'Terminal' },
  { type: 'code',     label: 'Code' },
  { type: 'note',     label: 'Note' },
  { type: 'browser',  label: 'Browser' },
  { type: 'chat',     label: 'Chat' },
]

function EmptyPanel({ onAddTile }: { onAddTile: (type: string) => void }): JSX.Element {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#1a1a1a', gap: 16 }}>
      <span style={{ fontSize: 13, color: '#555', userSelect: 'none' }}>Open a tile or drag a tab here</span>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {QUICK_ACTIONS.map(action => (
          <button
            key={action.type}
            onClick={() => onAddTile(action.type)}
            style={{ background: '#252525', border: '1px solid #333', borderRadius: 6, color: '#aaa', fontSize: 12, padding: '6px 14px', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.background = '#2a2a2a'; e.currentTarget.style.borderColor = '#4a9eff'; e.currentTarget.style.color = '#ddd' }}
            onMouseLeave={e => { e.currentTarget.style.background = '#252525'; e.currentTarget.style.borderColor = '#333'; e.currentTarget.style.color = '#aaa' }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ─── Leaf Panel ───────────────────────────────────────────────────────────────

interface LeafPanelProps {
  leaf: PanelLeaf
  getTileLabel: (tileId: string) => string
  renderTile: (tileId: string) => React.ReactNode
  onActivate: (panelId: string, tileId: string) => void
  onCloseTab: (tileId: string) => void
  onTabMouseDown: (tileId: string, panelId: string, label: string, e: React.MouseEvent) => void
  onPanelFocus: (panelId: string) => void
  onAddTile: (type: string) => void
  dragTarget: { panelId: string; zone: DockZone } | null
  onExit: () => void
  getTileType: (tileId: string) => string
  onSplitNew: (panelId: string, tileType: string, zone: DockZone) => void
  onCloseOthers: (panelId: string, tileId: string) => void
  onCloseToRight: (panelId: string, tileId: string) => void
}

function LeafPanel({ leaf, getTileLabel, renderTile, onActivate, onCloseTab, onTabMouseDown, onPanelFocus, onAddTile, dragTarget, onExit, getTileType, onSplitNew, onCloseOthers, onCloseToRight }: LeafPanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const tabs = leaf.tabs.map(id => ({ id, label: getTileLabel(id) }))
  const isEmpty = tabs.length === 0
  const dockZone = dragTarget?.panelId === leaf.id ? dragTarget.zone : null

  useEffect(() => {
    const el = panelRef.current
    registerPanel(leaf.id, el)
    return () => { registerPanel(leaf.id, null) }
  }, [leaf.id])

  return (
    <div
      ref={panelRef}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, position: 'relative' }}
      onClick={() => onPanelFocus(leaf.id)}
    >
      {!isEmpty && (
        <TabBar
          tabs={tabs}
          activeTab={leaf.activeTab}
          panelId={leaf.id}
          onActivate={tileId => onActivate(leaf.id, tileId)}
          onClose={onCloseTab}
          onTabMouseDown={onTabMouseDown}
          onExit={onExit}
          getTileType={getTileType}
          onSplitNew={onSplitNew}
          onCloseOthers={onCloseOthers}
          onCloseToRight={onCloseToRight}
        />
      )}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
        {isEmpty ? (
          <EmptyPanel onAddTile={onAddTile} />
        ) : (
          leaf.tabs.map(tileId => (
            <div
              key={tileId}
              style={{
                position: 'absolute',
                inset: 0,
                visibility: tileId === leaf.activeTab ? 'visible' : 'hidden',
                pointerEvents: tileId === leaf.activeTab ? 'auto' : 'none',
              }}
            >
              {renderTile(tileId)}
            </div>
          ))
        )}
      </div>
      <DockOverlay zone={dockZone} />
    </div>
  )
}

// ─── Main PanelLayout ─────────────────────────────────────────────────────────

export interface PanelLayoutProps {
  root: PanelNode
  getTileLabel: (tileId: string) => string
  renderTile: (tileId: string) => React.ReactNode
  onLayoutChange: (newRoot: PanelNode) => void
  onCloseTab: (tileId: string) => void
  onAddTile: (type: string) => void
  onExit: () => void
  activePanelId: string | null
  onActivePanelChange: (panelId: string) => void
  getTileType: (tileId: string) => string
  onSplitNew: (panelId: string, tileType: string, zone: DockZone) => void
  onCloseOthers: (panelId: string, tileId: string) => void
  onCloseToRight: (panelId: string, tileId: string) => void
}

export function PanelLayout({ root, getTileLabel, renderTile, onLayoutChange, onCloseTab, onAddTile, onExit, activePanelId: _activePanelId, onActivePanelChange, getTileType, onSplitNew, onCloseOthers, onCloseToRight }: PanelLayoutProps): JSX.Element {
  const [dragTarget, setDragTarget] = useState<{ panelId: string; zone: DockZone } | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const handleDockRef = useRef<(tileId: string, fromPanelId: string, targetPanelId: string, zone: DockZone) => void>(() => {})

  const handleActivate = useCallback((panelId: string, tileId: string) => {
    onActivePanelChange(panelId)
    onLayoutChange(setActiveTab(root, panelId, tileId))
  }, [root, onLayoutChange, onActivePanelChange])

  const handleDock = useCallback((tileId: string, fromPanelId: string, targetPanelId: string, zone: DockZone) => {
    if (fromPanelId === targetPanelId && zone === 'center') return

    if (fromPanelId === targetPanelId) {
      onLayoutChange(splitLeaf(root, targetPanelId, tileId, zone))
      return
    }

    let updated = removeTileFromTree(root, tileId) ?? createLeaf([tileId])
    updated = splitLeaf(updated, targetPanelId, tileId, zone)
    onLayoutChange(updated)
  }, [root, onLayoutChange])
  handleDockRef.current = handleDock

  const handleTabMouseDown = useCallback((tileId: string, fromPanelId: string, label: string, e: React.MouseEvent) => {
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!dragging && Math.sqrt(dx * dx + dy * dy) > 5) {
        dragging = true
        document.body.style.cursor = 'grabbing'
        document.body.style.userSelect = 'none'
      }
      if (!dragging) return

      setGhost({ x: ev.clientX, y: ev.clientY, label })

      const panelId = getPanelAtPoint(ev.clientX, ev.clientY)
      if (panelId) {
        setDragTarget({ panelId, zone: getZone(ev.clientX, ev.clientY, panelId) })
      } else {
        setDragTarget(null)
      }
    }

    const onUp = (ev: MouseEvent) => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setGhost(null)
      setDragTarget(null)

      if (!dragging) return

      const targetPanelId = getPanelAtPoint(ev.clientX, ev.clientY)
      if (!targetPanelId) return
      const zone = getZone(ev.clientX, ev.clientY, targetPanelId)
      handleDockRef.current(tileId, fromPanelId, targetPanelId, zone)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  const handleResize = useCallback((splitId: string, index: number, delta: number, totalPx: number) => {
    const update = (node: PanelNode): PanelNode => {
      if (node.type === 'leaf') return node
      if (node.id === splitId) {
        const pct = (delta / totalPx) * 100
        const sizes = [...node.sizes]
        sizes[index] = Math.max(10, sizes[index] + pct)
        sizes[index + 1] = Math.max(10, sizes[index + 1] - pct)
        return { ...node, sizes }
      }
      return { ...node, children: node.children.map(update) }
    }
    onLayoutChange(update(root))
  }, [root, onLayoutChange])

  const renderNode = (node: PanelNode): React.ReactNode => {
    if (node.type === 'leaf') {
      return (
        <LeafPanel
          key={node.id}
          leaf={node}
          getTileLabel={getTileLabel}
          renderTile={renderTile}
          onActivate={handleActivate}
          onCloseTab={onCloseTab}
          onTabMouseDown={handleTabMouseDown}
          onPanelFocus={onActivePanelChange}
          onAddTile={onAddTile}
          dragTarget={dragTarget}
          onExit={onExit}
          getTileType={getTileType}
          onSplitNew={onSplitNew}
          onCloseOthers={onCloseOthers}
          onCloseToRight={onCloseToRight}
        />
      )
    }

    return (
      <div
        key={node.id}
        data-split-id={node.id}
        style={{ display: 'flex', flexDirection: node.direction === 'horizontal' ? 'row' : 'column', flex: 1, minWidth: 0, minHeight: 0 }}
      >
        {node.children.map((child, i) => (
          <React.Fragment key={child.id}>
            <div style={{ flex: `${node.sizes[i]} 0 0%`, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {renderNode(child)}
            </div>
            {i < node.children.length - 1 && (
              <ResizeHandle
                direction={node.direction}
                onResize={delta => {
                  const el = document.querySelector(`[data-split-id="${node.id}"]`) as HTMLElement
                  const totalPx = el ? (node.direction === 'horizontal' ? el.clientWidth : el.clientHeight) : 800
                  handleResize(node.id, i, delta, totalPx)
                }}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    )
  }

  return (
    <div
      style={{ position: 'absolute', top: 0, right: 8, bottom: 8, left: 8, zIndex: 99990, background: '#1e1e1e', display: 'flex', flexDirection: 'column', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.12)' }}
      onMouseDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
    >
      {/* Panel tree */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {renderNode(root)}
      </div>

      {/* Drag ghost — follows cursor */}
      {ghost && (
        <div style={{
          position: 'fixed', left: ghost.x + 12, top: ghost.y - 10,
          background: '#252525', border: '1px solid #4a9eff',
          borderRadius: 4, padding: '2px 10px', fontSize: 12, color: '#e0e0e0',
          pointerEvents: 'none', zIndex: 100000, userSelect: 'none',
        }}>
          {ghost.label}
        </div>
      )}
    </div>
  )
}
