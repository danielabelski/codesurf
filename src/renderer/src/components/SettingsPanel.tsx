import React, { useEffect, useState, useCallback } from 'react'
import type { AppSettings, FontConfig } from '../../../shared/types'
import { DEFAULT_SETTINGS, withDefaultSettings } from '../../../shared/types'
import { Settings, Type, Monitor, Terminal, FolderOpen, Layout, Sliders, Network, Plus, Trash2, ChevronDown, ChevronRight } from 'lucide-react'

interface Workspace {
  id: string
  name: string
  path: string
}

interface Props {
  onClose: () => void
  onSettingsChange: (s: AppSettings) => void
  workspaces?: Workspace[]
}

type Section = 'general' | 'canvas' | 'terminal' | 'sidebar' | 'tiles' | 'behaviour' | 'mcp'

const SECTIONS: { id: Section; label: string; icon: React.ReactNode; description: string }[] = [
  { id: 'general',   label: 'General',   icon: <Type size={15} />,      description: 'App typography — primary, secondary and monospace fonts' },
  { id: 'canvas',    label: 'Canvas',    icon: <Monitor size={15} />,   description: 'Background, grid and snap settings' },
  { id: 'terminal',  label: 'Terminal',  icon: <Terminal size={15} />,  description: 'Font size and family for terminal tiles' },
  { id: 'sidebar',   label: 'Sidebar',   icon: <FolderOpen size={15} />,description: 'File tree sort and ignored folders' },
  { id: 'tiles',     label: 'Tiles',     icon: <Layout size={15} />,    description: 'Default sizes for each tile type' },
  { id: 'behaviour', label: 'Behaviour', icon: <Sliders size={15} />,   description: 'Auto-save interval and UI font size' },
  { id: 'mcp',       label: 'MCP',       icon: <Network size={15} />,   description: 'Model Context Protocol server connections' },
]

// ─── MCP types ────────────────────────────────────────────────────────────────
interface MCPServerEntry {
  type?: 'stdio' | 'sse' | 'http'
  url?: string
  cmd?: string
  args?: string[]
  command?: string
  description?: string
  enabled?: boolean
}

interface MCPConfig {
  port: number
  url: string
  mcpServers: Record<string, MCPServerEntry>
  endpoints: Record<string, string>
  updatedAt: string
}

// ─── Control components ────────────────────────────────────────────────────────
function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): JSX.Element {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 44, height: 26, borderRadius: 13, cursor: 'pointer', flexShrink: 0,
        background: value ? '#666' : '#333',
        position: 'relative', transition: 'background 0.2s',
      }}
    >
      <div style={{
        position: 'absolute',
        top: 3, left: value ? 21 : 3,
        width: 20, height: 20, borderRadius: '50%',
        background: value ? '#fff' : '#888',
        transition: 'left 0.2s, background 0.2s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)'
      }} />
    </div>
  )
}

function NumInput({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }): JSX.Element {
  return (
    <input
      type="number" value={value} min={min} max={max} step={step}
      onChange={e => onChange(Number(e.target.value))}
      style={{
        width: 72, padding: '5px 10px', fontSize: 13,
        background: '#222', color: '#ccc',
        border: '1px solid #333', borderRadius: 8, outline: 'none',
        textAlign: 'right', fontFamily: 'monospace'
      }}
    />
  )
}

function TextInput({ value, onChange, width = 240 }: { value: string; onChange: (v: string) => void; width?: number }): JSX.Element {
  return (
    <input
      type="text" value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width, padding: '5px 10px', fontSize: 12,
        background: '#222', color: '#ccc',
        border: '1px solid #333', borderRadius: 8, outline: 'none',
        fontFamily: 'monospace'
      }}
    />
  )
}

function ColorSwatch({ value, onChange }: { value: string; onChange: (v: string) => void }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <div
          style={{ width: 28, height: 28, borderRadius: 6, background: value, cursor: 'pointer', border: '1px solid #444' }}
          onClick={e => (e.currentTarget.nextSibling as HTMLInputElement)?.click()}
        />
        <input type="color" value={value} onChange={e => onChange(e.target.value)}
          style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }} />
      </div>
      <span style={{ fontSize: 11, color: '#555', fontFamily: 'monospace' }}>{value}</span>
    </div>
  )
}

const SANS_FONTS = [
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif',
  '"SF Pro Display", "Segoe UI", "Helvetica Neue", sans-serif',
  '"Helvetica Neue", Helvetica, Arial, sans-serif',
  '"Inter", "Segoe UI", sans-serif',
  '"Geist", "SF Pro Text", sans-serif',
  'system-ui, sans-serif',
]

const MONO_FONTS = [
  '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", "Fira Code", monospace',
  '"Fira Code", "JetBrains Mono", monospace',
  '"SF Mono", "Menlo", "Monaco", monospace',
  '"Cascadia Code", "Fira Code", monospace',
  '"Source Code Pro", "Menlo", monospace',
  '"Geist Mono", "SF Mono", monospace',
  'monospace',
]

function FontSelect({ value, onChange, fonts }: { value: string; onChange: (v: string) => void; fonts: string[] }): JSX.Element {
  const displayName = (stack: string) => {
    const first = stack.split(',')[0].trim().replace(/^"|"$/g, '')
    return first.startsWith('-apple-system') ? 'System Default' : first
  }
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        width: 200, padding: '5px 10px', fontSize: 12,
        background: '#222', color: '#ccc',
        border: '1px solid #333', borderRadius: 8, outline: 'none',
        fontFamily: value
      }}
    >
      {fonts.map(f => (
        <option key={f} value={f} style={{ fontFamily: f }}>
          {displayName(f)}
        </option>
      ))}
      {!fonts.includes(value) && (
        <option value={value} style={{ fontFamily: value }}>
          {displayName(value)} (custom)
        </option>
      )}
    </select>
  )
}

function FontGroup({ label, font, onChange, fonts }: {
  label: string
  font: FontConfig
  onChange: (f: FontConfig) => void
  fonts: string[]
}): JSX.Element {
  return (
    <>
      <SectionLabel label={label} />
      <SettingRow label="Font family" description="Select from common font stacks">
        <FontSelect value={font.family} onChange={v => onChange({ ...font, family: v })} fonts={fonts} />
      </SettingRow>
      <SettingRow label="Font size" description="Size in pixels">
        <NumInput value={font.size} min={8} max={32} onChange={v => onChange({ ...font, size: v })} />
      </SettingRow>
      <SettingRow label="Line height" description="Line height multiplier">
        <NumInput value={font.lineHeight} min={1} max={3} step={0.1} onChange={v => onChange({ ...font, lineHeight: v })} />
      </SettingRow>
    </>
  )
}

// ─── Setting row ──────────────────────────────────────────────────────────────
function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }): JSX.Element {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: '#161616', borderRadius: 10, padding: '14px 16px',
      marginBottom: 8, gap: 16
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, color: '#e0e0e0', fontWeight: 500, marginBottom: description ? 3 : 0 }}>{label}</div>
        {description && <div style={{ fontSize: 12, color: '#555' }}>{description}</div>}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  )
}

function SectionLabel({ label }: { label: string }): JSX.Element {
  return (
    <div style={{
      fontSize: 11, fontWeight: 600, color: '#555',
      letterSpacing: '0.08em', textTransform: 'uppercase',
      marginTop: 20, marginBottom: 8, paddingLeft: 2
    }}>
      {label}
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────
export function SettingsPanel({ onClose, onSettingsChange, workspaces = [] }: Props): JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [section, setSection] = useState<Section>('general')
  const [mcpConfig, setMcpConfig] = useState<MCPConfig | null>(null)
  const [mcpSaved, setMcpSaved] = useState(false)
  const [addingServer, setAddingServer] = useState(false)
  const [newServer, setNewServer] = useState({ name: '', url: '', cmd: '', description: '' })
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [workspaceServers, setWorkspaceServers] = useState<Record<string, Record<string, MCPServerEntry>>>({})
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)

  useEffect(() => {
    window.electron.settings?.get().then((s: AppSettings) => {
      if (s) setSettings(withDefaultSettings(s))
    })
    window.electron.mcp?.getConfig?.().then((cfg: MCPConfig) => {
      if (cfg) setMcpConfig(cfg)
    })
  }, [])

  // Load workspace MCP servers when MCP section is opened
  useEffect(() => {
    if (section !== 'mcp') return
    Promise.all(
      workspaces.map(async ws => {
        const servers = await window.electron.mcp?.getWorkspaceServers?.(ws.id) ?? {}
        return [ws.id, servers] as [string, Record<string, MCPServerEntry>]
      })
    ).then(entries => {
      setWorkspaceServers(Object.fromEntries(entries))
      if (!activeWorkspaceId && workspaces.length > 0) {
        setActiveWorkspaceId(workspaces[0].id)
      }
    })
  }, [section, workspaces])

  // ─── MCP helpers ────────────────────────────────────────────────────────
  const saveMcpServers = useCallback(async (servers: Record<string, MCPServerEntry>) => {
    const cfg = await window.electron.mcp?.saveServers?.(servers)
    if (cfg) {
      setMcpConfig(cfg)
      setMcpSaved(true)
      setTimeout(() => setMcpSaved(false), 2000)
    }
  }, [])

  const updateServer = useCallback((name: string, patch: Partial<MCPServerEntry>) => {
    if (!mcpConfig) return
    const servers = { ...mcpConfig.mcpServers }
    servers[name] = { ...servers[name], ...patch }
    // Don't pass collaborator through saveServers — it's preserved server-side
    const { collaborator: _, ...rest } = servers
    saveMcpServers(rest)
  }, [mcpConfig, saveMcpServers])

  const removeServer = useCallback((name: string) => {
    if (!mcpConfig) return
    const { collaborator: _, [name]: __, ...rest } = mcpConfig.mcpServers
    saveMcpServers(rest)
  }, [mcpConfig, saveMcpServers])

  const addServer = useCallback(() => {
    if (!newServer.name.trim() || !mcpConfig) return
    const { collaborator: _, ...rest } = mcpConfig.mcpServers
    const entry: MCPServerEntry = {
      type: newServer.url ? 'http' : 'stdio',
      ...(newServer.url ? { url: newServer.url } : {}),
      ...(newServer.cmd ? { cmd: newServer.cmd } : {}),
      ...(newServer.description ? { description: newServer.description } : {}),
      enabled: true
    }
    saveMcpServers({ ...rest, [newServer.name.trim()]: entry })
    setNewServer({ name: '', url: '', cmd: '', description: '' })
    setAddingServer(false)
  }, [newServer, mcpConfig, saveMcpServers])

  const saveWorkspaceServers = useCallback(async (wsId: string, servers: Record<string, MCPServerEntry>) => {
    const saved = await window.electron.mcp?.saveWorkspaceServers?.(wsId, servers)
    if (saved) setWorkspaceServers(prev => ({ ...prev, [wsId]: saved }))
  }, [])

  const updateWorkspaceServer = useCallback((wsId: string, name: string, patch: Partial<MCPServerEntry>) => {
    const current = workspaceServers[wsId] ?? {}
    saveWorkspaceServers(wsId, { ...current, [name]: { ...current[name], ...patch } })
  }, [workspaceServers, saveWorkspaceServers])

  const removeWorkspaceServer = useCallback((wsId: string, name: string) => {
    const { [name]: _, ...rest } = workspaceServers[wsId] ?? {}
    saveWorkspaceServers(wsId, rest)
  }, [workspaceServers, saveWorkspaceServers])

  // Auto-save on every change
  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value }
      window.electron.settings?.set(next).then((saved: AppSettings) => {
        if (saved) onSettingsChange(saved)
      })
      return next
    })
  }, [onSettingsChange])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const active = SECTIONS.find(s => s.id === section)!

  const renderContent = () => {
    switch (section) {
      case 'general':
        return (
          <>
            <FontGroup label="Primary Font" font={settings.primaryFont} onChange={v => update('primaryFont', v)} fonts={SANS_FONTS} />
            <FontGroup label="Secondary Font" font={settings.secondaryFont} onChange={v => update('secondaryFont', v)} fonts={SANS_FONTS} />
            <FontGroup label="Monospace Font" font={settings.monoFont} onChange={v => update('monoFont', v)} fonts={MONO_FONTS} />
            <div style={{ marginTop: 16, padding: '12px 16px', background: '#0d0d0d', borderRadius: 10, border: '1px solid #1a1a1a' }}>
              <div style={{ fontSize: 12, color: '#555' }}>
                <strong style={{ color: '#666' }}>Primary</strong> — headings, labels, and UI text.{' '}
                <strong style={{ color: '#666' }}>Secondary</strong> — descriptions, metadata, and smaller text.{' '}
                <strong style={{ color: '#666' }}>Monospace</strong> — code, terminals, and data.
              </div>
            </div>
          </>
        )
      case 'canvas':
        return (
          <>
            <SectionLabel label="Display" />
            <SettingRow label="Background colour" description="Canvas background color">
              <ColorSwatch value={settings.canvasBackground} onChange={v => update('canvasBackground', v)} />
            </SettingRow>
            <SectionLabel label="Grid" />
            <SettingRow label="Small dot colour" description="Color of the small grid dots">
              <ColorSwatch value={settings.gridColorSmall} onChange={v => update('gridColorSmall', v)} />
            </SettingRow>
            <SettingRow label="Large dot colour" description="Color of the large grid dots">
              <ColorSwatch value={settings.gridColorLarge} onChange={v => update('gridColorLarge', v)} />
            </SettingRow>
            <SettingRow label="Small dot spacing" description="Distance between small dots in pixels">
              <NumInput value={settings.gridSpacingSmall} min={4} max={200} onChange={v => update('gridSpacingSmall', v)} />
            </SettingRow>
            <SettingRow label="Large dot spacing" description="Distance between large dots in pixels">
              <NumInput value={settings.gridSpacingLarge} min={20} max={500} onChange={v => update('gridSpacingLarge', v)} />
            </SettingRow>
            <SectionLabel label="Snap" />
            <SettingRow label="Snap grid size" description="Snap grid size in pixels">
              <NumInput value={settings.gridSize} min={4} max={80} onChange={v => update('gridSize', v)} />
            </SettingRow>
            <SettingRow label="Snap to grid" description="Snap tiles to the grid when dragging">
              <Toggle value={settings.snapToGrid} onChange={v => update('snapToGrid', v)} />
            </SettingRow>
          </>
        )
      case 'terminal':
        return (
          <>
            <SectionLabel label="Font" />
            <SettingRow label="Font size" description="Terminal font size in points">
              <NumInput value={settings.terminalFontSize} min={8} max={24} onChange={v => update('terminalFontSize', v)} />
            </SettingRow>
            <SettingRow label="Font family" description="Font stack for terminals">
              <TextInput value={settings.terminalFontFamily} onChange={v => update('terminalFontFamily', v)} />
            </SettingRow>
          </>
        )
      case 'sidebar':
        return (
          <>
            <SectionLabel label="Files" />
            <SettingRow label="Default sort" description="Initial sort order for the file tree">
              <select value={settings.sidebarDefaultSort}
                onChange={e => update('sidebarDefaultSort', e.target.value as AppSettings['sidebarDefaultSort'])}
                style={{ padding: '5px 10px', fontSize: 13, background: '#222', color: '#ccc', border: '1px solid #333', borderRadius: 8, outline: 'none' }}>
                <option value="name">Name</option>
                <option value="type">Type</option>
                <option value="ext">Ext</option>
              </select>
            </SettingRow>
            <SettingRow label="Ignored folders" description="Comma-separated list of folders to hide">
              <TextInput value={settings.sidebarIgnored.join(', ')}
                onChange={v => update('sidebarIgnored', v.split(',').map(s => s.trim()).filter(Boolean))}
                width={280} />
            </SettingRow>
          </>
        )
      case 'tiles':
        return (
          <>
            <SectionLabel label="Default tile sizes" />
            {(['terminal', 'code', 'note', 'image', 'kanban', 'browser'] as const).map(type => (
              <SettingRow key={type} label={type.charAt(0).toUpperCase() + type.slice(1)} description="Default width × height">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <NumInput value={settings.defaultTileSizes[type].w} min={200} max={2000}
                    onChange={v => update('defaultTileSizes', { ...settings.defaultTileSizes, [type]: { ...settings.defaultTileSizes[type], w: v } })} />
                  <span style={{ color: '#444', fontSize: 12 }}>×</span>
                  <NumInput value={settings.defaultTileSizes[type].h} min={100} max={2000}
                    onChange={v => update('defaultTileSizes', { ...settings.defaultTileSizes, [type]: { ...settings.defaultTileSizes[type], h: v } })} />
                </div>
              </SettingRow>
            ))}
          </>
        )
      case 'behaviour':
        return (
          <>
            <SectionLabel label="Saving" />
            <SettingRow label="Auto-save interval" description="How often canvas state is written to disk (ms)">
              <NumInput value={settings.autoSaveIntervalMs} min={100} max={10000} step={100} onChange={v => update('autoSaveIntervalMs', v)} />
            </SettingRow>
            <SectionLabel label="Interface" />
            <SettingRow label="UI font size" description="Base font size for the interface">
              <NumInput value={settings.uiFontSize} min={10} max={18} onChange={v => update('uiFontSize', v)} />
            </SettingRow>
          </>
        )

      case 'mcp': {
        const servers = mcpConfig?.mcpServers ?? {}
        const userServers = Object.entries(servers).filter(([k]) => k !== 'collaborator')
        return (
          <>
            {/* Status */}
            <SectionLabel label="Server Status" />
            <div style={{ background: '#161616', borderRadius: 10, padding: '12px 16px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: mcpConfig ? '#3fb950' : '#555', boxShadow: mcpConfig ? '0 0 6px #3fb950' : 'none', flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: '#e0e0e0', fontWeight: 500 }}>collaborator</span>
                <span style={{ fontSize: 11, color: '#444', fontFamily: 'monospace', marginLeft: 'auto' }}>built-in</span>
              </div>
              {mcpConfig && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {Object.entries(mcpConfig.endpoints ?? {}).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: '#444', fontFamily: 'monospace', width: 50, flexShrink: 0 }}>{k}</span>
                      <span style={{ fontSize: 10, color: '#3fb950', fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
                      <button onClick={() => navigator.clipboard.writeText(v)}
                        style={{ fontSize: 9, color: '#444', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                        onMouseEnter={e => (e.currentTarget.style.color = '#888')}
                        onMouseLeave={e => (e.currentTarget.style.color = '#444')}>
                        copy
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* User servers */}
            <SectionLabel label={`Connected Servers${mcpSaved ? ' — saved' : ''}`} />
            {userServers.map(([name, s]) => (
              <div key={name} style={{ background: '#161616', borderRadius: 10, marginBottom: 6, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
                  <span
                    onClick={() => updateServer(name, { enabled: !(s.enabled !== false) })}
                    title="Toggle enabled"
                    style={{ width: 7, height: 7, borderRadius: '50%', background: s.enabled !== false ? '#3fb950' : '#333', flexShrink: 0, cursor: 'pointer' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: '#e0e0e0', fontWeight: 500 }}>{name}</div>
                    {s.description && <div style={{ fontSize: 11, color: '#555', marginTop: 1 }}>{s.description}</div>}
                    <div style={{ fontSize: 10, color: '#333', fontFamily: 'monospace', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.url ?? s.cmd}
                    </div>
                  </div>
                  <button onClick={() => setExpandedServer(expandedServer === name ? null : name)}
                    style={{ background: 'none', border: 'none', color: '#444', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#888')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#444')}>
                    {expandedServer === name ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <button onClick={() => removeServer(name)}
                    style={{ background: 'none', border: 'none', color: '#333', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#f44747')}
                    onMouseLeave={e => (e.currentTarget.style.color = '#333')}>
                    <Trash2 size={13} />
                  </button>
                </div>
                {expandedServer === name && (
                  <div style={{ borderTop: '1px solid #1f1f1f', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: '#444', fontFamily: 'monospace', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>URL</div>
                      <input value={s.url ?? ''} onChange={e => {
                            const url = e.target.value || undefined
                            updateServer(name, { url, cmd: undefined, type: url ? 'http' : 'stdio' })
                          }}
                        placeholder="http://localhost:3000"
                        style={{ width: '100%', padding: '6px 10px', fontSize: 12, background: '#111', color: '#ccc', border: '1px solid #2a2a2a', borderRadius: 6, outline: 'none', fontFamily: 'monospace', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#444', fontFamily: 'monospace', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Stdio Command</div>
                      <input value={s.cmd ?? ''} onChange={e => {
                            const cmd = e.target.value || undefined
                            updateServer(name, { cmd, url: undefined, type: cmd ? 'stdio' : 'http' })
                          }}
                        placeholder="npx @modelcontextprotocol/server-name"
                        style={{ width: '100%', padding: '6px 10px', fontSize: 12, background: '#111', color: '#ccc', border: '1px solid #2a2a2a', borderRadius: 6, outline: 'none', fontFamily: 'monospace', boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: '#444', fontFamily: 'monospace', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Description</div>
                      <input value={s.description ?? ''} onChange={e => updateServer(name, { description: e.target.value })}
                        placeholder="What does this server provide?"
                        style={{ width: '100%', padding: '6px 10px', fontSize: 12, background: '#111', color: '#ccc', border: '1px solid #2a2a2a', borderRadius: 6, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 12, color: '#e0e0e0' }}>Enabled</span>
                      <Toggle value={s.enabled !== false} onChange={v => updateServer(name, { enabled: v })} />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Add server */}
            {addingServer ? (
              <div style={{ background: '#161616', borderRadius: 10, padding: '14px 16px', marginTop: 4 }}>
                <SectionLabel label="New Server" />
                {[
                  { key: 'name', label: 'Name', placeholder: 'my-server', mono: false },
                  { key: 'url',  label: 'URL',  placeholder: 'http://localhost:3000', mono: true },
                  { key: 'cmd',  label: 'Stdio Command', placeholder: 'npx @modelcontextprotocol/server-name', mono: true },
                  { key: 'description', label: 'Description', placeholder: 'What does this server do?', mono: false },
                ].map(f => (
                  <div key={f.key} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: '#444', fontFamily: 'monospace', marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{f.label}</div>
                    <input
                      value={(newServer as Record<string, string>)[f.key]}
                      onChange={e => setNewServer(p => ({ ...p, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      style={{ width: '100%', padding: '6px 10px', fontSize: 12, background: '#111', color: '#ccc', border: '1px solid #2a2a2a', borderRadius: 6, outline: 'none', fontFamily: f.mono ? 'monospace' : 'inherit', boxSizing: 'border-box' }}
                    />
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button onClick={addServer}
                    style={{ flex: 1, padding: '7px 0', borderRadius: 8, background: '#fff', color: '#000', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    Add Server
                  </button>
                  <button onClick={() => setAddingServer(false)}
                    style={{ padding: '7px 16px', borderRadius: 8, background: '#222', color: '#666', border: '1px solid #333', fontSize: 13, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingServer(true)}
                style={{
                  width: '100%', marginTop: 4, padding: '10px 0', borderRadius: 10,
                  background: 'transparent', border: '1px dashed #2a2a2a', color: '#555',
                  fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#4a9eff44'; e.currentTarget.style.color = '#4a9eff' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#2a2a2a'; e.currentTarget.style.color = '#555' }}>
                <Plus size={14} /> Add MCP Server
              </button>
            )}

            {/* Workspace servers */}
            {workspaces.length > 0 && (
              <>
                <SectionLabel label="Workspace Servers" />
                <div style={{ fontSize: 12, color: '#444', marginBottom: 10 }}>
                  MCP servers scoped to a specific workspace — only active when that workspace is open.
                </div>

                {/* Workspace tabs */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
                  {workspaces.map(ws => (
                    <button
                      key={ws.id}
                      onClick={() => setActiveWorkspaceId(ws.id)}
                      style={{
                        padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer',
                        background: activeWorkspaceId === ws.id ? '#fff' : '#161616',
                        color: activeWorkspaceId === ws.id ? '#000' : '#666',
                        border: `1px solid ${activeWorkspaceId === ws.id ? '#fff' : '#2a2a2a'}`,
                        fontWeight: activeWorkspaceId === ws.id ? 600 : 400
                      }}>
                      {ws.name}
                      {Object.keys(workspaceServers[ws.id] ?? {}).length > 0 && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: activeWorkspaceId === ws.id ? '#555' : '#444' }}>
                          {Object.keys(workspaceServers[ws.id]).length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {/* Active workspace servers */}
                {activeWorkspaceId && (() => {
                  const wsServers = workspaceServers[activeWorkspaceId] ?? {}
                  const ws = workspaces.find(w => w.id === activeWorkspaceId)!
                  return (
                    <>
                      <div style={{ fontSize: 10, color: '#333', fontFamily: 'monospace', marginBottom: 8 }}>{ws.path}</div>
                      {Object.entries(wsServers).map(([name, s]) => (
                        <div key={name} style={{ background: '#161616', borderRadius: 10, marginBottom: 6, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span
                            onClick={() => updateWorkspaceServer(activeWorkspaceId, name, { enabled: !(s.enabled !== false) })}
                            style={{ width: 7, height: 7, borderRadius: '50%', background: s.enabled !== false ? '#3fb950' : '#333', flexShrink: 0, cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13, color: '#e0e0e0', fontWeight: 500 }}>{name}</div>
                            {s.description && <div style={{ fontSize: 11, color: '#555', marginTop: 1 }}>{s.description}</div>}
                            <div style={{ fontSize: 10, color: '#333', fontFamily: 'monospace', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.url ?? s.cmd}
                            </div>
                          </div>
                          <button onClick={() => removeWorkspaceServer(activeWorkspaceId, name)}
                            style={{ background: 'none', border: 'none', color: '#333', cursor: 'pointer' }}
                            onMouseEnter={e => (e.currentTarget.style.color = '#f44747')}
                            onMouseLeave={e => (e.currentTarget.style.color = '#333')}>
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={() => {
                          const name = prompt('Server name:')
                          const cmd = prompt('Stdio command (or leave empty for URL):')
                          const url = cmd ? undefined : (prompt('URL:') ?? undefined)
                          const desc = prompt('Description (optional):') ?? ''
                          if (name) {
                            const type = cmd ? 'stdio' : 'http'
                            saveWorkspaceServers(activeWorkspaceId, { ...wsServers, [name]: { type, cmd: cmd || undefined, url, description: desc, enabled: true } })
                          }
                        }}
                        style={{
                          width: '100%', padding: '10px 0', borderRadius: 10,
                          background: 'transparent', border: '1px dashed #2a2a2a', color: '#555',
                          fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = '#4a9eff44'; e.currentTarget.style.color = '#4a9eff' }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = '#2a2a2a'; e.currentTarget.style.color = '#555' }}>
                        <Plus size={14} /> Add to {ws.name}
                      </button>
                    </>
                  )
                })()}
              </>
            )}

            {/* Config paths */}
            <div style={{ marginTop: 20, padding: '14px 16px', background: '#0d0d0d', borderRadius: 10, border: '1px solid #1a1a1a', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { label: 'Global config', path: '~/clawd-collab/mcp-server.json' },
                { label: 'Workspace servers', path: '~/clawd-collab/workspaces/<id>/mcp-servers.json' },
                { label: 'Merged config (point agents here)', path: '~/clawd-collab/workspaces/<id>/mcp-merged.json', highlight: true },
              ].map(row => (
                <div key={row.label}>
                  <div style={{ fontSize: 10, color: '#444', fontFamily: 'monospace', marginBottom: 3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{row.label}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ fontSize: 11, color: row.highlight ? '#4a9eff' : '#555', fontFamily: 'monospace', flex: 1 }}>{row.path}</code>
                    <button
                      onClick={() => navigator.clipboard.writeText(row.path)}
                      style={{ fontSize: 10, color: '#333', background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#888')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#333')}>
                      copy
                    </button>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 4, padding: '8px 10px', background: '#111', borderRadius: 6, border: '1px solid #1f1f1f' }}>
                <div style={{ fontSize: 11, color: '#555' }}>
                  The merged config combines global + workspace servers into one file. Point Claude Code, Cursor, or any MCP client at the merged path for the active workspace.
                </div>
              </div>
            </div>
          </>
        )
      }
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: 720, height: 580,
        background: '#111', borderRadius: 14,
        border: '1px solid #222',
        boxShadow: '0 32px 80px rgba(0,0,0,0.7)',
        display: 'flex', overflow: 'hidden'
      }}>

        {/* Left nav */}
        <div style={{
          width: 200, background: '#0d0d0d',
          borderRight: '1px solid #1a1a1a',
          display: 'flex', flexDirection: 'column',
          padding: '20px 0',
          flexShrink: 0
        }}>
          {/* Close */}
          <div style={{ padding: '0 16px 16px' }}>
            <div
              onClick={onClose}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                cursor: 'pointer', color: '#444',
              }}
              onMouseEnter={e => (e.currentTarget.style.color = '#888')}
              onMouseLeave={e => (e.currentTarget.style.color = '#444')}
            >
              <div style={{
                width: 22, height: 22, borderRadius: '50%',
                border: '1.5px solid currentColor',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, lineHeight: 1
              }}>
                ×
              </div>
              <span style={{ fontSize: 11 }}>esc</span>
            </div>
          </div>

          {/* Settings header */}
          <div style={{ padding: '8px 16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Settings size={18} color="#fff" />
            <span style={{ fontSize: 17, fontWeight: 700, color: '#fff' }}>Settings</span>
          </div>

          {/* Nav items */}
          <div style={{ flex: 1 }}>
            {SECTIONS.map(s => (
              <div
                key={s.id}
                onClick={() => setSection(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '9px 16px', cursor: 'pointer',
                  color: section === s.id ? '#fff' : '#555',
                  background: section === s.id ? 'rgba(255,255,255,0.06)' : 'transparent',
                  fontSize: 14, userSelect: 'none',
                  transition: 'color 0.1s'
                }}
                onMouseEnter={e => { if (section !== s.id) e.currentTarget.style.color = '#888' }}
                onMouseLeave={e => { if (section !== s.id) e.currentTarget.style.color = '#555' }}
              >
                <span style={{ opacity: section === s.id ? 1 : 0.5 }}>{s.icon}</span>
                {s.label}
              </div>
            ))}
          </div>

          {/* Version */}
          <div style={{ padding: '0 16px', fontSize: 11, color: '#333' }}>
            v0.1.0
          </div>
        </div>

        {/* Right content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Section header */}
          <div style={{ padding: '28px 28px 0' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{active.label}</div>
            <div style={{ fontSize: 14, color: '#555' }}>{active.description}</div>
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 28px 28px' }}>
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  )
}
