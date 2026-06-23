import React, { useEffect, useState, useCallback, useRef, lazy } from 'react'
import type { AppSettings, AutoDreamSettings, ExecutionHostRecord, GenerationProviderSettings, ToolPermissionGrant, Workspace } from '../../../shared/types'
import { withDefaultSettings } from '../../../shared/types'
import { Settings, Type, Monitor, Plus, Trash2, ChevronDown, ChevronRight, Puzzle, RefreshCw, Star, Wrench, Users, FileText, Globe, Eye, EyeOff, PanelRight, Pin, Shield, KeyRound, Mic } from 'lucide-react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { DEFAULT_THEME_ID, THEME_OPTIONS, getThemeCanvasDefaults, resolveEffectiveThemeId, getThemeById, type AppearanceMode } from '../theme'
import { ChromeSyncSection } from './settings/ChromeSyncSection'
import { DisplaySettingsEditor } from './settings/DisplaySettingsEditor'
import { VoiceSettingsEditor } from './settings/VoiceSettingsEditor'
import { ColorSwatch, NumInput, RangeInput, SectionLabel, SettingRow, Toggle } from './settings/controls'
import { DaemonSection, type DaemonStatus, type ExecutionResolution } from './settings/DaemonSection'
import { ProvidersSection, type ProviderValidationResult } from './settings/ProvidersSection'
import { SettingsControl } from './codesurf-ui'

const LazyPromptsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.PromptsSection })))
const LazySkillsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.SkillsSection })))
const LazyToolsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.ToolsSection })))
const LazyAgentsSection = lazy(() => import('./CustomisationTile').then(m => ({ default: m.AgentsSection })))

interface Props {
  onClose: () => void
  settings: AppSettings
  onSettingsChange: (s: AppSettings) => void
  workspaces?: Workspace[]
  workspacePath?: string
  initialSection?: Section
  /** OS dark mode (for "system" appearance and preset list). */
  systemPrefersDark?: boolean
}

type BuiltinSection = 'general' | 'daemon' | 'canvas' | 'providers' | 'voice' | 'browser' | 'permissions' | 'mcp' | 'extensions' | 'prompts' | 'skills' | 'tools' | 'agents'
type Section = BuiltinSection | `ext:${string}`

const SECTIONS: { id: Section; label: string; icon: React.ReactNode; description: string; group?: string }[] = [
  // App settings
  { id: 'general',    label: 'General',    icon: <Type size={15} />,       description: 'Display settings — fonts, weights, sizes, line heights, and raw JSON', group: 'app' },
  { id: 'daemon',     label: 'Daemon',     icon: <Settings size={15} />,   description: 'Daemon status, restart controls, execution routing, and remote hosts', group: 'app' },
  { id: 'canvas',     label: 'Canvas',     icon: <Monitor size={15} />,    description: 'Background, grid and snap settings', group: 'app' },
  { id: 'providers',  label: 'Providers',  icon: <KeyRound size={15} />,   description: 'Image and video generation providers, keys, and default models', group: 'app' },
  { id: 'voice',      label: 'Voice',      icon: <Mic size={15} />,        description: 'Speech-to-text, text-to-speech, auto-speak, and provider API keys', group: 'app' },


  { id: 'browser',    label: 'Browser',    icon: <Globe size={15} />,      description: 'Chrome data sync — cookies, bookmarks, history', group: 'app' },
  { id: 'permissions', label: 'Permissions', icon: <Shield size={15} />,   description: 'Tool approval memory, scoped grants, and reset controls', group: 'app' },
  // Customisation
  { id: 'prompts',    label: 'Prompts',    icon: <FileText size={15} />,   description: 'Prompt templates with variables and fields', group: 'customise' },
  { id: 'skills',     label: 'Skills',     icon: <Star size={15} />,       description: 'Custom skills and skill registry', group: 'customise' },
  { id: 'tools',      label: 'Tools',      icon: <Wrench size={15} />,     description: 'MCP servers, tools, integrations and registry', group: 'customise' },
  { id: 'agents',     label: 'Personas',   icon: <Users size={15} />,      description: 'Personas with system prompts and tool access', group: 'customise' },
  // System
  { id: 'extensions', label: 'Plugins', icon: <Puzzle size={15} />,     description: 'Installed plugins', group: 'system' },
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

type PermissionListResult = {
  path: string
  grants: ToolPermissionGrant[]
}

// ProviderModelOption + ProviderValidationResult now live in
// ./settings/ProvidersSection (the extracted section owns them).

type ExtensionListEntry = {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  tier: 'safe' | 'power'
  ui?: import('../../../shared/types').ExtensionManifest['ui']
  enabled: boolean
  contributes?: import('../../../shared/types').ExtensionManifest['contributes']
  dirPath?: string | null
}

const EXTENSIONS_CHANGED_EVENT = 'codesurf:extensions-changed'

function notifyExtensionsChanged(): void {
  window.dispatchEvent(new CustomEvent(EXTENSIONS_CHANGED_EVENT))
}

// ─── Extension settings panel ─────────────────────────────────────────────────
function ExtSettingsPanel({ extId, tileType }: { extId: string; tileType: string }): React.JSX.Element {
  const theme = useTheme()
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    window.electron.extensions?.tileEntry?.(extId, tileType)
      .then((url: string | null) => setSrc(url ?? null))
      .catch(() => setSrc(null))
  }, [extId, tileType])
  if (!src) return <div style={{ fontSize: 12, color: theme.text.muted }}>Loading…</div>
  return (
    <iframe
      key={src}
      src={src}
      style={{ width: '100%', height: '100%', border: 'none', borderRadius: 8 }}
    />
  )
}

// ─── Chrome Sync section ──────────────────────────────────────────────────────



// DaemonStatus + ExecutionResolution now live in ./settings/DaemonSection
// (the extracted section owns them); re-imported above.

// ─── Main panel ───────────────────────────────────────────────────────────────
export function SettingsPanel({ onClose, settings: initialSettings, onSettingsChange, workspaces = [], workspacePath, initialSection, systemPrefersDark = true }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings>(initialSettings)
  const [section, setSection] = useState<Section>(initialSection ?? 'general')
  const [mcpConfig, setMcpConfig] = useState<MCPConfig | null>(null)
  const fonts = useAppFonts()
  const theme = useTheme()
  const [mcpSaved, setMcpSaved] = useState(false)
  const [addingServer, setAddingServer] = useState(false)
  const [newServer, setNewServer] = useState({ name: '', url: '', cmd: '', description: '' })
  const [expandedServer, setExpandedServer] = useState<string | null>(null)
  const [workspaceServers, setWorkspaceServers] = useState<Record<string, Record<string, MCPServerEntry>>>({})
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [updateState, setUpdateState] = useState<{ checking: boolean; downloading: boolean; result: null | { ok: boolean; currentVersion: string; status: string; updateAvailable: boolean; updateInfo?: { version?: string; releaseName?: string; releaseDate?: string } } }>({ checking: false, downloading: false, result: null })
  const [extensionsList, setExtensionsList] = useState<ExtensionListEntry[]>([])
  const [extensionsLoading, setExtensionsLoading] = useState(false)
  const [extensionsError, setExtensionsError] = useState<string | null>(null)
  const [expandedExtId, setExpandedExtId] = useState<string | null>(null)
  const [extSettingsMap, setExtSettingsMap] = useState<Record<string, Record<string, unknown>>>({})
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null)
  const [daemonLoading, setDaemonLoading] = useState(false)
  const [daemonRestarting, setDaemonRestarting] = useState(false)
  const [daemonError, setDaemonError] = useState<string | null>(null)
  const [executionHosts, setExecutionHosts] = useState<ExecutionHostRecord[]>([])
  const [executionHostsLoading, setExecutionHostsLoading] = useState(false)
  const [executionHostsError, setExecutionHostsError] = useState<string | null>(null)
  const [executionResolution, setExecutionResolution] = useState<ExecutionResolution | null>(null)
  const [newHostLabel, setNewHostLabel] = useState('')
  const [newHostUrl, setNewHostUrl] = useState('')
  const [newHostToken, setNewHostToken] = useState('')
  const [permissionData, setPermissionData] = useState<PermissionListResult | null>(null)
  const [permissionsLoading, setPermissionsLoading] = useState(false)
  const [permissionsError, setPermissionsError] = useState<string | null>(null)
  const [visibleProviderKeys, setVisibleProviderKeys] = useState<Record<string, boolean>>({})
  const [providerValidation, setProviderValidation] = useState<Record<string, ProviderValidationResult | { loading: true }>>({})

  const latestSettingsSaveRef = useRef(0)
  const settingsRef = useRef<AppSettings>(withDefaultSettings(initialSettings))

  useEffect(() => {
    const normalized = withDefaultSettings(initialSettings)
    settingsRef.current = normalized
    setSettings(normalized)
  }, [initialSettings])

  useEffect(() => {
    window.electron.mcp?.getConfig?.().then((cfg: unknown) => {
      if (cfg) setMcpConfig(cfg as MCPConfig)
    })
  }, [])

  const loadDaemonStatus = useCallback(async () => {
    setDaemonLoading(true)
    setDaemonError(null)
    try {
      const next = await window.electron.system.daemonStatus()
      setDaemonStatus(next)
    } catch (e) {
      setDaemonError(e instanceof Error ? e.message : String(e))
      setDaemonStatus(null)
    } finally {
      setDaemonLoading(false)
    }
  }, [])

  const loadExecutionHosts = useCallback(async () => {
    setExecutionHostsLoading(true)
    setExecutionHostsError(null)
    try {
      const next = await window.electron.execution.listHosts()
      setExecutionHosts(next)
    } catch (e) {
      setExecutionHostsError(e instanceof Error ? e.message : String(e))
      setExecutionHosts([])
    } finally {
      setExecutionHostsLoading(false)
    }
  }, [])

  const resolveExecutionPreference = useCallback(async (nextSettings: AppSettings) => {
    try {
      const resolution = await window.electron.execution.resolveTarget(nextSettings.execution)
      setExecutionResolution(resolution)
    } catch {
      setExecutionResolution(null)
    }
  }, [])

  const loadPermissions = useCallback(async () => {
    setPermissionsLoading(true)
    setPermissionsError(null)
    try {
      const next = await window.electron.permissions.list()
      setPermissionData(next)
    } catch (e) {
      setPermissionsError(e instanceof Error ? e.message : String(e))
      setPermissionData(null)
    } finally {
      setPermissionsLoading(false)
    }
  }, [])

  const clearPermissionGrantById = useCallback(async (id: string) => {
    try {
      const next = await window.electron.permissions.clear(id)
      setPermissionData(next)
      setPermissionsError(null)
    } catch (e) {
      setPermissionsError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const clearAllPermissionGrants = useCallback(async () => {
    try {
      const next = await window.electron.permissions.clearAll()
      setPermissionData(next)
      setPermissionsError(null)
    } catch (e) {
      setPermissionsError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const handleRestartDaemon = useCallback(async () => {
    setDaemonRestarting(true)
    setDaemonError(null)
    try {
      const next = await window.electron.system.restartDaemon()
      setDaemonStatus(next)
    } catch (e) {
      setDaemonError(e instanceof Error ? e.message : String(e))
    } finally {
      setDaemonRestarting(false)
    }
  }, [])

  useEffect(() => {
    if (section !== 'daemon') return
    let cancelled = false

    const refresh = async () => {
      try {
        const next = await window.electron.system.daemonStatus()
        if (!cancelled) {
          setDaemonStatus(next)
          setDaemonError(null)
        }
      } catch (e) {
        if (!cancelled) {
          setDaemonError(e instanceof Error ? e.message : String(e))
          setDaemonStatus(null)
        }
      } finally {
        if (!cancelled) setDaemonLoading(false)
      }
    }

    setDaemonLoading(true)
    void refresh()
    const interval = window.setInterval(() => {
      void refresh()
    }, 5000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [section])

  useEffect(() => {
    if (section !== 'permissions') return
    void loadPermissions()
  }, [section, loadPermissions])

  useEffect(() => {
    if (section !== 'daemon') return
    void loadExecutionHosts()
  }, [section, loadExecutionHosts])

  useEffect(() => {
    if (section !== 'daemon') return
    void resolveExecutionPreference(settings)
  }, [section, settings, resolveExecutionPreference])

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

  const loadExtensions = useCallback(async () => {
    if (!window.electron?.extensions?.list) {
      setExtensionsError('Extensions API unavailable')
      return
    }
    setExtensionsLoading(true)
    setExtensionsError(null)
    try {
      const list = await window.electron.extensions.list()
      setExtensionsList(list as ExtensionListEntry[])
    } catch (e) {
      setExtensionsError(e instanceof Error ? e.message : String(e))
    } finally {
      setExtensionsLoading(false)
    }
  }, [])

  const refreshExtensions = useCallback(async () => {
    if (!window.electron?.extensions?.refresh) return loadExtensions()
    setExtensionsLoading(true)
    setExtensionsError(null)
    try {
      const wsPath = workspaces[0]?.path ?? null
      const list = await window.electron.extensions.refresh(wsPath)
      setExtensionsList(list as ExtensionListEntry[])
    } catch (e) {
      setExtensionsError(e instanceof Error ? e.message : String(e))
      await loadExtensions()
    } finally {
      setExtensionsLoading(false)
    }
  }, [workspaces, loadExtensions])

  const toggleExtensionEnabled = useCallback(async (extId: string, nextEnabled: boolean) => {
    if (!window.electron?.extensions) return
    try {
      if (nextEnabled) {
        await window.electron.extensions.enable(extId)
        await window.electron.extensions.refresh(workspaces[0]?.path ?? null)
      } else {
        await window.electron.extensions.disable(extId)
      }
      const list = await window.electron.extensions.list()
      setExtensionsList(list as ExtensionListEntry[])
      notifyExtensionsChanged()
    } catch (e) {
      setExtensionsError(e instanceof Error ? e.message : String(e))
    }
  }, [workspaces])

  useEffect(() => {
    if (section !== 'extensions') return
    void loadExtensions()
  }, [section, loadExtensions])

  const checkForUpdates = useCallback(async () => {
    setUpdateState(prev => ({ ...prev, checking: true }))
    const result = await window.electron.updater.check()
    setUpdateState(prev => ({ ...prev, checking: false, result }))
  }, [])

  const downloadUpdate = useCallback(async () => {
    setUpdateState(prev => ({ ...prev, downloading: true }))
    const result = await window.electron.updater.download()
    setUpdateState(prev => ({
      ...prev,
      downloading: false,
      result: prev.result ? { ...prev.result, status: result.status } : prev.result,
    }))
  }, [])

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
    // Don't pass contex through saveServers — it's preserved server-side
    const { contex: _, ...rest } = servers
    saveMcpServers(rest)
  }, [mcpConfig, saveMcpServers])

  const removeServer = useCallback((name: string) => {
    if (!mcpConfig) return
    const { contex: _, [name]: __, ...rest } = mcpConfig.mcpServers
    saveMcpServers(rest)
  }, [mcpConfig, saveMcpServers])

  const addServer = useCallback(() => {
    if (!newServer.name.trim() || !mcpConfig) return
    const { contex: _, ...rest } = mcpConfig.mcpServers
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

  const persistSettings = useCallback((next: AppSettings) => {
    const requestId = ++latestSettingsSaveRef.current
    const normalizedNext = withDefaultSettings(next)
    settingsRef.current = normalizedNext
    onSettingsChange(normalizedNext)
    void window.electron.settings?.set(normalizedNext).then((saved: AppSettings) => {
      if (!saved || requestId !== latestSettingsSaveRef.current) return
      const normalizedSaved = withDefaultSettings(saved)
      settingsRef.current = normalizedSaved
      setSettings(normalizedSaved)
      onSettingsChange(normalizedSaved)
    })
  }, [onSettingsChange])

  // Auto-save on every change
  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = withDefaultSettings({ ...settingsRef.current, [key]: value })
    settingsRef.current = next
    setSettings(next)
    persistSettings(next)
  }, [persistSettings])

  const updateSettingsPatch = useCallback((patch: Partial<AppSettings>) => {
    const themePatch = patch.themeId !== undefined && patch.canvasBackground === undefined && patch.gridColorSmall === undefined && patch.gridColorLarge === undefined
      ? (() => {
          const canvas = getThemeCanvasDefaults(patch.themeId)
          return {
            canvasBackground: canvas.background,
            gridColorSmall: canvas.gridSmall,
            gridColorLarge: canvas.gridLarge,
          }
        })()
      : {}
    const next = withDefaultSettings({ ...settingsRef.current, ...patch, ...themePatch })
    settingsRef.current = next
    setSettings(next)
    persistSettings(next)

    if (
      patch.extensionsDisabled !== undefined
      || patch.hiddenFromSidebarExtIds !== undefined
      || patch.settingsPanelExtIds !== undefined
      || patch.pinnedExtensionIds !== undefined
    ) {
      notifyExtensionsChanged()
    }
  }, [persistSettings])

  const updateAutoDreamPatch = useCallback((patch: Partial<AutoDreamSettings>) => {
    updateSettingsPatch({
      autoDream: {
        ...settingsRef.current.autoDream,
        ...patch,
      },
    })
  }, [updateSettingsPatch])

  const updateGenerationProvider = useCallback((providerId: string, patch: Partial<GenerationProviderSettings>) => {
    const current = settingsRef.current.generationProviders?.[providerId]
    if (!current) return
    updateSettingsPatch({
      generationProviders: {
        ...settingsRef.current.generationProviders,
        [providerId]: {
          ...current,
          ...patch,
          id: providerId,
        },
      },
    })
  }, [updateSettingsPatch])

  const validateProvider = useCallback(async (provider: GenerationProviderSettings) => {
    setProviderValidation(prev => ({ ...prev, [provider.id]: { loading: true } }))
    try {
      const result = await window.electron.settings.validateGenerationProvider(provider.id, provider)
      setProviderValidation(prev => ({ ...prev, [provider.id]: result }))
    } catch (err) {
      setProviderValidation(prev => ({
        ...prev,
        [provider.id]: {
          ok: false,
          providerId: provider.id,
          message: err instanceof Error ? err.message : String(err),
          models: [],
          textModels: [],
          imageModels: [],
          videoModels: [],
        },
      }))
    }
  }, [])

  const saveExecutionHost = useCallback(async (host: ExecutionHostRecord) => {
    setExecutionHostsError(null)
    try {
      const next = await window.electron.execution.upsertHost(host)
      setExecutionHosts(next)
    } catch (e) {
      setExecutionHostsError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const removeExecutionHost = useCallback(async (hostId: string) => {
    setExecutionHostsError(null)
    try {
      const result = await window.electron.execution.deleteHost(hostId)
      setExecutionHosts(result.hosts)
      if (settings.execution.hostId === hostId) {
        updateSettingsPatch({ execution: { ...settings.execution, hostId: null, mode: 'auto' } })
      }
    } catch (e) {
      setExecutionHostsError(e instanceof Error ? e.message : String(e))
    }
  }, [settings.execution, updateSettingsPatch])

  const applyThemePreset = useCallback((themeId: string) => {
    const canvas = getThemeCanvasDefaults(themeId)
    updateSettingsPatch({
      themeId,
      canvasBackground: canvas.background,
      gridColorSmall: canvas.gridSmall,
      gridColorLarge: canvas.gridLarge,
    })
  }, [updateSettingsPatch])

  const applyAppearanceMode = useCallback((mode: AppearanceMode) => {
    const currentThemeId = settingsRef.current.themeId
    const currentTheme = getThemeById(currentThemeId)
    const shouldUseLightTheme = mode === 'light' || (mode === 'system' && !systemPrefersDark)
    const nextThemeId = shouldUseLightTheme
      ? (currentTheme.mode === 'light' ? currentThemeId : 'paper-light')
      : (currentTheme.mode === 'dark' ? currentThemeId : DEFAULT_THEME_ID)
    const canvas = getThemeCanvasDefaults(nextThemeId)
    updateSettingsPatch({
      appearance: mode,
      themeId: nextThemeId,
      canvasBackground: canvas.background,
      gridColorSmall: canvas.gridSmall,
      gridColorLarge: canvas.gridLarge,
    })
  }, [systemPrefersDark, updateSettingsPatch])

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const activeExt = section.startsWith('ext:') ? extensionsList.find(e => `ext:${e.id}` === section) : undefined
  const active = SECTIONS.find(s => s.id === section) ?? (activeExt ? { label: activeExt.name, description: activeExt.description ?? '' } : { label: '', description: '' })

  const renderContent = () => {
    switch (section) {
      case 'general': {
        const resolvedThemeId = resolveEffectiveThemeId(settings.appearance ?? 'dark', settings.themeId, systemPrefersDark)
        const resolvedUiMode = getThemeById(resolvedThemeId).mode
        const presetOptions = THEME_OPTIONS.filter(o => o.mode === resolvedUiMode)
        const appearanceMode = settings.appearance ?? 'dark'
        return (
          <>
            <SectionLabel label="Theme" />
            <SettingRow label="Mode" description="Dark uses the palette below. Light uses the Paper Light theme. System follows your OS dark/light setting.">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(['dark', 'light', 'system'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => applyAppearanceMode(mode)}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 8,
                      fontSize: fonts.secondarySize,
                      fontWeight: 600,
                      border: `1px solid ${appearanceMode === mode ? theme.accent.base : theme.border.default}`,
                      background: appearanceMode === mode ? theme.accent.soft : theme.surface.input,
                      color: appearanceMode === mode ? theme.accent.hover : theme.text.secondary,
                      cursor: 'pointer',
                      textTransform: 'capitalize',
                    }}
                  >
                    {mode === 'system' ? 'System' : mode}
                  </button>
                ))}
              </div>
            </SettingRow>
            <SettingRow label="Preset" description="Changes block chrome, terminal colours, shell surfaces, and resets the canvas palette to the preset defaults. Presets match the current light or dark mode.">
              <select
                value={resolvedThemeId}
                onChange={e => applyThemePreset(e.target.value)}
                style={{
                  minWidth: 220,
                  padding: '6px 10px',
                  fontSize: fonts.secondarySize,
                  background: theme.surface.input,
                  color: theme.text.secondary,
                  border: `1px solid ${theme.border.default}`,
                  borderRadius: 8,
                  outline: 'none',
                }}
              >
                {presetOptions.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label} · {option.mode}
                  </option>
                ))}
              </select>
            </SettingRow>
            <SettingRow
              label="Contrast"
              description="Push surfaces and text apart (positive) or compress them toward mid-grey (negative). 0 keeps the preset's natural contrast."
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 240 }}>
                <input
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={settings.themeContrast ?? 0}
                  onChange={e => updateSettingsPatch({ themeContrast: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: theme.accent.base, cursor: 'pointer' }}
                  aria-label="Theme contrast"
                />
                <button
                  type="button"
                  onClick={() => updateSettingsPatch({ themeContrast: 0 })}
                  title="Reset contrast to preset default"
                  style={{
                    padding: '4px 10px',
                    fontSize: fonts.secondarySize,
                    background: theme.surface.input,
                    color: theme.text.secondary,
                    border: `1px solid ${theme.border.default}`,
                    borderRadius: 6,
                    cursor: 'pointer',
                  }}
                >
                  Reset
                </button>
                <span
                  style={{
                    minWidth: 44,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: fonts.secondarySize,
                    color: theme.text.muted,
                  }}
                >
                  {((settings.themeContrast ?? 0) >= 0 ? '+' : '') + (settings.themeContrast ?? 0).toFixed(2)}
                </span>
              </div>
            </SettingRow>
            <DisplaySettingsEditor
              settings={settings}
              onApply={updateSettingsPatch}
              updateState={updateState}
              onCheckForUpdates={checkForUpdates}
              onDownloadUpdate={downloadUpdate}
            />
            <SettingRow
              label="Welcome screen"
              description="Replay the first-run welcome and feature tour."
            >
              <button
                onClick={() => { updateSettingsPatch({ onboardingComplete: false }); onClose() }}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 8,
                  border: `1px solid ${theme.border.default}`,
                  background: theme.surface.panelMuted,
                  color: theme.text.primary, cursor: 'pointer',
                  fontSize: fonts.size, fontWeight: 600,
                }}
              >
                Show welcome
              </button>
            </SettingRow>
          </>
        )
      }
      case 'daemon':
        return (
          <DaemonSection
            settings={settings}
            daemonStatus={daemonStatus}
            daemonLoading={daemonLoading}
            daemonRestarting={daemonRestarting}
            daemonError={daemonError}
            loadDaemonStatus={loadDaemonStatus}
            handleRestartDaemon={handleRestartDaemon}
            updateAutoDreamPatch={updateAutoDreamPatch}
            updateSettingsPatch={updateSettingsPatch}
            executionHosts={executionHosts}
            executionHostsLoading={executionHostsLoading}
            executionHostsError={executionHostsError}
            executionResolution={executionResolution}
            saveExecutionHost={saveExecutionHost}
            removeExecutionHost={removeExecutionHost}
            newHostLabel={newHostLabel}
            newHostUrl={newHostUrl}
            newHostToken={newHostToken}
            setNewHostLabel={setNewHostLabel}
            setNewHostUrl={setNewHostUrl}
            setNewHostToken={setNewHostToken}
          />
        )
      case 'canvas':
        return (
          <>
            <SectionLabel label="Display" />
            <SettingRow label="Background colour" description="Canvas background color">
              <ColorSwatch value={settings.canvasBackground} onChange={v => update('canvasBackground', v)} />
            </SettingRow>
            <SettingRow label="Canvas translucency" description="Slide left for see-through vibrancy, all the way right for fully opaque">
              <RangeInput value={settings.translucentBackgroundOpacity} min={0.05} max={1} step={0.01} onChange={v => update('translucentBackgroundOpacity', Number(v.toFixed(2)))} formatValue={v => `${Math.round(v * 100)}%`} />
            </SettingRow>
            <SettingRow label="Cursor glow" description="Show or hide the cursor-proximity glow over the canvas grid. Radius is measured in screen pixels.">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Toggle value={settings.canvasGlowEnabled} onChange={v => update('canvasGlowEnabled', v)} />
                <div style={{ opacity: settings.canvasGlowEnabled ? 1 : 0.45, pointerEvents: settings.canvasGlowEnabled ? 'auto' : 'none' }}>
                  <RangeInput value={settings.canvasGlowRadius} min={50} max={200} step={5} onChange={v => update('canvasGlowRadius', v)} formatValue={v => `${Math.round(v)}px`} />
                </div>
              </div>
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
            <SettingRow label="Snap to grid" description="Snap blocks to the grid when dragging">
              <Toggle value={settings.snapToGrid} onChange={v => update('snapToGrid', v)} />
            </SettingRow>
          </>
        )

      case 'permissions':
        return (
          <>
            <SectionLabel label="Tool Permission Memory" />
            <div style={{ background: theme.surface.panelMuted, borderRadius: 10, padding: '12px 16px', marginBottom: 12 }}>
              <div style={{ fontSize: fonts.size, color: theme.text.secondary, marginBottom: 6 }}>
                Approvals are remembered per provider, tool, and workspace.
              </div>
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, lineHeight: 1.6 }}>
                When a tool asks for approval, CodeSurf can allow it once, for this session, for the rest of today, or permanently.
              </div>
              <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 8 }}>
                {permissionData?.path ?? '~/.codesurf/permissions.json'}
              </div>
            </div>
            <SettingRow label="Stored grants" description="Clear remembered approvals so tools prompt again.">
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => { void loadPermissions() }}
                  disabled={permissionsLoading}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: fonts.secondarySize,
                    fontWeight: 600,
                    border: `1px solid ${theme.border.default}`,
                    background: theme.surface.input,
                    color: theme.text.secondary,
                    cursor: permissionsLoading ? 'not-allowed' : 'pointer',
                    opacity: permissionsLoading ? 0.6 : 1,
                  }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => { void clearAllPermissionGrants() }}
                  disabled={permissionsLoading || (permissionData?.grants.length ?? 0) === 0}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: fonts.secondarySize,
                    fontWeight: 600,
                    border: `1px solid ${theme.border.default}`,
                    background: `${theme.status.danger}14`,
                    color: theme.status.danger,
                    cursor: permissionsLoading || (permissionData?.grants.length ?? 0) === 0 ? 'not-allowed' : 'pointer',
                    opacity: permissionsLoading || (permissionData?.grants.length ?? 0) === 0 ? 0.6 : 1,
                  }}
                >
                  Clear all
                </button>
              </div>
            </SettingRow>
            {permissionsError && (
              <div style={{ fontSize: fonts.secondarySize, color: theme.status.danger, padding: '4px 2px 10px' }}>
                {permissionsError}
              </div>
            )}
            <SectionLabel label="Filesystem Access" />
            <SettingRow
              label="Restrict file access to workspace folders"
              description="When enabled, read/write IPC only allows paths under workspace project roots or ~/.contex. Enabled by default on new and migrated installs; turn off only if you need broader file access."
            >
              <Toggle
                value={settings.security.restrictFsToWorkspaceRoots}
                onChange={v => updateSettingsPatch({
                  security: {
                    ...settings.security,
                    restrictFsToWorkspaceRoots: v,
                    fsScopingMigrated: true,
                    fsScopingUserOptedOut: v ? undefined : true,
                  },
                })}
              />
            </SettingRow>

            {(permissionData?.grants.length ?? 0) === 0 ? (
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, padding: '8px 2px' }}>
                {permissionsLoading ? 'Loading permission grants…' : 'No remembered tool approvals.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {permissionData!.grants.map(grant => (
                  <div key={grant.id} style={{ background: theme.surface.panelMuted, borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 600 }}>{grant.title || grant.toolName}</span>
                        <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, background: theme.surface.input, padding: '2px 8px', borderRadius: 999 }}>
                          {grant.provider}
                        </span>
                        <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: grant.action === 'deny' ? theme.status.danger : theme.status.success, background: `${grant.action === 'deny' ? theme.status.danger : theme.status.success}14`, padding: '2px 8px', borderRadius: 999 }}>
                          {grant.action === 'deny' ? 'blocked' : grant.scope === 'forever' ? 'all time' : grant.scope}
                        </span>
                      </div>
                      {grant.description && (
                        <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, marginTop: 4 }}>
                          {grant.description}
                        </div>
                      )}
                      <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 6, wordBreak: 'break-all' }}>
                        {grant.toolName}{grant.workspaceDir ? ` · ${grant.workspaceDir}` : ''}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => { void clearPermissionGrantById(grant.id) }}
                      style={{
                        padding: '6px 10px',
                        borderRadius: 8,
                        fontSize: fonts.secondarySize,
                        fontWeight: 600,
                        border: `1px solid ${theme.border.default}`,
                        background: 'transparent',
                        color: theme.text.secondary,
                        cursor: 'pointer',
                        flexShrink: 0,
                      }}
                    >
                      Clear
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )

      case 'providers':
        return (
          <ProvidersSection
            settings={settings}
            updateGenerationProvider={updateGenerationProvider}
            updateSettingsPatch={updateSettingsPatch}
            visibleProviderKeys={visibleProviderKeys}
            setVisibleProviderKeys={setVisibleProviderKeys}
            providerValidation={providerValidation}
            validateProvider={validateProvider}
          />
        )



      case 'voice':
        return (
          <>
            <SectionLabel label="Voice — STT, TTS, spokify, API keys" />
            <VoiceSettingsEditor
              settings={settings}
              onChange={(next) => updateSettingsPatch({ voice: next.voice })}
            />
          </>
        )

      case 'browser':
        return (
          <>
            <SectionLabel label="Links" />
            <SettingRow label="Open links in" description="Choose whether rendered links open in a browser block on the canvas or in your default external browser.">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {([
                  { id: 'browser-block', label: 'Browser block' },
                  { id: 'external-browser', label: 'External browser' },
                ] as const).map(option => {
                  const active = (settings.linkOpenMode ?? 'browser-block') === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => update('linkOpenMode', option.id)}
                      style={{
                        padding: '6px 14px',
                        borderRadius: 8,
                        fontSize: fonts.secondarySize,
                        fontWeight: 600,
                        border: `1px solid ${active ? theme.accent.base : theme.border.default}`,
                        background: active ? theme.accent.soft : theme.surface.input,
                        color: active ? theme.accent.hover : theme.text.secondary,
                        cursor: 'pointer',
                      }}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </SettingRow>
            <ChromeSyncSection settings={settings} onUpdate={update} />
          </>
        )

      case 'tools':
      case 'mcp': {
        const servers = mcpConfig?.mcpServers ?? {}
        const userServers = Object.entries(servers).filter(([k]) => k !== 'contex')
        return (
          <>
            {/* Tools & permissions — only when accessed via Tools tab */}
            {section === 'tools' && (
              <div style={{ marginBottom: 20 }}>
                <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
                  <LazyToolsSection hideHeaderText />
                </React.Suspense>
              </div>
            )}

            {/* MCP Server Status */}
            <SectionLabel label="Server Status" />
            <div style={{ background: theme.surface.panelMuted, borderRadius: 10, padding: '12px 16px', marginBottom: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: mcpConfig ? theme.status.success : '#555', boxShadow: mcpConfig ? '0 0 6px #3fb950' : 'none', flexShrink: 0 }} />
                <span style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 500 }}>contex</span>
                <span style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: 'inherit', marginLeft: 'auto' }}>built-in</span>
              </div>
              {mcpConfig && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {Object.entries(mcpConfig.endpoints ?? {}).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 10, color: theme.text.muted, fontFamily: fonts.mono, width: 50, flexShrink: 0 }}>{k}</span>
                      <span style={{ fontSize: 10, color: theme.status.success, fontFamily: fonts.mono, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</span>
                      <button onClick={() => navigator.clipboard.writeText(v)}
                        style={{ fontSize: 9, color: theme.text.muted, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                        onMouseEnter={e => (e.currentTarget.style.color = theme.text.muted)}
                        onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
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
              <div key={name} style={{ background: theme.surface.panelMuted, borderRadius: 10, marginBottom: 6, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px' }}>
                  <span
                    onClick={() => updateServer(name, { enabled: !(s.enabled !== false) })}
                    title="Toggle enabled"
                    style={{ width: 7, height: 7, borderRadius: '50%', background: s.enabled !== false ? theme.status.success : theme.border.default, flexShrink: 0, cursor: 'pointer' }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 500 }}>{name}</div>
                    {s.description && <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, marginTop: 1 }}>{s.description}</div>}
                    <div style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.url ?? s.cmd}
                    </div>
                  </div>
                  <button onClick={() => setExpandedServer(expandedServer === name ? null : name)}
                    style={{ background: 'none', border: 'none', color: theme.text.muted, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.color = theme.text.muted)}
                    onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
                    {expandedServer === name ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  </button>
                  <button onClick={() => removeServer(name)}
                    style={{ background: 'none', border: 'none', color: theme.text.disabled, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                    onMouseEnter={e => (e.currentTarget.style.color = theme.status.danger)}
                    onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
                    <Trash2 size={13} />
                  </button>
                </div>
                {expandedServer === name && (
                  <div style={{ borderTop: '1px solid #1f1f1f', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>URL</div>
                      <input value={s.url ?? ''} onChange={e => {
                            const url = e.target.value || undefined
                            updateServer(name, { url, cmd: undefined, type: url ? 'http' : 'stdio' })
                          }}
                        placeholder="http://localhost:3000"
                        style={{ width: '100%', padding: '6px 10px', fontSize: fonts.secondarySize, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, borderRadius: 6, outline: 'none', fontFamily: fonts.mono, boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Stdio Command</div>
                      <input value={s.cmd ?? ''} onChange={e => {
                            const cmd = e.target.value || undefined
                            updateServer(name, { cmd, url: undefined, type: cmd ? 'stdio' : 'http' })
                          }}
                        placeholder="npx @modelcontextprotocol/server-name"
                        style={{ width: '100%', padding: '6px 10px', fontSize: fonts.secondarySize, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, borderRadius: 6, outline: 'none', fontFamily: fonts.mono, boxSizing: 'border-box' }} />
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Description</div>
                      <input value={s.description ?? ''} onChange={e => updateServer(name, { description: e.target.value })}
                        placeholder="What does this server provide?"
                        style={{ width: '100%', padding: '6px 10px', fontSize: fonts.secondarySize, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, borderRadius: 6, outline: 'none', boxSizing: 'border-box' }} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: fonts.secondarySize, color: theme.text.primary }}>Enabled</span>
                      <Toggle value={s.enabled !== false} onChange={v => updateServer(name, { enabled: v })} />
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Add server */}
            {addingServer ? (
              <div style={{ background: theme.surface.panelMuted, borderRadius: 10, padding: '14px 16px', marginTop: 4 }}>
                <SectionLabel label="New Server" />
                {[
                  { key: 'name', label: 'Name', placeholder: 'my-server', mono: false },
                  { key: 'url',  label: 'URL',  placeholder: 'http://localhost:3000', mono: true },
                  { key: 'cmd',  label: 'Stdio Command', placeholder: 'npx @modelcontextprotocol/server-name', mono: true },
                  { key: 'description', label: 'Description', placeholder: 'What does this server do?', mono: false },
                ].map(f => (
                  <div key={f.key} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 4, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{f.label}</div>
                    <input
                      value={(newServer as Record<string, string>)[f.key]}
                      onChange={e => setNewServer(p => ({ ...p, [f.key]: e.target.value }))}
                      placeholder={f.placeholder}
                      style={{ width: '100%', padding: '6px 10px', fontSize: fonts.secondarySize, background: theme.surface.input, color: theme.text.secondary, border: `1px solid ${theme.border.default}`, borderRadius: 6, outline: 'none', fontFamily: f.mono ? 'monospace' : 'inherit', boxSizing: 'border-box' }}
                    />
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                  <button onClick={addServer}
                    style={{ flex: 1, padding: '7px 0', borderRadius: 8, background: theme.accent.base, color: theme.text.inverse, border: 'none', fontSize: fonts.size, fontWeight: 600, cursor: 'pointer' }}>
                    Add Server
                  </button>
                  <button onClick={() => setAddingServer(false)}
                    style={{ padding: '7px 16px', borderRadius: 8, background: theme.surface.panelElevated, color: theme.text.muted, border: `1px solid ${theme.border.default}`, fontSize: fonts.size, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setAddingServer(true)}
                style={{
                  width: '100%', marginTop: 4, padding: '10px 0', borderRadius: 10,
                  background: 'transparent', border: `1px dashed ${theme.border.default}`, color: theme.text.disabled,
                  fontSize: fonts.size, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = theme.accent.base; e.currentTarget.style.color = theme.accent.base }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = theme.border.default; e.currentTarget.style.color = theme.text.disabled }}>
                <Plus size={14} /> Add MCP Server
              </button>
            )}

            {/* Workspace servers */}
            {workspaces.length > 0 && (
              <>
                <SectionLabel label="Workspace Servers" />
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, marginBottom: 10 }}>
                  MCP servers scoped to a specific workspace — only active when that workspace is open.
                </div>

                {/* Workspace tabs */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 12, flexWrap: 'wrap' }}>
                  {workspaces.map(ws => (
                    <button
                      key={ws.id}
                      onClick={() => setActiveWorkspaceId(ws.id)}
                      style={{
                        padding: '4px 12px', borderRadius: 6, fontSize: fonts.secondarySize, cursor: 'pointer',
                        background: activeWorkspaceId === ws.id ? theme.accent.base : theme.surface.panelElevated,
                        color: activeWorkspaceId === ws.id ? theme.text.inverse : theme.text.muted,
                        border: `1px solid ${activeWorkspaceId === ws.id ? theme.accent.base : theme.border.default}`,
                        fontWeight: activeWorkspaceId === ws.id ? 600 : 400
                      }}>
                      {ws.name}
                      {Object.keys(workspaceServers[ws.id] ?? {}).length > 0 && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: activeWorkspaceId === ws.id ? theme.text.inverse : theme.text.disabled }}>
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
                      <div style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, marginBottom: 8 }}>{ws.path}</div>
                      {Object.entries(wsServers).map(([name, s]) => (
                        <div key={name} style={{ background: theme.surface.panelMuted, borderRadius: 10, marginBottom: 6, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span
                            onClick={() => updateWorkspaceServer(activeWorkspaceId, name, { enabled: !(s.enabled !== false) })}
                            style={{ width: 7, height: 7, borderRadius: '50%', background: s.enabled !== false ? theme.status.success : theme.border.default, flexShrink: 0, cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 500 }}>{name}</div>
                            {s.description && <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, marginTop: 1 }}>{s.description}</div>}
                            <div style={{ fontSize: 10, color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.url ?? s.cmd}
                            </div>
                          </div>
                          <button onClick={() => removeWorkspaceServer(activeWorkspaceId, name)}
                            style={{ background: 'none', border: 'none', color: theme.text.disabled, cursor: 'pointer' }}
                            onMouseEnter={e => (e.currentTarget.style.color = theme.status.danger)}
                            onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
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
                          background: 'transparent', border: `1px dashed ${theme.border.default}`, color: theme.text.disabled,
                          fontSize: fonts.size, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = theme.accent.base; e.currentTarget.style.color = theme.accent.base }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = theme.border.default; e.currentTarget.style.color = theme.text.disabled }}>
                        <Plus size={14} /> Add to {ws.name}
                      </button>
                    </>
                  )
                })()}
              </>
            )}

            {/* Config paths */}
            <div style={{ marginTop: 20, padding: '14px 16px', background: theme.surface.panel, borderRadius: 10, border: `1px solid ${theme.border.default}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { label: 'Global config', path: '~/.contex/mcp-server.json' },
                { label: 'Workspace servers', path: '~/.contex/workspaces/<id>/mcp-servers.json' },
                { label: 'Merged config (point agents here)', path: '~/.contex/workspaces/<id>/.contex/mcp-merged.json', highlight: true },
              ].map(row => (
                <div key={row.label}>
                  <div style={{ fontSize: 10, color: theme.text.muted, marginBottom: 3, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{row.label}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code style={{ fontSize: fonts.secondarySize, color: row.highlight ? theme.accent.base : theme.text.muted, fontFamily: fonts.mono, flex: 1 }}>{row.path}</code>
                    <button
                      onClick={() => navigator.clipboard.writeText(row.path)}
                      style={{ fontSize: 10, color: theme.text.disabled, background: 'none', border: 'none', cursor: 'pointer', flexShrink: 0 }}
                      onMouseEnter={e => (e.currentTarget.style.color = theme.text.muted)}
                      onMouseLeave={e => (e.currentTarget.style.color = theme.text.disabled)}>
                      copy
                    </button>
                  </div>
                </div>
              ))}
              <div style={{ marginTop: 4, padding: '8px 10px', background: theme.surface.input, borderRadius: 6, border: `1px solid ${theme.border.subtle}` }}>
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>
                  The merged config combines global + workspace servers into one file. Point Claude Code, Cursor, or any MCP client at the merged path for the active workspace.
                </div>
              </div>
            </div>
          </>
        )
      }

      case 'extensions':
        return (
          <>
            <SectionLabel label="Installed extensions" />
            {/* Master kill-switch */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', marginBottom: 12, borderRadius: 10,
              background: settings.extensionsDisabled ? 'rgba(244,71,71,0.08)' : theme.surface.panelMuted,
              border: `1px solid ${settings.extensionsDisabled ? 'rgba(244,71,71,0.25)' : theme.border.default}`,
              transition: 'background 0.15s, border-color 0.15s',
            }}>
              <div>
                <div style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>Disable all plugins</div>
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, marginTop: 2 }}>
                  {settings.extensionsDisabled ? 'Plugins are hidden from the sidebar and footer' : 'Hide all plugins from the sidebar and footer'}
                </div>
              </div>
              <Toggle value={settings.extensionsDisabled ?? false} onChange={v => updateSettingsPatch({ extensionsDisabled: v })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, lineHeight: 1.45, flex: 1, minWidth: 200 }}>
                Plugins load from <code style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>~/.codesurf/extensions</code>
                {workspaces.length > 0 && (
                  <> and the active workspace&apos;s <code style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>.contex/extensions</code></>
                )}
                . Disable a power plugin to unload its main process code; use Refresh after adding folders.
              </div>
              <button
                type="button"
                onClick={() => { void refreshExtensions() }}
                disabled={extensionsLoading}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '7px 12px', borderRadius: 8, fontSize: fonts.secondarySize, fontWeight: 600,
                  cursor: extensionsLoading ? 'wait' : 'pointer',
                  background: theme.surface.input,
                  color: theme.text.secondary,
                  border: `1px solid ${theme.border.default}`,
                  flexShrink: 0,
                }}
              >
                <RefreshCw size={14} style={{ opacity: extensionsLoading ? 0.5 : 1 }} />
                Rescan
              </button>
            </div>

            {extensionsError && (
              <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(244,71,71,0.12)', border: '1px solid rgba(244,71,71,0.35)', fontSize: fonts.secondarySize, color: '#f48771' }}>
                {extensionsError}
              </div>
            )}

            {extensionsLoading && extensionsList.length === 0 ? (
              <div style={{ fontSize: fonts.size, color: theme.text.muted, padding: '12px 0' }}>Loading extensions…</div>
            ) : extensionsList.length === 0 ? (
              <div style={{ fontSize: fonts.size, color: theme.text.disabled, padding: '16px', background: theme.surface.panelMuted, borderRadius: 10, border: `1px dashed ${theme.border.default}` }}>
                No extensions found. Add a folder under <span style={{ fontFamily: fonts.mono, fontSize: fonts.secondarySize }}>~/.contex/extensions</span> with an <span style={{ fontFamily: fonts.mono, fontSize: fonts.secondarySize }}>extension.json</span> manifest.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {extensionsList.map(ext => {
                  const tiles = ext.contributes?.tiles?.length ?? 0
                  const menus = ext.contributes?.contextMenu?.length ?? 0
                  const extSettings = ext.contributes?.settings ?? []
                  const extSettingsSections = ext.contributes?.settingsSections ?? []
                  const hasAnySettings = extSettings.length > 0 || extSettingsSections.length > 0
                  const isHiddenFromSidebar = (settings.hiddenFromSidebarExtIds ?? []).includes(ext.id)
                  const isInSettingsPanel = (settings.settingsPanelExtIds ?? []).includes(ext.id)
                  const isPinned = (settings.pinnedExtensionIds ?? []).includes(ext.id)
                  const isExpanded = expandedExtId === ext.id
                  const savedExtSettings = extSettingsMap[ext.id] ?? {}
                  return (
                    <div
                      key={ext.id}
                      style={{
                        background: theme.surface.panelMuted,
                        borderRadius: 10,
                        border: `1px solid ${isExpanded ? theme.border.strong : theme.border.default}`,
                        overflow: 'hidden',
                        transition: 'border-color 0.15s',
                      }}
                    >
                      {/* Card header row */}
                      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                            <span style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>{ext.name}</span>
                            <span style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>v{ext.version}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
                              padding: '2px 6px', borderRadius: 4,
                              background: ext.tier === 'power' ? 'rgba(74,158,255,0.15)' : 'rgba(63,185,80,0.12)',
                              color: ext.tier === 'power' ? '#4a9eff' : theme.status.success,
                            }}>{ext.tier}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.04em',
                              padding: '2px 6px', borderRadius: 4,
                              background: ext.ui?.mode === 'custom' ? 'rgba(251,191,36,0.15)' : theme.surface.accentSoft,
                              color: ext.ui?.mode === 'custom' ? theme.status.warning : theme.accent.base,
                            }}>{ext.ui?.mode === 'custom' ? 'custom ui' : 'core ui'}</span>
                            <span style={{
                              fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                              background: ext.enabled ? 'rgba(63,185,80,0.12)' : 'rgba(136,136,136,0.15)',
                              color: ext.enabled ? theme.status.success : theme.text.disabled,
                            }}>{ext.enabled ? 'enabled' : 'disabled'}</span>
                          </div>
                          <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono, marginBottom: 4 }}>{ext.id}</div>
                          {ext.description && (
                            <div style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, lineHeight: 1.4, marginBottom: 4 }}>{ext.description}</div>
                          )}
                          <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted }}>
                            {tiles > 0 && <span>{tiles} block{tiles === 1 ? '' : 's'}</span>}
                            {tiles > 0 && menus > 0 && ' · '}
                            {menus > 0 && <span>{menus} menu item{menus === 1 ? '' : 's'}</span>}
                            {(tiles > 0 || menus > 0) && ' · '}
                            <span>{ext.ui?.mode === 'custom' ? 'bespoke extension surface' : 'host-aligned extension surface'}</span>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                          <button
                            title={isPinned ? 'Unpin from canvas menu' : 'Pin to canvas menu'}
                            onClick={() => {
                              const next = isPinned
                                ? (settings.pinnedExtensionIds ?? []).filter(id => id !== ext.id)
                                : [...(settings.pinnedExtensionIds ?? []), ext.id]
                              updateSettingsPatch({ pinnedExtensionIds: next })
                            }}
                            style={{
                              background: isPinned ? theme.surface.accentSoft : 'none',
                              border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                              color: isPinned ? theme.accent.base : theme.text.disabled,
                              display: 'flex', alignItems: 'center', transition: 'color 0.15s, background 0.15s',
                            }}
                          >
                            <Pin size={14} />
                          </button>
                          {/* Show in sidebar toggle (ON by default) */}
                          <button
                            title={isHiddenFromSidebar ? 'Show in sidebar and footer' : 'Hide from sidebar and footer'}
                            onClick={() => {
                              const next = isHiddenFromSidebar
                                ? (settings.hiddenFromSidebarExtIds ?? []).filter(id => id !== ext.id)
                                : [...(settings.hiddenFromSidebarExtIds ?? []), ext.id]
                              updateSettingsPatch({ hiddenFromSidebarExtIds: next })
                            }}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                              color: isHiddenFromSidebar ? theme.text.disabled : theme.text.secondary,
                              display: 'flex', alignItems: 'center', transition: 'color 0.15s',
                            }}
                          >
                            {isHiddenFromSidebar ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                          {/* Show as settings panel toggle */}
                          {ext.contributes?.tiles && ext.contributes.tiles.length > 0 && (
                            <button
                              title={isInSettingsPanel ? 'Remove from settings' : 'Show in settings panel'}
                              onClick={() => {
                                const next = isInSettingsPanel
                                  ? (settings.settingsPanelExtIds ?? []).filter(id => id !== ext.id)
                                  : [...(settings.settingsPanelExtIds ?? []), ext.id]
                                updateSettingsPatch({ settingsPanelExtIds: next })
                              }}
                              style={{
                                background: isInSettingsPanel ? theme.surface.accentSoft : 'none',
                                border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                                color: isInSettingsPanel ? theme.accent.base : theme.text.disabled,
                                display: 'flex', alignItems: 'center', transition: 'color 0.15s, background 0.15s',
                              }}
                            >
                              <PanelRight size={14} />
                            </button>
                          )}
                          {/* Settings cog — only show if extension declares settings */}
                          {hasAnySettings && (
                            <button
                              title="Plugin settings"
                              onClick={async () => {
                                if (isExpanded) { setExpandedExtId(null); return }
                                // Load current settings for this extension
                                const current = await window.electron.extensions?.getSettings?.(ext.id).catch(() => ({})) ?? {}
                                setExtSettingsMap(prev => ({ ...prev, [ext.id]: current }))
                                setExpandedExtId(ext.id)
                              }}
                              style={{
                                background: isExpanded ? theme.surface.accentSoft : 'none',
                                border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6,
                                color: isExpanded ? theme.accent.base : theme.text.disabled,
                                display: 'flex', alignItems: 'center',
                                transition: 'color 0.15s, background 0.15s',
                              }}
                            >
                              <Settings size={14} />
                            </button>
                          )}
                          <Toggle value={ext.enabled} onChange={v => { void toggleExtensionEnabled(ext.id, v) }} />
                        </div>
                      </div>
                      {/* Inline settings panel */}
                      {isExpanded && hasAnySettings && (
                        <div style={{
                          borderTop: `1px solid ${theme.border.default}`,
                          padding: '12px 14px',
                          background: theme.surface.panel,
                          display: 'flex', flexDirection: 'column', gap: 10,
                        }}>
                          {extSettings.length > 0 && (
                            <div style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Settings</div>
                          )}
                          {extSettings.map((s) => (
                            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                              <label style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, flex: 1 }}>{s.label}</label>
                              {s.type === 'boolean' ? (
                                <Toggle
                                  value={savedExtSettings[s.key] !== undefined ? Boolean(savedExtSettings[s.key]) : Boolean(s.default)}
                                  onChange={async v => {
                                    const next = { ...savedExtSettings, [s.key]: v }
                                    setExtSettingsMap(prev => ({ ...prev, [ext.id]: next }))
                                    await window.electron.extensions?.setSettings?.(ext.id, next).catch(() => {})
                                  }}
                                />
                              ) : (
                                <input
                                  type={s.type === 'number' ? 'number' : 'text'}
                                  value={String(savedExtSettings[s.key] ?? s.default ?? '')}
                                  onChange={async e => {
                                    const val = s.type === 'number' ? Number(e.target.value) : e.target.value
                                    const next = { ...savedExtSettings, [s.key]: val }
                                    setExtSettingsMap(prev => ({ ...prev, [ext.id]: next }))
                                    await window.electron.extensions?.setSettings?.(ext.id, next).catch(() => {})
                                  }}
                                  style={{
                                    background: theme.surface.input, border: `1px solid ${theme.border.default}`,
                                    color: theme.text.primary, borderRadius: 6, padding: '4px 8px',
                                    fontSize: fonts.secondarySize, fontFamily: fonts.mono, width: 160,
                                  }}
                                />
                              )}
                            </div>
                          ))}
                          {/* v2 settings sections — declarative control union rendered with @codesurf/ui */}
                          {extSettingsSections.map((sec) => (
                            <div key={sec.id} style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: extSettings.length > 0 ? 8 : 0 }}>
                              {sec.title && (
                                <div style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.muted, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{sec.title}</div>
                              )}
                              {sec.items.map((control, i) => (
                                <SettingsControl
                                  key={('key' in control ? control.key : control.label) + ':' + i}
                                  control={control}
                                  value={'key' in control ? (savedExtSettings[control.key] ?? control.default) : undefined}
                                  onChange={async (val) => {
                                    if (!('key' in control)) return
                                    const next = { ...savedExtSettings, [control.key]: val }
                                    setExtSettingsMap(prev => ({ ...prev, [ext.id]: next }))
                                    await window.electron.extensions?.setSettings?.(ext.id, next).catch(() => {})
                                  }}
                                  onCommand={(command) => { window.dispatchEvent(new CustomEvent('codesurf:command', { detail: { extId: ext.id, id: command } })) }}
                                />
                              ))}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )

      case 'prompts':
        return workspacePath ? (
          <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
            <LazyPromptsSection workspacePath={workspacePath} hideHeaderText />
          </React.Suspense>
        ) : <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Open a workspace first</div>

      case 'skills':
        return workspacePath ? (
          <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
            <LazySkillsSection workspacePath={workspacePath} hideHeaderText />
          </React.Suspense>
        ) : <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Open a workspace first</div>

      case 'agents':
        return workspacePath ? (
          <React.Suspense fallback={<div style={{ color: theme.text.muted, fontSize: fonts.secondarySize }}>Loading...</div>}>
            <LazyAgentsSection workspacePath={workspacePath} hideHeaderText />
          </React.Suspense>
        ) : <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Open a workspace first</div>

      default: {
        if (section.startsWith('ext:')) {
          const extId = section.slice(4)
          const ext = extensionsList.find(e => e.id === extId)
          const tile = ext?.contributes?.tiles?.[0]
          if (ext && tile) {
            return <ExtSettingsPanel extId={extId} tileType={tile.type} />
          }
          return <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Plugin has no block.</div>
        }
        return null
      }
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 99999,
        background: theme.mode === 'light' ? 'rgba(15,23,42,0.18)' : 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center'
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        width: '90vw', maxWidth: 1100, height: '85vh', maxHeight: 780,
        borderRadius: 14,
        border: '1px solid transparent',
        boxShadow: theme.shadow.modal,
        padding: 1,
        overflow: 'visible',
      }}>
        <div style={{
          width: '100%', height: '100%',
          background: theme.surface.panel, borderRadius: 13,
          display: 'flex', overflow: 'hidden',
          fontFamily: fonts.primary, fontSize: fonts.size,
        }}>

        {/* Left nav */}
        <div style={{
          width: 200, background: theme.surface.panelElevated,
          borderRight: '1px solid transparent',
          boxShadow: theme.mode === 'light'
            ? 'inset -1px 0 0 rgba(255,255,255,0.82)'
            : 'inset -1px 0 0 rgba(255,255,255,0.28)',
          display: 'flex', flexDirection: 'column',
          padding: '20px 0',
          flexShrink: 0
        }}>

          {/* Settings header */}
          <div style={{ padding: '8px 16px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Settings size={18} color={theme.text.primary} />
            <span style={{ fontSize: 17, fontWeight: 700, color: theme.text.primary }}>Settings</span>
          </div>

          {/* Nav items — grouped */}
          <div className="cs-fade-scroll-y" style={{ flex: 1, overflowY: 'auto' }}>
            {(['app', 'customise', 'system'] as const).map(group => {
              const groupSections = SECTIONS
                .filter(s => s.group === group)
              const groupLabel = group === 'app' ? 'App' : group === 'customise' ? 'Customise' : 'System'
              return (
                <div key={group}>
                  <div style={{ padding: '14px 16px 4px', fontSize: 9, fontWeight: 700, color: theme.text.muted, letterSpacing: 1.2, textTransform: 'uppercase', userSelect: 'none' }}>{groupLabel}</div>
                  {groupSections.map(s => (
                    <div
                      key={s.id}
                      onClick={() => setSection(s.id as Section)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 16px', cursor: 'pointer',
                        color: section === s.id ? theme.text.primary : theme.text.secondary,
                        background: section === s.id ? theme.surface.selection : 'transparent',
                        fontSize: fonts.size, userSelect: 'none',
                        transition: 'color 0.1s'
                      }}
                      onMouseEnter={e => { if (section !== s.id) e.currentTarget.style.color = theme.text.primary }}
                      onMouseLeave={e => { if (section !== s.id) e.currentTarget.style.color = theme.text.secondary }}
                    >
                      <span style={{ opacity: section === s.id ? 1 : 0.8 }}>{s.icon}</span>
                      {s.label}
                    </div>
                  ))}
                </div>
              )
            })}
            {/* Extension panels pinned to settings */}
            {(() => {
              const panelExts = extensionsList
                .filter(e => (settings.settingsPanelExtIds ?? []).includes(e.id))
                .sort((a, b) => a.name.localeCompare(b.name))
              if (panelExts.length === 0) return null
              return (
                <div>
                  <div style={{ padding: '14px 16px 4px', fontSize: 9, fontWeight: 700, color: theme.text.muted, letterSpacing: 1.2, textTransform: 'uppercase', userSelect: 'none' }}>Plugins</div>
                  {panelExts.map(e => {
                    const sid = `ext:${e.id}` as Section
                    return (
                      <div
                        key={e.id}
                        onClick={() => setSection(sid)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 16px', cursor: 'pointer',
                          color: section === sid ? theme.text.primary : theme.text.secondary,
                          background: section === sid ? theme.surface.selection : 'transparent',
                          fontSize: fonts.size, userSelect: 'none', transition: 'color 0.1s',
                        }}
                        onMouseEnter={e2 => { if (section !== sid) e2.currentTarget.style.color = theme.text.primary }}
                        onMouseLeave={e2 => { if (section !== sid) e2.currentTarget.style.color = theme.text.secondary }}
                      >
                        <span style={{ opacity: 0.85 }}>
                          <svg width="15" height="15" viewBox="0 0 14 14" fill="none"><path d="M6 1.5h2a.5.5 0 01.5.5v1.5H8a1 1 0 00-1 1 1 1 0 001 1h.5V7a.5.5 0 01-.5.5H6V7a1 1 0 00-1-1 1 1 0 00-1 1v.5H2.5A.5.5 0 012 7V5.5h.5a1 1 0 001-1 1 1 0 00-1-1H2V2a.5.5 0 01.5-.5H6z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>
                        </span>
                        {e.name}
                      </div>
                    )
                  })}
                </div>
              )
            })()}
          </div>

          {/* Version */}
          <div style={{ padding: '0 16px', fontSize: fonts.secondarySize, color: theme.text.disabled }}>
            v{__VERSION__}
          </div>
        </div>

        {/* Right content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Section header */}
          <div style={{ padding: '28px 28px 0' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: theme.text.primary, marginBottom: 4 }}>{active.label}</div>
            <div style={{ fontSize: fonts.size, color: theme.text.muted }}>{active.description}</div>
          </div>

          {/* Content */}
          <div className="cs-fade-scroll-y cs-fade-scroll-y-lg" style={{ flex: 1, overflowY: 'auto', scrollbarGutter: 'stable', padding: '4px 28px 34px' }}>
            {renderContent()}
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}

export { FontTokenEditor } from './settings/FontTokenEditor'
