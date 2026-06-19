import { useRef, useEffect, useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { AppSettings, AgentMode } from '../../../shared/types'
import type { ChatMessage } from '../../../shared/chat-types'
import type { SessionEntryHint } from '../../../shared/session-types'
import { stripCapabilityPrefix } from '../../../shared/nodeTools'
import {
  type BuiltinProvider,
  PROVIDER_MODES,
  EXTENSION_PROVIDER_MODE,
  resolveProviderModeId,
} from '../config/providers'
import { executeCommand, type PaletteCommand } from '../lib/commandRegistry'
import { recordChatMessageSent } from '../components/chatMessageSentStore'
import type { ChatTilePersistedState, QueuedChatTurn } from '../components/chat/chatTileTypes'
import {
  mergeAttachments,
  buildOutgoingMessageContent,
  encodeUtf8Base64,
  buildQueuedTurnPreview,
  buildBlockNotesContext,
  splitMessageAttachmentPaths,
  buildRecentEditContext,
  type ActiveChatSurface,
  type PendingAttachment,
  type DiscoveryPeer,
} from '../components/chat/chatTileUtils'
import { normalizeMessagesForMemory } from '../components/chat/messageNormalization'
import { resolveActiveChatMode } from './chatModeResolution'
import { resolveDispatchAgentMode } from './agentModeDispatch'
import { loadAgentModes } from '../config/agentModes'
import type { ProviderEntry } from './useChatTileProviders'

export interface UseChatTileMessagingOptions {
  tileId: string
  workspaceId: string
  workspaceDir: string
  settings?: AppSettings

  isStreaming: boolean
  input: string
  attachments: PendingAttachment[]
  implicitPeerImageAttachments: PendingAttachment[]
  queuedTurns: QueuedChatTurn[]
  messages: ChatMessage[]
  provider: string
  model: string
  mode: string
  thinking: string
  agentId: string | null
  resolvedAgentMode: AgentMode | null
  agentModesLoaded: boolean
  sessionId: string | null
  mcpEnabled: boolean
  executionTarget: 'local' | 'cloud'
  cloudHostId: string | null
  effectiveAgentMode: boolean
  autoAgentMode: boolean
  linkedSessionEntryId: string | null
  linkedSessionHint: SessionEntryHint | null
  hasEarlierMessages: boolean
  connectedPeers: DiscoveryPeer[]
  peerContextRef: MutableRefObject<Map<string, Record<string, unknown>>>
  peerToolNames: string[]
  providerEntryById: Map<string, ProviderEntry>
  currentProviderEntry: ProviderEntry | undefined
  activeCloudHost: { id: string } | null | undefined

  latestStateRef: MutableRefObject<ChatTilePersistedState | null>
  persistLatestState: (stateOverride?: ChatTilePersistedState | null) => void
  lastJobSequenceRef: MutableRefObject<number>
  resumedJobKeyRef: MutableRefObject<string | null>
  stickToBottomRef: MutableRefObject<boolean>
  activeChatSurfaceRef: MutableRefObject<ActiveChatSurface | null>
  openChatSurfacesRef: MutableRefObject<ActiveChatSurface[]>
  textareaRef: MutableRefObject<HTMLTextAreaElement | null>

  setMessagesSafe: (updater: SetStateAction<ChatMessage[]>) => void
  setInput: Dispatch<SetStateAction<string>>
  setAttachments: Dispatch<SetStateAction<PendingAttachment[]>>
  setQueuedTurns: Dispatch<SetStateAction<QueuedChatTurn[]>>
  setOpenChatSurfaces: Dispatch<SetStateAction<ActiveChatSurface[]>>
  setActiveChatSurfaceId: Dispatch<SetStateAction<string | null>>
  setIsStreaming: Dispatch<SetStateAction<boolean>>
  setJobId: Dispatch<SetStateAction<string | null>>
  setJobSequence: Dispatch<SetStateAction<number>>
  setPreserveSessionSummary: Dispatch<SetStateAction<boolean>>
  setAcType: (type: 'slash' | 'mention' | null) => void
  setAcQuery: (query: string) => void

  focusComposer: () => void
  getChatSurfaceIframe: (instanceId: string) => HTMLIFrameElement | null
  postToChatSurface: (instanceId: string, payload: Record<string, unknown>) => void
  exportNotesToClipboard: () => Promise<void>
  pluginCommands: PaletteCommand[]
}

export interface UseChatTileMessagingResult {
  dispatchMessageContent: (messageContent: string) => Promise<boolean>
  sendMessage: () => Promise<void>
  queueCurrentDraft: () => boolean
  reorderQueuedTurn: (draggedId: string, targetId: string, mode: 'before' | 'after' | 'into') => void
  flushQueueStateNow: (nextQueue: QueuedChatTurn[]) => void
  logQueueEvent: (
    type: 'enqueue' | 'dispatch' | 'delete' | 'complete' | 'clear' | 'reorder',
    details?: {
      queueId?: string
      content?: string
      preview?: string
      attachmentCount?: number
      createdAt?: number
      draggedId?: string
      targetId?: string
      mode?: string
      newParentId?: string | null
    },
  ) => void
  insertSteerMessageIntoStream: (content: string) => void
  stopStreaming: () => void
  handleQueuedTurnSteer: (turn: QueuedChatTurn) => Promise<void>
}

export function useChatTileMessaging(options: UseChatTileMessagingOptions): UseChatTileMessagingResult {
  const {
    tileId,
    workspaceId,
    workspaceDir,
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
  } = options

  const isFlushingQueuedTurnRef = useRef(false)

  const logQueueEvent = useCallback((
    type: 'enqueue' | 'dispatch' | 'delete' | 'complete' | 'clear' | 'reorder',
    details?: {
      queueId?: string
      content?: string
      preview?: string
      attachmentCount?: number
      createdAt?: number
      draggedId?: string
      targetId?: string
      mode?: string
      newParentId?: string | null
    },
  ) => {
    try {
      const result = (window.electron as { canvas?: { queuedMessages?: { append?: (payload: Record<string, unknown>) => Promise<unknown> } } })?.canvas?.queuedMessages?.append?.({
        type,
        at: Date.now(),
        workspaceId,
        tileId,
        ...(details ?? {}),
      })
      if (result && typeof result.catch === 'function') {
        result.catch(() => { /* best-effort */ })
      }
    } catch { /* best effort */ }
  }, [workspaceId, tileId])

  const flushQueueStateNow = useCallback((nextQueue: QueuedChatTurn[]) => {
    const base = latestStateRef.current
    if (!base) return
    persistLatestState({ ...base, queuedTurns: nextQueue })
  }, [latestStateRef, persistLatestState])

  const dispatchMessageContent = useCallback(async (messageContent: string): Promise<boolean> => {
    const trimmedContent = messageContent.trim()
    if (!trimmedContent) return false

    // A-PR1 BLOCKING-1 + load-race fix: resolve the AUTHORITATIVE AgentMode for
    // this send. Built-ins are seeded synchronously for composer UX, but a SEND
    // must reflect any agents.json override of a built-in id. During the pre-load
    // window the seed is the LOOSER default built-in — and because it is non-null
    // and valid-looking, the IPC/daemon/builder fail-closed guards (which only
    // trip on a null/unresolved agentMode) would NOT catch it, so the turn would
    // run with the default's tools (for `agent`, tools:null = UNRESTRICTED) for
    // one turn. resolveDispatchAgentMode re-resolves from disk when definitions
    // have not loaded, picking up the override, and fails closed otherwise. This
    // is the only place the window can be closed; do NOT use the pre-load seed.
    const agentResolution = await resolveDispatchAgentMode({
      agentId,
      resolvedAgentMode,
      agentModesLoaded,
      loadFinalModes: () => loadAgentModes(workspaceDir),
    })
    if (!agentResolution.ok) {
      setMessagesSafe(prev => [...prev, {
        id: `msg-agent-unresolved-${Date.now()}`,
        role: 'assistant',
        content: 'The selected agent could not be resolved — its persona and tool restrictions are not ready yet (or failed to load). Wait a moment and resend, or clear the selected agent.',
        timestamp: Date.now(),
        isStreaming: false,
      }])
      return false
    }
    const dispatchAgentMode = agentResolution.agentMode

    const { bodyText: userBodyText } = splitMessageAttachmentPaths(trimmedContent)

    const state = latestStateRef.current
    const activeProvider = state?.provider ?? provider
    const activeModel = state?.model ?? model
    const activeThinking = state?.thinking ?? thinking
    const activeSessionId = state?.sessionId ?? sessionId
    const activeMcpEnabled = state?.mcpEnabled ?? mcpEnabled
    const activeMessages = state?.messages ?? messages
    const activeProviderEntry = providerEntryById.get(activeProvider) ?? currentProviderEntry
    const activeModeOptions = activeProviderEntry?.kind === 'builtin'
      ? PROVIDER_MODES[activeProviderEntry.id as BuiltinProvider]
      : [EXTENSION_PROVIDER_MODE]
    // A-PR1 #2a: prefer the LIVE mode over the persisted-state ref (which lags a
    // render behind a mode toggle), so a change-then-send launches with the
    // chosen mode. resolveActiveChatMode validates against the active provider's
    // options and falls back to the provider default.
    const activeMode = resolveActiveChatMode(
      mode,
      state?.mode,
      activeModeOptions.map(option => option.id),
      resolveProviderModeId(activeProvider, settings?.chatProviderModes?.[activeProvider]),
    )
    const nextCloudHostId = executionTarget === 'cloud'
      ? (cloudHostId ?? activeCloudHost?.id ?? null)
      : null

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: trimmedContent,
      timestamp: Date.now(),
    }
    const assistantId = `msg-${Date.now() + 1}`
    const optimisticMessages = normalizeMessagesForMemory([
      ...activeMessages,
      userMsg,
      {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isStreaming: true,
      },
    ])
    const optimisticState: ChatTilePersistedState = {
      messages: optimisticMessages,
      input: '',
      attachments: [],
      queuedTurns: state?.queuedTurns ?? queuedTurns,
      executionTarget: state?.executionTarget ?? executionTarget,
      provider: activeProvider,
      model: activeModel,
      mcpEnabled: activeMcpEnabled,
      mode: activeMode,
      thinking: activeThinking,
      agentId: state?.agentId ?? agentId,
      agentMode: state?.agentMode ?? effectiveAgentMode,
      autoAgentMode: state?.autoAgentMode ?? autoAgentMode,
      preserveSessionSummary: linkedSessionEntryId ? true : false,
      linkedSessionEntryId,
      linkedSessionHint,
      hasEarlierMessages,
      sessionId: activeSessionId,
      jobId: null,
      jobSequence: 0,
      cloudHostId: nextCloudHostId,
      isStreaming: true,
    }

    setPreserveSessionSummary(linkedSessionEntryId ? true : false)
    setMessagesSafe(optimisticMessages)
    setIsStreaming(true)
    setJobId(null)
    setJobSequence(0)
    lastJobSequenceRef.current = 0
    resumedJobKeyRef.current = null
    stickToBottomRef.current = true
    focusComposer()
    latestStateRef.current = optimisticState
    persistLatestState(optimisticState)

    window.electron?.bus?.publish(`tile:${tileId}`, 'activity', `chat:${tileId}`, {
      message: `User: ${userMsg.content.slice(0, 100)}`, role: 'user',
    })

    try {
      const recentEditContext = await buildRecentEditContext(activeMessages, workspaceDir, userBodyText)
      const blockNotesContext = buildBlockNotesContext(activeMessages)
      const requestMessages = [...activeMessages, userMsg].map((message, index, allMessages) => {
        const isNewestUserMessage = index === allMessages.length - 1 && message.id === userMsg.id
        if (!isNewestUserMessage || (!recentEditContext && !blockNotesContext)) {
          return { role: message.role, content: message.content }
        }
        const parts = [message.content]
        if (recentEditContext) parts.push(`---\nRecent edit context:\n${recentEditContext}`)
        if (blockNotesContext) parts.push(`---\n${blockNotesContext}`)
        return {
          role: message.role,
          content: parts.join('\n\n').trim(),
        }
      })

      const peers = activeMcpEnabled ? connectedPeers.map(p => ({
        peerId: p.peerId,
        peerType: p.peerType,
        tools: p.capabilities.filter(c => c.startsWith('tool:')).map(c => stripCapabilityPrefix(c)),
        actions: p.actions,
        context: peerContextRef.current.get(p.peerId),
      })) : []

      const result = await window.electron?.chat?.send({
        cardId: tileId,
        workspaceId,
        provider: activeProvider,
        model: activeModel,
        providerTransport: activeProviderEntry?.transport ?? null,
        mode: activeMode,
        thinking: activeThinking,
        agentId: agentId ?? null,
        agentMode: dispatchAgentMode,
        workspaceDir,
        mcpEnabled: activeMcpEnabled,
        executionTarget,
        cloudHostId: nextCloudHostId,
        executionPreference: settings?.execution ?? null,
        messages: requestMessages,
        negotiatedTools: activeMcpEnabled ? peerToolNames : undefined,
        peers: peers.length > 0 ? peers : undefined,
        sessionId: activeSessionId,
      })
      if (result && typeof result === 'object' && 'ok' in result && (result as { ok?: unknown }).ok === false) {
        setMessagesSafe(prev => prev.map(m =>
          m.id === assistantId ? { ...m, content: 'Error: chat request failed', isStreaming: false } : m
        ))
        setIsStreaming(false)
        focusComposer()
        return false
      }
      if (result && typeof result === 'object' && 'jobId' in result && typeof (result as { jobId?: unknown }).jobId === 'string') {
        const nextJobId = (result as { jobId: string }).jobId
        setJobId(nextJobId)
        setJobSequence(0)
        lastJobSequenceRef.current = 0
        const nextState = {
          ...optimisticState,
          jobId: nextJobId,
          jobSequence: 0,
        }
        latestStateRef.current = nextState
        persistLatestState(nextState)
      } else {
        setJobId(null)
        setJobSequence(0)
        lastJobSequenceRef.current = 0
        latestStateRef.current = optimisticState
        persistLatestState(optimisticState)
      }
      return true
    } catch (err) {
      setMessagesSafe(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: `Error: ${err}`, isStreaming: false } : m
      ))
      setIsStreaming(false)
      focusComposer()
      return false
    }
  }, [
    provider, model, mode, thinking, sessionId, mcpEnabled, messages, providerEntryById, currentProviderEntry,
    tileId, workspaceId, workspaceDir, connectedPeers, peerContextRef, executionTarget, cloudHostId, activeCloudHost,
    settings?.execution, settings?.chatProviderModes, peerToolNames, focusComposer, setMessagesSafe, queuedTurns,
    agentId, resolvedAgentMode, agentModesLoaded,
    effectiveAgentMode, autoAgentMode, linkedSessionEntryId, linkedSessionHint, hasEarlierMessages,
    latestStateRef, persistLatestState, lastJobSequenceRef, resumedJobKeyRef, stickToBottomRef,
    setPreserveSessionSummary, setIsStreaming, setJobId, setJobSequence,
  ])

  const reorderQueuedTurn = useCallback((
    draggedId: string,
    targetId: string,
    mode: 'before' | 'after' | 'into',
  ) => {
    if (draggedId === targetId) return
    const prev = queuedTurns
    const draggedIdx = prev.findIndex(t => t.id === draggedId)
    const targetIdx = prev.findIndex(t => t.id === targetId)
    if (draggedIdx < 0 || targetIdx < 0) return
    const dragged = prev[draggedIdx]

    const orphaned = prev.map(t =>
      t.parentId === draggedId ? { ...t, parentId: null } : t
    )
    const without = orphaned.filter(t => t.id !== draggedId)
    const newTargetIdx = without.findIndex(t => t.id === targetId)
    if (newTargetIdx < 0) return
    const target = without[newTargetIdx]

    let newParentId: string | null = null
    let insertIdx = newTargetIdx

    if (mode === 'into') {
      if (target.parentId) {
        newParentId = target.parentId
        insertIdx = newTargetIdx + 1
      } else {
        newParentId = target.id
        const childCount = without.filter(t => t.parentId === target.id).length
        insertIdx = newTargetIdx + 1 + childCount
      }
    } else if (mode === 'before') {
      newParentId = target.parentId ?? null
      insertIdx = newTargetIdx
    } else {
      newParentId = target.parentId ?? null
      if (!target.parentId) {
        const childCount = without.filter(t => t.parentId === target.id).length
        insertIdx = newTargetIdx + 1 + childCount
      } else {
        insertIdx = newTargetIdx + 1
      }
    }

    const nextDragged: QueuedChatTurn = { ...dragged, parentId: newParentId }
    const result = [
      ...without.slice(0, insertIdx),
      nextDragged,
      ...without.slice(insertIdx),
    ]
    setQueuedTurns(result)
    flushQueueStateNow(result)
    logQueueEvent('reorder', { draggedId, targetId, mode, newParentId })
  }, [queuedTurns, flushQueueStateNow, logQueueEvent, setQueuedTurns])

  const queueCurrentDraft = useCallback(() => {
    const draftAttachments = mergeAttachments(attachments, implicitPeerImageAttachments)
    const messageContent = buildOutgoingMessageContent(input, draftAttachments)
    if (!messageContent) return false

    const queuedTurn: QueuedChatTurn = {
      id: `queued-${Date.now()}`,
      content: messageContent,
      preview: buildQueuedTurnPreview(messageContent, draftAttachments.length),
      attachmentCount: draftAttachments.length,
      createdAt: Date.now(),
    }

    setPreserveSessionSummary(linkedSessionEntryId ? true : false)
    const nextQueue = [...queuedTurns, queuedTurn]
    setQueuedTurns(nextQueue)
    flushQueueStateNow(nextQueue)
    logQueueEvent('enqueue', {
      queueId: queuedTurn.id,
      content: queuedTurn.content,
      preview: queuedTurn.preview,
      attachmentCount: queuedTurn.attachmentCount,
      createdAt: queuedTurn.createdAt,
    })
    setInput('')
    setAttachments([])
    setAcType(null)
    setAcQuery('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    focusComposer()
    return true
  }, [
    input, attachments, implicitPeerImageAttachments, focusComposer, queuedTurns, linkedSessionEntryId,
    flushQueueStateNow, logQueueEvent, setInput, setAttachments, setAcType, setAcQuery, setQueuedTurns,
    setPreserveSessionSummary, textareaRef,
  ])

  const sendMessage = useCallback(async () => {
    if (isStreaming) {
      queueCurrentDraft()
      return
    }

    let flushedAttachments = mergeAttachments(attachments, implicitPeerImageAttachments)
    const surface = activeChatSurfaceRef.current
    if (surface) {
      try {
        await new Promise<void>((resolve) => {
          let done = false
          const ack = () => {
            if (done) return
            done = true
            window.removeEventListener('message', onceAck)
            clearTimeout(timeout)
            resolve()
          }
          const timeout = setTimeout(ack, 1200)
          const onceAck = (e: MessageEvent) => {
            if (getChatSurfaceIframe(surface.instanceId)?.contentWindow !== e.source) return
            const msg = e.data
            if (!msg || typeof msg !== 'object') return
            if (msg.type === 'contex-rpc' && msg.method === 'surface.setPayload' && msg.tileId === surface.instanceId) {
              ack()
            }
          }
          window.addEventListener('message', onceAck)
          postToChatSurface(surface.instanceId, { type: 'contex-event', event: 'surface.requestFlush', data: {} })
        })
      } catch { /* best-effort */ }

      const latest = activeChatSurfaceRef.current
      const payload = latest?.payload
      if (payload?.data) {
        try {
          const chatApi = (window.electron as unknown as { chat?: { writeTempAttachment?: (p: { data: string; mime?: string; ext?: string; filenameHint?: string }) => Promise<{ ok: true; path: string } | { ok: false; error: string }> } }).chat
          if (chatApi?.writeTempAttachment) {
            const attachmentData = payload.kind === 'text' ? encodeUtf8Base64(payload.data) : payload.data
            const attachmentKind: PendingAttachment['kind'] = payload.kind === 'text' ? 'file' : 'image'
            const r = await chatApi.writeTempAttachment({
              data: attachmentData,
              mime: payload.kind === 'text' ? (payload.mime ?? 'text/html') : payload.mime,
              ext: payload.kind === 'text' ? (payload.ext ?? 'html') : payload.ext,
              filenameHint: surface.label.toLowerCase().replace(/\s+/g, '-'),
            })
            if (r.ok) {
              flushedAttachments = mergeAttachments(flushedAttachments, [{ path: r.path, kind: attachmentKind }])
            }
          }
        } catch { /* best-effort */ }
      }
    }

    const messageContent = buildOutgoingMessageContent(input, flushedAttachments)
    if (!messageContent) return

    if (messageContent.trim() === '/export-notes') {
      setInput('')
      setAcType(null)
      setAcQuery('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      await exportNotesToClipboard()
      return
    }

    const slashToken = messageContent.trim().match(/^\/(\S+)/)?.[1]?.toLowerCase()
    if (slashToken) {
      const hit = pluginCommands.find(
        c => typeof c.slash === 'string' && c.slash.replace(/^\/+/, '').toLowerCase() === slashToken,
      )
      if (hit) {
        setInput('')
        setAcType(null)
        setAcQuery('')
        if (textareaRef.current) textareaRef.current.style.height = 'auto'
        await executeCommand(hit)
        return
      }
    }

    recordChatMessageSent({ tileId, sessionId, entryId: linkedSessionEntryId })

    setInput('')
    setAcType(null)
    setAcQuery('')
    setAttachments([])

    for (const openSurface of openChatSurfacesRef.current) {
      postToChatSurface(openSurface.instanceId, { type: 'contex-event', event: 'surface.clear', data: {} })
    }
    setOpenChatSurfaces([])
    setActiveChatSurfaceId(null)

    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    await dispatchMessageContent(messageContent)
  }, [
    isStreaming, input, attachments, implicitPeerImageAttachments, queueCurrentDraft, dispatchMessageContent,
    exportNotesToClipboard, getChatSurfaceIframe, postToChatSurface, pluginCommands, activeChatSurfaceRef,
    openChatSurfacesRef, setInput, setAcType, setAcQuery, setAttachments, setOpenChatSurfaces, setActiveChatSurfaceId,
    textareaRef, tileId, sessionId, linkedSessionEntryId,
  ])

  const insertSteerMessageIntoStream = useCallback((content: string) => {
    const trimmed = content.trim()
    if (!trimmed) return
    const userMsg: ChatMessage = {
      id: `msg-steer-${Date.now()}`,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
    }
    setMessagesSafe(prev => {
      const streamingAssistantIndex = prev.findLastIndex(message => message.role === 'assistant' && message.isStreaming)
      if (streamingAssistantIndex < 0) return [...prev, userMsg]
      return [
        ...prev.slice(0, streamingAssistantIndex),
        userMsg,
        ...prev.slice(streamingAssistantIndex),
      ]
    })
    stickToBottomRef.current = true
    window.electron?.bus?.publish(`tile:${tileId}`, 'activity', `chat:${tileId}`, {
      message: `User steered: ${trimmed.slice(0, 100)}`,
      role: 'user',
    })
  }, [setMessagesSafe, tileId, stickToBottomRef])

  const stopStreaming = useCallback(() => {
    window.electron?.chat?.stop?.(tileId)
    setIsStreaming(false)
    setJobId(null)
    setMessagesSafe(prev => prev.map(m => m.isStreaming ? { ...m, isStreaming: false } : m))
    focusComposer()
  }, [tileId, focusComposer, setIsStreaming, setJobId, setMessagesSafe])

  const handleQueuedTurnSteer = useCallback(async (turn: QueuedChatTurn) => {
    const content = turn.content.trim()
    if (!content) return

    if (isStreaming) {
      const result = await window.electron?.chat?.steer?.({ cardId: tileId, message: content })
      if (!result?.ok) {
        setMessagesSafe(prev => [...prev, {
          id: `msg-steer-error-${Date.now()}`,
          role: 'assistant',
          content: `Steer failed: ${result?.error ?? 'No active steerable stream'}`,
          timestamp: Date.now(),
          isStreaming: false,
        }])
        return
      }

      const remaining = queuedTurns.filter(item => item.id !== turn.id)
      setQueuedTurns(remaining)
      flushQueueStateNow(remaining)
      logQueueEvent('dispatch', { queueId: turn.id, content: turn.content, preview: turn.preview, attachmentCount: turn.attachmentCount })
      insertSteerMessageIntoStream(content)
      return
    }

    const remaining = queuedTurns.filter(item => item.id !== turn.id)
    setQueuedTurns(remaining)
    flushQueueStateNow(remaining)
    logQueueEvent('dispatch', { queueId: turn.id, content: turn.content, preview: turn.preview, attachmentCount: turn.attachmentCount })
    const sent = await dispatchMessageContent(content)
    if (!sent) {
      setInput(current => current.trim() ? current : content)
    }
  }, [
    isStreaming, tileId, queuedTurns, flushQueueStateNow, logQueueEvent, insertSteerMessageIntoStream,
    dispatchMessageContent, setMessagesSafe, setQueuedTurns, setInput,
  ])

  useEffect(() => {
    if (isStreaming || queuedTurns.length === 0 || isFlushingQueuedTurnRef.current) return

    const nextTurn = queuedTurns[0]
    isFlushingQueuedTurnRef.current = true

    void (async () => {
      const sent = await dispatchMessageContent(nextTurn.content)
      setQueuedTurns(prev => {
        const remaining = prev.filter(turn => turn.id !== nextTurn.id)
        flushQueueStateNow(remaining)
        return remaining
      })
      logQueueEvent('dispatch', { queueId: nextTurn.id })
      if (!sent) {
        setInput(current => current.trim() ? current : nextTurn.content)
      }
    })().finally(() => {
      isFlushingQueuedTurnRef.current = false
    })
  }, [isStreaming, queuedTurns, dispatchMessageContent, flushQueueStateNow, logQueueEvent, setQueuedTurns, setInput])

  return {
    dispatchMessageContent,
    sendMessage,
    queueCurrentDraft,
    reorderQueuedTurn,
    flushQueueStateNow,
    logQueueEvent,
    insertSteerMessageIntoStream,
    stopStreaming,
    handleQueuedTurnSteer,
  }
}