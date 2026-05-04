import React, { useEffect, useState, useCallback, useRef, lazy } from 'react'
import type { AppSettings, AutoDreamSettings, ExecutionHostRecord, ExecutionMode, GenerationProviderSettings, ToolPermissionGrant, Workspace } from '../../../shared/types'
import { DEFAULT_SETTINGS, withDefaultSettings } from '../../../shared/types'
import { Settings, Type, Monitor, FolderOpen, Plus, Trash2, ChevronDown, ChevronRight, RotateCcw, Puzzle, RefreshCw, Star, Wrench, Users, FileText, Globe, Eye, EyeOff, PanelRight, Pin, Shield, KeyRound, Image as ImageIcon, Video, Mic } from 'lucide-react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { THEME_OPTIONS, getThemeCanvasDefaults, resolveEffectiveThemeId, getThemeById, type AppearanceMode } from '../theme'
import { ChromeSyncSection } from './settings/ChromeSyncSection'
import { DisplaySettingsEditor } from './settings/DisplaySettingsEditor'
import { VoiceSettingsEditor } from './settings/VoiceSettingsEditor'
import { ColorSwatch, NumInput, RangeInput, SectionLabel, SettingRow, TextInput, Toggle } from './settings/controls'

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
  { id: 'agents',     label: 'Agents',     icon: <Users size={15} />,      description: 'Agent modes with system prompts and tool access', group: 'customise' },
  // System
  { id: 'extensions', label: 'Extensions', icon: <Puzzle size={15} />,     description: 'Installed extensions', group: 'system' },
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

type ProviderModelOption = {
  id: string
  name: string
  label: string
  methods: string[]
  capabilities: Array<'image' | 'video' | 'text'>
}

type ProviderValidationResult = {
  ok: boolean
  providerId: string
  message: string
  models: ProviderModelOption[]
  textModels: ProviderModelOption[]
  imageModels: ProviderModelOption[]
  videoModels: ProviderModelOption[]
}

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

interface ChromeProfile { name: string; dir: string; email?: string }

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

type ExecutionResolution = {
  host: ExecutionHostRecord
  fallback: boolean
  reason: string
}

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
    const currentThemeId = settings.themeId
    if (mode === 'light') {
      const canvas = getThemeCanvasDefaults('paper-light')
      updateSettingsPatch({
        appearance: mode,
        themeId: 'paper-light',
        canvasBackground: canvas.background,
        gridColorSmall: canvas.gridSmall,
        gridColorLarge: canvas.gridLarge,
      })
      return
    }
    let nextThemeId = currentThemeId
    if (currentThemeId === 'paper-light') {
      nextThemeId = 'default-dark'
    }
    const canvas = getThemeCanvasDefaults(nextThemeId)
    updateSettingsPatch({
      appearance: mode,
      themeId: nextThemeId,
      canvasBackground: canvas.background,
      gridColorSmall: canvas.gridSmall,
      gridColorLarge: canvas.gridLarge,
    })
  }, [settings.themeId, updateSettingsPatch])

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
            <DisplaySettingsEditor
              settings={settings}
              onApply={updateSettingsPatch}
              updateState={updateState}
              onCheckForUpdates={checkForUpdates}
              onDownloadUpdate={downloadUpdate}
            />
          </>
        )
      }
      case 'daemon': {
        const daemonRunning = daemonStatus?.running === true
        const daemonInfo = daemonStatus?.info ?? null
        const daemonStartedLabel = daemonInfo?.startedAt
          ? new Date(daemonInfo.startedAt).toLocaleString()
          : 'Unavailable'
        return (
          <>
            <SectionLabel label="Daemon" />
            <SettingRow label="Status" description="The detached CodeSurf daemon persists workspaces, projects, settings, and session indexing outside the renderer.">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: daemonRunning ? theme.status.success : theme.status.danger,
                    boxShadow: daemonRunning ? `0 0 8px ${theme.status.success}66` : 'none',
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: fonts.secondarySize, color: daemonRunning ? theme.text.secondary : theme.status.danger }}>
                  {daemonLoading
                    ? 'Checking…'
                    : daemonRunning
                      ? `Active${daemonInfo?.pid ? ` · PID ${daemonInfo.pid}` : ''}${daemonInfo?.port ? ` · port ${daemonInfo.port}` : ''}`
                      : 'Offline'}
                </span>
              </div>
            </SettingRow>
            <SettingRow label="Runtime" description="Daemon boot time and protocol metadata.">
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <span style={{ fontSize: fonts.secondarySize, color: theme.text.secondary }}>
                  Started {daemonStartedLabel}
                </span>
                <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, fontFamily: fonts.mono }}>
                  protocol {daemonInfo?.protocolVersion ?? '—'} · app {daemonInfo?.appVersion ?? '—'}
                </span>
              </div>
            </SettingRow>
            <SettingRow label="Control" description="Refresh the status view or restart the daemon without quitting the app.">
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => { void loadDaemonStatus() }}
                  disabled={daemonLoading || daemonRestarting}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: fonts.secondarySize,
                    fontWeight: 600,
                    border: `1px solid ${theme.border.default}`,
                    background: theme.surface.input,
                    color: theme.text.secondary,
                    cursor: daemonLoading || daemonRestarting ? 'not-allowed' : 'pointer',
                    opacity: daemonLoading || daemonRestarting ? 0.6 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <RefreshCw size={14} />
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => { void handleRestartDaemon() }}
                  disabled={daemonRestarting}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 8,
                    fontSize: fonts.secondarySize,
                    fontWeight: 600,
                    border: `1px solid ${theme.border.default}`,
                    background: theme.accent.soft,
                    color: theme.accent.hover,
                    cursor: daemonRestarting ? 'not-allowed' : 'pointer',
                    opacity: daemonRestarting ? 0.6 : 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <RotateCcw size={14} />
                  {daemonRestarting ? 'Restarting…' : 'Restart daemon'}
                </button>
              </div>
            </SettingRow>
            {daemonError && (
              <div style={{ fontSize: fonts.secondarySize, color: theme.status.danger, padding: '4px 2px' }}>
                {daemonError}
              </div>
            )}
            <SectionLabel label="Dreaming" />
            <SettingRow
              label="Auto-dream"
              description="Let the daemon consolidate recent workspace sessions into generated .codesurf/DREAMING.md memory."
            >
              <Toggle
                value={settings.autoDream.enabled}
                onChange={enabled => updateAutoDreamPatch({ enabled })}
              />
            </SettingRow>
            <SettingRow
              label="Fresh sessions"
              description="Minimum new or changed sessions required before the daemon starts an automatic dream."
            >
              <NumInput
                value={settings.autoDream.minSessions}
                min={1}
                max={20}
                onChange={value => updateAutoDreamPatch({ minSessions: Math.max(1, Math.min(20, Math.round(value || 1))) })}
              />
            </SettingRow>
            <SettingRow
              label="Cooldown"
              description="Minimum minutes between successful automatic dreams. Manual runs are still available from the dream API."
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <NumInput
                  value={Math.round((settings.autoDream.minIntervalMs ?? 0) / 60000)}
                  min={0}
                  max={240}
                  onChange={value => updateAutoDreamPatch({ minIntervalMs: Math.max(0, Math.min(240, Math.round(value || 0))) * 60000 })}
                />
                <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>min</span>
              </div>
            </SettingRow>
            <details style={{ marginBottom: 8 }}>
              <summary style={{ cursor: 'pointer', color: theme.text.disabled, fontSize: fonts.secondarySize, padding: '6px 2px' }}>
                Advanced auto-dream cadence
              </summary>
              <div style={{ marginTop: 8 }}>
                <SettingRow
                  label="Sweep interval"
                  description="Minutes between daemon background sweeps for externally written sessions. Set 0 to disable periodic sweeps."
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <NumInput
                      value={Math.round((settings.autoDream.sweepMs ?? 0) / 60000)}
                      min={0}
                      max={120}
                      onChange={value => updateAutoDreamPatch({ sweepMs: Math.max(0, Math.min(120, Math.round(value || 0))) * 60000 })}
                    />
                    <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>min</span>
                  </div>
                </SettingRow>
                <SettingRow
                  label="Trigger debounce"
                  description="Seconds to wait after session updates before evaluating auto-dream thresholds."
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <NumInput
                      value={Math.round((settings.autoDream.debounceMs ?? 0) / 1000)}
                      min={0}
                      max={120}
                      onChange={value => updateAutoDreamPatch({ debounceMs: Math.max(0, Math.min(120, Math.round(value || 0))) * 1000 })}
                    />
                    <span style={{ fontSize: fonts.secondarySize, color: theme.text.disabled }}>sec</span>
                  </div>
                </SettingRow>
              </div>
            </details>
            <SectionLabel label="Execution" />
            <SettingRow
              label="Default routing"
              description="Choose whether new work prefers the local daemon, stays in-process, or pins to a specific registered host."
            >
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 460 }}>
                {([
                  { id: 'auto', label: 'Auto' },
                  { id: 'prefer-local-daemon', label: 'Prefer daemon' },
                  { id: 'runtime-only', label: 'Runtime only' },
                  { id: 'daemon-only', label: 'Daemon only' },
                  { id: 'specific-host', label: 'Specific host' },
                ] as const satisfies Array<{ id: ExecutionMode; label: string }>).map(option => {
                  const activeExecutionMode = (settings.execution?.mode ?? 'auto') === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => updateSettingsPatch({
                        execution: {
                          mode: option.id,
                          hostId: option.id === 'specific-host'
                            ? (settings.execution?.hostId ?? executionHosts.find(host => host.type === 'remote-daemon')?.id ?? null)
                            : null,
                        },
                      })}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 8,
                        fontSize: fonts.secondarySize,
                        fontWeight: 600,
                        border: `1px solid ${activeExecutionMode ? theme.accent.base : theme.border.default}`,
                        background: activeExecutionMode ? theme.accent.soft : theme.surface.input,
                        color: activeExecutionMode ? theme.accent.hover : theme.text.secondary,
                        cursor: 'pointer',
                      }}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </SettingRow>
            {(settings.execution?.mode ?? 'auto') === 'specific-host' && (
              <SettingRow
                label="Pinned host"
                description="Use one registered remote daemon for new work until you change the policy."
              >
                <select
                  value={settings.execution?.hostId ?? ''}
                  onChange={e => updateSettingsPatch({
                    execution: {
                      ...settings.execution,
                      mode: 'specific-host',
                      hostId: e.target.value || null,
                    },
                  })}
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
                  <option value="">Select host…</option>
                  {executionHosts.filter(host => host.type === 'remote-daemon' && host.enabled !== false).map(host => (
                    <option key={host.id} value={host.id}>
                      {host.label} · {host.type}
                    </option>
                  ))}
                </select>
              </SettingRow>
            )}
            <SettingRow
              label="Resolved target"
              description="What the current policy resolves to right now, using the daemon status and registered hosts."
            >
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, maxWidth: 420 }}>
                <span style={{ fontSize: fonts.secondarySize, color: theme.text.secondary, fontWeight: 600 }}>
                  {executionResolution
                    ? `${executionResolution.host.label}${executionResolution.fallback ? ' · fallback' : ''}`
                    : 'Unavailable'}
                </span>
                <span style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, textAlign: 'right', lineHeight: 1.4 }}>
                  {executionResolution?.reason ?? 'Execution routing has not been resolved yet.'}
                </span>
              </div>
            </SettingRow>
            <SectionLabel label="Hosts" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
              {executionHostsLoading && (
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, padding: '4px 2px' }}>
                  Loading hosts…
                </div>
              )}
              {executionHosts.map(host => {
                const builtin = host.type !== 'remote-daemon'
                return (
                  <div
                    key={host.id}
                    style={{
                      background: theme.surface.panelMuted,
                      border: `1px solid ${theme.border.default}`,
                      borderRadius: 10,
                      padding: '12px 14px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 600 }}>{host.label}</span>
                        <span style={{ fontSize: 10, color: theme.text.disabled, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{host.type}</span>
                        {builtin && (
                          <span style={{ fontSize: 10, color: theme.text.disabled, textTransform: 'uppercase', letterSpacing: '0.06em' }}>built-in</span>
                        )}
                      </div>
                      <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: host.url ? fonts.mono : undefined, marginTop: 3 }}>
                        {host.url || (host.type === 'runtime' ? 'In-process Electron main runtime' : 'Detached daemon on this machine')}
                      </div>
                    </div>
                    {!builtin && (
                      <>
                        <Toggle
                          value={host.enabled !== false}
                          onChange={value => { void saveExecutionHost({ ...host, enabled: value }) }}
                        />
                        <button
                          type="button"
                          onClick={() => { void removeExecutionHost(host.id) }}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: theme.text.disabled,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      </>
                    )}
                  </div>
                )
              })}
              <div
                style={{
                  background: theme.surface.panelMuted,
                  border: `1px dashed ${theme.border.default}`,
                  borderRadius: 10,
                  padding: '12px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 600 }}>Add remote daemon</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <TextInput value={newHostLabel} onChange={setNewHostLabel} width={180} placeholder="Mac Mini" />
                  <TextInput value={newHostUrl} onChange={setNewHostUrl} width={240} placeholder="https://daemon.example.com" />
                  <TextInput value={newHostToken} onChange={setNewHostToken} width={200} placeholder="Optional token" />
                  <button
                    type="button"
                    onClick={() => {
                      const trimmedLabel = newHostLabel.trim()
                      const trimmedUrl = newHostUrl.trim()
                      if (!trimmedLabel || !trimmedUrl) return
                      const id = trimmedLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `host-${Date.now()}`
                      void saveExecutionHost({
                        id,
                        type: 'remote-daemon',
                        label: trimmedLabel,
                        url: trimmedUrl,
                        authToken: newHostToken.trim() || null,
                        enabled: true,
                      }).then(() => {
                        setNewHostLabel('')
                        setNewHostUrl('')
                        setNewHostToken('')
                      })
                    }}
                    style={{
                      padding: '6px 12px',
                      borderRadius: 8,
                      fontSize: fonts.secondarySize,
                      fontWeight: 600,
                      border: `1px solid ${theme.border.default}`,
                      background: theme.accent.soft,
                      color: theme.accent.hover,
                      cursor: 'pointer',
                    }}
                  >
                    Add host
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled }}>
                  <span>Label</span>
                  <span>URL</span>
                  <span>Token</span>
                </div>
              </div>
            </div>
            {executionHostsError && (
              <div style={{ fontSize: fonts.secondarySize, color: theme.status.danger, padding: '4px 2px' }}>
                {executionHostsError}
              </div>
            )}
          </>
        )
      }
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

      case 'providers': {
        const generationProviders = Object.values(settings.generationProviders ?? {})
        const providerOrder = ['gemini', 'anthropic', 'openrouter', 'openai', 'replicate', 'runway', 'luma', 'stability', 'local']
        const sortedProviders = generationProviders.sort((a, b) => {
          const ai = providerOrder.indexOf(a.id)
          const bi = providerOrder.indexOf(b.id)
          if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
          return a.label.localeCompare(b.label)
        })
        const inputStyle: React.CSSProperties = {
          width: '100%',
          minWidth: 0,
          padding: '7px 9px',
          fontSize: fonts.secondarySize,
          background: theme.surface.input,
          color: theme.text.secondary,
          border: `1px solid ${theme.border.default}`,
          borderRadius: 8,
          outline: 'none',
          fontFamily: fonts.mono,
        }
        const labelStyle: React.CSSProperties = {
          fontSize: Math.max(10, fonts.secondarySize - 1),
          color: theme.text.disabled,
          marginBottom: 5,
        }
        return (
          <>
            <SectionLabel label="Generation Providers" />
            <div style={{ background: theme.surface.panelMuted, border: `1px solid ${theme.border.subtle}`, borderRadius: 10, padding: '12px 16px', marginBottom: 10 }}>
              <div style={{ fontSize: fonts.size, color: theme.text.secondary, lineHeight: 1.45 }}>
                These keys are for canvas image and video tools. Connected blocks can request edits or generations against an enabled provider, then replace the image or media source when the file is ready.
              </div>
              <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, marginTop: 6 }}>
                Keys are stored in the local CodeSurf settings file on this machine.
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 10 }}>
              {sortedProviders.map(provider => {
                const capabilities = new Set(provider.capabilities ?? [])
                const showKey = visibleProviderKeys[provider.id] ?? false
                const validation = providerValidation[provider.id]
                const validationLoading = validation && 'loading' in validation
                const validationResult = validation && !('loading' in validation) ? validation : null
                const textModelOptions = validationResult?.textModels ?? []
                const imageModelOptions = validationResult?.imageModels ?? []
                const videoModelOptions = validationResult?.videoModels ?? []
                const allModelOptions = validationResult?.models ?? []
                const textListId = `provider-${provider.id}-text-models`
                const imageListId = `provider-${provider.id}-image-models`
                const videoListId = `provider-${provider.id}-video-models`
                return (
                  <div
                    key={provider.id}
                    style={{
                      background: theme.surface.panelMuted,
                      border: `1px solid ${provider.enabled ? theme.accent.base : theme.border.subtle}`,
                      borderRadius: 10,
                      padding: 14,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                      minWidth: 0,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: fonts.size, color: theme.text.primary, fontWeight: 700 }}>{provider.label}</span>
                          {capabilities.has('image') && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: theme.text.muted, background: theme.surface.input, borderRadius: 999, padding: '3px 7px' }}>
                              <ImageIcon size={11} />
                              image
                            </span>
                          )}
                          {capabilities.has('text') && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: theme.text.muted, background: theme.surface.input, borderRadius: 999, padding: '3px 7px' }}>
                              <Type size={11} />
                              text
                            </span>
                          )}
                          {capabilities.has('video') && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: theme.text.muted, background: theme.surface.input, borderRadius: 999, padding: '3px 7px' }}>
                              <Video size={11} />
                              video
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, fontFamily: fonts.mono, marginTop: 4 }}>
                          {provider.id}
                        </div>
                      </div>
                      <Toggle value={provider.enabled} onChange={enabled => updateGenerationProvider(provider.id, { enabled })} />
                    </div>

                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        onClick={() => validateProvider(provider)}
                        disabled={Boolean(validationLoading)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '6px 10px',
                          borderRadius: 8,
                          fontSize: fonts.secondarySize,
                          fontWeight: 600,
                          border: `1px solid ${theme.border.default}`,
                          background: theme.surface.input,
                          color: theme.text.secondary,
                          cursor: validationLoading ? 'default' : 'pointer',
                          opacity: validationLoading ? 0.7 : 1,
                        }}
                      >
                        <RefreshCw size={13} />
                        {validationLoading ? 'Checking...' : 'Validate key'}
                      </button>
                      {validationResult ? (
                        <div
                          style={{
                            flex: 1,
                            minWidth: 180,
                            fontSize: Math.max(10, fonts.secondarySize - 1),
                            color: validationResult.ok ? theme.accent.base : '#ff9b8b',
                            lineHeight: 1.35,
                          }}
                        >
                          {validationResult.message}
                        </div>
                      ) : null}
                    </div>

                    {provider.id !== 'local' && (
                      <div>
                        <div style={labelStyle}>API key</div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <input
                            type={showKey ? 'text' : 'password'}
                            value={provider.apiKey ?? ''}
                            onChange={e => updateGenerationProvider(provider.id, { apiKey: e.target.value })}
                            placeholder={`${provider.label} API key`}
                            autoComplete="off"
                            spellCheck={false}
                            style={inputStyle}
                          />
                          <button
                            type="button"
                            onClick={() => setVisibleProviderKeys(prev => ({ ...prev, [provider.id]: !showKey }))}
                            title={showKey ? 'Hide key' : 'Show key'}
                            style={{
                              width: 34,
                              height: 34,
                              borderRadius: 8,
                              border: `1px solid ${theme.border.default}`,
                              background: theme.surface.input,
                              color: theme.text.secondary,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              flexShrink: 0,
                            }}
                          >
                            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      </div>
                    )}

                    {capabilities.has('text') && (
                      <div>
                        <div style={labelStyle}>Default text model</div>
                        <input
                          type="text"
                          value={provider.textModel ?? ''}
                          onChange={e => updateGenerationProvider(provider.id, { textModel: e.target.value })}
                          placeholder={provider.id === 'anthropic' ? 'claude-sonnet-4-20250514' : provider.id === 'openrouter' ? 'openrouter/auto' : 'Provider model id'}
                          list={textModelOptions.length ? textListId : undefined}
                          spellCheck={false}
                          style={inputStyle}
                        />
                        {textModelOptions.length ? (
                          <datalist id={textListId}>
                            {textModelOptions.map(model => <option key={model.name || model.id} value={model.id}>{model.label}</option>)}
                          </datalist>
                        ) : null}
                      </div>
                    )}

                    {capabilities.has('image') && (
                      <div>
                        <div style={labelStyle}>Default image model</div>
                        <input
                          type="text"
                          value={provider.imageModel ?? ''}
                          onChange={e => updateGenerationProvider(provider.id, { imageModel: e.target.value })}
                          placeholder={provider.id === 'gemini' ? 'gemini-2.5-flash-image' : 'Provider model id'}
                          list={imageModelOptions.length ? imageListId : undefined}
                          spellCheck={false}
                          style={inputStyle}
                        />
                        {imageModelOptions.length ? (
                          <datalist id={imageListId}>
                            {imageModelOptions.map(model => <option key={model.name || model.id} value={model.id}>{model.label}</option>)}
                          </datalist>
                        ) : null}
                      </div>
                    )}

                    {capabilities.has('video') && (
                      <div>
                        <div style={labelStyle}>Default video model</div>
                        <input
                          type="text"
                          value={provider.videoModel ?? ''}
                          onChange={e => updateGenerationProvider(provider.id, { videoModel: e.target.value })}
                          placeholder={provider.id === 'gemini' ? 'veo-3.1-generate-preview' : 'Provider model id'}
                          list={videoModelOptions.length ? videoListId : undefined}
                          spellCheck={false}
                          style={inputStyle}
                        />
                        {videoModelOptions.length ? (
                          <datalist id={videoListId}>
                            {videoModelOptions.map(model => <option key={model.name || model.id} value={model.id}>{model.label}</option>)}
                          </datalist>
                        ) : null}
                      </div>
                    )}

                    {provider.id === 'gemini' && capabilities.has('video') && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <div>
                          <div style={labelStyle}>Video aspect</div>
                          <select
                            value={provider.videoAspectRatio ?? '16:9'}
                            onChange={e => updateGenerationProvider(provider.id, { videoAspectRatio: e.target.value })}
                            style={inputStyle}
                          >
                            <option value="16:9">16:9 landscape</option>
                            <option value="9:16">9:16 portrait</option>
                          </select>
                        </div>
                        <div>
                          <div style={labelStyle}>Video resolution</div>
                          <select
                            value={provider.videoResolution ?? '720p'}
                            onChange={e => updateGenerationProvider(provider.id, { videoResolution: e.target.value })}
                            style={inputStyle}
                          >
                            <option value="720p">720p</option>
                            <option value="1080p">1080p</option>
                            <option value="4k">4k</option>
                          </select>
                        </div>
                      </div>
                    )}

                    {validationResult?.ok && allModelOptions.length ? (
                      <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.disabled, lineHeight: 1.35 }}>
                        {allModelOptions.length} accessible models listed. Image and video fields above will autocomplete with compatible models where the API exposes that metadata.
                      </div>
                    ) : null}

                    {(provider.id === 'local' || provider.baseUrl !== undefined) && (
                      <div>
                        <div style={labelStyle}>Base URL</div>
                        <input
                          type="text"
                          value={provider.baseUrl ?? ''}
                          onChange={e => updateGenerationProvider(provider.id, { baseUrl: e.target.value })}
                          placeholder="http://localhost:8188 or compatible endpoint"
                          spellCheck={false}
                          style={inputStyle}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
            <SettingRow label="Reset providers" description="Restore the built-in provider list while keeping unrelated settings untouched.">
              <button
                type="button"
                onClick={() => updateSettingsPatch({ generationProviders: DEFAULT_SETTINGS.generationProviders })}
                style={{
                  padding: '6px 12px',
                  borderRadius: 8,
                  fontSize: fonts.secondarySize,
                  fontWeight: 600,
                  border: `1px solid ${theme.border.default}`,
                  background: theme.surface.input,
                  color: theme.text.secondary,
                  cursor: 'pointer',
                }}
              >
                Reset list
              </button>
            </SettingRow>
          </>
        )
      }



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
                <div style={{ fontSize: fonts.size, fontWeight: 600, color: theme.text.primary }}>Disable all extensions</div>
                <div style={{ fontSize: fonts.secondarySize, color: theme.text.muted, marginTop: 2 }}>
                  {settings.extensionsDisabled ? 'Extensions are hidden from the sidebar and footer' : 'Hide all extensions from the sidebar and footer'}
                </div>
              </div>
              <Toggle value={settings.extensionsDisabled ?? false} onChange={v => updateSettingsPatch({ extensionsDisabled: v })} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ fontSize: fonts.secondarySize, color: theme.text.disabled, lineHeight: 1.45, flex: 1, minWidth: 200 }}>
                Extensions load from <code style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>~/.contex/extensions</code>
                {workspaces.length > 0 && (
                  <> and the active workspace&apos;s <code style={{ fontSize: fonts.secondarySize, color: theme.text.muted, fontFamily: fonts.mono }}>.contex/extensions</code></>
                )}
                . Disable a power extension to unload its main process code; use Refresh after adding folders.
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
                          {extSettings.length > 0 && (
                            <button
                              title="Extension settings"
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
                      {isExpanded && extSettings.length > 0 && (
                        <div style={{
                          borderTop: `1px solid ${theme.border.default}`,
                          padding: '12px 14px',
                          background: theme.surface.panel,
                          display: 'flex', flexDirection: 'column', gap: 10,
                        }}>
                          <div style={{ fontSize: fonts.secondarySize, fontWeight: 600, color: theme.text.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Settings</div>
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
          return <div style={{ color: theme.text.disabled, fontSize: fonts.secondarySize }}>Extension has no block.</div>
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
        background: theme.surface.panel, borderRadius: 14,
        border: `1px solid ${theme.border.default}`,
        boxShadow: theme.shadow.modal,
        display: 'flex', overflow: 'hidden',
        fontFamily: fonts.primary, fontSize: fonts.size,
      }}>

        {/* Left nav */}
        <div style={{
          width: 200, background: theme.surface.panelElevated,
          borderRight: `1px solid ${theme.border.default}`,
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
          <div style={{ flex: 1, overflowY: 'auto' }}>
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
                  <div style={{ padding: '14px 16px 4px', fontSize: 9, fontWeight: 700, color: theme.text.muted, letterSpacing: 1.2, textTransform: 'uppercase', userSelect: 'none' }}>Extensions</div>
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
          <div style={{ flex: 1, overflowY: 'auto', scrollbarGutter: 'stable', padding: '4px 28px 28px' }}>
            {renderContent()}
          </div>
        </div>
      </div>
    </div>
  )
}

export { FontTokenEditor } from './settings/FontTokenEditor'
