import React, { useState, useEffect, useRef, useCallback, useMemo, Suspense } from 'react'
import type { AppSettings, Persona } from '../../../shared/types'
import { loadPersonas, getAgentIcon, DEFAULT_PERSONAS } from '../config/agentModes'
import { resolvePersonaModelSeed, resolveSkillModelLock } from '../hooks/personaModelBinding'
import { MONO_DEFAULT } from '../FontContext'

const LazyTerminalTile = React.lazy(() => import('./TerminalTile').then(m => ({ default: m.TerminalTile })))

import { useChatGitState } from '../hooks/useChatGitState'
import { useAutoSpeak, bargeIn } from '../hooks/useAutoSpeak'
import { ttsPlayer, type TtsPlayerState } from '../utils/ttsPlayer'
import { useChatDictation } from '../hooks/useChatDictation'
import { useChatExecutionHosts } from '../hooks/useChatExecutionHosts'
import { useChatTileCoreState } from '../hooks/useChatTileCoreState'
import { useChatTileProviders } from '../hooks/useChatTileProviders'
import { useChatTilePersistence } from '../hooks/useChatTilePersistence'
import { useChatTileMessaging } from '../hooks/useChatTileMessaging'
import { useChatTileTranscript } from '../hooks/useChatTileTranscript'
import { useChatTileBlockNotes } from '../hooks/useChatTileBlockNotes'
import { useChatTileLatestChangeDrawer } from '../hooks/useChatTileLatestChangeDrawer'
import { useChatTileComposerMenus } from '../hooks/useChatTileComposerMenus'
import { useChatTileLiveComposerActivity } from '../hooks/useChatTileLiveComposerActivity'
import { useChatTileThemeFonts } from '../hooks/useChatTileThemeFonts'
import { useChatTilePeerContext } from '../hooks/useChatTilePeerContext'
import { useChatTileInventories } from '../hooks/useChatTileInventories'
import { useChatTileWorkspaceSkills } from '../hooks/useChatTileWorkspaceSkills'
import { useChatTileStreamBuffer } from '../hooks/useChatTileStreamBuffer'
import { useChatTileLifecycleEffects } from '../hooks/useChatTileLifecycleEffects'
import { useChatTileContextUsage } from '../hooks/useChatTileContextUsage'
import { useChatTileGitMenus } from '../hooks/useChatTileGitMenus'
import { useChatTileSurfaces } from '../hooks/useChatTileSurfaces'

import { ChatTileTranscriptColumn } from './chat/ChatTileTranscriptColumn'
import { useChatStreamHandler } from '../hooks/useChatStreamHandler'
import { useTileTodos } from '../state/tileTodosStore'
import { PlanPane } from './chat/PlanPane'
import { ChatTileComposer } from './chat/ChatTileComposer'
import { ToolPermissionProvider } from './ai-elements/ToolPermission'
import { useChatAutocomplete } from '../hooks/useChatAutocomplete'
import { useChatTileDreamPolling } from '../hooks/useChatTileDreamPolling'
import { useChatTileComposerKeys } from '../hooks/useChatTileComposerKeys'
import { useChatTileAttachments } from '../hooks/useChatTileAttachments'
import { useChatAutocompleteSelection } from '../hooks/useChatAutocompleteSelection'
import { useContributions } from '../hooks/useContributions'
import { type PaletteCommand } from '../lib/commandRegistry'
import {
  AskUserQuestionContext,
  AskUserQuestionFontsContext,
} from './chat/AskUserQuestionForm'
import { ensureChatMdStyle } from './chat/ChatTileViews'
import { CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT } from './chat/chatTileLayout'
import {
  FontCtx,
  CheckpointRestoreContext,
  ChatDispatchProvider,
  type ChatDispatchValue,
} from './chat/chatTileContexts'
import { canUsePagedLinkedHistory, type DiscoveryPeer } from './chat/chatTileUtils'

export {
  hasVisibleFileChangeStats,
  hasRenderableFileChangeDiff,
  getToolDisplayName,
} from './chat/chatTileUtils'

// --- Types -----------------------------------------------------------------------

interface Props {
  tileId: string
  workspaceId: string
  workspaceDir: string
  width: number
  height: number
  reloadToken?: number
  settings?: AppSettings
  onChatModePreferenceChange?: (providerId: string, modeId: string) => void
  isConnected?: boolean
  isAutoConnected?: boolean
  connectedPeers?: DiscoveryPeer[]
}

export type { CheckpointRestoreContextValue } from './chat/chatTileTypes'
export {
  CheckpointRestoreContext,
  TOOL_BLOCK_MAX_WIDTH,
  NON_SELECTABLE_UI_STYLE,
} from './chat/chatTileContexts'

// --- Component -------------------------------------------------------------------

export function ChatTile({ tileId, workspaceId, workspaceDir: _workspaceDir, width, height, reloadToken = 0, settings, onChatModePreferenceChange, isConnected, isAutoConnected, connectedPeers = [] }: Props): JSX.Element {
  const {
    theme,
    fontSans,
    fontMono,
    fontSize,
    fontLineHeight,
    fontWeight,
    monoSize,
    chatViewportBackground,
    composerBackground,
    composerBorder,
    chatSurfaceThemeColors,
    chatSurfaceThemeVars,
    fontCtxValue,
  } = useChatTileThemeFonts(settings)
  const {
    initialRuntimeStateRef, initialMode, initialJobSequence,
    messages, setMessages, input, setInput, isStreaming, setIsStreaming,
    executionTarget, setExecutionTarget, cloudHostId, setCloudHostId,
    provider, setProvider, model, setModel, mcpEnabled, setMcpEnabled,
    mode, setMode, thinking, setThinking, agentId, setAgentId, autoAgentMode, setAutoAgentMode,
    attachments, setAttachments, queuedTurns, setQueuedTurns,
    openChatSurfaces, setOpenChatSurfaces, activeChatSurfaceId, setActiveChatSurfaceId,
    sessionId, setSessionId, sessionIdsByProvider, setSessionIdsByProvider, commitSessionId, swapProviderSession,
    jobId, setJobId, jobSequence, setJobSequence,
    linkedSessionEntryId, setLinkedSessionEntryId, linkedSessionHint, setLinkedSessionHint,
    preserveSessionSummary, setPreserveSessionSummary, hasEarlierMessages, setHasEarlierMessages,
    activeView, setActiveView,
    lastActivityAtRef, toolCollapseTick, setToolCollapseTick, explodedChipGroups, toggleExplodedChipGroup,
    pendingToolPermissions, setPendingToolPermissions, resolvedToolPermissions, setResolvedToolPermissions,
    handleToolPermissionDecision, toolCompletedAtRef,
  } = useChatTileCoreState({ tileId, settings })
  const { workspaceSkills } = useChatTileWorkspaceSkills(_workspaceDir)
  const { peerContextRef, peerContextVersion, implicitPeerImageAttachments } = useChatTilePeerContext({
    tileId,
    workspaceId,
    connectedPeers,
  })
  const { mcpServers, peerToolNames } = useChatTileInventories({
    tileId,
    provider,
    model,
    mcpEnabled,
    connectedPeers,
    workspaceSkills,
  })
  const [disabledServers, setDisabledServers] = useState<Set<string>>(new Set())
  // Tracks the permission mode we last pushed to the running Claude query so
  // user-initiated mid-stream mode switches (Default -> Bypass etc.) propagate
  // into the active canUseTool closure via chat:setPermissionMode.
  const lastPushedModeRef = useRef<string>(initialMode)
  const effectiveAgentMode = Boolean(isConnected || isAutoConnected || autoAgentMode)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const acRef = useRef<HTMLDivElement>(null)
  const closeProviderMenuRef = useRef<() => void>(() => {})
  const closeAutocompleteRef = useRef<() => void>(() => {})
  const {
    providerEntries,
    providerEntryById,
    currentProviderEntry,
    modeOptions,
    currentMode,
    optionNoun,
    currentModel,
    thinkingOptions,
    handleProviderChange,
  } = useChatTileProviders({
    provider,
    setProvider,
    model,
    setModel,
    mode,
    setMode,
    thinking,
    setThinking,
    settings,
    connectedPeers,
    peerContextRef,
    peerContextVersion,
    onProviderChanged: () => closeProviderMenuRef.current(),
    swapProviderSession,
  })
  const {
    showModelMenu,
    setShowModelMenu,
    showProviderMenu,
    setShowProviderMenu,
    showInsertMenu,
    setShowInsertMenu,
    showModeMenu,
    setShowModeMenu,
    showThinkingMenu,
    setShowThinkingMenu,
    showLocationMenu,
    setShowLocationMenu,
    showBranchMenu,
    setShowBranchMenu,
    showContextMenu,
    showAgentMenu,
    setShowAgentMenu,
    modelFilter,
    setModelFilter,
    branchFilter,
    setBranchFilter,
    modelMenuRef,
    providerMenuRef,
    insertMenuRef,
    modeMenuRef,
    thinkingMenuRef,
    locationMenuRef,
    branchMenuRef,
    contextMenuRef,
    agentMenuRef,
    toggleMenu,
  } = useChatTileComposerMenus({
    textareaRef,
    acRef,
    onCloseAutocomplete: () => closeAutocompleteRef.current(),
  })
  closeProviderMenuRef.current = () => setShowProviderMenu(false)

  // Agent definitions (built-ins + workspace agents.json) selectable from the
  // composer toolbar. Refreshed on mount and whenever the agent menu opens, so a
  // freshly-authored agent in CustomisationTile shows up without a tile reload.
  // Seed with the built-in modes so a restored built-in agentId resolves
  // synchronously (no fail-closed window for Agent/Ask/Plan). Only user-authored
  // agents — which live in agents.json and load asynchronously below — can briefly
  // be unresolved, and the dispatch guard + provider safety net cover that window.
  const [agentModes, setAgentModes] = useState<Persona[]>(DEFAULT_PERSONAS)
  // Definitive "agents.json has been read for this workspace" flag. The composer
  // seeds built-ins synchronously for UX, but a SEND must reflect any agents.json
  // override — until this is true, dispatchMessageContent re-resolves the agent
  // from disk (or fails closed) instead of trusting the looser seeded built-in.
  const [agentModesLoaded, setAgentModesLoaded] = useState(false)
  // Reset on workspace change so a send can't dispatch against the previous
  // workspace's agent definitions.
  useEffect(() => { setAgentModesLoaded(false) }, [_workspaceDir])
  useEffect(() => {
    let cancelled = false
    void loadPersonas(_workspaceDir).then(list => {
      if (!cancelled) { setAgentModes(list); setAgentModesLoaded(true) }
    })
    return () => { cancelled = true }
  }, [_workspaceDir, showAgentMenu])
  const resolvedAgentMode = useMemo(
    () => agentModes.find(a => a.id === agentId) ?? null,
    [agentModes, agentId],
  )
  // Precedence LAYER 1 (P1b-2): a linked skill's `requiredModel` HARD-locks the
  // composer. Computed from the active persona + discovered workspace skills; when
  // non-null the model/provider pills are disabled and the live state is pinned.
  const modelLock = useMemo(
    () => resolveSkillModelLock(resolvedAgentMode, workspaceSkills),
    [resolvedAgentMode, workspaceSkills],
  )
  // Keep the live composer state pinned while a lock is active. This closes the
  // gap onSelectAgent can't: an async skill load or a restored `agentId` (where
  // the click handler never fires) would otherwise leave a stale model behind a
  // disabled pill. Early-return when unlocked so layer 3 (user pick) is untouched.
  // This effect only forces the HARD lock — the soft seed (layer 2) still happens
  // exclusively in the onSelectAgent click handler, never in an effect.
  useEffect(() => {
    if (!modelLock) return
    if (modelLock.provider) setProvider(modelLock.provider)
    if (modelLock.model) setModel(modelLock.model)
  }, [modelLock?.provider, modelLock?.model])

  const {
    chatSurfaceMenu,
    activeChatSurface,
    activeChatSurfaceRef,
    openChatSurfacesRef,
    setChatSurfaceIframeRef,
    getChatSurfaceIframe,
    postToChatSurface,
    openChatSurface,
    openBuilderFromSketch,
    closeChatSurface,
  } = useChatTileSurfaces({
    tileId,
    workspaceId,
    workspaceDir: _workspaceDir,
    openChatSurfaces,
    setOpenChatSurfaces,
    activeChatSurfaceId,
    setActiveChatSurfaceId,
    setShowInsertMenu,
    chatSurfaceThemeColors,
    chatSurfaceThemeVars,
  })
  const pagedLinkedHistoryEnabled = canUsePagedLinkedHistory(linkedSessionEntryId, linkedSessionHint, sessionId)
  const { isStreamingRef, setMessagesSafe, queueStreamText, flushPendingStreamText } = useChatTileStreamBuffer({
    setMessages,
    pagedLinkedHistoryEnabled,
    isStreaming,
  })
  const { localExecutionLabel, remoteHosts, activeCloudHost, executionDisplayLabel, executionDisplayDetail } = useChatExecutionHosts({
    executionPreference: settings?.execution ?? null,
    executionTarget,
    cloudHostId,
  })
  const hasSendableDraft = input.trim().length > 0 || attachments.length > 0 || implicitPeerImageAttachments.length > 0
  // Drag-reorder state for the queued-turn list. A row can be dropped above
  // ('before'), below ('after'), or onto ('into') another row — the last case
  // nests it as a child of that row, rendered indented underneath.
  const [draggingTurnId, setDraggingTurnId] = useState<string | null>(null)
  const [dragOverTurn, setDragOverTurn] = useState<{ id: string; mode: 'before' | 'after' | 'into' } | null>(null)
  // Collapse the queue into a single summary row once it grows past a few
  // items. Keeps the composer area quiet when a batch of queued prompts
  // stacks up. Auto-collapses on the cross-over, but the user can manually
  // expand / re-collapse via the header.
  const [queueCollapsed, setQueueCollapsed] = useState(true)
  const { gitStatus, gitBranches, refreshGitState } = useChatGitState(_workspaceDir)
  const lastJobSequenceRef = useRef<number>(initialJobSequence)
  const resumedJobKeyRef = useRef<string | null>(null)

  useEffect(() => {
    lastJobSequenceRef.current = jobSequence
  }, [jobSequence])

  useEffect(() => {
    if (!jobId) {
      resumedJobKeyRef.current = null
    }
  }, [jobId])

  const { latestStateRef, stateLoadedRef, persistLatestState } = useChatTilePersistence({
    tileId,
    workspaceId,
    reloadToken,
    initialRuntimeStateRef,
    fallbackProvider: provider,
    messages,
    input,
    attachments,
    queuedTurns,
    openChatSurfaces,
    activeChatSurfaceId,
    executionTarget,
    provider,
    model,
    mcpEnabled,
    mode,
    thinking,
    agentId,
    effectiveAgentMode,
    autoAgentMode,
    preserveSessionSummary,
    linkedSessionEntryId,
    linkedSessionHint,
    hasEarlierMessages,
    sessionId,
    sessionIdsByProvider,
    jobId,
    jobSequence,
    cloudHostId,
    isStreaming,
    activeView,
    setMessagesSafe,
    setInput,
    setAttachments,
    setQueuedTurns,
    setOpenChatSurfaces,
    setActiveChatSurfaceId,
    setActiveView,
    setProvider,
    setModel,
    setExecutionTarget,
    setMcpEnabled,
    setMode,
    setThinking,
    setAgentId,
    setAutoAgentMode,
    setPreserveSessionSummary,
    setLinkedSessionEntryId,
    setLinkedSessionHint,
    setHasEarlierMessages,
    setSessionId,
    setSessionIdsByProvider,
    setJobId,
    setJobSequence,
    setCloudHostId,
    setIsStreaming,
    lastJobSequenceRef,
  })

  const {
    messagesRef,
    stickToBottomRef,
    historicalMessages,
    setHistoricalMessages,
    allMessages,
    renderedMessages,
    hiddenMessageCount,
    loadingEarlier,
    earlierLoadError,
    showScrollToLatest,
    scrollToLatest,
    reviewLatestChanges,
    handleMessagesScroll,
    handleMessagesWheel,
    handleMessagesKeyDown,
    setAnnotationComposerActive,
  } = useChatTileTranscript({
    workspaceId,
    sessionId,
    linkedSessionEntryId,
    linkedSessionHint,
    hasEarlierMessages,
    setHasEarlierMessages,
    messages,
    setMessages,
    pagedLinkedHistoryEnabled,
    isStreaming,
  })

  const {
    updateBlockNote,
    exportNotesToClipboard,
  } = useChatTileBlockNotes({
    allMessages,
    setMessagesSafe,
    setHistoricalMessages,
  })

  // ─── TTS auto-speak (last-message-only, sentence-streamed) ──────────
  // Voice config comes from the persisted AppSettings.voice block (edited
  // via Settings → Voice). The ChatTile receives `settings` as a prop, so
  // any update from the settings panel re-flows here automatically.
  const voiceSettings = settings?.voice ?? {
    sttProvider: 'openai' as const,
    sttLang: 'en',
    ttsProvider: 'cartesia' as const,
    spokifyModel: 'claude-haiku-4-5-20251001',
    autoSpeak: 'off' as const,
    bargeIn: true,
  }

  // Voice dictation — extracted to useChatDictation hook.
  const dictation = useChatDictation({ voiceSettings })
  const { isDictating, dictationText, dictationError, toggleDictation } = dictation
  const autoSpeakEnabled = voiceSettings.autoSpeak === 'last-message'
  // Track the most recent assistant message id + final text for auto-speak.
  // We need its id (for deduping in the hook) and its text (after stream
  // completion). isStreaming gates: don't speak until the agent has finished.
  // ─── Subscribe to TTS player state for the visual indicator ─────────
  const [ttsState, setTtsState] = useState<TtsPlayerState>(() => ttsPlayer.state)
  useEffect(() => ttsPlayer.subscribe(setTtsState), [])

  // Find the most-recent assistant message (excluding streaming-in-progress).
  // This is what auto-speak watches.
  const lastAssistantMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'assistant') return m
    }
    return null
  }, [messages])

  useAutoSpeak({
    enabled: autoSpeakEnabled,
    messageId: lastAssistantMessage?.id ?? null,
    text: lastAssistantMessage?.content ?? null,
    isStreaming: Boolean(lastAssistantMessage?.isStreaming) || isStreaming,
    ttsProvider: voiceSettings.ttsProvider,
    ttsVoice: voiceSettings.ttsVoice,
    spokifyModel: voiceSettings.spokifyModel,
  })

  // Plan pane (right-docked inline plan panel). Subscribes to the per-tile
  // todos store so the pane, the composer chip, and the transcript's inline
  // PlanCard all share one source of truth (latest TodoWrite/update_plan block).
  const planTodos = useTileTodos(tileId)
  const [isPlanOpen, setIsPlanOpen] = useState(false)
  // Auto-close when the plan goes away (conversation cleared / new chat).
  useEffect(() => {
    if (!planTodos || planTodos.length === 0) setIsPlanOpen(false)
  }, [planTodos])
  const [planUpdatedAt, setPlanUpdatedAt] = useState<number | null>(null)
  useEffect(() => {
    if (planTodos && planTodos.length > 0) setPlanUpdatedAt(Date.now())
  }, [planTodos])

  // Plugin-contributed commands that expose a slash trigger surface in the chat
  // composer's `/` menu (point 3 — plugins appear in the chat area).
  const pluginCommands = useContributions('commands') as PaletteCommand[]
  const pluginSlashCommands = useMemo(
    () =>
      pluginCommands
        .filter(c => typeof c.slash === 'string' && c.slash.trim())
        .map(c => ({ slash: c.slash as string, title: c.title })),
    [pluginCommands],
  )

  // Autocomplete state (extracted to hook)
  const {
    acType,
    setAcType,
    acQuery,
    setAcQuery,
    acIndex,
    setAcIndex,
    acItems,
    handleComposerInputChange,
  } = useChatAutocomplete({
    workspaceDir: _workspaceDir,
    connectedPeers,
    workspaceSkills,
    pluginSlashCommands,
  })
  closeAutocompleteRef.current = () => {
    setAcType(null)
    setAcQuery('')
  }

  const {
    latestChangeDrawer,
    latestChangeDrawerHasStats,
    latestChangeDrawerExpanded,
    setLatestChangeDrawerExpanded,
    latestChangeDrawerExpandedFiles,
    latestCheckpointId,
    isRestoringLatestCheckpoint,
    toggleLatestChangeDrawerFile,
    restoreLatestCheckpoint,
    checkpointRestoreContextValue,
  } = useChatTileLatestChangeDrawer({
    workspaceId,
    tileId,
    messages,
    setMessagesSafe,
  })

  const liveComposerActivityChip = useChatTileLiveComposerActivity({
    isStreaming,
    renderedMessages,
  })

  useChatTileDreamPolling(workspaceId, setMessagesSafe)

  useEffect(() => { ensureChatMdStyle() }, [])

  useChatTileLifecycleEffects({
    tileId,
    sessionId,
    linkedSessionEntryId,
    provider,
    model,
    mode,
    workspaceDir: _workspaceDir,
    executionTarget,
    cloudHostId,
    settingsExecution: settings?.execution ?? null,
    jobId,
    jobSequence,
    isStreaming,
    isStreamingRef,
    messages,
    historicalMessages,
    allMessages,
    queuedTurnsLength: queuedTurns.length,
    pagedLinkedHistoryEnabled,
    stateLoadedRef,
    lastActivityAtRef,
    lastPushedModeRef,
    toolCompletedAtRef,
    toolCollapseTick,
    setToolCollapseTick,
    setMessages,
    setMessagesSafe,
    setQueueCollapsed,
    resumedJobKeyRef,
  })

  const {
    contextWindowLimit,
    systemOverheadTokens,
    readAttachmentPaths,
    estimatedContextTokens,
    contextUsageRatio,
    contextUsagePercent,
  } = useChatTileContextUsage({ provider, model, messages, input })

  const locationLabel = executionDisplayLabel
  const {
    isGitRepo,
    branchMenuCreateEnabled,
    normalizedRepoRoot,
    projectFolderName,
    currentBranchLabel,
    activeProjectPathLabel,
    filteredBranches,
    handleProjectFolderSwitch,
    handleBranchSelect,
    handleCreateBranch,
  } = useChatTileGitMenus({
    workspaceDir: _workspaceDir,
    workspaceId,
    executionTarget,
    executionTargetCloud: executionTarget === 'cloud',
    executionDisplayDetail,
    gitStatus,
    gitBranches,
    refreshGitState,
    branchFilter,
    setBranchFilter,
    setShowBranchMenu,
    remoteHosts,
    cloudHostId,
    setCloudHostId,
    setMessages,
  })

  // ─── Voice dictation (via useChatDictation hook) ────────────────────
  // Wire transcriptions into the input state.
  useEffect(() => {
    dictation.onTranscription((text: string) => {
      setInput(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + text)
    })
  }, [dictation])

  // Stream listener -- handles all rich event types from Claude Agent SDK
  useChatStreamHandler({
    tileId,
    setMessagesSafe,
    setSessionId: commitSessionId,
    setIsStreaming,
    setJobId,
    setJobSequence,
    flushPendingStreamText,
    queueStreamText,
    lastJobSequenceRef,
    setPendingToolPermissions,
    setResolvedToolPermissions,
  })

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      const pos = ta.value.length
      ta.setSelectionRange(pos, pos)
    })
  }, [])

  const {
    dispatchMessageContent,
    sendMessage,
    reorderQueuedTurn,
    flushQueueStateNow,
    logQueueEvent,
    stopStreaming,
    handleQueuedTurnSteer,
  } = useChatTileMessaging({
    tileId,
    workspaceId,
    workspaceDir: _workspaceDir,
    settings,
    isStreaming,
    input,
    attachments,
    implicitPeerImageAttachments,
    queuedTurns,
    messages,
    provider,
    model,
    mode,
    thinking,
    agentId,
    resolvedAgentMode,
    agentModesLoaded,
    sessionId,
    mcpEnabled,
    executionTarget,
    cloudHostId,
    effectiveAgentMode,
    autoAgentMode,
    linkedSessionEntryId,
    linkedSessionHint,
    hasEarlierMessages,
    connectedPeers,
    peerContextRef,
    peerToolNames,
    providerEntryById,
    currentProviderEntry,
    activeCloudHost,
    latestStateRef,
    persistLatestState,
    lastJobSequenceRef,
    resumedJobKeyRef,
    stickToBottomRef,
    activeChatSurfaceRef,
    openChatSurfacesRef,
    textareaRef,
    setMessagesSafe,
    setInput,
    setAttachments,
    setQueuedTurns,
    setOpenChatSurfaces,
    setActiveChatSurfaceId,
    setIsStreaming,
    setJobId,
    setJobSequence,
    setPreserveSessionSummary,
    setAcType,
    setAcQuery,
    focusComposer,
    getChatSurfaceIframe,
    postToChatSurface,
    exportNotesToClipboard,
    pluginCommands,
  })

  const syncComposerHeight = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.max(CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT, Math.min(ta.scrollHeight, 134))}px`
  }, [])

  const {
    isDropTarget,
    openAttachmentPicker,
    removeAttachment,
    handleTileDragOver,
    handleTileDragLeave,
    handleTileDrop,
  } = useChatTileAttachments({
    textareaRef,
    syncComposerHeight,
    setAttachments,
    setAcType,
    setAcQuery,
    setShowInsertMenu,
  })

  const { selectAcItem } = useChatAutocompleteSelection({
    input,
    acType,
    textareaRef,
    syncComposerHeight,
    setInput,
    setAttachments,
    setAcType,
    setAcQuery,
  })

  const { handleKeyDown, handleKeyUp } = useChatTileComposerKeys({
    input,
    isDictating,
    toggleDictation,
    acType,
    acItems,
    acIndex,
    setAcIndex,
    setAcType,
    setAcQuery,
    selectAcItem,
    sendMessage,
  })

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    handleComposerInputChange(e, setInput, syncComposerHeight)
  }, [handleComposerInputChange, syncComposerHeight])

  const isStartScreen = messages.length === 0 && !isStreaming

  // Embedded terminal: mount it the first time the Terminal tab is opened and
  // keep it mounted thereafter. TerminalTile unmount fires `terminal:detach`,
  // which kills the PTY — so we never unmount on tab switch; the transcript
  // column hides it with layout-preserving CSS instead. The PTY backend is
  // keyed by tileId, so we derive a deterministic embedded id from the chat id.
  const [terminalMounted, setTerminalMounted] = useState(activeView === 'terminal')
  useEffect(() => {
    if (activeView === 'terminal') setTerminalMounted(true)
  }, [activeView])
  // Resolve terminal fonts from settings exactly like App.tsx does for canvas
  // terminal tiles, so the embedded terminal matches the standalone one.
  const terminalFontFamily = settings?.terminalFontFamily || settings?.fonts?.mono?.family || MONO_DEFAULT
  const terminalFontSize = settings?.terminalFontSize || settings?.fonts?.mono?.size || 13
  const embeddedTerminal = terminalMounted ? (
    <Suspense fallback={null}>
      <LazyTerminalTile
        tileId={`${tileId}-terminal`}
        workspaceDir={_workspaceDir}
        width={width}
        height={height}
        fontSize={terminalFontSize}
        fontFamily={terminalFontFamily}
      />
    </Suspense>
  ) : null

  const openMiniChat = useCallback(() => {
    if (!workspaceId) return
    void window.electron?.window?.openMiniChat?.({
      workspaceId,
      tileId,
      title: messages[0]?.content?.trim().slice(0, 80) || 'CodeSurf chat',
    }).catch(error => {
      console.warn('[ChatTile] failed to open mini chat window:', error)
    })
  }, [messages, tileId, workspaceId])

  const chatDispatchValue = useMemo<ChatDispatchValue>(() => ({
    sendAnswer: async (text: string) => {
      await dispatchMessageContent(text)
    },
  }), [dispatchMessageContent])

  return (
    <ChatDispatchProvider value={chatDispatchValue}>
    <FontCtx.Provider value={fontCtxValue}>
    <AskUserQuestionFontsContext.Provider value={fontCtxValue}>
    <AskUserQuestionContext.Provider value={{ cardId: tileId }}>
    <CheckpointRestoreContext.Provider value={checkpointRestoreContextValue}>
    <ToolPermissionProvider
      cardId={tileId}
      pending={pendingToolPermissions}
      resolved={resolvedToolPermissions}
      onDecide={handleToolPermissionDecision}
    >
    <div
      className="cs-chat-shell"
      onDragOver={handleTileDragOver}
      onDragLeave={handleTileDragLeave}
      onDrop={handleTileDrop}
      style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        background: chatViewportBackground, color: theme.chat.text,
        fontFamily: fontSans, fontSize, lineHeight: fontLineHeight, fontWeight,
        position: 'relative',
      }}
    >

      {/* Active agent definition header — surfaces the selected AgentMode's
          colour + icon so the persona driving this tile is visible at a glance. */}
      {resolvedAgentMode && (
        <div
          title={resolvedAgentMode.description}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', flexShrink: 0,
            borderBottom: `0.5px solid ${composerBorder}`,
            color: resolvedAgentMode.color,
            background: `color-mix(in srgb, ${resolvedAgentMode.color} 10%, transparent)`,
            fontSize: 11, fontWeight: 600, letterSpacing: 0.2,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center' }}>{getAgentIcon(resolvedAgentMode.icon)}</span>
          <span>{resolvedAgentMode.name}</span>
        </div>
      )}

      {/* Horizontal split: [transcript + composer column] | [plan pane] */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'row',
        minHeight: 0,
        minWidth: 0,
      }}>
      <ChatTileTranscriptColumn
        isStartScreen={isStartScreen}
        messagesRef={messagesRef}
        handleMessagesScroll={handleMessagesScroll}
        handleMessagesWheel={handleMessagesWheel}
        handleMessagesKeyDown={handleMessagesKeyDown}
        hiddenMessageCount={hiddenMessageCount}
        renderedMessages={renderedMessages}
        pagedLinkedHistoryEnabled={pagedLinkedHistoryEnabled}
        loadingEarlier={loadingEarlier}
        earlierLoadError={earlierLoadError}
        isStreaming={isStreaming}
        toolCollapseTick={toolCollapseTick}
        explodedChipGroups={explodedChipGroups}
        toggleExplodedChipGroup={toggleExplodedChipGroup}
        updateBlockNote={updateBlockNote}
        setAnnotationComposerActive={setAnnotationComposerActive}
        readAttachmentPaths={readAttachmentPaths}
        fontSize={fontSize}
        fontLineHeight={fontLineHeight}
        fontMono={fontMono}
        monoSize={monoSize}
        ttsState={ttsState}
        voiceSettings={voiceSettings}
        showScrollToLatest={showScrollToLatest}
        scrollToLatest={scrollToLatest}
        liveComposerActivityChip={liveComposerActivityChip}
        latestChangeDrawer={latestChangeDrawer}
        latestChangeDrawerHasStats={latestChangeDrawerHasStats}
        latestChangeDrawerExpanded={latestChangeDrawerExpanded}
        latestChangeDrawerExpandedFiles={latestChangeDrawerExpandedFiles}
        latestCheckpointId={latestCheckpointId}
        isRestoringLatestCheckpoint={isRestoringLatestCheckpoint}
        fontSans={fontSans}
        onToggleLatestChangeDrawerExpanded={() => setLatestChangeDrawerExpanded(v => !v)}
        onToggleLatestChangeDrawerFile={toggleLatestChangeDrawerFile}
        onRestoreLatestCheckpoint={() => { void restoreLatestCheckpoint() }}
        onReviewLatestChanges={reviewLatestChanges}
        queuedTurns={queuedTurns}
        queueCollapsed={queueCollapsed}
        draggingTurnId={draggingTurnId}
        dragOverTurn={dragOverTurn}
        onToggleQueueCollapsed={() => setQueueCollapsed(v => !v)}
        onSetDraggingTurnId={setDraggingTurnId}
        onSetDragOverTurn={setDragOverTurn}
        onReorderQueuedTurn={reorderQueuedTurn}
        onSteerQueuedTurn={handleQueuedTurnSteer}
        onDeleteQueuedTurn={(turnId) => {
          const remaining = queuedTurns.filter(item => item.id !== turnId)
          setQueuedTurns(remaining)
          flushQueueStateNow(remaining)
          logQueueEvent('delete', { queueId: turnId })
        }}
        activeView={activeView}
        embeddedTerminal={embeddedTerminal}
      >
        <ChatTileComposer
          isStartScreen={isStartScreen}
          isDropTarget={isDropTarget}
          composerBackground={composerBackground}
          composerBorder={composerBorder}
          acRef={acRef}
          acType={acType}
          acQuery={acQuery}
          acItems={acItems}
          acIndex={acIndex}
          fontSans={fontSans}
          fontMono={fontMono}
          onAcHoverIndex={setAcIndex}
          onAcSelect={selectAcItem}
          isDictating={isDictating}
          dictationText={dictationText}
          dictationError={dictationError}
          ttsState={ttsState}
          onStopVoicePlayback={() => bargeIn()}
          openChatSurfaces={openChatSurfaces}
          activeChatSurface={activeChatSurface}
          chatSurfaceMenu={chatSurfaceMenu}
          onActivateSurface={setActiveChatSurfaceId}
          onCloseSurface={closeChatSurface}
          onOpenBuilderFromSketch={() => { void openBuilderFromSketch() }}
          onSetSurfaceIframeRef={setChatSurfaceIframeRef}
          attachments={attachments}
          onRemoveAttachment={removeAttachment}
          textareaRef={textareaRef}
          input={input}
          fontSize={fontSize}
          fontLineHeight={fontLineHeight}
          onInputChange={handleInputChange}
          onInputKeyDown={handleKeyDown}
          onInputKeyUp={handleKeyUp}
          insertMenuRef={insertMenuRef}
          showInsertMenu={showInsertMenu}
          onToggleMenu={toggleMenu}
          onAttachFiles={openAttachmentPicker}
          mcpEnabled={mcpEnabled}
          onToggleMcpEnabled={() => setMcpEnabled(v => !v)}
          mcpServers={mcpServers}
          disabledServers={disabledServers}
          setDisabledServers={setDisabledServers}
          peerToolNames={peerToolNames}
          onOpenChatSurface={openChatSurface}
          showProviderPicker={messages.length === 0}
          providerMenuRef={providerMenuRef}
          showProviderMenu={showProviderMenu}
          providerEntries={providerEntries}
          provider={provider}
          onProviderChange={handleProviderChange}
          modelMenuRef={modelMenuRef}
          showModelMenu={showModelMenu}
          currentProviderEntry={currentProviderEntry}
          currentModelLabel={currentModel.label}
          modelLocked={Boolean(modelLock)}
          lockReason={modelLock?.reason}
          model={model}
          modelFilter={modelFilter}
          onModelFilterChange={setModelFilter}
          optionNoun={optionNoun}
          onSelectModel={(id) => { setModel(id); setShowModelMenu(false); setModelFilter('') }}
          thinkingMenuRef={thinkingMenuRef}
          showThinkingMenu={showThinkingMenu}
          thinking={thinking}
          thinkingOptions={thinkingOptions}
          onSelectThinking={(id) => { setThinking(id); setShowThinkingMenu(false) }}
          onOpenMiniChat={openMiniChat}
          isStreaming={isStreaming}
          lastActivityAtRef={lastActivityAtRef}
          onToggleDictation={toggleDictation}
          hasSendableDraft={hasSendableDraft}
          onStopStreaming={stopStreaming}
          onSendMessage={sendMessage}
          locationMenuRef={locationMenuRef}
          showLocationMenu={showLocationMenu}
          executionTarget={executionTarget}
          locationLabel={locationLabel}
          localExecutionLabel={localExecutionLabel}
          normalizedRepoRoot={normalizedRepoRoot}
          remoteHosts={remoteHosts}
          activeCloudHost={activeCloudHost}
          onSelectLocalExecution={() => {
            setExecutionTarget('local')
            setShowLocationMenu(false)
          }}
          onSelectCloudExecution={() => {
            if (remoteHosts.length > 0) {
              setExecutionTarget('cloud')
              setCloudHostId(activeCloudHost?.id ?? remoteHosts[0].id)
            }
            setShowLocationMenu(false)
          }}
          onSelectRemoteHost={hostId => {
            setExecutionTarget('cloud')
            setCloudHostId(hostId)
            setShowLocationMenu(false)
          }}
          branchMenuRef={branchMenuRef}
          showBranchMenu={showBranchMenu}
          isGitRepo={isGitRepo}
          filteredBranches={filteredBranches}
          branchFilter={branchFilter}
          branchMenuCreateEnabled={branchMenuCreateEnabled}
          currentBranchLabel={currentBranchLabel}
          projectFolderName={projectFolderName}
          changedCount={gitStatus.changedCount}
          onBranchFilterChange={setBranchFilter}
          onSelectBranch={handleBranchSelect}
          onCreateBranch={handleCreateBranch}
          activeProjectPathLabel={activeProjectPathLabel}
          onProjectFolderSwitch={handleProjectFolderSwitch}
          modeMenuRef={modeMenuRef}
          showModeMenu={showModeMenu}
          mode={mode}
          currentMode={currentMode}
          modeOptions={modeOptions}
          onSelectMode={modeId => {
            setMode(modeId)
            onChatModePreferenceChange?.(provider, modeId)
            setShowModeMenu(false)
          }}
          agentMenuRef={agentMenuRef}
          showAgentMenu={showAgentMenu}
          agentId={agentId}
          agentModes={agentModes}
          onSelectAgent={nextAgentId => {
            setAgentId(nextAgentId)
            const nextPersona = agentModes.find(a => a.id === nextAgentId) ?? null
            // Precedence LAYER 1 (P1b-2): if a linked skill imposes a HARD model lock,
            // it PINS provider/model and SHORT-CIRCUITS the soft seed below. The picker
            // is disabled in the composer; the live-state effect keeps the pin honoured.
            const skillLock = resolveSkillModelLock(nextPersona, workspaceSkills)
            if (skillLock) {
              if (skillLock.provider) setProvider(skillLock.provider)
              if (skillLock.model) setModel(skillLock.model)
            } else {
              // Precedence layer 2: a selected persona's SOFT defaultBinding seeds the
              // composer's provider/model. Seed once here (NOT in an effect — an effect
              // keyed on agentId would re-clobber the user's pick on restore/re-render).
              // The user can freely change it afterward; the live composer state flows
              // to req.model/provider, so the user pick (layer 3) always wins.
              const modelSeed = resolvePersonaModelSeed(nextPersona)
              if (modelSeed?.provider) setProvider(modelSeed.provider)
              if (modelSeed?.model) setModel(modelSeed.model)
            }
            setShowAgentMenu(false)
          }}
          planTodos={planTodos}
          isPlanOpen={isPlanOpen}
          onTogglePlanOpen={() => setIsPlanOpen(v => !v)}
          contextMenuRef={contextMenuRef}
          showContextMenu={showContextMenu}
          contextUsageRatio={contextUsageRatio}
          contextUsagePercent={contextUsagePercent}
          estimatedContextTokens={estimatedContextTokens}
          contextWindowLimit={contextWindowLimit}
          systemOverheadTokens={systemOverheadTokens}
          activeView={activeView}
          onSelectView={setActiveView}
        />
      </ChatTileTranscriptColumn>
      {isPlanOpen && planTodos && planTodos.length > 0 && (
        <PlanPane
          todos={planTodos}
          updatedAt={planUpdatedAt}
          onClose={() => setIsPlanOpen(false)}
        />
      )}
      </div>
    </div>
    </ToolPermissionProvider>
    </CheckpointRestoreContext.Provider>
    </AskUserQuestionContext.Provider>
    </AskUserQuestionFontsContext.Provider>
    </FontCtx.Provider>
    </ChatDispatchProvider>
  )
}
