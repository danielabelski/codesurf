import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react'
import type {
  AppSettings,
  ExtensionChatModel,
  ExtensionChatProviderConfig,
  ExtensionChatTransportConfig,
  SkillDefinition,
} from '../../../shared/types'
import { basename, getDroppedPaths, isImagePath } from '../utils/dnd'
import { dispatchOpenLink, findAnchorFromEventTarget } from '../utils/links'
import {
  ShieldCheck, ChevronDown, AlertTriangle,
  Check, ArrowUp, ArrowDown, Square, MessageSquare, Bot,
  Brain, ChevronRight, Clock, Cog, Copy, CornerDownRight, DollarSign,
  FileText, GripVertical, History, Maximize2, Mic, Pencil, Plus, RotateCcw, Sparkles, Trash2, Wrench
} from 'lucide-react'
import { useMCPServers } from '../hooks/useMCPServers'
import { useAutoSpeak, speakMessage, bargeIn } from '../hooks/useAutoSpeak'
import { ttsPlayer, type TtsPlayerState } from '../utils/ttsPlayer'
import { useVoiceActivityDetector, float32ToWav } from '../hooks/useVoiceActivityDetector'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { ensureShimmerStyles, ShimmerText, WorkingDots, ChatMarkdown } from './shared/streamdown-utils'
import { DiffView } from './chat/DiffView'
import {
  type BuiltinProvider, type ModelOption, type ModeOption, type ThinkingOption,
  DEFAULT_MODELS, DEFAULT_PROVIDER_ID, PROVIDER_MODES, EXTENSION_PROVIDER_MODE,
  THINKING_OPTIONS, PROVIDER_LABELS, isBuiltinProvider, getApproxContextWindowTokens,
  getApproxSystemOverheadTokens, resolveProviderModeId,
} from '../config/providers'
import { stripCapabilityPrefix, getAllNodeTools } from '../../../shared/nodeTools'
import type { ToolBlock, ThinkingBlock, ContentBlock, ChatMessage, BlockNote, FileChange } from '../../../shared/chat-types'
import type { SessionEntryHint } from '../../../shared/session-types'
import { buildChatMessageHistoryFingerprint } from '../../../shared/chat-history'
import { BlockNoteAffordance } from './chat/BlockNoteAffordance'
import { getChatTileRuntimeState, setChatTileRuntimeState, reviveChatTileRuntimeState, isChatTileRuntimeStateDisposed } from './chatTileRuntimeState'
import { setChatStreaming } from './chatStreamingStore'
import { recordChatMessageSent } from './chatMessageSentStore'
import { setTileTodos, clearTileTodos, useTileTodos, type TileTodoItem } from '../state/tileTodosStore'
import { CUSTOMISATION_LOCATIONS_CHANGED_EVENT, type CustomisationLocationsChangedDetail } from './CustomisationTile'
import { PlanCard } from './chat/PlanCard'
import { PlanPane } from './chat/PlanPane'
import { PlanChip } from './chat/PlanChip'
import { JSXPreview, JSXPreviewContent, JSXPreviewError } from './ai-elements/JSXPreview'
import {
  ToolPermissionCard,
  ToolPermissionProvider,
  useToolPermissionContext,
  type ToolPermissionDecision,
  type ToolPermissionRequest,
} from './ai-elements/ToolPermission'
import { handleBasicChatSurfaceRpc, normalizeChatSurfacePayload, type ChatSurfacePayload } from './chatSurfaceHostRpc'
import { getCheckpointRestoreAction, isCheckpointToolBlock } from './chat/checkpointToolActions'
import { DREAM_TOOL_ID_PREFIX, DREAM_TOOL_NAME, isDreamToolBlock } from './chat/dreamToolActions'
import { CHAT_STREAM_FLUSH_INTERVAL_MS, isLargeArtifact, isLargeMessage, measureText, previewText, splitRawDiffText, type RawDiffFile } from './chat/largeContent'
import { ChatComposerAttachments, ChatComposerAutocompletePopup, ChatComposerBranchMenu, ChatComposerCard, ChatComposerContextUsageDial, ChatComposerDrawerFrame, ChatComposerInput, ChatComposerLocationMenu, ChatComposerModeMenu, ChatComposerPrimaryToolbar, ChatComposerProjectPathButton, ChatComposerSecondaryToolbar, ChatComposerSurfaceHost, ChatComposerVoiceStatus, ChatComposerWrap, type ChatComposerAutocompleteItem } from './chat/ChatComposer'
import { ToolbarBtn, ToolbarPill } from './chat/ChatComposerControls'
import { ComposerInsertMenu, Dropdown, DropdownItem, MenuPortal, ModelDropdown, type ChatSurfaceMenuEntry } from './chat/ChatComposerMenus'

const CHAT_SLASH_COMMANDS = [
  { value: '/compact', description: 'Compact conversation' },
  { value: '/clear', description: 'Clear conversation' },
  { value: '/model', description: 'Switch model' },
  { value: '/mode', description: 'Switch mode (plan, build, etc.)' },
  { value: '/help', description: 'Show help' },
  { value: '/init', description: 'Initialize workspace' },
  { value: '/export-notes', description: 'Copy all attached block notes to the clipboard' },
] as const

const CHAT_DEFAULT_SKILL_LOCATIONS = [
  '$HOME/.claude/commands',
  '$WORKSPACE/.claude/commands',
  '$HOME/.claude/skills',
  '$WORKSPACE/.claude/skills',
  '$HOME/.config/opencode/skills',
  '$WORKSPACE/.opencode/skills',
  '$WORKSPACE/.cursor/rules',
  '$WORKSPACE/.continue/prompts',
].join('\n')

function resolveChatSkillLocations(raw: string, homePath: string, workspacePath: string | null): string[] {
  return raw
    .split('\n')
    .map(line => {
      // Strip optional surrounding quotes and convert shell-style escapes
      // (e.g. `Application\ Support`) into literal characters. Without this
      // a pasted shell path silently fails the `readDir` lookup.
      let l = line.trim()
      if (!l) return ''
      if ((l.startsWith('"') && l.endsWith('"')) || (l.startsWith("'") && l.endsWith("'"))) l = l.slice(1, -1)
      return l.replace(/\\([ \t()'"\\])/g, '$1')
    })
    .filter(Boolean)
    .filter(line => workspacePath || !line.startsWith('$WORKSPACE'))
    .map(line => line.replace(/^\$HOME/, homePath).replace(/^\$WORKSPACE/, workspacePath ?? ''))
}

// Provider brand icons are shared with the sidebar via ./icons/providerIcons.
import { ClaudeIcon, CodexIcon, HermesIcon, OpenClawIcon } from './icons/providerIcons'

// --- Thinking strength icon (brain + signal bars) --------------------------------

const THINKING_LEVELS: Record<string, number> = { none: 0, low: 1, medium: 2, adaptive: 3, high: 4, max: 5 }

function ThinkingIcon({ level }: { level: string }): JSX.Element {
  const bars = THINKING_LEVELS[level] ?? 3
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <Brain size={14} />
      <svg width="12" height="14" viewBox="0 0 10 12">
        {[0, 1, 2, 3, 4].map(i => (
          <rect
            key={i}
            x={i * 2}
            y={12 - (i + 1) * 2.2}
            width="1.4"
            height={(i + 1) * 2.2}
            rx="0.4"
            fill="currentColor"
            opacity={i < bars ? 1 : 0.2}
          />
        ))}
      </svg>
    </div>
  )
}

// --- Types -----------------------------------------------------------------------


function shouldRenderToolBlock(block: ToolBlock): boolean {
  return block.status === 'running'
    || (block.fileChanges?.length ?? 0) > 0
    || (block.commandEntries?.length ?? 0) > 0
    || Boolean(block.summary?.trim())
    || Boolean(block.input?.trim())
}

/**
 * Heuristic: does a queued-message body look like pasted error output?
 *
 * Triggered when the user pastes a stack trace / console log into the
 * composer so the queue bar can flag it visually (red tint, alert icon).
 * Matches on common logger prefixes, error keywords, and file:line:col
 * patterns; requires the text to be either reasonably long OR to contain
 * an unambiguous signal like "Uncaught" so a plain message like
 * "fix the error in foo.ts" doesn't light up red.
 */
function isUrgentQueuedContent(text: string): boolean {
  if (!text) return false
  const body = text.trim()
  if (body.length < 20) return false
  // Unambiguous error/panic markers — any one of these is enough.
  const strongPatterns = [
    /\buncaught\b/i,
    /\bunhandled (?:promise )?rejection\b/i,
    /\bstack trace\b/i,
    /\btraceback\b/i,
    /\bsegmentation fault\b/i,
    /\bfatal\b/i,
    /\bpanic:/i,
    /\bexception\b.*\bat\b/is,
    /^\s*at\s+\S+\s*\(.+:\d+:\d+\)/m,                  // JS stack frame
    /\bERR_[A-Z_]+\b/,                                  // Node error codes
    /\b(?:TypeError|ReferenceError|SyntaxError|RangeError|Error):/,
  ]
  for (const re of strongPatterns) {
    if (re.test(body)) return true
  }
  // Weaker signals: need multiple matches or bulk size to count.
  const weakPatterns = [
    /\berror\b/i,
    /\bwarning\b/i,
    /\bfailed\b/i,
    /\bcannot\s+(?:read|find|resolve|access)\b/i,
    /\[Violation\]/,
  ]
  let weakHits = 0
  for (const re of weakPatterns) {
    if (re.test(body)) weakHits += 1
    if (weakHits >= 2) return true
  }
  // A single weak hit plus a long body (≥300 chars) likely indicates a
  // pasted log excerpt rather than a short imperative like "fix the error".
  return weakHits >= 1 && body.length >= 300
}

interface PendingAttachment {
  path: string
  kind: 'image' | 'file'
}

/**
 * Chat-surface extension mounted above the composer (e.g. Sketch/Builder).
 * Multiple surfaces can stay resident as tabs; the host caches the latest
 * payload via RPC and flushes the active/dirty payloads to temp files on send.
 */
interface ActiveChatSurface {
  extId: string
  surfaceId: string
  label: string
  icon?: string
  instanceId: string
  entryUrl: string
  emits: 'image' | 'text'
  height: number
  minHeight: number
  /** Last payload pushed up from the iframe via surface.setPayload */
  payload: ChatSurfacePayload | null
  /** Per-surface state exposed through window.contex.tile.getState/setState. */
  tileState: Record<string, unknown>
  /** Lightweight local context store for chat-surface peer coordination. */
  context: Record<string, unknown>
  /** Actions registered by the surface via window.contex.actions.register(). */
  registeredActions: Array<{ name: string; description: string }>
}

interface QueuedChatTurn {
  id: string
  content: string
  preview: string
  attachmentCount: number
  createdAt: number
  /** Optional parent turn id — when set, this turn renders indented beneath
   *  its parent as a sub-item, representing work the user intends to run
   *  *as part of* the parent turn rather than as its own top-level turn. */
  parentId?: string | null
}

type LatestChangeDrawerState = {
  key: string
  messageId: string
  toolBlockId: string
  fileChanges: FileChange[]
  fileCount: number
  additions: number
  deletions: number
  changeBlockCount: number
}

function hasVisibleFileChangeStats(change: Pick<FileChange, 'additions' | 'deletions'>): boolean {
  return change.additions > 0 || change.deletions > 0
}

function hasRenderableFileChangeDiff(change: Pick<FileChange, 'diff'>): boolean {
  return change.diff.trim().length > 0
}

interface ChatTilePersistedState {
  messages: ChatMessage[]
  input: string
  attachments: PendingAttachment[]
  queuedTurns?: QueuedChatTurn[]
  openChatSurfaces?: ActiveChatSurface[]
  activeChatSurfaceId?: string | null
  provider: string
  model: string
  mcpEnabled: boolean
  mode: string
  thinking: string
  agentMode: boolean
  autoAgentMode: boolean
  preserveSessionSummary?: boolean
  linkedSessionEntryId?: string | null
  linkedSessionHint?: SessionEntryHint | null
  hasEarlierMessages?: boolean
  sessionId: string | null
  jobId?: string | null
  jobSequence?: number
  cloudHostId?: string | null
  isStreaming: boolean
  executionTarget?: 'local' | 'cloud'
}

interface GitStatusSummary {
  isRepo: boolean
  root: string
  changedCount: number
}

interface GitBranchSummary {
  isRepo: boolean
  root: string
  current: string | null
  branches: Array<{ name: string; current: boolean }>
}

interface CachedGitState {
  status: GitStatusSummary
  branches: GitBranchSummary
  fetchedAt: number
}

interface DiscoveryPeer {
  peerId: string
  peerType: string
  capabilities: string[]
  distance: number
  lastSeen: number
  actions?: Array<{ name: string; description: string }>
  filePath?: string
  label?: string
}

function mergeAttachments(...groups: PendingAttachment[][]): PendingAttachment[] {
  const seen = new Set<string>()
  const merged: PendingAttachment[] = []
  for (const group of groups) {
    for (const item of group) {
      const path = item.path.trim()
      if (!path || seen.has(path)) continue
      seen.add(path)
      merged.push({ ...item, path })
    }
  }
  return merged
}

function getImplicitPeerImageAttachments(peers: DiscoveryPeer[]): PendingAttachment[] {
  return peers
    .filter(peer => peer.peerType === 'image' && typeof peer.filePath === 'string' && isImagePath(peer.filePath))
    .map(peer => ({ path: peer.filePath!.trim(), kind: 'image' as const }))
    .filter(item => item.path.length > 0)
}

function normalizePersistedChatSurfaces(value: unknown): ActiveChatSurface[] {
  if (!Array.isArray(value)) return []
  return value.map((item): ActiveChatSurface | null => {
    if (!item || typeof item !== 'object') return null
    const surface = item as Partial<ActiveChatSurface> & Record<string, unknown>
    const extId = typeof surface.extId === 'string' ? surface.extId : ''
    const surfaceId = typeof surface.surfaceId === 'string' ? surface.surfaceId : ''
    const instanceId = typeof surface.instanceId === 'string' ? surface.instanceId : ''
    const entryUrl = typeof surface.entryUrl === 'string' ? surface.entryUrl : ''
    if (!extId || !surfaceId || !instanceId || !entryUrl) return null
    const tileState = surface.tileState && typeof surface.tileState === 'object' && !Array.isArray(surface.tileState)
      ? { ...(surface.tileState as Record<string, unknown>) }
      : {}
    const context = surface.context && typeof surface.context === 'object' && !Array.isArray(surface.context)
      ? { ...(surface.context as Record<string, unknown>) }
      : {}
    const registeredActions = Array.isArray(surface.registeredActions)
      ? surface.registeredActions
        .filter((action: any) => action && typeof action.name === 'string')
        .map((action: any) => ({ name: String(action.name), description: typeof action.description === 'string' ? action.description : '' }))
      : []
    return {
      extId,
      surfaceId,
      label: typeof surface.label === 'string' && surface.label ? surface.label : surfaceId,
      icon: typeof surface.icon === 'string' ? surface.icon : undefined,
      instanceId,
      entryUrl,
      emits: surface.emits === 'text' ? 'text' : 'image',
      height: typeof surface.height === 'number' && Number.isFinite(surface.height) ? surface.height : 260,
      minHeight: typeof surface.minHeight === 'number' && Number.isFinite(surface.minHeight) ? surface.minHeight : 160,
      payload: normalizeChatSurfacePayload(surface.payload ?? null),
      tileState,
      context,
      registeredActions,
    }
  }).filter((surface): surface is ActiveChatSurface => !!surface)
}

type AutocompleteItem = ChatComposerAutocompleteItem

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

// --- AskUserQuestion interactive form ------------------------------------------

interface AskUserQuestionOption {
  label: string
  description?: string
  preview?: string
}
interface AskUserQuestionItem {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskUserQuestionOption[]
}
interface AskUserQuestionPayload {
  questions: AskUserQuestionItem[]
  metadata?: Record<string, unknown>
}

// Context provides the cardId so ToolBlockView (defined outside ChatTile) can
// submit answers back to main via IPC without prop-drilling through groups.
const AskUserQuestionContext = React.createContext<{ cardId: string } | null>(null)

interface CheckpointRestoreContextValue {
  workspaceId: string | null
  tileId: string
  restoringCheckpointId: string | null
  restoreCheckpoint: (checkpointId: string, sessionEntryId: string, label?: string) => Promise<void>
}

const CheckpointRestoreContext = React.createContext<CheckpointRestoreContextValue | null>(null)

/**
 * Parses a ToolBlock.input string (streamed JSON, potentially partial) and
 * returns a fully-formed AskUserQuestion payload, or null if not yet parseable.
 */
function parseAskUserQuestionInput(input: string): AskUserQuestionPayload | null {
  if (!input) return null
  try {
    const parsed = JSON.parse(input) as { questions?: unknown; metadata?: unknown }
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) return null
    const questions: AskUserQuestionItem[] = []
    for (const q of parsed.questions) {
      if (!q || typeof q !== 'object') return null
      const qq = q as Partial<AskUserQuestionItem>
      if (typeof qq.question !== 'string' || !Array.isArray(qq.options) || qq.options.length < 2) return null
      const options: AskUserQuestionOption[] = []
      for (const opt of qq.options) {
        if (!opt || typeof opt !== 'object' || typeof (opt as AskUserQuestionOption).label !== 'string') return null
        options.push({
          label: (opt as AskUserQuestionOption).label,
          description: typeof (opt as AskUserQuestionOption).description === 'string' ? (opt as AskUserQuestionOption).description : undefined,
          preview: typeof (opt as AskUserQuestionOption).preview === 'string' ? (opt as AskUserQuestionOption).preview : undefined,
        })
      }
      questions.push({
        question: qq.question,
        header: typeof qq.header === 'string' ? qq.header : undefined,
        multiSelect: qq.multiSelect === true,
        options,
      })
    }
    return { questions, metadata: (parsed.metadata as Record<string, unknown> | undefined) }
  } catch {
    return null
  }
}

interface AskUserQuestionFormProps {
  toolId: string
  payload: AskUserQuestionPayload
  onSubmitted: () => void
}

function AskUserQuestionForm({ toolId, payload, onSubmitted }: AskUserQuestionFormProps): JSX.Element {
  const theme = useTheme()
  const fonts = useFonts()
  const ctx = React.useContext(AskUserQuestionContext)
  // For single-select: Map<questionIndex, selectedLabel | '__other__'>
  // For multi-select:  Map<questionIndex, Set<selectedLabel | '__other__'>>
  const [singleChoice, setSingleChoice] = useState<Record<number, string>>({})
  const [multiChoice, setMultiChoice] = useState<Record<number, Set<string>>>({})
  const [otherText, setOtherText] = useState<Record<number, string>>({})
  const [previewIdx, setPreviewIdx] = useState<Record<number, number | null>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleMulti = useCallback((qIdx: number, label: string) => {
    setMultiChoice(prev => {
      const cur = new Set(prev[qIdx] ?? [])
      if (cur.has(label)) cur.delete(label)
      else cur.add(label)
      return { ...prev, [qIdx]: cur }
    })
  }, [])

  const allAnswered = useMemo(() => {
    return payload.questions.every((q, idx) => {
      if (q.multiSelect) {
        const set = multiChoice[idx]
        if (!set || set.size === 0) return false
        if (set.has('__other__') && !(otherText[idx]?.trim())) return false
        return true
      } else {
        const pick = singleChoice[idx]
        if (!pick) return false
        if (pick === '__other__' && !(otherText[idx]?.trim())) return false
        return true
      }
    })
  }, [payload.questions, singleChoice, multiChoice, otherText])

  const handleSubmit = useCallback(async () => {
    if (!ctx?.cardId) { setError('Chat context unavailable'); return }
    if (!allAnswered || submitting) return
    setSubmitting(true)
    setError(null)
    const answers: Record<string, string> = {}
    const annotations: Record<string, { notes?: string; preview?: string }> = {}
    payload.questions.forEach((q, idx) => {
      const otherTxt = otherText[idx]?.trim() ?? ''
      let labelOut: string
      if (q.multiSelect) {
        const set = multiChoice[idx] ?? new Set<string>()
        const parts: string[] = []
        for (const v of set) {
          if (v === '__other__') parts.push(otherTxt)
          else parts.push(v)
        }
        labelOut = parts.join(', ')
      } else {
        const pick = singleChoice[idx] ?? ''
        labelOut = pick === '__other__' ? otherTxt : pick
      }
      answers[q.question] = labelOut
      // If a preview option is focused, include it as annotation.
      const pIdx = previewIdx[idx]
      if (pIdx != null && q.options[pIdx]?.preview) {
        annotations[q.question] = { preview: q.options[pIdx].preview }
      }
    })
    try {
      const res = await window.electron?.chat?.answerUserQuestion?.({
        cardId: ctx.cardId,
        toolId,
        answers,
        annotations: Object.keys(annotations).length > 0 ? annotations : undefined,
      })
      if (res && res.ok === false) {
        setError(res.error ?? 'Failed to submit')
        setSubmitting(false)
        return
      }
      onSubmitted()
    } catch (err) {
      setError((err as Error).message || 'Failed to submit')
      setSubmitting(false)
    }
  }, [ctx?.cardId, toolId, payload.questions, singleChoice, multiChoice, otherText, previewIdx, allAnswered, submitting, onSubmitted])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 12,
      padding: 12,
      borderTop: `1px solid ${theme.chat.assistantBubbleBorder}`,
      fontFamily: fonts.sans, fontSize: 12, color: theme.chat.text,
    }}>
      {payload.questions.map((q, qIdx) => {
        const activePreview = previewIdx[qIdx] != null ? q.options[previewIdx[qIdx] as number]?.preview : null
        return (
          <div key={qIdx} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {q.header && (
                <span style={{
                  fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4,
                  color: theme.chat.muted,
                  background: theme.chat.assistantBubble,
                  border: `1px solid ${theme.chat.assistantBubbleBorder}`,
                  padding: '2px 6px', borderRadius: 4,
                }}>{q.header}</span>
              )}
              {q.multiSelect && (
                <span style={{ fontSize: 9, color: theme.chat.muted }}>(choose any)</span>
              )}
            </div>
            <div style={{ fontWeight: 500, fontSize: 13, lineHeight: 1.35 }}>{q.question}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
              {q.options.map((opt, oIdx) => {
                const checked = q.multiSelect
                  ? (multiChoice[qIdx]?.has(opt.label) ?? false)
                  : singleChoice[qIdx] === opt.label
                return (
                  <label
                    key={oIdx}
                    onMouseEnter={() => { if (opt.preview) setPreviewIdx(p => ({ ...p, [qIdx]: oIdx })) }}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: `1px solid ${checked ? theme.accent.base : theme.chat.assistantBubbleBorder}`,
                      background: checked ? theme.chat.assistantBubble : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`ask-${toolId}-${qIdx}`}
                      checked={checked}
                      onChange={() => {
                        if (q.multiSelect) toggleMulti(qIdx, opt.label)
                        else setSingleChoice(prev => ({ ...prev, [qIdx]: opt.label }))
                      }}
                      style={{ marginTop: 2, accentColor: theme.accent.base }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 500, fontSize: 12 }}>{opt.label}</span>
                      {opt.description && (
                        <span style={{ fontSize: 11, color: theme.chat.muted, lineHeight: 1.35 }}>{opt.description}</span>
                      )}
                    </div>
                  </label>
                )
              })}
              {/* Auto-included "Other" freeform option */}
              {(() => {
                const otherChecked = q.multiSelect
                  ? (multiChoice[qIdx]?.has('__other__') ?? false)
                  : singleChoice[qIdx] === '__other__'
                return (
                  <label
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 8,
                      padding: '6px 8px',
                      borderRadius: 6,
                      border: `1px solid ${otherChecked ? theme.accent.base : theme.chat.assistantBubbleBorder}`,
                      background: otherChecked ? theme.chat.assistantBubble : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`ask-${toolId}-${qIdx}`}
                      checked={otherChecked}
                      onChange={() => {
                        if (q.multiSelect) toggleMulti(qIdx, '__other__')
                        else setSingleChoice(prev => ({ ...prev, [qIdx]: '__other__' }))
                      }}
                      style={{ marginTop: 2, accentColor: theme.accent.base }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
                      <span style={{ fontWeight: 500, fontSize: 12 }}>Other…</span>
                      <input
                        type="text"
                        placeholder="Type your own answer"
                        value={otherText[qIdx] ?? ''}
                        onFocus={() => {
                          if (q.multiSelect) {
                            if (!(multiChoice[qIdx]?.has('__other__'))) toggleMulti(qIdx, '__other__')
                          } else {
                            setSingleChoice(prev => ({ ...prev, [qIdx]: '__other__' }))
                          }
                        }}
                        onChange={e => setOtherText(prev => ({ ...prev, [qIdx]: e.target.value }))}
                        style={{
                          background: theme.chat.input,
                          color: theme.chat.text,
                          border: `1px solid ${theme.chat.inputBorder}`,
                          borderRadius: 4,
                          padding: '4px 6px',
                          fontSize: 12,
                          fontFamily: fonts.sans,
                          outline: 'none',
                        }}
                      />
                    </div>
                  </label>
                )
              })()}
            </div>
            {activePreview && (
              <pre style={{
                background: theme.chat.input,
                color: theme.chat.text,
                border: `1px solid ${theme.chat.inputBorder}`,
                borderRadius: 6,
                padding: 8,
                fontSize: 11,
                fontFamily: fonts.mono,
                whiteSpace: 'pre-wrap',
                overflow: 'auto',
                maxHeight: 180,
                margin: 0,
              }}>{activePreview}</pre>
            )}
          </div>
        )
      })}
      {error && (
        <div style={{ fontSize: 11, color: theme.status.danger }}>{error}</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button
          type="button"
          disabled={!allAnswered || submitting}
          onClick={handleSubmit}
          style={{
            background: allAnswered && !submitting ? theme.accent.base : theme.chat.assistantBubble,
            color: allAnswered && !submitting ? theme.chat.input : theme.chat.muted,
            border: `1px solid ${allAnswered && !submitting ? theme.accent.base : theme.chat.assistantBubbleBorder}`,
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 12,
            fontFamily: fonts.sans,
            fontWeight: 500,
            cursor: allAnswered && !submitting ? 'pointer' : 'not-allowed',
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? 'Sending…' : 'Submit answer'}
        </button>
      </div>
    </div>
  )
}

/**
 * Chip-shell wrapper around AskUserQuestionForm so the rendering matches the
 * look of other tool blocks (bordered card with a header row).
 */
function AskUserQuestionChip({ block, payload }: { block: ToolBlock; payload: AskUserQuestionPayload }): JSX.Element {
  const theme = useTheme()
  const fonts = useFonts()
  const [submitted, setSubmitted] = useState(false)
  return (
    <div
      data-ask-user-question={block.id}
      style={{
        background: theme.chat.assistantBubble,
        border: `1px solid ${theme.chat.assistantBubbleBorder}`,
        borderRadius: 10,
        overflow: 'hidden',
        alignSelf: 'stretch',
        width: '100%',
      }}
    >
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 12px',
        fontSize: 10.5,
        fontFamily: fonts.sans,
        color: theme.chat.muted,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
      }}>
        <MessageSquare size={11} />
        <span>Question</span>
        {submitted && (
          <span style={{
            marginLeft: 'auto',
            display: 'flex', alignItems: 'center', gap: 4,
            color: theme.status.success,
            textTransform: 'none', letterSpacing: 0,
            fontSize: 11,
          }}>
            <Check size={11} /> Answer sent
          </span>
        )}
      </div>
      {submitted ? (
        <div style={{
          padding: '0 12px 12px',
          fontSize: 12, fontFamily: fonts.sans, color: theme.chat.muted,
        }}>
          Waiting for the agent to continue…
        </div>
      ) : (
        <AskUserQuestionForm
          toolId={block.id}
          payload={payload}
          onSubmitted={() => setSubmitted(true)}
        />
      )}
    </div>
  )
}


// --- Font defaults (used when no settings are provided) --------------------------

// Use the canonical font stacks from shared/types.ts DEFAULT_FONTS
const FONT_SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
const FONT_MONO = '"JetBrains Mono", "Menlo", "Monaco", "SF Mono", "Fira Code", monospace'
const FONT_SIZE_DEFAULT = 13
const MONO_SIZE_DEFAULT = 13
const CHAT_MESSAGE_MAX_WIDTH = 'var(--cs-thread-content-max-width)'
const CHAT_CHIP_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  alignItems: 'flex-start',
  alignContent: 'flex-start',
  width: '100%',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'visible',
  paddingTop: 1,
}
const CHAT_OFFSCREEN_MESSAGE_STYLE: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: '0 160px',
}
const CHAT_RENDER_PAGE_SIZE = 20
const CHAT_INITIAL_RENDER_PAGES = 2
const CHAT_INITIAL_RENDER_WINDOW = CHAT_RENDER_PAGE_SIZE * CHAT_INITIAL_RENDER_PAGES
const LINKED_SESSION_LIVE_TAIL_LIMIT = 40
const LINKED_SESSION_HISTORY_PAGE_SIZE = 20
const LINKED_SESSION_HISTORY_LOAD_THRESHOLD = 32
const CHAT_MEMORY_MESSAGE_LIMIT = 120
const CHAT_MEMORY_CHAR_LIMIT = 180_000
const CHAT_MEMORY_SINGLE_MESSAGE_LIMIT = 80_000
const CHAT_MEMORY_PRESERVE_RICH_MESSAGE_COUNT = 12
const CHAT_MEMORY_TOOL_INPUT_LIMIT = 2_000
const CHAT_MEMORY_TOOL_INPUT_LIMIT_AGGRESSIVE = 500
const CHAT_MEMORY_TOOL_SUMMARY_LIMIT = 2_000
const CHAT_MEMORY_TOOL_SUMMARY_LIMIT_AGGRESSIVE = 600
const CHAT_MEMORY_THINKING_LIMIT = 8_000
const CHAT_MEMORY_THINKING_LIMIT_AGGRESSIVE = 1_200
const CHAT_MEMORY_CONTENT_BLOCK_LIMIT = 8_000
const CHAT_MEMORY_CONTENT_BLOCK_LIMIT_AGGRESSIVE = 1_500
const CHAT_TRIM_NOTICE_PREFIX = '[CodeSurf memory guard]'
const CHAT_COMPOSER_MAX_WIDTH = CHAT_MESSAGE_MAX_WIDTH
const CHAT_COMPOSER_MIN_WIDTH = 'var(--cs-chat-composer-min-width)'
const CHAT_COMPOSER_SIDE_INSET = 'var(--cs-chat-composer-side-inset)'
const CHAT_COMPOSER_WIDTH = `min(calc(100% - calc(${CHAT_COMPOSER_SIDE_INSET} * 2)), ${CHAT_COMPOSER_MAX_WIDTH})`
const CHAT_COMPOSER_MIN_WIDTH_STYLE = `min(${CHAT_COMPOSER_MIN_WIDTH}, calc(100% - calc(${CHAT_COMPOSER_SIDE_INSET} * 2)))`
const CHAT_COMPOSER_MIN_HEIGHT = 105
const CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT = 56
const CHAT_AUTO_SCROLL_THRESHOLD = 48
const TOOLBAR_ICON_SIZE = 16
const TOOLBAR_PILL_ICON_SIZE = 14
const TOOL_BLOCK_MAX_WIDTH = 420

function getToolDisplayName(name: string): string {
  return name === 'exec_command' ? 'bash' : name
}
const LIVE_TOOL_COLLAPSE_GRACE_MS = 5000
const GIT_STATE_CACHE_TTL_MS = 15_000
const NON_SELECTABLE_UI_STYLE = {
  userSelect: 'none' as const,
  WebkitUserSelect: 'none' as const,
}
const TOOL_OUTPUT_METADATA_PATTERNS = [
  /^Chunk ID:/i,
  /^Wall time:/i,
  /^Process exited with code /i,
  /^Process running with session ID /i,
  /^Original token count:/i,
  /^Output:$/i,
  /^\[CodeSurf memory guard\] Older tool (output|summary) /i,
]

const gitStateCache = new Map<string, CachedGitState>()
const gitStateInflight = new Map<string, Promise<CachedGitState>>()

function normalizeGitWorkspaceKey(workspaceDir: string): string {
  return workspaceDir.replace(/\/+$/, '')
}

function createEmptyGitState(workspaceDir: string): CachedGitState {
  return {
    status: { isRepo: false, root: workspaceDir, changedCount: 0 },
    branches: { isRepo: false, root: workspaceDir, current: null, branches: [] },
    fetchedAt: 0,
  }
}

function getCachedGitState(workspaceDir: string): CachedGitState | null {
  if (!workspaceDir) return null
  return gitStateCache.get(normalizeGitWorkspaceKey(workspaceDir)) ?? null
}

function isFreshGitState(entry: CachedGitState | null | undefined): entry is CachedGitState {
  return Boolean(entry) && (Date.now() - entry.fetchedAt) < GIT_STATE_CACHE_TTL_MS
}

async function loadGitState(workspaceDir: string, force = false): Promise<CachedGitState> {
  if (!workspaceDir || !window.electron?.git) return createEmptyGitState(workspaceDir)

  const cacheKey = normalizeGitWorkspaceKey(workspaceDir)
  const cached = gitStateCache.get(cacheKey)
  if (!force && isFreshGitState(cached)) return cached

  const pending = gitStateInflight.get(cacheKey)
  if (!force && pending) return pending

  const request = (async () => {
    try {
      const [statusResult, branchResult] = await Promise.all([
        window.electron.git.status(workspaceDir),
        window.electron.git.branches(workspaceDir),
      ])

      const next: CachedGitState = {
        status: {
          isRepo: statusResult?.isRepo === true,
          root: statusResult?.root ?? workspaceDir,
          changedCount: Array.isArray(statusResult?.files) ? statusResult.files.length : 0,
        },
        branches: {
          isRepo: branchResult?.isRepo === true,
          root: branchResult?.root ?? workspaceDir,
          current: branchResult?.current ?? null,
          branches: Array.isArray(branchResult?.branches) ? branchResult.branches : [],
        },
        fetchedAt: Date.now(),
      }
      gitStateCache.set(cacheKey, next)
      return next
    } catch {
      const empty: CachedGitState = { ...createEmptyGitState(workspaceDir), fetchedAt: Date.now() }
      gitStateCache.set(cacheKey, empty)
      return empty
    } finally {
      gitStateInflight.delete(cacheKey)
    }
  })()

  gitStateInflight.set(cacheKey, request)
  return request
}

// Font context so sub-components can read settings-derived fonts without prop drilling
const FontCtx = React.createContext({ sans: FONT_SANS, secondary: FONT_SANS, mono: FONT_MONO, size: FONT_SIZE_DEFAULT, monoSize: MONO_SIZE_DEFAULT, lineHeight: 1.5, weight: 400, monoLineHeight: 1.5, monoWeight: 400, secondarySize: 11, secondaryLineHeight: 1.4, secondaryWeight: 400 })
function useFonts() { return React.useContext(FontCtx) }

// Dispatch context — lets deeply-nested tool renderers (e.g. AskUserQuestion form)
// send answers back into the chat as the next user turn.
type ChatDispatchValue = {
  sendAnswer: (text: string) => void | Promise<void>
}
const ChatDispatchCtx = React.createContext<ChatDispatchValue | null>(null)
function useChatDispatch(): ChatDispatchValue | null { return React.useContext(ChatDispatchCtx) }

function sanitizeToolOutputText(text: string | undefined): string | undefined {
  if (!text) return text

  const cleaned = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => !TOOL_OUTPUT_METADATA_PATTERNS.some(pattern => pattern.test(line.trim())))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return cleaned || undefined
}

function buildOutgoingMessageContent(draftInput: string, draftAttachments: PendingAttachment[]): string {
  const trimmedInput = draftInput.trim()
  const attachmentBlock = draftAttachments.length > 0
    ? `Attached file paths:\n${draftAttachments.map(item => item.path).join('\n')}`
    : ''
  return [trimmedInput, attachmentBlock].filter(Boolean).join('\n\n').trim()
}

function renderChatSurfaceIcon(icon: string | undefined, size = 14): JSX.Element {
  const name = String(icon ?? '').toLowerCase()
  if (name === 'sparkles' || name === 'builder') return <Sparkles size={size} />
  if (name === 'pencil' || name === 'sketch') return <Pencil size={size} />
  if (name === 'settings' || name === 'cog') return <Cog size={size} />
  return <Wrench size={size} />
}

function encodeUtf8Base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function buildQueuedTurnPreview(content: string, attachmentCount: number): string {
  const trimmed = content.trim()
  const attachmentMarkerIndex = trimmed.indexOf('Attached file paths:')
  const visibleText = attachmentMarkerIndex >= 0 ? trimmed.slice(0, attachmentMarkerIndex).trim() : trimmed
  const firstLine = visibleText.split(/\r?\n/, 1)[0]?.trim() ?? ''
  const truncated = firstLine.length > 140 ? `${firstLine.slice(0, 139)}…` : firstLine
  if (truncated) return truncated
  if (attachmentCount > 0) return `Queued attachment${attachmentCount === 1 ? '' : 's'}`
  return 'Queued follow-up'
}

const RECENT_EDIT_CONTEXT_FILE_LIMIT = 3
const RECENT_EDIT_CONTEXT_SNIPPET_LINE_LIMIT = 24
const RECENT_EDIT_CONTEXT_SURROUNDING_LINES = 4
const RECENT_EDIT_CONTEXT_MAX_CHARS = 5000

function shouldAttachRecentEditContext(userText: string): boolean {
  const normalized = userText.trim()
  if (!normalized) return false
  if (normalized.length > 320) return false

  const hasEditIntent = /\b(edit|change|adjust|tweak|move|nudge|shift|raise|lower|increase|decrease|reduce|make|set|resize|align|position|offset|widen|narrow|shorten|lengthen|bigger|smaller|higher|lower)\b/i.test(normalized)
    || /\b\d+(?:px|rem|em|%)\b/i.test(normalized)
  const refersToExistingThing = /\b(it|that|those|them|this|same|again|more|further|another|still|also|back|left|right|up|down|higher|lower|bigger|smaller)\b/i.test(normalized)
  return hasEditIntent && refersToExistingThing
}

function resolveEditedFilePath(filePath: string, workspaceDir: string): string {
  const trimmed = String(filePath ?? '').trim()
  if (!trimmed) return trimmed
  if (trimmed.startsWith('/')) return trimmed
  return `${workspaceDir.replace(/\/+$/, '')}/${trimmed.replace(/^\/+/, '')}`
}

function extractChangedLineRangesFromDiff(diff: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = []
  for (const line of String(diff ?? '').split('\n')) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/)
    if (!match) continue
    const start = Number(match[1] ?? '0')
    const count = Number(match[2] ?? '1')
    if (!Number.isFinite(start) || start <= 0) continue
    const safeCount = Number.isFinite(count) && count > 0 ? count : 1
    ranges.push({ start, end: start + safeCount - 1 })
  }
  return ranges
}

function buildSnippetFromRanges(fileContent: string, ranges: Array<{ start: number; end: number }>): string {
  const lines = String(fileContent ?? '').split(/\r?\n/)
  if (lines.length === 0) return ''
  const windows = ranges.length > 0
    ? ranges.slice(0, 3)
    : [{ start: 1, end: Math.min(lines.length, 8) }]

  const merged: Array<{ start: number; end: number }> = []
  for (const range of windows) {
    const next = {
      start: Math.max(1, range.start - RECENT_EDIT_CONTEXT_SURROUNDING_LINES),
      end: Math.min(lines.length, range.end + RECENT_EDIT_CONTEXT_SURROUNDING_LINES),
    }
    const previous = merged[merged.length - 1]
    if (previous && next.start <= previous.end + 2) {
      previous.end = Math.max(previous.end, next.end)
    } else {
      merged.push(next)
    }
  }

  let emittedLines = 0
  const parts: string[] = []
  for (const range of merged) {
    if (emittedLines >= RECENT_EDIT_CONTEXT_SNIPPET_LINE_LIMIT) break
    if (parts.length > 0) parts.push('...')
    for (let lineNumber = range.start; lineNumber <= range.end; lineNumber += 1) {
      if (emittedLines >= RECENT_EDIT_CONTEXT_SNIPPET_LINE_LIMIT) {
        parts.push('...')
        break
      }
      parts.push(`${lineNumber}: ${lines[lineNumber - 1] ?? ''}`)
      emittedLines += 1
    }
  }
  return parts.join('\n').trim()
}

async function buildRecentEditContext(messages: ChatMessage[], workspaceDir: string, userText: string): Promise<string | null> {
  if (!shouldAttachRecentEditContext(userText) || !workspaceDir.trim() || !window.electron?.fs?.readFile) return null

  const seenPaths = new Set<string>()
  const recentChanges: Array<{ displayPath: string; resolvedPath: string; diff: string; changeType: string }> = []

  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message.role !== 'assistant') continue
    const toolBlocks = message.toolBlocks ?? []
    for (let blockIndex = toolBlocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = toolBlocks[blockIndex]
      for (const change of [...(block.fileChanges ?? [])].reverse()) {
        const resolvedPath = resolveEditedFilePath(change.path, workspaceDir)
        if (!resolvedPath || seenPaths.has(resolvedPath)) continue
        seenPaths.add(resolvedPath)
        recentChanges.push({
          displayPath: change.path,
          resolvedPath,
          diff: change.diff,
          changeType: change.changeType,
        })
        if (recentChanges.length >= RECENT_EDIT_CONTEXT_FILE_LIMIT) break
      }
      if (recentChanges.length >= RECENT_EDIT_CONTEXT_FILE_LIMIT) break
    }
    if (recentChanges.length >= RECENT_EDIT_CONTEXT_FILE_LIMIT) break
  }

  if (recentChanges.length === 0) return null

  const sections: string[] = []
  for (const change of recentChanges) {
    try {
      const fileContent = await window.electron.fs.readFile(change.resolvedPath)
      const snippet = buildSnippetFromRanges(fileContent, extractChangedLineRangesFromDiff(change.diff))
      if (!snippet) continue
      sections.push(
        `File: ${change.displayPath}\n` +
        `Recent change type: ${change.changeType}\n` +
        `Current nearby code:\n${snippet}`,
      )
    } catch {
      // If the file no longer exists or can't be read, skip it quietly.
    }
  }

  if (sections.length === 0) return null

  const combined =
    'Recent edit context from the immediately previous implementation pass. Use this only as fast-follow context if the user is referring to the same change area.\n\n'
    + sections.join('\n\n---\n\n')

  if (combined.length <= RECENT_EDIT_CONTEXT_MAX_CHARS) return combined
  return `${combined.slice(0, RECENT_EDIT_CONTEXT_MAX_CHARS - 1).trimEnd()}…`
}

/** Per-turn annotations ("block notes") the user has stuck onto earlier
 *  messages, tool calls, or thinking blocks are pure UI state by default —
 *  they never reach the model. This helper serialises them into a compact
 *  markdown block that we append to the newest outgoing user message so the
 *  agent can read them as guidance. Capped in size to avoid ballooning the
 *  request, and silently returns null when there's nothing to send. */
const BLOCK_NOTES_CONTEXT_MAX_CHARS = 4000
function buildBlockNotesContext(messages: ChatMessage[]): string | null {
  const lines: string[] = []
  for (let turnIdx = 0; turnIdx < messages.length; turnIdx += 1) {
    const msg = messages[turnIdx]
    if (msg.note?.text) {
      const snippet = (msg.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
      lines.push(`- [${msg.role} turn ${turnIdx + 1}${snippet ? `: "${snippet}${snippet.length >= 80 ? '…' : ''}"` : ''}] ${msg.note.text}`)
    }
    for (const tb of msg.toolBlocks ?? []) {
      if (tb.note?.text) {
        lines.push(`- [tool \`${tb.name}\`] ${tb.note.text}`)
      }
    }
    for (const tk of msg.thinkingBlocks ?? []) {
      if (tk.note?.text) {
        const snippet = (tk.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
        lines.push(`- [thinking${snippet ? `: "${snippet}${snippet.length >= 80 ? '…' : ''}"` : ''}] ${tk.note.text}`)
      }
    }
  }
  if (lines.length === 0) return null
  const body = 'User annotations on earlier turns (treat as durable guidance, not fresh requests):\n' + lines.join('\n')
  if (body.length <= BLOCK_NOTES_CONTEXT_MAX_CHARS) return body
  return `${body.slice(0, BLOCK_NOTES_CONTEXT_MAX_CHARS - 1).trimEnd()}…`
}

function splitMessageAttachmentPaths(text: string): {
  bodyText: string
  attachmentPaths: string[]
} {
  const marker = 'Attached file paths:'
  const normalized = String(text ?? '')
  const attachmentMarkerIndex = normalized.indexOf(marker)
  if (attachmentMarkerIndex < 0) {
    return {
      bodyText: normalized,
      attachmentPaths: [],
    }
  }

  const bodyText = normalized.slice(0, attachmentMarkerIndex).trim()
  const attachmentText = normalized.slice(attachmentMarkerIndex + marker.length).trim()
  const attachmentPaths = attachmentText
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  if (attachmentPaths.length === 0) {
    return {
      bodyText: normalized,
      attachmentPaths: [],
    }
  }

  return {
    bodyText,
    attachmentPaths,
  }
}

/**
 * Extracts the set of absolute file paths that the model demonstrably "read"
 * across a conversation. We only consider tools that actually load file
 * bytes into the model's context:
 *   - `Read` — canonical file read (images returned as image blocks by the harness)
 *   - `NotebookEdit` / `NotebookRead` — ditto for notebooks
 *
 * Paths referenced by write/edit tools are excluded: writing to a path does
 * not guarantee the model loaded the file contents first. The output is only
 * used to drive the "image was read" tick on attachment chips, so being
 * conservative here is important — the tick must never lie.
 */
function collectModelReadPaths(messages: ChatMessage[]): Set<string> {
  const paths = new Set<string>()
  for (const msg of messages) {
    const blocks = msg.toolBlocks
    if (!blocks || blocks.length === 0) continue
    for (const block of blocks) {
      if (block.name !== 'Read' && block.name !== 'NotebookRead') continue
      // Only count a read as successful if the tool finished without error —
      // a failed Read (e.g. file missing) did not actually load anything into
      // context, so the tick would be misleading.
      if (block.status !== 'done') continue
      if (!block.input) continue
      try {
        const parsed = JSON.parse(block.input) as Record<string, unknown>
        const filePath = typeof parsed.file_path === 'string' ? parsed.file_path : null
        if (filePath) paths.add(filePath)
      } catch {
        // Non-JSON input — skip rather than guess.
      }
    }
  }
  return paths
}

function truncateTextForMemory(text: string | undefined, limit: number, label: string): string {
  if (!text) return ''
  if (text.length <= limit) return text
  const keptTail = text.slice(-limit)
  return `${CHAT_TRIM_NOTICE_PREFIX} Older ${label} was truncated to keep the renderer alive.\n\n${keptTail}`
}

function trimToolBlockForMemory(block: ToolBlock, aggressive: boolean): ToolBlock {
  const input = truncateTextForMemory(
    block.input,
    aggressive ? CHAT_MEMORY_TOOL_INPUT_LIMIT_AGGRESSIVE : CHAT_MEMORY_TOOL_INPUT_LIMIT,
    `tool input for ${block.name}`,
  )
  const sanitizedSummary = sanitizeToolOutputText(block.summary)
  const summary = sanitizedSummary
    ? truncateTextForMemory(
      sanitizedSummary,
      aggressive ? CHAT_MEMORY_TOOL_SUMMARY_LIMIT_AGGRESSIVE : CHAT_MEMORY_TOOL_SUMMARY_LIMIT,
      `tool summary for ${block.name}`,
    )
    : sanitizedSummary
  const fileChanges = block.fileChanges?.map(change => {
    const diff = truncateTextForMemory(
      change.diff,
      aggressive ? CHAT_MEMORY_TOOL_SUMMARY_LIMIT_AGGRESSIVE : CHAT_MEMORY_TOOL_SUMMARY_LIMIT,
      `tool diff for ${change.path}`,
    )
    if (diff === change.diff) return change
    return { ...change, diff }
  })
  const commandEntries = block.commandEntries?.map(entry => {
    const sanitizedOutput = sanitizeToolOutputText(entry.output)
    if (!sanitizedOutput) {
      if (!entry.output) return entry
      return { ...entry, output: undefined }
    }
    const output = truncateTextForMemory(
      sanitizedOutput,
      aggressive ? CHAT_MEMORY_TOOL_SUMMARY_LIMIT_AGGRESSIVE : CHAT_MEMORY_TOOL_SUMMARY_LIMIT,
      `tool output for ${entry.label}`,
    )
    if (output === entry.output) return entry
    return { ...entry, output }
  })

  const fileChangesChanged = fileChanges?.some((change, index) => change !== block.fileChanges?.[index]) ?? false
  const commandEntriesChanged = commandEntries?.some((entry, index) => entry !== block.commandEntries?.[index]) ?? false

  if (input === block.input && summary === block.summary && !fileChangesChanged && !commandEntriesChanged) return block
  return { ...block, input, summary, fileChanges, commandEntries }
}

function mergeToolBlockDuplicate(existing: ToolBlock, incoming: ToolBlock): ToolBlock {
  return {
    ...existing,
    ...incoming,
    name: incoming.name || existing.name,
    input: incoming.input || existing.input,
    summary: incoming.summary ?? existing.summary,
    status: incoming.status === 'running' && existing.status !== 'running'
      ? existing.status
      : incoming.status,
    elapsed: incoming.elapsed ?? existing.elapsed,
    fileChanges: incoming.fileChanges ?? existing.fileChanges,
    commandEntries: incoming.commandEntries ?? existing.commandEntries,
  }
}

function normalizeMessageStructure(message: ChatMessage): ChatMessage {
  const toolBlocks = message.toolBlocks
  const contentBlocks = message.contentBlocks
  if ((!toolBlocks || toolBlocks.length <= 1) && (!contentBlocks || contentBlocks.length <= 1)) return message

  let nextToolBlocks = toolBlocks
  if (toolBlocks?.length) {
    const seen = new Map<string, number>()
    const deduped: ToolBlock[] = []
    let changed = false
    for (const block of toolBlocks) {
      const existingIndex = seen.get(block.id)
      if (existingIndex == null) {
        seen.set(block.id, deduped.length)
        deduped.push(block)
        continue
      }
      deduped[existingIndex] = mergeToolBlockDuplicate(deduped[existingIndex], block)
      changed = true
    }
    if (changed) nextToolBlocks = deduped
  }

  let nextContentBlocks = contentBlocks
  if (contentBlocks?.length) {
    const seenToolRefs = new Set<string>()
    const deduped = contentBlocks.filter(block => {
      if (block.type !== 'tool') return true
      if (seenToolRefs.has(block.toolId)) return false
      seenToolRefs.add(block.toolId)
      return true
    })
    if (deduped.length !== contentBlocks.length) nextContentBlocks = deduped
  }

  if (nextToolBlocks === toolBlocks && nextContentBlocks === contentBlocks) return message
  return {
    ...message,
    toolBlocks: nextToolBlocks,
    contentBlocks: nextContentBlocks,
  }
}

function compactMessageForMemory(message: ChatMessage, options: { aggressive: boolean; preserveRichLayout: boolean }): ChatMessage {
  const normalizedMessage = normalizeMessageStructure(message)
  const aggressive = options.aggressive && !message.isStreaming
  const content = truncateTextForMemory(normalizedMessage.content, CHAT_MEMORY_SINGLE_MESSAGE_LIMIT, 'message content')
  let next: ChatMessage = content === normalizedMessage.content ? normalizedMessage : { ...normalizedMessage, content }

  if (normalizedMessage.thinking?.content) {
    const thinkingContent = truncateTextForMemory(
      normalizedMessage.thinking.content,
      aggressive ? CHAT_MEMORY_THINKING_LIMIT_AGGRESSIVE : CHAT_MEMORY_THINKING_LIMIT,
      'thinking text',
    )
    if (thinkingContent !== normalizedMessage.thinking.content) {
      next = next === normalizedMessage ? { ...normalizedMessage } : next
      next.thinking = { ...normalizedMessage.thinking, content: thinkingContent }
    }
  }

  if (normalizedMessage.toolBlocks?.length) {
    const sourceBlocks = aggressive && normalizedMessage.toolBlocks.length > 3
      ? normalizedMessage.toolBlocks.slice(-3)
      : normalizedMessage.toolBlocks
    const trimmedBlocks = sourceBlocks.map(block => trimToolBlockForMemory(block, aggressive))
    const blocksChanged = sourceBlocks.length !== normalizedMessage.toolBlocks.length
      || trimmedBlocks.some((block, index) => block !== sourceBlocks[index])
    if (blocksChanged) {
      next = next === normalizedMessage ? { ...normalizedMessage } : next
      next.toolBlocks = trimmedBlocks.length > 0 ? trimmedBlocks : undefined
    }
  }

  if (normalizedMessage.contentBlocks?.length) {
    if (normalizedMessage.isStreaming || options.preserveRichLayout) {
      const nextContentBlocks = normalizedMessage.contentBlocks.map(block => {
        if (block.type !== 'text') return block
        const text = truncateTextForMemory(
          block.text,
          aggressive ? CHAT_MEMORY_CONTENT_BLOCK_LIMIT_AGGRESSIVE : CHAT_MEMORY_CONTENT_BLOCK_LIMIT,
          'interleaved message content',
        )
        if (text === block.text) return block
        return {
          ...block,
          text,
        }
      })
      if (nextContentBlocks.some((block, index) => block !== normalizedMessage.contentBlocks?.[index])) {
        next = next === normalizedMessage ? { ...normalizedMessage } : next
        next.contentBlocks = nextContentBlocks
      }
    } else {
      next = next === normalizedMessage ? { ...normalizedMessage } : next
      next.contentBlocks = undefined
    }
  }

  return next
}

function estimateMessageChars(message: ChatMessage): number {
  const toolChars = (message.toolBlocks ?? []).reduce((sum, block) => {
    const fileChangeChars = (block.fileChanges ?? []).reduce((fileSum, change) => {
      return fileSum + change.path.length + (change.previousPath?.length ?? 0) + change.diff.length
    }, 0)
    const commandEntryChars = (block.commandEntries ?? []).reduce((entrySum, entry) => {
      return entrySum + entry.label.length + (entry.command?.length ?? 0) + (entry.output?.length ?? 0)
    }, 0)
    return sum + (block.name?.length ?? 0) + (block.input?.length ?? 0) + (block.summary?.length ?? 0) + fileChangeChars + commandEntryChars
  }, 0)
  const contentBlockChars = (message.contentBlocks ?? []).reduce((sum, block) => {
    return sum + (block.type === 'text' ? (block.text?.length ?? 0) : 24)
  }, 0)
  return (message.content?.length ?? 0) + (message.thinking?.content?.length ?? 0) + toolChars + contentBlockChars
}

function normalizeMessagesForMemory(messages: ChatMessage[]): ChatMessage[] {
  const withoutNotice = messages.filter(message => !(message.role === 'system' && message.content.startsWith(CHAT_TRIM_NOTICE_PREFIX)))
  const sourceMessages = withoutNotice.length === messages.length ? messages : withoutNotice
  const normalized = sourceMessages.map((message, index, arr) => compactMessageForMemory(message, {
    aggressive: index < arr.length - CHAT_MEMORY_PRESERVE_RICH_MESSAGE_COUNT,
    preserveRichLayout: index >= arr.length - CHAT_MEMORY_PRESERVE_RICH_MESSAGE_COUNT,
  }))

  let start = 0
  let totalChars = normalized.reduce((sum, message) => sum + estimateMessageChars(message), 0)
  while (normalized.length - start > CHAT_MEMORY_MESSAGE_LIMIT || totalChars > CHAT_MEMORY_CHAR_LIMIT) {
    totalChars -= estimateMessageChars(normalized[start])
    start += 1
  }

  if (start === 0) {
    if (sourceMessages.length === messages.length && normalized.every((message, index) => message === messages[index])) {
      return messages
    }
    return normalized
  }

  const notice: ChatMessage = {
    id: `msg-memory-guard-${normalized[start]?.timestamp ?? Date.now()}`,
    role: 'system',
    content: `${CHAT_TRIM_NOTICE_PREFIX} Dropped ${start} older message${start === 1 ? '' : 's'} from live renderer state to avoid an out-of-memory crash. Remaining history may also be compacted.`,
    timestamp: normalized[start]?.timestamp ?? Date.now(),
  }
  return [notice, ...normalized.slice(start)]
}

function canUsePagedLinkedHistory(
  linkedSessionEntryId: string | null | undefined,
  linkedSessionHint: SessionEntryHint | null | undefined,
  sessionId: string | null | undefined,
): boolean {
  if (!linkedSessionEntryId || !linkedSessionHint || !sessionId) return false
  return linkedSessionHint.source !== 'codesurf'
}

function mergeHistoricalMessages(
  previous: ChatMessage[],
  incoming: ChatMessage[],
): ChatMessage[] {
  if (incoming.length === 0) return previous
  const seen = new Set<string>()
  const out: ChatMessage[] = []
  for (const message of [...previous, ...incoming]) {
    const key = buildChatMessageHistoryFingerprint(message)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(message)
  }
  out.sort((a, b) => a.timestamp - b.timestamp)
  return out
}

function getRelativeMentionPath(filePath: string, workspaceDir: string): string {
  const normalizedFilePath = filePath.replace(/\\/g, '/')
  const normalizedWorkspaceDir = workspaceDir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!normalizedWorkspaceDir) return basename(normalizedFilePath)
  if (normalizedFilePath === normalizedWorkspaceDir) return basename(normalizedFilePath)
  if (normalizedFilePath.startsWith(`${normalizedWorkspaceDir}/`)) {
    return normalizedFilePath.slice(normalizedWorkspaceDir.length + 1)
  }
  return basename(normalizedFilePath)
}


type RenderableMessageSegment =
  | { type: 'markdown'; text: string }
  | { type: 'jsx'; jsx: string; isStreaming: boolean }

const JSX_FENCE_LANGUAGES = new Set(['jsx', 'tsx', 'react'])

function looksLikeInlineJsxSource(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.startsWith('```')) return false

  const hasJsxTag = /<[A-Za-z][\w:.-]*(\s|>)/.test(trimmed)
  if (!hasJsxTag) return false

  if (/^<[A-Za-z][\w:.-]*(\s|>)/.test(trimmed)) return true

  return /\b(return\s*\(|export\s+(default\s+)?(const|function)|const\s+[A-Z][\w$]*\s*=|function\s+[A-Z][\w$]*\s*\(|React\.FC|useState\s*\()/m.test(trimmed)
}

function splitRenderableMessageSegments(text: string, isStreaming = false): RenderableMessageSegment[] {
  if (!text.includes('```')) {
    if (looksLikeInlineJsxSource(text)) {
      return [{ type: 'jsx', jsx: text, isStreaming }]
    }
    return text.trim() ? [{ type: 'markdown', text }] : []
  }

  const segments: RenderableMessageSegment[] = []
  let cursor = 0

  while (cursor < text.length) {
    let fenceStart = -1
    let headerEnd = -1
    let searchFrom = cursor

    while (searchFrom < text.length) {
      const candidateStart = text.indexOf('```', searchFrom)
      if (candidateStart === -1) break

      const candidateHeaderEnd = text.indexOf('\n', candidateStart + 3)
      if (candidateHeaderEnd === -1) break

      const header = text.slice(candidateStart + 3, candidateHeaderEnd).trim().toLowerCase()
      const language = header.split(/\s+/)[0]
      if (JSX_FENCE_LANGUAGES.has(language)) {
        fenceStart = candidateStart
        headerEnd = candidateHeaderEnd
        break
      }

      searchFrom = candidateHeaderEnd + 1
    }

    if (fenceStart === -1 || headerEnd === -1) break

    if (fenceStart > cursor) {
      segments.push({ type: 'markdown', text: text.slice(cursor, fenceStart) })
    }

    const closingFenceStart = text.indexOf('\n```', headerEnd + 1)
    if (closingFenceStart === -1) {
      if (isStreaming) {
        const jsx = text.slice(headerEnd + 1)
        if (jsx.trim()) segments.push({ type: 'jsx', jsx, isStreaming: true })
      } else {
        segments.push({ type: 'markdown', text: text.slice(fenceStart) })
      }
      cursor = text.length
      break
    }

    const jsx = text.slice(headerEnd + 1, closingFenceStart)
    if (jsx.trim()) segments.push({ type: 'jsx', jsx, isStreaming: false })

    cursor = closingFenceStart + 4
    if (text[cursor] === '\n') cursor += 1
  }

  if (cursor < text.length) {
    const trailingText = text.slice(cursor)
    if (looksLikeInlineJsxSource(trailingText)) {
      segments.push({ type: 'jsx', jsx: trailingText, isStreaming })
    } else {
      segments.push({ type: 'markdown', text: trailingText })
    }
  }

  const filtered = segments.filter(segment => segment.type === 'jsx' ? Boolean(segment.jsx.trim()) : Boolean(segment.text.trim()))
  if (filtered.length === 0 && looksLikeInlineJsxSource(text)) {
    return [{ type: 'jsx', jsx: text, isStreaming }]
  }
  return filtered
}

function InlineJSXPreviewBlock({ jsx, isStreaming = false }: { jsx: string; isStreaming?: boolean }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()

  const previewComponents = useMemo(() => {
    const mergeStyle = (style: unknown, defaults: React.CSSProperties): React.CSSProperties => ({
      ...defaults,
      ...(style && typeof style === 'object' ? style as React.CSSProperties : {}),
    })

    const Card = ({ children, style, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div
        {...props}
        style={mergeStyle(style, {
          borderRadius: 12,
          border: `1px solid ${theme.border.default}`,
          background: theme.surface.panel,
          boxShadow: theme.shadow.panel,
          padding: 16,
        })}
      >
        {children}
      </div>
    )

    const CardHeader = ({ children, style, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props} style={mergeStyle(style, { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 })}>{children}</div>
    )
    const CardTitle = ({ children, style, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props} style={mergeStyle(style, { fontSize: Math.max(16, fonts.size + 2), fontWeight: 700, color: theme.text.primary })}>{children}</div>
    )
    const CardDescription = ({ children, style, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props} style={mergeStyle(style, { fontSize: Math.max(12, fonts.secondarySize), color: theme.text.muted, lineHeight: 1.5 })}>{children}</div>
    )
    const CardContent = ({ children, style, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props} style={mergeStyle(style, { display: 'flex', flexDirection: 'column', gap: 10 })}>{children}</div>
    )
    const CardFooter = ({ children, style, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props} style={mergeStyle(style, { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 })}>{children}</div>
    )
    const Button = ({ children, style, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
      <button
        {...props}
        type={props.type ?? 'button'}
        style={mergeStyle(style, {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          borderRadius: 8,
          border: `1px solid ${theme.border.default}`,
          background: theme.accent.base,
          color: theme.text.inverse,
          padding: '8px 12px',
          fontSize: Math.max(12, fonts.size - 1),
          fontWeight: 600,
          cursor: 'default',
        })}
      >
        {children}
      </button>
    )
    const Badge = ({ children, style, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span
        {...props}
        style={mergeStyle(style, {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          borderRadius: 999,
          border: `1px solid ${theme.border.subtle}`,
          background: theme.surface.panelMuted,
          color: theme.text.secondary,
          padding: '3px 8px',
          fontSize: Math.max(11, fonts.secondarySize - 1),
          fontWeight: 600,
        })}
      >
        {children}
      </span>
    )
    const Input = ({ style, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
      <input
        {...props}
        style={mergeStyle(style, {
          width: '100%',
          borderRadius: 8,
          border: `1px solid ${theme.chat.inputBorder}`,
          background: theme.chat.input,
          color: theme.text.primary,
          padding: '8px 10px',
          fontSize: Math.max(12, fonts.size - 1),
        })}
      />
    )
    const Textarea = ({ style, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
      <textarea
        {...props}
        style={mergeStyle(style, {
          width: '100%',
          minHeight: 96,
          borderRadius: 8,
          border: `1px solid ${theme.chat.inputBorder}`,
          background: theme.chat.input,
          color: theme.text.primary,
          padding: '8px 10px',
          fontSize: Math.max(12, fonts.size - 1),
          resize: 'vertical',
        })}
      />
    )
    const Separator = ({ style, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props} style={mergeStyle(style, { width: '100%', height: 1, background: theme.border.subtle })} />
    )
    const Stack = ({ children, style, gap = 10, ...props }: React.HTMLAttributes<HTMLDivElement> & { gap?: number }) => (
      <div {...props} style={mergeStyle(style, { display: 'flex', flexDirection: 'column', gap })}>{children}</div>
    )
    const Grid = ({ children, style, columns = 2, gap = 10, ...props }: React.HTMLAttributes<HTMLDivElement> & { columns?: number; gap?: number }) => (
      <div {...props} style={mergeStyle(style, { display: 'grid', gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap })}>{children}</div>
    )

    return {
      Badge,
      Button,
      Card,
      CardContent,
      CardDescription,
      CardFooter,
      CardHeader,
      CardTitle,
      Grid,
      Input,
      Separator,
      Stack,
      Textarea,
    }
  }, [fonts.secondarySize, fonts.size, theme.accent.base, theme.border.default, theme.border.subtle, theme.chat.input, theme.chat.inputBorder, theme.shadow.panel, theme.surface.panel, theme.surface.panelMuted, theme.text.inverse, theme.text.muted, theme.text.primary, theme.text.secondary])

  const previewBindings = useMemo(() => ({
    theme,
    colors: {
      accent: theme.accent.base,
      background: theme.chat.background,
      border: theme.border.default,
      muted: theme.text.muted,
      text: theme.text.primary,
    },
  }), [theme])

  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${theme.border.default}`,
        background: theme.surface.panelMuted,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '10px 12px',
          borderBottom: `1px solid ${theme.border.subtle}`,
          background: theme.surface.panel,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: isStreaming ? theme.status.warning : theme.status.success,
              flexShrink: 0,
            }}
          />
          <div style={{ fontSize: Math.max(11, fonts.secondarySize), fontWeight: 700, color: theme.text.primary, letterSpacing: 0.2 }}>
            JSX Preview
          </div>
        </div>
        <div style={{ fontSize: Math.max(10, fonts.secondarySize - 1), color: theme.text.muted, flexShrink: 0 }}>
          {isStreaming ? 'streaming' : 'inline render'}
        </div>
      </div>

      <div
        className="allow-text-selection"
        style={{
          padding: 14,
          background: theme.chat.background,
          color: theme.text.primary,
          fontFamily: fonts.primary,
          fontSize: fonts.size,
        }}
      >
        <JSXPreview
          jsx={jsx}
          isStreaming={isStreaming}
          components={previewComponents}
          bindings={previewBindings}
        >
          <JSXPreviewContent />
          <JSXPreviewError
            style={{
              padding: isStreaming ? '0' : '10px 12px',
              marginTop: isStreaming ? 0 : 8,
              borderRadius: isStreaming ? 0 : 8,
              border: isStreaming ? 'none' : `1px solid ${theme.border.subtle}`,
              background: isStreaming ? 'transparent' : theme.surface.panel,
              color: theme.text.muted,
              fontSize: Math.max(11, fonts.secondarySize),
              whiteSpace: 'pre-wrap',
            }}
          >
            {(error) => isStreaming
              ? <div style={{ color: theme.text.muted, fontSize: Math.max(11, fonts.secondarySize) }}>Waiting for valid JSX…</div>
              : `Could not render JSX preview: ${error.message}`}
          </JSXPreviewError>
        </JSXPreview>
      </div>

      <details style={{ borderTop: `1px solid ${theme.border.subtle}` }}>
        <summary
          style={{
            cursor: 'pointer',
            listStyle: 'none',
            padding: '10px 12px',
            fontSize: Math.max(11, fonts.secondarySize),
            color: theme.text.muted,
            userSelect: 'none',
          }}
        >
          Show JSX
        </summary>
        <div style={{ padding: '0 12px 12px' }}>
          <pre
            className="allow-text-selection"
            style={{
              margin: 0,
              borderRadius: 8,
              border: `1px solid ${theme.border.subtle}`,
              background: theme.surface.panel,
              color: theme.text.primary,
              padding: 12,
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'IBM Plex Mono, JetBrains Mono, monospace',
              fontSize: Math.max(11, fonts.size - 1),
              lineHeight: 1.55,
            }}
          >
            <code>{jsx.trim()}</code>
          </pre>
        </div>
      </details>
    </div>
  )
}

// ─── Insight block detection ──────────────────────────────────────────────
// The model emits "★ Insight" callouts framed by box-drawing horizontal rules
// (U+2500). Both marker lines are typically wrapped in backticks (so they
// don't disrupt markdown flow), but the backticks can drop during streaming —
// be permissive. We detect the open/close pair and lift the body out so we
// can render it as a single styled block instead of three disjoint inline-code
// runs interleaved with markdown.
type ChatBodySegment =
  | { kind: 'md'; text: string }
  | { kind: 'insight'; text: string; closed: boolean }

// `★ Insight ─────…` — leading backtick optional, trailing backtick optional.
const INSIGHT_OPEN_RE = /^[ \t]*`?★ Insight[ \t]*─{5,}[ \t]*`?[ \t]*$/m
// `─────…` — must be box-drawing rules, optionally backticked. A regular
// markdown `---` HR doesn't match (intentional — we don't want to swallow them).
const INSIGHT_CLOSE_RE = /^[ \t]*`?─{5,}`?[ \t]*$/m

function splitInsightSegments(text: string): ChatBodySegment[] {
  const segments: ChatBodySegment[] = []
  let cursor = 0
  while (cursor < text.length) {
    const slice = text.slice(cursor)
    const openMatch = slice.match(INSIGHT_OPEN_RE)
    if (!openMatch || openMatch.index === undefined) {
      const remaining = text.slice(cursor)
      if (remaining.trim()) segments.push({ kind: 'md', text: remaining })
      break
    }
    const openStart = cursor + openMatch.index
    const openEnd = openStart + openMatch[0].length
    if (openStart > cursor) {
      const before = text.slice(cursor, openStart)
      if (before.trim()) segments.push({ kind: 'md', text: before })
    }
    const afterOpen = text.slice(openEnd)
    const closeMatch = afterOpen.match(INSIGHT_CLOSE_RE)
    if (!closeMatch || closeMatch.index === undefined) {
      // Unclosed — still streaming. Render the partial body as an open insight.
      segments.push({ kind: 'insight', text: afterOpen.replace(/^\n+/, ''), closed: false })
      cursor = text.length
      break
    }
    const bodyEnd = openEnd + closeMatch.index
    const closeEnd = openEnd + closeMatch.index + closeMatch[0].length
    segments.push({
      kind: 'insight',
      text: text.slice(openEnd, bodyEnd).replace(/^\n+/, '').replace(/\n+$/, ''),
      closed: true,
    })
    cursor = closeEnd
    // Eat one trailing newline so the next markdown chunk doesn't start blank.
    if (text[cursor] === '\n') cursor += 1
  }
  return segments
}

// Hex color helper: append an alpha component (00..ff) to a #rrggbb color.
// Used to derive a subtle accent-tinted background from theme.accent.base.
// TODO(design): the styling in InsightBlock below is a sensible default —
// tweak the four marked knobs to match your sketch.
function withAlpha(hex: string, alphaHex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return hex
  return hex + alphaHex
}

interface InsightBlockProps {
  text: string
  closed: boolean
  isStreaming?: boolean
  accent: string
  textColor: string
}

const InsightBlock = React.memo(({ text, closed, isStreaming, accent, textColor }: InsightBlockProps): JSX.Element => {
  void closed
  return (
    <div
      className="chat-insight"
      style={{
        // ── Glass panel in the active accent color ──────────────────────
        // Layered for the "tinted glass" effect:
        //   1. accent-tinted fill at ~14% so the color reads even against
        //      opaque backgrounds (chat surface is theme.surface.panel)
        //   2. backdrop-filter blur softens whatever sits behind
        //   3. hairline accent border at ~30% alpha gives the edge definition
        //      that the removed left rule used to provide
        background: withAlpha(accent, '24'),                          // ~14% tint
        backdropFilter: 'blur(14px) saturate(160%)',
        WebkitBackdropFilter: 'blur(14px) saturate(160%)',
        border: `1px solid ${withAlpha(accent, '4d')}`,               // ~30% accent edge
        borderRadius: 12,                                              // matches code-block radius cohesion
        padding: '12px 16px',
        margin: '10px 0',
        color: textColor,
        // Subtle inner highlight on the top edge — a small touch that
        // sells the "glass" reading without being explicit about it.
        boxShadow: `0 1px 0 0 ${withAlpha(accent, '14')} inset, 0 1px 2px rgba(0,0,0,0.04)`,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: accent,
          marginBottom: 6,
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span style={{ fontSize: 13, lineHeight: 1 }}>★</span>
        <span>Insight</span>
      </div>
      <GuardedChatMarkdown text={text} isStreaming={isStreaming} />
    </div>
  )
})

function LargeTextBlock({ text, isStreaming, className }: {
  text: string
  isStreaming?: boolean
  className?: string
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [expanded, setExpanded] = useState(false)
  const measure = useMemo(() => measureText(text), [text])
  const preview = useMemo(() => previewText(text), [text])

  if (expanded) {
    return (
      <div className={className}>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 8,
            border: `1px solid ${theme.chat.assistantBubbleBorder}`,
            borderRadius: 8,
            background: theme.chat.assistantBubble,
            color: theme.chat.textSecondary,
            padding: '5px 9px',
            fontSize: fonts.secondarySize,
            cursor: 'pointer',
          }}
        >
          <ChevronRight size={12} style={{ transform: 'rotate(90deg)' }} />
          Collapse large message
        </button>
        <ChatMarkdown text={text} isStreaming={isStreaming} />
      </div>
    )
  }

  return (
    <div
      className={className}
      style={{
        border: `1px solid ${theme.chat.assistantBubbleBorder}`,
        borderRadius: 10,
        background: theme.chat.assistantBubble,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${theme.chat.assistantBubbleBorder}` }}>
        <FileText size={13} color={theme.chat.textSecondary} style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1, color: theme.chat.textSecondary, fontSize: fonts.secondarySize, fontWeight: 600 }}>
          Large message - {measure.lines.toLocaleString()} lines - {measure.chars.toLocaleString()} chars
        </div>
        <button
          type="button"
          onClick={() => { void navigator.clipboard.writeText(text).catch(() => {}) }}
          title="Copy full message"
          style={{ border: 'none', background: 'transparent', color: theme.chat.muted, cursor: 'pointer', padding: 4, display: 'inline-flex' }}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          style={{
            border: `1px solid ${theme.chat.assistantBubbleBorder}`,
            borderRadius: 7,
            background: theme.surface.panelMuted,
            color: theme.chat.textSecondary,
            padding: '4px 8px',
            fontSize: fonts.secondarySize,
            cursor: 'pointer',
          }}
        >
          Expand
        </button>
      </div>
      <pre
        className="allow-text-selection"
        style={{
          margin: 0,
          maxHeight: 320,
          overflow: 'auto',
          padding: 10,
          color: theme.chat.text,
          background: theme.surface.panelMuted,
          fontFamily: fonts.mono,
          fontSize: Math.max(10, fonts.size - 2),
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {preview}
      </pre>
    </div>
  )
}

function RawDiffFileBlock({ file }: { file: RawDiffFile }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const [expanded, setExpanded] = useState(false)
  const [renderFull, setRenderFull] = useState(false)
  const large = useMemo(() => isLargeArtifact(file.diff), [file.diff])
  const preview = useMemo(() => previewText(file.diff), [file.diff])

  return (
    <div style={{ borderTop: `1px solid ${theme.chat.assistantBubbleBorder}` }}>
      <button
        type="button"
        onClick={() => setExpanded(value => !value)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          border: 'none',
          background: 'transparent',
          color: theme.chat.textSecondary,
          padding: '7px 10px',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <ChevronRight size={13} style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: fonts.mono, fontSize: Math.max(10, fonts.size - 2) }}>
          {file.path}
        </span>
        <span style={{ color: theme.status.success, fontFamily: fonts.mono, fontSize: 11 }}>+{file.additions}</span>
        <span style={{ color: theme.status.danger, fontFamily: fonts.mono, fontSize: 11 }}>-{file.deletions}</span>
      </button>
      {expanded && (
        <div style={{ padding: '0 10px 10px' }}>
          {large && !renderFull ? (
            <>
              <pre
                className="allow-text-selection"
                style={{
                  margin: 0,
                  maxHeight: 280,
                  overflow: 'auto',
                  borderRadius: 8,
                  background: theme.surface.panelMuted,
                  color: theme.chat.text,
                  padding: 10,
                  fontFamily: fonts.mono,
                  fontSize: Math.max(10, fonts.size - 2),
                  lineHeight: 1.45,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {preview}
              </pre>
              <button
                type="button"
                onClick={() => setRenderFull(true)}
                style={{
                  marginTop: 8,
                  border: `1px solid ${theme.chat.assistantBubbleBorder}`,
                  borderRadius: 7,
                  background: theme.surface.panelMuted,
                  color: theme.chat.textSecondary,
                  padding: '4px 8px',
                  fontSize: fonts.secondarySize,
                  cursor: 'pointer',
                }}
              >
                Render full diff
              </button>
            </>
          ) : (
            <DiffView diff={file.diff} />
          )}
        </div>
      )}
    </div>
  )
}

function RawDiffBlock({ files }: { files: RawDiffFile[] }): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const totals = useMemo(() => files.reduce((acc, file) => ({
    additions: acc.additions + file.additions,
    deletions: acc.deletions + file.deletions,
  }), { additions: 0, deletions: 0 }), [files])
  const raw = useMemo(() => files.map(file => file.diff).join('\n\n'), [files])

  return (
    <div
      style={{
        border: `1px solid ${theme.chat.assistantBubbleBorder}`,
        borderRadius: 12,
        background: theme.chat.assistantBubble,
        overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px' }}>
        <FileText size={13} color={theme.chat.textSecondary} style={{ flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1, color: theme.chat.textSecondary, fontSize: fonts.secondarySize, fontWeight: 600 }}>
          Diff - {files.length} file{files.length === 1 ? '' : 's'}
        </div>
        <span style={{ color: theme.status.success, fontFamily: fonts.mono, fontSize: 11 }}>+{totals.additions}</span>
        <span style={{ color: theme.status.danger, fontFamily: fonts.mono, fontSize: 11 }}>-{totals.deletions}</span>
        <button
          type="button"
          onClick={() => { void navigator.clipboard.writeText(raw).catch(() => {}) }}
          title="Copy raw diff"
          style={{ border: 'none', background: 'transparent', color: theme.chat.muted, cursor: 'pointer', padding: 4, display: 'inline-flex' }}
        >
          <Copy size={13} />
        </button>
      </div>
      {files.map((file, index) => <RawDiffFileBlock key={`${file.path}:${index}`} file={file} />)}
    </div>
  )
}

function looksLikeUnfencedDiff(text: string): boolean {
  const lines = text.split('\n')
  const hasHunk = lines.some(line => /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line.trim()))
  const hasReviewDiffHeader = lines.some(line => /^review diff\s+a\/.+\s+(?:→|->)\s+b\/.+@@/.test(line.trim()))
  const markdownTrapLines = lines.filter(line => /^[+-]\s{2,}\S/.test(line)).length
  return (hasHunk || hasReviewDiffHeader) && markdownTrapLines >= 2
}

function GuardedChatMarkdown({ text, isStreaming, className }: {
  text: string
  isStreaming?: boolean
  className?: string
}): JSX.Element {
  const theme = useTheme()
  const fonts = useAppFonts()
  const diff = useMemo(() => isStreaming ? null : splitRawDiffText(text), [isStreaming, text])

  if (!isStreaming && !diff && looksLikeUnfencedDiff(text)) {
    return (
      <div className={className} style={{ minWidth: 0 }}>
        <pre
          className="allow-text-selection"
          style={{
            margin: 0,
            maxWidth: '100%',
            overflow: 'auto',
            borderRadius: 8,
            background: theme.surface.panelMuted,
            color: theme.chat.text,
            padding: 10,
            fontFamily: fonts.mono,
            fontSize: Math.max(10, fonts.size - 2),
            lineHeight: 1.45,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {text}
        </pre>
      </div>
    )
  }

  if (diff) {
    return (
      <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
        {diff.prefix && (
          isLargeMessage(diff.prefix)
            ? <LargeTextBlock text={diff.prefix} isStreaming={isStreaming} />
            : <ChatMarkdown text={diff.prefix} isStreaming={isStreaming} />
        )}
        <RawDiffBlock files={diff.files} />
      </div>
    )
  }

  if (isLargeMessage(text)) {
    return <LargeTextBlock text={text} isStreaming={isStreaming} className={className} />
  }

  return <ChatMarkdown text={text} isStreaming={isStreaming} className={className} />
}

type ExternalAgentMarkupSegment =
  | { kind: 'md'; text: string }
  | { kind: 'tool'; block: ToolBlock }

function splitExternalAgentMarkup(text: string): ExternalAgentMarkupSegment[] {
  const pattern = /\[external_agent_tool_call:\s*([^\]]+)\]([\s\S]*?)\[\/external_agent_tool_call\]|\[external_agent_tool_result(?::\s*([^\]]+))?\]([\s\S]*?)\[\/external_agent_tool_result\]/g
  const segments: ExternalAgentMarkupSegment[] = []
  let lastIndex = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index == null) continue
    const before = text.slice(lastIndex, match.index)
    if (before) segments.push({ kind: 'md', text: before })
    const callName = (match[1] ?? '').trim()
    const resultLabel = (match[3] ?? '').trim()
    const body = (match[2] ?? match[4] ?? '').trim()
    const isResult = !callName
    const isError = isResult && resultLabel.toLowerCase() === 'error'
    segments.push({
      kind: 'tool',
      block: {
        id: `external-agent-${match.index}-${index++}`,
        name: callName || resultLabel || 'result',
        input: body,
        status: isError ? 'error' : 'done',
      },
    })
    lastIndex = match.index + match[0].length
  }
  const tail = text.slice(lastIndex)
  if (tail) segments.push({ kind: 'md', text: tail })
  return segments.length > 0 ? segments : [{ kind: 'md', text }]
}

function getExternalAgentToolBlocks(text: string): ToolBlock[] {
  return splitExternalAgentMarkup(text)
    .filter((segment): segment is Extract<ExternalAgentMarkupSegment, { kind: 'tool' }> => segment.kind === 'tool')
    .map(segment => segment.block)
}

function isExternalAgentToolOnlyText(text: string): boolean {
  const segments = splitExternalAgentMarkup(text)
  return segments.some(segment => segment.kind === 'tool')
    && segments.every(segment => segment.kind === 'tool' || segment.text.trim().length === 0)
}

const ChatMessageContent = React.memo(({
  text,
  isStreaming,
  isUser,
  className,
  readAttachmentPaths,
}: {
  text: string
  isStreaming?: boolean
  isUser?: boolean
  className?: string
  /** Paths that the model has demonstrably loaded via Read-style tools.
   *  Used to render a confirmation tick on attachment chips — must only be
   *  set when the attachment was actually consumed by the model. */
  readAttachmentPaths?: Set<string>
}) => {
  const theme = useTheme()
  const fonts = useAppFonts()
  const { bodyText, attachmentPaths } = useMemo(() => splitMessageAttachmentPaths(text), [text])
  // JSX preview disabled — was causing render lockups on message history load
  // const bodySegments = useMemo(() => splitRenderableMessageSegments(bodyText, isStreaming), [bodyText, isStreaming])
  // Chip colors must stay legible regardless of whether the parent message
  // bubble is dark (dark theme user bubble) or light (light theme user
  // bubble). In light mode we pick an explicitly-white chip surface with a
  // strong border and a forced-dark text colour so we don't blend into the
  // pale user bubble — previously `theme.surface.panelElevated` was nearly
  // identical to the bubble and child text colours were inheriting light
  // values from elsewhere, producing a "ghost chip" effect.
  void isUser
  const isLight = theme.mode === 'light'
  const chipBackground = isLight ? '#ffffff' : theme.surface.panelElevated
  const chipBorder = isLight ? 'rgba(15,23,42,0.18)' : theme.border.default
  const chipText = isLight ? '#1b2430' : theme.text.primary
  const chipMeta = isLight ? '#2d3748' : theme.text.secondary

  const attachments = attachmentPaths.length > 0 ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: bodyText ? 8 : 0, minWidth: 0 }}>
      {bodyText && (
        <div
          style={{
            fontSize: Math.max(10, fonts.secondarySize - 1),
            color: chipMeta,
            fontWeight: 600,
            letterSpacing: 0.2,
          }}
        >
          Attached file paths
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minWidth: 0 }}>
        {attachmentPaths.map(path => {
          const wasRead = readAttachmentPaths?.has(path) === true
          const isImage = isImagePath(path)
          return (
            <button
              key={path}
              type="button"
              title={wasRead ? `${path} — read by the model` : path}
              onClick={() => { void dispatchOpenLink(path) }}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                minWidth: 0,
                maxWidth: '100%',
                borderRadius: 6,
                border: `1px solid ${chipBorder}`,
                background: chipBackground,
                color: chipText,
                padding: isImage ? 3 : '3px 7px',
                cursor: 'pointer',
              }}
            >
              {isImage ? (
                <img
                  src={`contex-file://${encodeURI(path).replace(/#/g, '%23')}`}
                  alt={basename(path)}
                  style={{
                    width: 28,
                    height: 28,
                    objectFit: 'cover',
                    borderRadius: 4,
                    flexShrink: 0,
                    display: 'block',
                    background: isLight ? '#f5f7fb' : 'rgba(255,255,255,0.04)',
                  }}
                />
              ) : (
                <FileText size={10} color={chipText} style={{ flexShrink: 0, opacity: 0.85 }} />
              )}
              <span
                style={{
                  minWidth: 0,
                  maxWidth: 320,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  fontSize: Math.max(10, fonts.size - 2),
                  lineHeight: 1.2,
                  color: chipText,
                  paddingRight: isImage ? 6 : 0,
                }}
              >
                {basename(path)}
              </span>
              {wasRead && (
                <Check
                  size={10}
                  color={theme.status.success}
                  style={{ flexShrink: 0, marginRight: isImage ? 4 : 0 }}
                  aria-label="Read by the model"
                />
              )}
            </button>
          )
        })}
      </div>
    </div>
  ) : null

  if (!bodyText) return attachments ?? null

  // Split body into markdown / insight segments. Insights become styled
  // blocks rendered with the active accent color; everything else flows
  // through the normal markdown pipeline.
  const accent = theme.accent.base
  const textColor = theme.text.primary
  const externalAgentSegments = useMemo(() => splitExternalAgentMarkup(bodyText), [bodyText])
  const hasExternalAgentMarkup = externalAgentSegments.some(seg => seg.kind === 'tool')
  const segments = useMemo(() => splitInsightSegments(bodyText), [bodyText])
  const renderedBody = hasExternalAgentMarkup
    ? (
      <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
        {(() => {
          const elements: JSX.Element[] = []
          let chipRow: JSX.Element[] = []
          let chipRowStart = 0
          const flushChipRow = () => {
            if (chipRow.length === 0) return
            elements.push(
              <div key={`external-tool-row-${chipRowStart}`} style={CHAT_CHIP_ROW_STYLE}>
                {chipRow}
              </div>
            )
            chipRow = []
          }
          externalAgentSegments.forEach((seg, i) => {
            if (seg.kind === 'tool') {
              if (chipRow.length === 0) chipRowStart = i
              chipRow.push(<ToolBlockView key={seg.block.id} block={seg.block} />)
              return
            }
            if (!seg.text.trim()) return
            flushChipRow()
            elements.push(<GuardedChatMarkdown key={`external-md-${i}`} text={seg.text} isStreaming={isStreaming} />)
          })
          flushChipRow()
          return elements
        })()}
      </div>
    )
    : segments.length === 1 && segments[0].kind === 'md'
      ? <GuardedChatMarkdown text={segments[0].text} isStreaming={isStreaming} className={className} />
      : (
        <div className={className}>
          {segments.map((seg, i) => seg.kind === 'insight'
            ? <InsightBlock key={i} text={seg.text} closed={seg.closed} isStreaming={isStreaming} accent={accent} textColor={textColor} />
            : <GuardedChatMarkdown key={i} text={seg.text} isStreaming={isStreaming} />
          )}
        </div>
      )

  if (!attachments) return renderedBody
  return <>{renderedBody}{attachments}</>
})

// --- Provider / Model config -----------------------------------------------------

interface ProviderEntry {
  id: string
  label: string
  description?: string
  noun: 'model' | 'agent'
  icon: React.ReactNode
  models: ModelOption[]
  kind: 'builtin' | 'extension'
  transport?: ExtensionChatTransportConfig | null
}


const PROVIDER_ICON: Record<BuiltinProvider, React.ReactNode> = {
  claude: <ClaudeIcon size={TOOLBAR_PILL_ICON_SIZE} />,
  codex: <CodexIcon size={TOOLBAR_PILL_ICON_SIZE} />,
  opencode: <Bot size={TOOLBAR_PILL_ICON_SIZE} />,
  openclaw: <OpenClawIcon size={TOOLBAR_PILL_ICON_SIZE} />,
  hermes: <HermesIcon size={TOOLBAR_PILL_ICON_SIZE} />,
}


function getExtensionProviderIcon(icon: ExtensionChatProviderConfig['icon'] | undefined): React.ReactNode {
  switch (icon) {
    case 'server':
      return <ShieldCheck size={TOOLBAR_PILL_ICON_SIZE} />
    case 'plug':
      return <Wrench size={TOOLBAR_PILL_ICON_SIZE} />
    case 'bot':
    default:
      return <Bot size={TOOLBAR_PILL_ICON_SIZE} />
  }
}

function normalizeExtensionModels(value: unknown): ExtensionChatModel[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): ExtensionChatModel[] => {
    if (!item || typeof item !== 'object') return []
    const model = item as Record<string, unknown>
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    const label = typeof model.label === 'string' ? model.label.trim() : id
    if (!id || !label) return []
    return [{
      id,
      label,
      description: typeof model.description === 'string' ? model.description : undefined,
    }]
  })
}

function normalizeExtensionProviders(value: unknown): ExtensionChatProviderConfig[] {
  const rawProviders = Array.isArray(value) ? value : [value]
  return rawProviders.flatMap((item): ExtensionChatProviderConfig[] => {
    if (!item || typeof item !== 'object') return []
    const provider = item as Record<string, unknown>
    const id = typeof provider.id === 'string' ? provider.id.trim() : ''
    const label = typeof provider.label === 'string' ? provider.label.trim() : ''
    const transport = provider.transport
    if (!id || !label || !transport || typeof transport !== 'object') return []

    const transportConfig = transport as Record<string, unknown>
    if (transportConfig.type !== 'local-proxy') return []
    const baseUrl = typeof transportConfig.baseUrl === 'string' ? transportConfig.baseUrl.trim() : ''
    if (!baseUrl) return []

    const models = normalizeExtensionModels(provider.models)
    if (models.length === 0) return []

    return [{
      id,
      label,
      description: typeof provider.description === 'string' ? provider.description : undefined,
      noun: provider.noun === 'agent' ? 'agent' : 'model',
      icon: provider.icon === 'server' || provider.icon === 'plug' || provider.icon === 'bot'
        ? provider.icon
        : undefined,
      models,
      transport: {
        type: 'local-proxy',
        baseUrl,
        apiKey: typeof transportConfig.apiKey === 'string' ? transportConfig.apiKey : undefined,
        autoStart: transportConfig.autoStart === false ? false : true,
      },
    }]
  })
}

// --- Shimmer keyframes (injected once, lifted from Paseo) ------------------------

const SHIMMER_ID = 'chat-tile-shimmer'
function relativeTime(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diff < 5) return 'just now'
  if (diff < 60) return `${diff}s ago`
  const mins = Math.floor(diff / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function ensureChatMdStyle(): void {
  ensureShimmerStyles()
  let style = document.getElementById(SHIMMER_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = SHIMMER_ID
    document.head.appendChild(style)
  }
  style.textContent = `
    /* Hide scrollbar on the messages pane (scroll still works) */
    .chat-messages::-webkit-scrollbar { display: none; }
    /* Chat markdown styles (Streamdown overrides) */
    .chat-md { line-height: 1.55; color: inherit; max-width: 100%; overflow: hidden; }
    .chat-md, .chat-md * { min-width: 0; }
    .chat-md > * { max-width: 100%; }
    .chat-md > *:first-child { margin-top: 0 !important; }
    .chat-md > *:last-child { margin-bottom: 0 !important; }
    .chat-md pre { max-width: 100%; overflow-x: auto; overflow-y: hidden; }
    .chat-md p, .chat-md .chat-md-p { margin: 0 0 8px; }
    .chat-md p:last-child, .chat-md .chat-md-p:last-child { margin-bottom: 0; }
    .chat-md h1 { font-size: 1.3em; font-weight: 700; margin: 12px 0 6px; color: inherit; }
    .chat-md h2 { font-size: 1.15em; font-weight: 600; margin: 10px 0 4px; color: inherit; }
    .chat-md h3 { font-size: 1.05em; font-weight: 600; margin: 8px 0 4px; color: inherit; }
    .chat-md strong { font-weight: 600; }
    .chat-md em { font-style: italic; }
    .chat-md code:not(pre code) {
      background: rgba(128,128,128,0.15); padding: 1px 5px; border-radius: 6px;
      font-family: "JetBrains Mono", "Fira Code", monospace; font-size: 0.88em;
      overflow-wrap: anywhere; word-break: break-word; white-space: normal;
      -webkit-box-decoration-break: clone; box-decoration-break: clone;
    }
    .chat-md pre { margin: 8px 0; border-radius: 12px; overflow: hidden; }
    .chat-md pre:first-child { margin-top: 0; }
    .chat-md pre:last-child { margin-bottom: 0; }
    .chat-md [data-streamdown="code-block"] { max-width: 100%; }
    .chat-md [data-streamdown="code-block-body"] { max-width: 100%; overflow-x: auto; overflow-y: hidden; }
    .chat-md code { max-width: 100%; }
    .chat-md ul, .chat-md ol { padding-left: 18px; margin: 6px 0; }
    .chat-md ul:first-child, .chat-md ol:first-child { margin-top: 0; }
    .chat-md ul:last-child, .chat-md ol:last-child { margin-bottom: 0; }
    .chat-md li { line-height: 1.55; margin-bottom: 2px; }
    .chat-md li > p, .chat-md li > .chat-md-p { margin: 0; }
    .chat-md a,
    .chat-md a:any-link,
    .chat-md a:visited { color: var(--chat-link-color, #4f8cff) !important; opacity: 1; text-decoration: underline; text-underline-offset: 2px; }
    .chat-md a:hover,
    .chat-md a:focus-visible { color: var(--chat-link-hover-color, #77a2ff) !important; opacity: 1; }
    .chat-md blockquote {
      border-left: 3px solid rgba(128,128,128,0.4); padding-left: 10px;
      margin: 6px 0; opacity: 0.85;
    }
    .chat-md hr { border: none; border-top: 1px solid rgba(128,128,128,0.3); margin: 10px 0; }
    .chat-md table {
      display: table; max-width: 100%; overflow: hidden; border-collapse: separate; border-spacing: 0;
      margin: 8px 0; width: 100%; font-size: 0.9em; table-layout: fixed;
      border: 0; border-radius: 0; box-shadow: none;
    }
    .chat-md th, .chat-md td {
      border: 0; padding: 8px 12px; text-align: left; vertical-align: top;
      overflow-wrap: anywhere; word-break: normal;
    }
    .chat-md th {
      font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
      color: var(--color-muted-foreground); background: color-mix(in srgb, var(--color-muted) 62%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--color-muted-foreground) 22%, transparent);
    }
    .chat-md tbody tr + tr td { border-top: 1px solid color-mix(in srgb, var(--color-muted-foreground) 14%, transparent); }
    .chat-md th:first-child, .chat-md td:first-child { width: 22%; min-width: 120px; overflow-wrap: normal; }
  `
}


// --- Component -------------------------------------------------------------------

export function ChatTile({ tileId, workspaceId, workspaceDir: _workspaceDir, width: _width, height: _height, reloadToken = 0, settings, onChatModePreferenceChange, isConnected, isAutoConnected, connectedPeers = [] }: Props): JSX.Element {
  const theme = useTheme()
  const chatViewportBackground = theme.surface.panel
  const composerBackground = theme.mode === 'dark'
    ? theme.chat.input
    : `color-mix(in srgb, ${theme.surface.panelMuted} 82%, ${theme.chat.input})`
  const composerBorder = theme.chat.inputBorder
  const fontSans = settings?.fonts?.primary?.family ?? settings?.primaryFont?.family ?? FONT_SANS
  const fontMono = settings?.fonts?.mono?.family ?? settings?.monoFont?.family ?? FONT_MONO
  const fontSize = settings?.fonts?.primary?.size ?? settings?.primaryFont?.size ?? FONT_SIZE_DEFAULT
  const fontLineHeight = settings?.fonts?.primary?.lineHeight ?? 1.5
  const fontWeight = settings?.fonts?.primary?.weight ?? 400
  const monoSize = settings?.fonts?.mono?.size ?? settings?.monoFont?.size ?? MONO_SIZE_DEFAULT
  const monoLineHeight = settings?.fonts?.mono?.lineHeight ?? 1.5
  const monoWeight = settings?.fonts?.mono?.weight ?? 400
  const fontSecondary = settings?.fonts?.secondary?.family ?? settings?.secondaryFont?.family ?? FONT_SANS
  const secondarySize = settings?.fonts?.secondary?.size ?? 11
  const secondaryLineHeight = settings?.fonts?.secondary?.lineHeight ?? 1.4
  const secondaryWeight = settings?.fonts?.secondary?.weight ?? 400
  const chatSurfaceThemeColors = useMemo(() => ({
    background: theme.surface.panelElevated,
    panel: theme.surface.panelElevated,
    border: theme.border.default,
    text: theme.chat.text,
    muted: theme.chat.muted,
    accent: theme.accent.base,
    mode: theme.mode,
    success: theme.status.success,
    warning: theme.status.warning,
    danger: theme.status.danger,
  }), [theme])
  const chatSurfaceThemeVars = useMemo(() => ({
    '--ct-mode': theme.mode,
    '--ct-bg': 'transparent',
    '--ct-panel': theme.surface.panelElevated,
    '--ct-panel-2': theme.surface.overlay,
    '--ct-border': theme.border.default,
    '--ct-border-2': theme.border.strong,
    '--ct-text': theme.chat.text,
    '--ct-muted': theme.chat.textSecondary,
    '--ct-dim': theme.chat.muted,
    '--ct-hover': theme.surface.hover,
    '--ct-accent': theme.accent.base,
    '--ct-accent-s': theme.accent.soft,
    '--ct-success': theme.status.success,
    '--ct-warning': theme.status.warning,
    '--ct-danger': theme.status.danger,
    '--ct-radius': '8px',
    '--ct-font-primary': fontSans,
    '--ct-font-primary-size': `${fontSize}px`,
    '--ct-font-primary-line': String(fontLineHeight),
    '--ct-font-primary-weight': String(fontWeight),
    '--ct-font-secondary': fontSecondary,
    '--ct-font-secondary-size': `${secondarySize}px`,
    '--ct-font-secondary-line': String(secondaryLineHeight),
    '--ct-font-secondary-weight': String(secondaryWeight),
    '--ct-font-sans': fontSans,
    '--ct-font-mono': fontMono,
    '--ct-font-size': `${fontSize}px`,
    '--ct-font-line': String(fontLineHeight),
    '--ct-font-weight': String(fontWeight),
    '--ct-font-subtle': fontSecondary,
    '--ct-font-subtle-size': `${secondarySize}px`,
    '--ct-font-subtle-line': String(secondaryLineHeight),
    '--ct-font-subtle-weight': String(secondaryWeight),
    '--ct-font-title': fontSans,
    '--ct-font-title-size': `${fontSize}px`,
    '--ct-font-title-weight': String(Math.max(fontWeight, 600)),
  }), [fontLineHeight, fontMono, fontSans, fontSecondary, fontSize, fontWeight, secondaryLineHeight, secondarySize, secondaryWeight, theme])
  const initialRuntimeStateRef = useRef<ChatTilePersistedState | null>(getChatTileRuntimeState<ChatTilePersistedState>(tileId))
  const initialProvider = initialRuntimeStateRef.current?.provider ?? DEFAULT_PROVIDER_ID
  const initialModel = initialRuntimeStateRef.current?.model
    ?? (isBuiltinProvider(initialProvider)
      ? DEFAULT_MODELS[initialProvider][0]?.id
      : DEFAULT_MODELS[DEFAULT_PROVIDER_ID][0]?.id)
    ?? ''
  const initialMode = resolveProviderModeId(
    initialProvider,
    initialRuntimeStateRef.current?.mode ?? settings?.chatProviderModes?.[initialProvider],
  )
  const initialExecutionTarget = initialRuntimeStateRef.current?.executionTarget ?? 'local'
  const initialCloudHostId = initialRuntimeStateRef.current?.cloudHostId ?? null
  const initialJobId = initialRuntimeStateRef.current?.jobId ?? null
  const initialJobSequence = initialRuntimeStateRef.current?.jobSequence ?? 0

  const [messages, setMessages] = useState<ChatMessage[]>(() => initialRuntimeStateRef.current?.messages ?? [])
  const [input, setInput] = useState(() => initialRuntimeStateRef.current?.input ?? '')
  const [isStreaming, setIsStreaming] = useState(() => initialRuntimeStateRef.current?.isStreaming ?? false)
  // Subtle liveness tracking — when streaming, we bump `lastActivityAtRef` on
  // every message/block mutation so the quiet-indicator can show how long the
  // server has been idle without forcing the whole transcript to rerender.
  const lastActivityAtRef = useRef<number>(Date.now())
  // Sparse ticker used only when a just-finished tool crosses the collapse
  // grace window and the chip cluster needs to recompute once.
  const [toolCollapseTick, setToolCollapseTick] = useState(0)
  // Progressive tool-chip collapse: remember when each ToolBlock first
  // flipped to 'done' so we can fold chips into a group summary only after
  // a grace period (keeps just-finished chips readable for a few seconds
  // before they get tucked into "Called N tools"). Populated by an effect
  // that walks messages; cleared when the chip is gone from state.
  const toolCompletedAtRef = useRef<Map<string, number>>(new Map())
  // Inline tool-permission prompts. Keyed by tool_use id.
  // `pending` holds active requests awaiting a user decision.
  // `resolved` holds recently-answered ones so the chip collapses gracefully
  // instead of vanishing the moment the user clicks.
  const [pendingToolPermissions, setPendingToolPermissions] = useState<Map<string, ToolPermissionRequest>>(() => new Map())
  const [resolvedToolPermissions, setResolvedToolPermissions] = useState<Map<string, ToolPermissionDecision>>(() => new Map())
  const handleToolPermissionDecision = useCallback(async (args: { cardId: string; toolId: string; decision: ToolPermissionDecision }) => {
    const res = await window.electron?.chat?.answerToolPermission?.(args)
    return res ?? { ok: true }
  }, [])
  const [executionTarget, setExecutionTarget] = useState<'local' | 'cloud'>(() => initialExecutionTarget)
  const [cloudHostId, setCloudHostId] = useState<string | null>(() => initialCloudHostId)
  const [provider, setProvider] = useState<string>(() => initialProvider)
  const [model, setModel] = useState(() => initialModel)
  const [mcpEnabled, setMcpEnabled] = useState(() => initialRuntimeStateRef.current?.mcpEnabled ?? true)
  const [workspaceSkills, setWorkspaceSkills] = useState<SkillDefinition[]>([])
  const mcpServers = useMCPServers()
  const [disabledServers, setDisabledServers] = useState<Set<string>>(new Set())
  const peerToolNames = useMemo(() => {
    const discovered = new Set<string>()
    const validTool = new Set(getAllNodeTools().map(tool => tool.name))

    for (const peer of connectedPeers) {
      for (const cap of peer.capabilities) {
        if (!cap.startsWith('tool:')) continue
        const toolName = stripCapabilityPrefix(cap)
        if (toolName && validTool.has(toolName)) {
          discovered.add(toolName)
        }
      }
      // Extension actions are not in the static node tool set — include them directly
      if (peer.actions) {
        for (const action of peer.actions) {
          if (action.name) discovered.add(action.name)
        }
      }
    }

    return Array.from(discovered).sort()
  }, [connectedPeers])

  const availableToolInventory = useMemo(() => {
    const items: Array<{ id: string; label: string; source: 'builtin' | 'peer' | 'mcp-server'; detail?: string }> = []
    const seen = new Set<string>()

    for (const tool of getAllNodeTools()) {
      if (seen.has(`builtin:${tool.name}`)) continue
      seen.add(`builtin:${tool.name}`)
      items.push({
        id: `builtin:${tool.name}`,
        label: tool.name,
        source: 'builtin',
        detail: tool.description,
      })
    }

    if (mcpEnabled) {
      for (const server of mcpServers) {
        const key = `mcp-server:${server.name}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
          id: key,
          label: server.name,
          source: 'mcp-server',
          detail: server.url ? 'http server' : 'stdio server',
        })
      }

      for (const toolName of peerToolNames) {
        const key = `peer:${toolName}`
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
          id: key,
          label: toolName,
          source: 'peer',
          detail: 'Connected peer tool',
        })
      }
    }

    return items.sort((a, b) => {
      const sourceOrder = { builtin: 0, peer: 1, 'mcp-server': 2 }
      const sourceDelta = sourceOrder[a.source] - sourceOrder[b.source]
      if (sourceDelta !== 0) return sourceDelta
      return a.label.localeCompare(b.label)
    })
  }, [mcpEnabled, mcpServers, peerToolNames])

  const availableSkillInventory = useMemo(() => {
    const items: Array<{ id: string; name: string; enabled: boolean; source: 'workspace' | 'command'; description?: string }> = []
    const seen = new Set<string>()

    for (const skill of workspaceSkills) {
      const key = `workspace:${skill.name}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        id: skill.id || key,
        name: skill.name,
        enabled: true,
        source: 'workspace',
        description: skill.description,
      })
    }

    for (const command of CHAT_SLASH_COMMANDS) {
      const key = `command:${command.value}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push({
        id: key,
        name: command.value,
        enabled: true,
        source: 'command',
        description: command.description,
      })
    }

    return items.sort((a, b) => {
      const sourceOrder = { workspace: 0, command: 1 }
      const sourceDelta = sourceOrder[a.source] - sourceOrder[b.source]
      if (sourceDelta !== 0) return sourceDelta
      return a.name.localeCompare(b.name)
    })
  }, [workspaceSkills])

  // Track current context values published by peer extension tiles
  const peerContextRef = useRef<Map<string, Record<string, unknown>>>(new Map())
  const [peerContextVersion, setPeerContextVersion] = useState(0)
  const connectedPeerSignature = useMemo(
    () => connectedPeers.map(peer => peer.peerId).sort().join('|'),
    [connectedPeers],
  )
  const implicitPeerImageAttachments = useMemo(
    () => getImplicitPeerImageAttachments(connectedPeers),
    [connectedPeers],
  )

  useEffect(() => {
    if (!workspaceId || connectedPeers.length === 0 || !window.electron?.tileContext) {
      if (peerContextRef.current.size > 0) {
        peerContextRef.current = new Map()
        setPeerContextVersion(v => v + 1)
      }
      return
    }

    let cancelled = false

    void Promise.all(connectedPeers.map(async (peer) => {
      const entries = await window.electron.tileContext.getAll(workspaceId, peer.peerId, 'ctx:')
      return [peer.peerId, Array.isArray(entries) ? entries : []] as const
    })).then((results) => {
      if (cancelled) return
      const next = new Map<string, Record<string, unknown>>()
      for (const [peerId, entries] of results) {
        const values: Record<string, unknown> = {}
        for (const entry of entries) {
          if (!entry || typeof entry !== 'object') continue
          const contextEntry = entry as { key?: unknown; value?: unknown }
          if (typeof contextEntry.key !== 'string') continue
          values[contextEntry.key] = contextEntry.value
        }
        next.set(peerId, values)
      }
      peerContextRef.current = next
      setPeerContextVersion(v => v + 1)
    }).catch(() => {})

    return () => { cancelled = true }
  }, [workspaceId, connectedPeerSignature])

  useEffect(() => {
    if (!window.electron?.bus) return
    const unsubs: Array<() => void> = []

    for (const peer of connectedPeers) {
      const channel = `ctx:${peer.peerId}`
      const subscriberId = `chat:${tileId}:peer-ctx:${peer.peerId}`
      const unsubscribe = window.electron.bus.subscribe(channel, subscriberId, (event: any) => {
        const p = event?.payload ?? event
        if (p?.action === 'context_changed' && p.key) {
          const existing = peerContextRef.current.get(peer.peerId) ?? {}
          peerContextRef.current.set(peer.peerId, { ...existing, [p.key]: p.value })
          setPeerContextVersion(v => v + 1)
        }
      })
      if (typeof unsubscribe === 'function') unsubs.push(unsubscribe)
    }

    return () => { for (const u of unsubs) u() }
  }, [connectedPeerSignature, tileId])
  const [mode, setMode] = useState(() => initialMode)
  // Tracks the permission mode we last pushed to the running Claude query so
  // user-initiated mid-stream mode switches (Default -> Bypass etc.) propagate
  // into the active canUseTool closure via chat:setPermissionMode.
  const lastPushedModeRef = useRef<string>(initialMode)
  const [thinking, setThinking] = useState(() => initialRuntimeStateRef.current?.thinking ?? 'adaptive')
  const [autoAgentMode, setAutoAgentMode] = useState(() => initialRuntimeStateRef.current?.autoAgentMode ?? false)
  const effectiveAgentMode = Boolean(isConnected || isAutoConnected || autoAgentMode)
  const [showModelMenu, setShowModelMenu] = useState(false)
  const [showProviderMenu, setShowProviderMenu] = useState(false)
  const [showInsertMenu, setShowInsertMenu] = useState(false)
  const [showModeMenu, setShowModeMenu] = useState(false)
  const [showThinkingMenu, setShowThinkingMenu] = useState(false)
  const [showLocationMenu, setShowLocationMenu] = useState(false)
  const [showBranchMenu, setShowBranchMenu] = useState(false)
  const [showContextMenu, setShowContextMenu] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(() => initialRuntimeStateRef.current?.sessionId ?? null)
  const [linkedSessionEntryId, setLinkedSessionEntryId] = useState<string | null>(() => initialRuntimeStateRef.current?.linkedSessionEntryId ?? null)
  const [linkedSessionHint, setLinkedSessionHint] = useState<SessionEntryHint | null>(() => initialRuntimeStateRef.current?.linkedSessionHint ?? null)
  const [preserveSessionSummary, setPreserveSessionSummary] = useState<boolean>(() => initialRuntimeStateRef.current?.preserveSessionSummary === true)
  const [hasEarlierMessages, setHasEarlierMessages] = useState<boolean>(() => initialRuntimeStateRef.current?.hasEarlierMessages === true)
  const pagedLinkedHistoryEnabled = canUsePagedLinkedHistory(linkedSessionEntryId, linkedSessionHint, sessionId)

  // Publish this tile's streaming state so the sidebar can swap the row icon
  // for a spinner while the thread is active.
  useEffect(() => {
    setChatStreaming(tileId, isStreaming, { sessionId, entryId: linkedSessionEntryId })
    return () => { setChatStreaming(tileId, false) }
  }, [tileId, isStreaming, sessionId, linkedSessionEntryId])
  // Older messages are loaded on demand and prepended into the same transcript
  // list. They stay out of the live model context and persistence hot path,
  // but render with the normal chat UI once loaded.
  const [historicalMessages, setHistoricalMessages] = useState<ChatMessage[]>([])
  const [visibleMessageLimit, setVisibleMessageLimit] = useState(CHAT_INITIAL_RENDER_WINDOW)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierLoadError, setEarlierLoadError] = useState<string | null>(null)
  const pendingHistoryPrependRef = useRef<{ previousHeight: number; previousTop: number } | null>(null)
  const loadEarlierMessagesRef = useRef<() => Promise<void>>(async () => {})
  const [jobId, setJobId] = useState<string | null>(() => initialJobId)
  const [jobSequence, setJobSequence] = useState<number>(() => initialJobSequence)
  const [executionHosts, setExecutionHosts] = useState<import('../../../shared/types').ExecutionHostRecord[]>([])
  const [localExecutionLabel, setLocalExecutionLabel] = useState('Local')
  const [opencodeModels, setOpencodeModels] = useState<ModelOption[]>(DEFAULT_MODELS.opencode)
  const [openclawAgents, setOpenclawAgents] = useState<ModelOption[]>(DEFAULT_MODELS.openclaw)
  const [modelFilter, setModelFilter] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>(() => initialRuntimeStateRef.current?.attachments ?? [])
  const hasSendableDraft = input.trim().length > 0 || attachments.length > 0 || implicitPeerImageAttachments.length > 0
  // Chat-surface extensions (e.g. Sketch, Builder) mounted above the composer.
  // Multiple surfaces can stay open as tabs so a sketch can sit beside its
  // enhanced builder output inside the same chat.
  const [openChatSurfaces, setOpenChatSurfaces] = useState<ActiveChatSurface[]>(() => normalizePersistedChatSurfaces(initialRuntimeStateRef.current?.openChatSurfaces))
  const [activeChatSurfaceId, setActiveChatSurfaceId] = useState<string | null>(() => initialRuntimeStateRef.current?.activeChatSurfaceId ?? null)
  const [chatSurfaceMenu, setChatSurfaceMenu] = useState<ChatSurfaceMenuEntry[]>([])
  const openChatSurfacesRef = useRef<ActiveChatSurface[]>([])
  useEffect(() => { openChatSurfacesRef.current = openChatSurfaces }, [openChatSurfaces])
  const activeChatSurface = useMemo(
    () => openChatSurfaces.find(surface => surface.instanceId === activeChatSurfaceId) ?? openChatSurfaces[openChatSurfaces.length - 1] ?? null,
    [activeChatSurfaceId, openChatSurfaces],
  )
  const activeChatSurfaceRef = useRef<ActiveChatSurface | null>(null)
  useEffect(() => { activeChatSurfaceRef.current = activeChatSurface }, [activeChatSurface])
  const chatSurfaceIframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({})
  const pendingChatSurfaceActionResultsRef = useRef(new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>())
  const setChatSurfaceIframeRef = useCallback((instanceId: string, node: HTMLIFrameElement | null) => {
    if (node) chatSurfaceIframeRefs.current[instanceId] = node
    else delete chatSurfaceIframeRefs.current[instanceId]
  }, [])
  const getChatSurfaceIframe = useCallback((instanceId: string): HTMLIFrameElement | null => chatSurfaceIframeRefs.current[instanceId] ?? null, [])
  const postToChatSurface = useCallback((instanceId: string, payload: Record<string, unknown>) => {
    getChatSurfaceIframe(instanceId)?.contentWindow?.postMessage(payload, '*')
  }, [getChatSurfaceIframe])
  const getChatSurfacePeerEntries = useCallback((surfaceId: string) => {
    return openChatSurfacesRef.current
      .filter(surface => surface.instanceId !== surfaceId)
      .map(surface => ({
        peerId: surface.instanceId,
        label: surface.label,
        contextEntries: Object.entries(surface.context ?? {}).map(([key, value]) => ({ key, value })),
      }))
  }, [])
  useEffect(() => {
    if (openChatSurfaces.length === 0) {
      if (activeChatSurfaceId !== null) setActiveChatSurfaceId(null)
      return
    }
    if (!openChatSurfaces.some(surface => surface.instanceId === activeChatSurfaceId)) {
      setActiveChatSurfaceId(openChatSurfaces[openChatSurfaces.length - 1]?.instanceId ?? null)
    }
  }, [activeChatSurfaceId, openChatSurfaces])
  const [queuedTurns, setQueuedTurns] = useState<QueuedChatTurn[]>(() => initialRuntimeStateRef.current?.queuedTurns ?? [])
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
  const prevQueuedCountRef = useRef(0)
  const [isDropTarget, setIsDropTarget] = useState(false)
  const [showScrollToLatest, setShowScrollToLatest] = useState(false)
  const [branchFilter, setBranchFilter] = useState('')
  const [gitStatus, setGitStatus] = useState<GitStatusSummary>(() => getCachedGitState(_workspaceDir)?.status ?? createEmptyGitState(_workspaceDir).status)
  const [gitBranches, setGitBranches] = useState<GitBranchSummary>(() => getCachedGitState(_workspaceDir)?.branches ?? createEmptyGitState(_workspaceDir).branches)
  const pagedLinkedHistoryEnabledRef = useRef(pagedLinkedHistoryEnabled)
  pagedLinkedHistoryEnabledRef.current = pagedLinkedHistoryEnabled
  const isStreamingRef = useRef(false)
  const setMessagesSafe = useCallback((updater: React.SetStateAction<ChatMessage[]>) => {
    setMessages(prev => {
      const next = typeof updater === 'function'
        ? (updater as (prev: ChatMessage[]) => ChatMessage[])(prev)
        : updater
      if (pagedLinkedHistoryEnabledRef.current) return next
      // During streaming, skip expensive normalization for text-only appends
      // (same message count, last message still streaming). Normalize once
      // when streaming ends or message count changes.
      if (isStreamingRef.current && next.length === prev.length && next[next.length - 1]?.isStreaming) {
        return next
      }
      return normalizeMessagesForMemory(next)
    })
  }, [])
  const pendingStreamTextRef = useRef('')
  const pendingStreamFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushPendingStreamText = useCallback(() => {
    const text = pendingStreamTextRef.current
    if (!text) return
    pendingStreamTextRef.current = ''
    setMessagesSafe(prev => {
      const last = prev[prev.length - 1]
      if (!last?.isStreaming) return prev
      const blocks = [...(last.contentBlocks ?? [])]
      const lastBlock = blocks[blocks.length - 1]
      if (lastBlock?.type === 'text') {
        blocks[blocks.length - 1] = { ...lastBlock, text: lastBlock.text + text }
      } else {
        blocks.push({ type: 'text', text })
      }
      return [...prev.slice(0, -1), { ...last, content: last.content + text, contentBlocks: blocks }]
    })
  }, [setMessagesSafe])
  const queueStreamText = useCallback((text: string) => {
    if (!text) return
    pendingStreamTextRef.current += text
    if (pendingStreamFlushTimerRef.current) return
    pendingStreamFlushTimerRef.current = setTimeout(() => {
      pendingStreamFlushTimerRef.current = null
      flushPendingStreamText()
    }, CHAT_STREAM_FLUSH_INTERVAL_MS)
  }, [flushPendingStreamText])
  const stateLoadedRef = useRef(false)
  const lastJobSequenceRef = useRef<number>(initialJobSequence)
  const resumedJobKeyRef = useRef<string | null>(null)

  useEffect(() => {
    return () => {
      if (pendingStreamFlushTimerRef.current) {
        clearTimeout(pendingStreamFlushTimerRef.current)
        pendingStreamFlushTimerRef.current = null
      }
      pendingStreamTextRef.current = ''
    }
  }, [])

  useEffect(() => {
    lastJobSequenceRef.current = jobSequence
  }, [jobSequence])

  useEffect(() => {
    if (!jobId) {
      resumedJobKeyRef.current = null
    }
  }, [jobId])
  const latestStateRef = useRef<ChatTilePersistedState | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestedProviderOptionsRef = useRef<{ opencode: boolean; openclaw: boolean }>({ opencode: false, openclaw: false })
  const isFlushingQueuedTurnRef = useRef(false)

  // Voice dictation state.
  // `isDictating` here means "VAD listening mode is on" — the mic is open
  // and we're auto-detecting utterances. `isSpeaking` (from the VAD hook)
  // means "an utterance is currently in progress". Together they drive the
  // visual indicator: muted when off, pulsing red while speaking, soft
  // accent while listening but silent.
  const [isDictating, setIsDictating] = useState(false)
  const [dictationText, setDictationText] = useState('')
  const [dictationError, setDictationError] = useState<string | null>(null)
  // Kept around for the legacy MediaRecorder fallback path; not used when
  // the VAD path is active (which is the new default).
  const recognitionRef = useRef<any>(null)
  // Most-recent transcription job id, so concurrent VAD-triggered
  // transcriptions don't append out of order.
  const transcribeJobRef = useRef(0)

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
  // Ref so memoized callbacks (toggleDictation) always read the current
  // voice settings without needing them in their dep array (settings change
  // mid-dictation is rare but should be honored on next press).
  const voiceSettingsRef = useRef(voiceSettings)
  voiceSettingsRef.current = voiceSettings
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

  // Autocomplete state
  const [acType, setAcType] = useState<'slash' | 'mention' | null>(null)
  const [acQuery, setAcQuery] = useState('')
  const [acIndex, setAcIndex] = useState(0)

  const messagesRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  // Previous scrollTop, used by handleMessagesScroll to detect scroll direction.
  // Any user scroll toward the top releases stickToBottomRef immediately, so
  // auto-pin can't fight the user while they're reading history during streaming.
  const lastScrollTopRef = useRef<number>(0)
  const showScrollToLatestRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const acRef = useRef<HTMLDivElement>(null)
  const modelMenuRef = useRef<HTMLDivElement>(null)
  const providerMenuRef = useRef<HTMLDivElement>(null)
  const insertMenuRef = useRef<HTMLDivElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const thinkingMenuRef = useRef<HTMLDivElement>(null)
  const locationMenuRef = useRef<HTMLDivElement>(null)
  const branchMenuRef = useRef<HTMLDivElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const latestGitWorkspaceKeyRef = useRef(normalizeGitWorkspaceKey(_workspaceDir))

  const loadEarlierMessages = useCallback(async () => {
    if (!pagedLinkedHistoryEnabled || !workspaceId || !linkedSessionEntryId || !hasEarlierMessages || loadingEarlier) return
    const api = window.electron?.chat?.loadSessionHistory
    if (typeof api !== 'function') {
      setEarlierLoadError('History loader unavailable')
      return
    }

    const oldestLoadedMessage = historicalMessages[0] ?? messages[0] ?? null
    const beforeFingerprint = oldestLoadedMessage
      ? buildChatMessageHistoryFingerprint(oldestLoadedMessage)
      : null
    const scroller = messagesRef.current
    if (scroller) {
      pendingHistoryPrependRef.current = {
        previousHeight: scroller.scrollHeight,
        previousTop: scroller.scrollTop,
      }
    }

    setLoadingEarlier(true)
    setEarlierLoadError(null)
    try {
      const res = await api({
        workspaceId,
        sessionEntryId: linkedSessionEntryId,
        entryHint: linkedSessionHint ?? null,
        beforeFingerprint,
        limit: LINKED_SESSION_HISTORY_PAGE_SIZE,
      })
      if (!res?.ok || !Array.isArray(res.messages)) {
        setEarlierLoadError(res?.error || 'Could not load earlier messages')
        pendingHistoryPrependRef.current = null
        return
      }
      const liveFingerprints = new Set(messages.map(message => buildChatMessageHistoryFingerprint(message)))
      const olderPage = (res.messages as ChatMessage[]).filter(message => !liveFingerprints.has(buildChatMessageHistoryFingerprint(message)))
      if (olderPage.length === 0) {
        pendingHistoryPrependRef.current = null
      } else {
        setHistoricalMessages(prev => mergeHistoricalMessages(prev, olderPage))
      }
      setHasEarlierMessages(res.hasMore === true)
    } catch (err: any) {
      pendingHistoryPrependRef.current = null
      setEarlierLoadError(String(err?.message ?? err ?? 'Load failed'))
    } finally {
      setLoadingEarlier(false)
    }
  }, [pagedLinkedHistoryEnabled, workspaceId, linkedSessionEntryId, linkedSessionHint, hasEarlierMessages, loadingEarlier, historicalMessages, messages])

  useEffect(() => {
    loadEarlierMessagesRef.current = loadEarlierMessages
  }, [loadEarlierMessages])

  // Slash commands (built-in) + discovered skills (workspaceSkills already
  // covers `.claude/commands`, `.claude/skills`, OpenCode skills, Cursor rules,
  // and plugin-namespaced commands picked up from CHAT_DEFAULT_SKILL_LOCATIONS).
  const SLASH_COMMANDS = CHAT_SLASH_COMMANDS

  // Workspace file index for `@` mentions. Built once per workspace via a
  // bounded recursive readDir; skips dot-folders and the usual heavy build
  // artifact dirs so a typical repo stays under a few thousand entries.
  const [workspaceFiles, setWorkspaceFiles] = useState<Array<{ path: string; relPath: string; name: string; depth: number }>>([])
  useEffect(() => {
    let cancelled = false
    const root = _workspaceDir?.trim() || ''
    if (!root) {
      setWorkspaceFiles([])
      return () => { cancelled = true }
    }

    const SKIP_DIRS = new Set([
      'node_modules', 'dist', 'build', 'out', 'target', 'coverage',
      '.git', '.next', '.turbo', '.cache', '.parcel-cache', '.vercel',
      '.nuxt', '.svelte-kit', '.angular', '.expo', '.terraform',
      'build-electrobun', 'dist-electron', '__pycache__', '.venv', 'venv',
    ])
    const MAX_FILES = 5000
    const MAX_DEPTH = 4

    ;(async () => {
      const collected: Array<{ path: string; relPath: string; name: string; depth: number }> = []
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (cancelled || collected.length >= MAX_FILES || depth > MAX_DEPTH) return
        const entries: Array<{ name: string; path: string; isDir: boolean; ext: string }> = await window.electron.fs.readDir(dir).catch(() => [])
        for (const entry of entries) {
          if (cancelled || collected.length >= MAX_FILES) return
          if (entry.name.startsWith('.') && depth === 0) continue
          if (entry.isDir) {
            if (SKIP_DIRS.has(entry.name)) continue
            if (entry.name.startsWith('.') && entry.name !== '.claude') continue
            await walk(entry.path, depth + 1)
            continue
          }
          const relPath = getRelativeMentionPath(entry.path, root)
          collected.push({ path: entry.path, relPath, name: entry.name, depth })
        }
      }
      await walk(root, 0)
      if (!cancelled) setWorkspaceFiles(collected)
    })().catch(() => { if (!cancelled) setWorkspaceFiles([]) })

    return () => { cancelled = true }
  }, [_workspaceDir])

  const mentionItems = useMemo<AutocompleteItem[]>(() => {
    const query = acQuery.trim().toLowerCase()
    const seenPaths = new Set<string>()
    const connectedFileItems: AutocompleteItem[] = []

    for (const peer of connectedPeers) {
      if (!peer.filePath || seenPaths.has(peer.filePath)) continue
      seenPaths.add(peer.filePath)

      const mentionPath = getRelativeMentionPath(peer.filePath, _workspaceDir)
      const searchText = [
        mentionPath,
        peer.filePath,
        peer.label ?? '',
        peer.peerType,
      ].join('\n').toLowerCase()

      if (query && !searchText.includes(query)) continue

      connectedFileItems.push({
        key: `connected-file:${peer.peerId}:${peer.filePath}`,
        value: `@${mentionPath}`,
        description: `Connected ${peer.peerType} · ${mentionPath}`,
        attachPath: peer.filePath,
        priority: peer.distance,
      })
    }

    connectedFileItems.sort((a, b) => {
      const priorityDelta = (a.priority ?? 0) - (b.priority ?? 0)
      if (priorityDelta !== 0) return priorityDelta
      return a.value.localeCompare(b.value)
    })

    const existingValues = new Set(connectedFileItems.map(item => item.value.toLowerCase()))

    // Real workspace file results. Rank by: basename-prefix > basename-contains
    // > path-contains, then by directory depth (shallower first), then
    // alphabetical. Cap the dropdown so we never paint thousands of rows.
    const FILE_RESULT_LIMIT = 40
    const fileItems: Array<AutocompleteItem & { rank: number }> = []
    if (workspaceFiles.length > 0) {
      for (const file of workspaceFiles) {
        const value = `@${file.relPath}`
        if (existingValues.has(value.toLowerCase())) continue
        const nameLower = file.name.toLowerCase()
        const relLower = file.relPath.toLowerCase()
        let rank = -1
        if (!query) rank = 2
        else if (nameLower.startsWith(query)) rank = 0
        else if (nameLower.includes(query)) rank = 1
        else if (relLower.includes(query)) rank = 2
        if (rank < 0) continue
        fileItems.push({
          key: `workspace-file:${file.path}`,
          value,
          description: file.relPath,
          attachPath: file.path,
          priority: rank * 100 + file.depth,
          rank,
        })
      }
      fileItems.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank
        if ((a.priority ?? 0) !== (b.priority ?? 0)) return (a.priority ?? 0) - (b.priority ?? 0)
        return a.value.localeCompare(b.value)
      })
    }

    return [...connectedFileItems, ...fileItems.slice(0, FILE_RESULT_LIMIT).map(({ rank: _rank, ...rest }) => rest)]
  }, [acQuery, connectedPeers, _workspaceDir, workspaceFiles])

  const slashItems = useMemo<AutocompleteItem[]>(() => {
    const q = acQuery.toLowerCase()
    const seen = new Set<string>()
    const items: AutocompleteItem[] = []

    for (const command of SLASH_COMMANDS) {
      if (!command.value.toLowerCase().startsWith('/' + q)) continue
      if (seen.has(command.value)) continue
      seen.add(command.value)
      items.push({ key: `slash:${command.value}`, value: command.value, description: command.description })
    }

    // Discovered skills/commands. Skill `command` is the slash trigger
    // (e.g. `cleanup` → `/cleanup`); fall back to `name` when absent.
    for (const skill of workspaceSkills) {
      const trigger = (skill.command || skill.name || '').trim()
      if (!trigger) continue
      const value = '/' + trigger.replace(/^\/+/, '')
      if (seen.has(value)) continue
      if (!value.toLowerCase().startsWith('/' + q)) continue
      seen.add(value)
      items.push({
        key: `skill:${skill.id || value}`,
        value,
        description: skill.description?.trim() || `Skill · ${skill.name}`,
      })
    }

    return items
  }, [acQuery, SLASH_COMMANDS, workspaceSkills])

  const acItems: AutocompleteItem[] = acType === 'slash'
    ? slashItems
    : acType === 'mention'
      ? mentionItems
      : []

  const renderedMessages = useMemo(() => {
    // Dedupe by message ID when combining historical (session-restore) with
    // live messages. Live wins — it has the freshest streaming state. Without
    // this, an overlapping claude-N id from both sources triggers React's
    // "two children with the same key" warning.
    let combined: ChatMessage[]
    if (historicalMessages.length > 0) {
      const liveIds = new Set(messages.map(m => m.id))
      combined = [
        ...historicalMessages.filter(m => !liveIds.has(m.id)),
        ...messages,
      ]
    } else {
      combined = messages
    }

    if (combined.length <= visibleMessageLimit) return combined
    return combined.slice(-visibleMessageLimit)
  }, [historicalMessages, messages, visibleMessageLimit])

  const mergeDrawerFileChanges = useCallback((fileChanges: FileChange[]): FileChange[] => {
    const merged = new Map<string, FileChange>()
    for (const change of fileChanges) {
      const key = `${change.path}::${change.previousPath ?? ''}::${change.changeType}`
      const existing = merged.get(key)
      if (!existing) {
        merged.set(key, { ...change })
        continue
      }
      existing.additions += change.additions
      existing.deletions += change.deletions
      existing.diff = `${existing.diff}\n\n${change.diff}`.trim()
    }
    return Array.from(merged.values())
  }, [])

  const hiddenMessageCount = Math.max(0, historicalMessages.length + messages.length - renderedMessages.length)
  const latestChangeDrawer = useMemo<LatestChangeDrawerState | null>(() => {
    const batchMessages: ChatMessage[] = []
    for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = messages[messageIndex]
      if (message.role === 'user') break
      batchMessages.unshift(message)
    }
    if (batchMessages.length === 0) return null

    const rawFileChanges: FileChange[] = []
    let latestMessageId: string | null = null
    let latestToolBlockId: string | null = null
    let changeBlockCount = 0

    for (const message of batchMessages) {
      for (const block of message.toolBlocks ?? []) {
        const fileChanges = block.fileChanges ?? []
        if (fileChanges.length === 0) continue
        changeBlockCount += 1
        rawFileChanges.push(...fileChanges)
        latestMessageId = message.id
        latestToolBlockId = block.id
      }
    }

    if (rawFileChanges.length === 0 || !latestMessageId || !latestToolBlockId) return null

    const fileChanges = mergeDrawerFileChanges(rawFileChanges)
    return {
      key: `${latestMessageId}:${latestToolBlockId}:${changeBlockCount}:${fileChanges.length}`,
      messageId: latestMessageId,
      toolBlockId: latestToolBlockId,
      fileChanges,
      fileCount: fileChanges.length,
      additions: fileChanges.reduce((sum, change) => sum + change.additions, 0),
      deletions: fileChanges.reduce((sum, change) => sum + change.deletions, 0),
      changeBlockCount,
    }
  }, [messages, mergeDrawerFileChanges])
  const latestChangeDrawerHasStats = latestChangeDrawer ? hasVisibleFileChangeStats(latestChangeDrawer) : false
  const liveComposerActivityChip = useMemo(() => {
    if (!isStreaming) return null
    const liveMsg = renderedMessages[renderedMessages.length - 1]
    if (!liveMsg || liveMsg.role !== 'assistant' || !liveMsg.isStreaming) return null

    const activeThinking = liveMsg.thinkingBlocks?.find(tb => !tb.done)
      ?? (!(liveMsg.contentBlocks ?? []).some(b => b.type === 'thinking') && liveMsg.thinking && !liveMsg.thinking.done
        ? liveMsg.thinking
        : null)

    return (
      <div style={{
        width: CHAT_COMPOSER_WIDTH,
        minWidth: CHAT_COMPOSER_MIN_WIDTH_STYLE,
        margin: '0 auto',
        paddingTop: 4,
        paddingBottom: 4,
        position: 'relative',
        zIndex: 2,
      }}>
        {activeThinking
          ? <ThinkingBlockView thinking={activeThinking} />
          : <WorkingChipView message={liveMsg} />
        }
      </div>
    )
  }, [isStreaming, renderedMessages])
  const [latestChangeDrawerExpanded, setLatestChangeDrawerExpanded] = useState(false)
  const [latestChangeDrawerExpandedFiles, setLatestChangeDrawerExpandedFiles] = useState<Record<string, boolean>>({})
  const [latestCheckpointId, setLatestCheckpointId] = useState<string | null>(null)
  const [isRestoringLatestCheckpoint, setIsRestoringLatestCheckpoint] = useState(false)
  const [restoringCheckpointId, setRestoringCheckpointId] = useState<string | null>(null)

  useEffect(() => {
    if (!latestChangeDrawer) {
      setLatestCheckpointId(null)
      return
    }

    // Default the drawer to collapsed whenever a new change block arrives
    // (including on initial mount / reload). Users can expand on demand.
    setLatestChangeDrawerExpanded(false)
    setLatestChangeDrawerExpandedFiles({})
  }, [latestChangeDrawer?.key])

  useEffect(() => {
    let cancelled = false
    if (!workspaceId || !latestChangeDrawer) {
      setLatestCheckpointId(null)
      return
    }

    void window.electron.canvas
      .listCheckpoints(workspaceId, `codesurf-runtime:${tileId}`)
      .then(checkpoints => {
        if (cancelled) return
        const undoIndex = Math.max(0, (latestChangeDrawer.changeBlockCount ?? 1) - 1)
        setLatestCheckpointId(checkpoints[undoIndex]?.id ?? checkpoints[0]?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setLatestCheckpointId(null)
      })

    return () => { cancelled = true }
  }, [workspaceId, tileId, latestChangeDrawer?.key])

  const toggleLatestChangeDrawerFile = useCallback((key: string) => {
    setLatestChangeDrawerExpandedFiles(prev => ({ ...prev, [key]: !(prev[key] ?? false) }))
  }, [])

  const restoreLatestCheckpoint = useCallback(async () => {
    if (!workspaceId || !latestCheckpointId || isRestoringLatestCheckpoint) return
    setIsRestoringLatestCheckpoint(true)
    try {
      const result = await window.electron.canvas.restoreCheckpoint(workspaceId, latestCheckpointId, `codesurf-runtime:${tileId}`)
      if (!result.ok) {
        const errorText = result.error ?? 'Checkpoint restore failed'
        setMessagesSafe(prev => [...prev, {
          id: `msg-restore-checkpoint-error-${Date.now()}`,
          role: 'assistant',
          content: `Undo failed: ${errorText}`,
          timestamp: Date.now(),
        }])
        return
      }
      const restoredParts: string[] = []
      if (typeof result.filesRestored === 'number' && result.filesRestored > 0) {
        restoredParts.push(`${result.filesRestored} restored`)
      }
      if (typeof result.filesDeleted === 'number' && result.filesDeleted > 0) {
        restoredParts.push(`${result.filesDeleted} deleted`)
      }
      const suffix = restoredParts.length > 0 ? ` (${restoredParts.join(', ')})` : ''
      setMessagesSafe(prev => [...prev, {
        id: `msg-restore-checkpoint-${Date.now()}`,
        role: 'assistant',
        content: `Restored the latest checkpoint before those changes${suffix}.`,
        timestamp: Date.now(),
      }])
      setLatestCheckpointId(null)
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      setMessagesSafe(prev => [...prev, {
        id: `msg-restore-checkpoint-error-${Date.now()}`,
        role: 'assistant',
        content: `Undo failed: ${errorText}`,
        timestamp: Date.now(),
      }])
    } finally {
      setIsRestoringLatestCheckpoint(false)
    }
  }, [workspaceId, tileId, latestCheckpointId, isRestoringLatestCheckpoint, setMessagesSafe])

  const restoreCheckpointFromToolBlock = useCallback(async (checkpointId: string, sessionEntryId: string, label = 'checkpoint') => {
    if (!workspaceId || !checkpointId || !sessionEntryId || restoringCheckpointId || isRestoringLatestCheckpoint) return
    setRestoringCheckpointId(checkpointId)
    try {
      const result = await window.electron.canvas.restoreCheckpoint(workspaceId, checkpointId, sessionEntryId)
      if (!result.ok) {
        const errorText = result.error ?? 'Checkpoint restore failed'
        setMessagesSafe(prev => [...prev, {
          id: `msg-restore-checkpoint-error-${Date.now()}`,
          role: 'assistant',
          content: `Restore failed: ${errorText}`,
          timestamp: Date.now(),
        }])
        return
      }
      const restoredParts: string[] = []
      if (typeof result.filesRestored === 'number' && result.filesRestored > 0) {
        restoredParts.push(`${result.filesRestored} restored`)
      }
      if (typeof result.filesDeleted === 'number' && result.filesDeleted > 0) {
        restoredParts.push(`${result.filesDeleted} deleted`)
      }
      const suffix = restoredParts.length > 0 ? ` (${restoredParts.join(', ')})` : ''
      setMessagesSafe(prev => [...prev, {
        id: `msg-restore-checkpoint-${Date.now()}`,
        role: 'assistant',
        content: `Restored checkpoint: ${label}${suffix}.`,
        timestamp: Date.now(),
      }])
      if (latestCheckpointId === checkpointId) setLatestCheckpointId(null)
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      setMessagesSafe(prev => [...prev, {
        id: `msg-restore-checkpoint-error-${Date.now()}`,
        role: 'assistant',
        content: `Restore failed: ${errorText}`,
        timestamp: Date.now(),
      }])
    } finally {
      setRestoringCheckpointId(current => current === checkpointId ? null : current)
    }
  }, [workspaceId, restoringCheckpointId, isRestoringLatestCheckpoint, latestCheckpointId, setMessagesSafe])

  const checkpointRestoreContextValue = useMemo<CheckpointRestoreContextValue>(() => ({
    workspaceId: workspaceId ?? null,
    tileId,
    restoringCheckpointId,
    restoreCheckpoint: restoreCheckpointFromToolBlock,
  }), [workspaceId, tileId, restoringCheckpointId, restoreCheckpointFromToolBlock])

  // Dream completion → synthetic chip in chat history.
  //
  // Polls the daemon summary every 5s. When the workspace's `lastRun.completedAt`
  // advances to a value we haven't seen yet (and the run succeeded), append a
  // single ChatMessage carrying a 'Dream completed' tool block. This appears
  // inline with the rest of history, scrolls with it, and persists to canvas
  // state alongside any other message — same lifecycle as a checkpoint chip.
  //
  // The first poll after mount seeds the "last seen" ref without injecting a
  // chip, so reopening a tile doesn't dump every historical dream into the
  // transcript. Only completions that happen *while the tile is open* show up.
  const lastSeenDreamCompletionRef = useRef<string | null>(null)
  const dreamPollSeededRef = useRef(false)
  useEffect(() => {
    if (!workspaceId) return
    let cancelled = false

    const poll = async () => {
      try {
        const summary = await window.electron.system.daemonSummary()
        if (cancelled) return
        const lastRun = summary?.dreaming?.lastRun
        if (!lastRun) return
        const matchesWorkspace = !lastRun.workspaceId || lastRun.workspaceId === workspaceId
        if (!matchesWorkspace) return
        const completedAt = lastRun.completedAt ?? null
        if (!completedAt) return
        if (!dreamPollSeededRef.current) {
          dreamPollSeededRef.current = true
          lastSeenDreamCompletionRef.current = completedAt
          return
        }
        if (lastSeenDreamCompletionRef.current === completedAt) return
        lastSeenDreamCompletionRef.current = completedAt
        if (lastRun.status === 'failed' || lastRun.status === 'cancelled') return

        const runId = String(lastRun.id ?? completedAt)
        const sessionsReviewed = Number(lastRun.sessionsReviewed ?? 0)
        const summaryText = sessionsReviewed > 0
          ? `Auto-dream consolidated ${sessionsReviewed} session${sessionsReviewed === 1 ? '' : 's'}`
          : 'Auto-dream completed'
        const toolId = `${DREAM_TOOL_ID_PREFIX}${runId}`
        const ts = Date.parse(completedAt) || Date.now()

        setMessagesSafe(prev => {
          // De-dupe: if a dream message with this toolId already exists in history, skip.
          if (prev.some(m => m.toolBlocks?.some(tb => tb.id === toolId))) return prev
          return [...prev, {
            id: `msg-dream-${runId}`,
            role: 'system',
            content: '',
            timestamp: ts,
            contentBlocks: [{ type: 'tool', toolId }],
            toolBlocks: [{
              id: toolId,
              name: DREAM_TOOL_NAME,
              input: '',
              summary: summaryText,
              status: 'done',
            }],
          }]
        })
      } catch {
        // Polling failures are non-fatal — try again next tick.
      }
    }

    poll()
    const interval = window.setInterval(poll, 5000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [workspaceId, setMessagesSafe])

  // Clamp index when filtered items change
  useEffect(() => {
    setAcIndex(i => Math.min(i, Math.max(0, acItems.length - 1)))
  }, [acItems.length])

  useEffect(() => { ensureChatMdStyle() }, [])

  // Bumped whenever CustomisationTile saves a new set of skill/prompt
  // locations, so the skill-discovery effect below re-runs and picks up new
  // folders (or drops skills from removed folders).
  const [skillLocationsVersion, setSkillLocationsVersion] = useState(0)
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<CustomisationLocationsChangedDetail>).detail
      if (!detail) return
      if (detail.kind !== 'skills' && detail.kind !== 'prompts') return
      const currentWorkspace = _workspaceDir?.trim() || null
      if (currentWorkspace && detail.workspacePath && detail.workspacePath !== currentWorkspace) return
      setSkillLocationsVersion(v => v + 1)
    }
    window.addEventListener(CUSTOMISATION_LOCATIONS_CHANGED_EVENT, handler as EventListener)
    return () => window.removeEventListener(CUSTOMISATION_LOCATIONS_CHANGED_EVENT, handler as EventListener)
  }, [_workspaceDir])

  useEffect(() => {
    let cancelled = false
    const workspacePath = _workspaceDir?.trim() || null
    const homePath = window.electron.homedir ?? ''
    const skillsPath = workspacePath ? `${workspacePath}/.contex/customisation/skills.json` : null
    const locationsPath = workspacePath ? `${workspacePath}/.contex/customisation/locations-skills.json` : null
    // Commands are conceptually prompts — the Prompts locations panel is the
    // canonical place users add slash-command folders. Merge both lists so any
    // folder added under Prompts OR Skills gets scanned for chat skills.
    const promptLocationsPath = workspacePath ? `${workspacePath}/.contex/customisation/locations-prompts.json` : null

    ;(async () => {
      const discovered = new Map<string, SkillDefinition>()

      const registerSkill = (skill: SkillDefinition) => {
        const key = skill.name.trim().toLowerCase()
        if (!key || discovered.has(key)) return
        discovered.set(key, skill)
      }

      if (skillsPath) {
        const savedRaw = await window.electron.fs.readFile(skillsPath).catch(() => '')
        if (savedRaw) {
          try {
            const parsed = JSON.parse(savedRaw)
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (
                  typeof item === 'object'
                  && item !== null
                  && typeof (item as { id?: unknown }).id === 'string'
                  && typeof (item as { name?: unknown }).name === 'string'
                  && typeof (item as { content?: unknown }).content === 'string'
                ) {
                  registerSkill(item as SkillDefinition)
                }
              }
            }
          } catch {
            // Ignore invalid JSON and continue with discovery.
          }
        }
      }

      const readLocationsFile = async (path: string | null): Promise<string> => {
        if (!path) return ''
        const raw = await window.electron.fs.readFile(path).catch(() => '')
        if (!raw) return ''
        try {
          const parsed = JSON.parse(raw)
          if (typeof parsed === 'string') return parsed
        } catch {
          return raw
        }
        return ''
      }

      const skillsLocationsText = await readLocationsFile(locationsPath)
      const promptsLocationsText = await readLocationsFile(promptLocationsPath)
      const mergedSources = [skillsLocationsText, promptsLocationsText].filter(s => s && s.trim()).join('\n')
      const rawLocations = mergedSources.trim() ? mergedSources : CHAT_DEFAULT_SKILL_LOCATIONS

      const seenDirs = new Set<string>()
      const dirs = resolveChatSkillLocations(rawLocations, homePath, workspacePath).filter(d => {
        if (seenDirs.has(d)) return false
        seenDirs.add(d)
        return true
      })
      // Claude-format skills are sub-folders containing `SKILL.md`. Other
      // tools drop a single `.md`/`.txt`/`.mdc` file at the top level. Support
      // both so e.g. `~/Library/Application Support/Claude/skills/foo/SKILL.md`
      // is picked up as skill "foo".
      const registerDiscoveredSkill = (filePath: string, fallbackName: string, content: string, dir: string): void => {
        const nameMatch = content.match(/^---[\s\S]*?name:\s*(.+?)$/m)
        const descriptionMatch = content.match(/^---[\s\S]*?description:\s*(.+?)$/m)
        const name = nameMatch?.[1]?.trim() ?? fallbackName
        registerSkill({
          id: `discovered-${filePath}`,
          name,
          description: descriptionMatch?.[1]?.trim() ?? `From ${dir}`,
          content,
          command: name,
        })
      }
      for (const dir of dirs) {
        const entries: Array<{ name: string; path: string; isDir: boolean; ext: string }> = await window.electron.fs.readDir(dir).catch(() => [])
        for (const entry of entries) {
          if (entry.isDir) {
            const sub: Array<{ name: string; path: string; isDir: boolean; ext: string }> = await window.electron.fs.readDir(entry.path).catch(() => [])
            const skillFile = sub.find(e => !e.isDir && /^skill\.md$/i.test(e.name))
              ?? sub.find(e => !e.isDir && /^skill\.(txt|mdc)$/i.test(e.name))
            if (!skillFile) continue
            const content = await window.electron.fs.readFile(skillFile.path).catch(() => '')
            if (!content) continue
            registerDiscoveredSkill(skillFile.path, entry.name, content, dir)
            continue
          }
          if (entry.ext !== '.md' && entry.ext !== '.txt' && entry.ext !== '.mdc') continue
          const content = await window.electron.fs.readFile(entry.path).catch(() => '')
          if (!content) continue
          registerDiscoveredSkill(entry.path, entry.name.replace(/\.(md|txt|mdc)$/i, ''), content, dir)
        }
      }

      if (cancelled) return
      setWorkspaceSkills(Array.from(discovered.values()).sort((a, b) => a.name.localeCompare(b.name)))
    })().catch(() => {
      if (!cancelled) setWorkspaceSkills([])
    })

    return () => { cancelled = true }
  }, [_workspaceDir, skillLocationsVersion])

  useEffect(() => {
    window.electron?.bus?.publish(`tile:${tileId}`, 'tool_inventory', `chat:${tileId}`, {
      provider,
      model,
      mcpEnabled,
      tools: availableToolInventory,
      updatedAt: Date.now(),
    })
  }, [tileId, provider, model, mcpEnabled, availableToolInventory])

  useEffect(() => {
    window.electron?.bus?.publish(`tile:${tileId}`, 'skill_inventory', `chat:${tileId}`, {
      provider,
      model,
      skills: availableSkillInventory,
      updatedAt: Date.now(),
    })
  }, [tileId, provider, model, availableSkillInventory])

  // Only tiles actively using OpenCode should subscribe to the model list, otherwise
  // every chat tile holds the same large provider payload in memory.
  useEffect(() => {
    if (provider !== 'opencode') return

    const unsubscribeOpencode = window.electron?.chat?.onOpencodeModelsUpdated?.((payload: any) => {
      if (payload?.models?.length) setOpencodeModels(payload.models)
    })

    return () => { unsubscribeOpencode?.() }
  }, [provider])

  useEffect(() => {
    if (provider === 'opencode' && !requestedProviderOptionsRef.current.opencode) {
      requestedProviderOptionsRef.current.opencode = true
      window.electron?.chat?.opencodeModels?.().then((result: any) => {
        if (result?.models?.length) setOpencodeModels(result.models)
      }).catch(() => {
        requestedProviderOptionsRef.current.opencode = false
      })
    }

    if (provider === 'openclaw' && !requestedProviderOptionsRef.current.openclaw) {
      requestedProviderOptionsRef.current.openclaw = true
      window.electron?.chat?.openclawAgents?.().then((result: any) => {
        if (result?.agents?.length) setOpenclawAgents(result.agents)
      }).catch(() => {
        requestedProviderOptionsRef.current.openclaw = false
      })
    }
  }, [provider])

  useEffect(() => {
    const listHosts = window.electron?.execution?.listHosts
    if (typeof listHosts !== 'function') {
      setExecutionHosts([])
      return
    }

    listHosts()
      .then((hosts) => setExecutionHosts(Array.isArray(hosts) ? hosts : []))
      .catch(() => setExecutionHosts([]))
  }, [])

  useEffect(() => {
    if (!settings?.execution) {
      setLocalExecutionLabel('Instant')
      return
    }
    const resolveTarget = window.electron?.execution?.resolveTarget
    if (typeof resolveTarget !== 'function') {
      setLocalExecutionLabel('Instant')
      return
    }

    resolveTarget(settings.execution)
      .then((resolution) => {
        // Map resolution.host.type to our short two-word vocab:
        //   'local-daemon' → "Local"  (full daemon execution)
        //   'runtime'      → "Instant" (in-process fallback)
        //   anything else  → use the host label verbatim
        const type = (resolution.host as { type?: string } | null)?.type
        if (type === 'local-daemon') setLocalExecutionLabel('Local')
        else if (type === 'runtime') setLocalExecutionLabel('Instant')
        else setLocalExecutionLabel(resolution.host.label || 'Instant')
      })
      .catch(() => {
        setLocalExecutionLabel('Instant')
      })
  }, [settings?.execution])

  useEffect(() => {
    if (pagedLinkedHistoryEnabled) return
    const normalized = normalizeMessagesForMemory(messages)
    if (normalized !== messages) {
      setMessages(normalized)
      return
    }
  }, [messages, pagedLinkedHistoryEnabled])

  useEffect(() => {
    if (!pagedLinkedHistoryEnabled || isStreaming) return
    if (messages.length <= LINKED_SESSION_LIVE_TAIL_LIMIT) return

    const overflowCount = messages.length - LINKED_SESSION_LIVE_TAIL_LIMIT
    if (overflowCount <= 0) return

    const overflowMessages = messages.slice(0, overflowCount)
    if (overflowMessages.length === 0) return

    setHistoricalMessages(prev => mergeHistoricalMessages(prev, overflowMessages))
    setMessages(prev => prev.slice(-LINKED_SESSION_LIVE_TAIL_LIMIT))
    setHasEarlierMessages(true)
  }, [pagedLinkedHistoryEnabled, isStreaming, messages])

  useEffect(() => {
    latestStateRef.current = {
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
      agentMode: effectiveAgentMode,
      autoAgentMode,
      preserveSessionSummary,
      linkedSessionEntryId,
      linkedSessionHint,
      hasEarlierMessages,
      sessionId,
      jobId,
      jobSequence,
      cloudHostId,
      isStreaming,
    }
    if (stateLoadedRef.current) {
      if (isChatTileRuntimeStateDisposed(tileId)) return
      setChatTileRuntimeState(tileId, latestStateRef.current)
    }
  }, [tileId, messages, input, attachments, queuedTurns, openChatSurfaces, activeChatSurfaceId, executionTarget, provider, model, mcpEnabled, mode, thinking, effectiveAgentMode, autoAgentMode, preserveSessionSummary, linkedSessionEntryId, linkedSessionHint, hasEarlierMessages, sessionId, jobId, jobSequence, cloudHostId, isStreaming])

  // Publish the latest task list for this tile so external chrome (tab bar,
  // sidebar) can surface the agent's current plan without drilling into
  // ChatTile internals. Walks reverse-chronologically across both the live
  // tail and any paged-in history so linked external sessions still surface
  // Codex `update_plan` data even when it lived outside the recent tail.
  useEffect(() => {
    let latest: TileTodoItem[] | null = null
    const allMessages = historicalMessages.length > 0
      ? [...historicalMessages, ...messages]
      : messages
    outer: for (let i = allMessages.length - 1; i >= 0; i -= 1) {
      const msg = allMessages[i]
      const blocks = msg.toolBlocks
      if (!blocks || blocks.length === 0) continue
      for (let j = blocks.length - 1; j >= 0; j -= 1) {
        const tb = blocks[j]
        const parsedPlan = parsePlanToolTodos(tb.name, tb.input || '{}')
        if (!parsedPlan) continue
        latest = parsedPlan.todos.length > 0 ? parsedPlan.todos : null
        break outer
      }
    }
    setTileTodos(tileId, latest)
  }, [tileId, historicalMessages, messages])

  // Clear the published todos when the tile unmounts so stale state doesn't
  // linger in the store.
  useEffect(() => {
    return () => { clearTileTodos(tileId) }
  }, [tileId])

  // Track the first moment each ToolBlock flipped to 'done' so the
  // progressive-collapse logic (applyLiveCollapse below) can apply a grace
  // period before folding a freshly-finished chip into the group summary.
  // Also prune entries for tool ids that no longer exist in state.
  const toolStampInitialRunRef = useRef(true)
  useEffect(() => {
    const seen = new Set<string>()
    const now = Date.now()
    // On first run (history load) stamp already-done tools as if they
    // completed before the grace window so they're immediately eligible
    // to fold. Subsequent runs stamp freshly-completed tools with `now`
    // so live streaming still gets the full grace period.
    const initialRun = toolStampInitialRunRef.current
    const liveStampValue = initialRun ? 0 : now
    for (const msg of historicalMessages) {
      for (const tb of msg.toolBlocks ?? []) {
        seen.add(tb.id)
        if (tb.status === 'done' && !toolCompletedAtRef.current.has(tb.id)) {
          toolCompletedAtRef.current.set(tb.id, 0)
        }
      }
    }
    for (const msg of messages) {
      for (const tb of msg.toolBlocks ?? []) {
        seen.add(tb.id)
        if (tb.status === 'done' && !toolCompletedAtRef.current.has(tb.id)) {
          toolCompletedAtRef.current.set(tb.id, liveStampValue)
        }
      }
    }
    toolStampInitialRunRef.current = false
    // Drop stale entries for tool blocks that got removed (e.g. conversation
    // cleared / message regenerated).
    for (const id of Array.from(toolCompletedAtRef.current.keys())) {
      if (!seen.has(id)) toolCompletedAtRef.current.delete(id)
    }
  }, [historicalMessages, messages])

  // Auto-collapse the queue when it crosses into "too many" territory, and
  // auto-expand when it drops back down so a lone queued item isn't hidden
  // behind a summary row. The user can still override by clicking the header.
  useEffect(() => {
    const prev = prevQueuedCountRef.current
    const next = queuedTurns.length
    if (prev < 3 && next >= 3) setQueueCollapsed(true)
    else if (prev >= 3 && next < 3) setQueueCollapsed(false)
    prevQueuedCountRef.current = next
  }, [queuedTurns.length])

  const persistLatestState = useCallback((stateOverride?: ChatTilePersistedState | null) => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    const nextState = stateOverride ?? latestStateRef.current
    if (!workspaceId || !stateLoadedRef.current || !nextState || isChatTileRuntimeStateDisposed(tileId)) return
    const persistedState = nextState.linkedSessionEntryId
      ? { ...nextState, messages: [] }
      : nextState
    void window.electron.canvas.saveTileState(workspaceId, tileId, persistedState).catch(() => {})
  }, [workspaceId, tileId])

  useEffect(() => {
    reviveChatTileRuntimeState(tileId)
    stateLoadedRef.current = false

    const applySavedState = (saved: Partial<ChatTilePersistedState> | null | undefined) => {
      if (!saved) return
      if (Array.isArray(saved.messages)) setMessagesSafe(saved.messages)
      if (typeof saved.input === 'string') setInput(saved.input)
      if (Array.isArray(saved.attachments)) {
        setAttachments(saved.attachments.filter((item: any) => typeof item?.path === 'string').map((item: any) => ({
          path: item.path,
          kind: item.kind === 'image' || isImagePath(item.path) ? 'image' : 'file',
        })))
      }
      if (Array.isArray(saved.queuedTurns)) {
        setQueuedTurns(saved.queuedTurns.filter((item: any) => typeof item?.id === 'string' && typeof item?.content === 'string').map((item: any) => ({
          id: item.id,
          content: item.content,
          preview: typeof item.preview === 'string' ? item.preview : buildQueuedTurnPreview(item.content, Number(item.attachmentCount) || 0),
          attachmentCount: Number(item.attachmentCount) || 0,
          createdAt: Number(item.createdAt) || Date.now(),
          parentId: typeof item.parentId === 'string' ? item.parentId : null,
        })))
      }
      if (Array.isArray(saved.openChatSurfaces)) {
        const restoredSurfaces = normalizePersistedChatSurfaces(saved.openChatSurfaces)
        setOpenChatSurfaces(restoredSurfaces)
        if (typeof saved.activeChatSurfaceId === 'string' && restoredSurfaces.some(surface => surface.instanceId === saved.activeChatSurfaceId)) {
          setActiveChatSurfaceId(saved.activeChatSurfaceId)
        } else if (saved.activeChatSurfaceId === null) {
          setActiveChatSurfaceId(null)
        } else {
          setActiveChatSurfaceId(restoredSurfaces[restoredSurfaces.length - 1]?.instanceId ?? null)
        }
      } else if (saved.activeChatSurfaceId === null) {
        setActiveChatSurfaceId(null)
      }
      const savedProvider = typeof saved.provider === 'string' ? saved.provider : provider
      if (saved.provider) setProvider(saved.provider)
      if (typeof saved.model === 'string') setModel(saved.model)
      if (saved.executionTarget === 'local' || saved.executionTarget === 'cloud') setExecutionTarget(saved.executionTarget)
      if (typeof saved.mcpEnabled === 'boolean') setMcpEnabled(saved.mcpEnabled)
      if (typeof saved.mode === 'string') setMode(resolveProviderModeId(savedProvider, saved.mode))
      if (typeof saved.thinking === 'string') setThinking(saved.thinking)
      if (typeof saved.autoAgentMode === 'boolean') setAutoAgentMode(saved.autoAgentMode)
      if (typeof saved.preserveSessionSummary === 'boolean') setPreserveSessionSummary(saved.preserveSessionSummary)
      if (typeof saved.linkedSessionEntryId === 'string' || saved.linkedSessionEntryId === null) setLinkedSessionEntryId(saved.linkedSessionEntryId ?? null)
      if (saved.linkedSessionHint === null) {
        setLinkedSessionHint(null)
      } else if (saved.linkedSessionHint && typeof saved.linkedSessionHint === 'object') {
        const hint = saved.linkedSessionHint as Partial<SessionEntryHint>
        if (typeof hint.id === 'string' && typeof hint.source === 'string') {
          setLinkedSessionHint({
            id: hint.id,
            source: hint.source as SessionEntryHint['source'],
            filePath: typeof hint.filePath === 'string' ? hint.filePath : undefined,
            sessionId: typeof hint.sessionId === 'string' || hint.sessionId === null ? hint.sessionId : null,
            provider: typeof hint.provider === 'string' ? hint.provider : '',
            model: typeof hint.model === 'string' ? hint.model : '',
            messageCount: typeof hint.messageCount === 'number' ? hint.messageCount : 0,
            title: typeof hint.title === 'string' ? hint.title : '',
            projectPath: typeof hint.projectPath === 'string' || hint.projectPath === null ? hint.projectPath : null,
          })
        }
      }
      if (typeof saved.hasEarlierMessages === 'boolean') setHasEarlierMessages(saved.hasEarlierMessages)
      else if (saved.linkedSessionEntryId == null) setHasEarlierMessages(false)
      if (typeof saved.sessionId === 'string' || saved.sessionId === null) setSessionId(saved.sessionId)
      if (typeof saved.jobId === 'string' || saved.jobId === null) setJobId(saved.jobId ?? null)
      if (typeof saved.jobSequence === 'number') {
        setJobSequence(saved.jobSequence)
        lastJobSequenceRef.current = saved.jobSequence
      }
      if (typeof saved.cloudHostId === 'string' || saved.cloudHostId === null) setCloudHostId(saved.cloudHostId ?? null)
      if (typeof saved.isStreaming === 'boolean') setIsStreaming(saved.isStreaming)
    }

    const cached = reloadToken > 0
      ? getChatTileRuntimeState<ChatTilePersistedState>(tileId)
      : (initialRuntimeStateRef.current ?? getChatTileRuntimeState<ChatTilePersistedState>(tileId))
    if (cached) {
      applySavedState(cached)
      stateLoadedRef.current = true
      return
    }

    if (!workspaceId) {
      stateLoadedRef.current = true
      return
    }

    window.electron.canvas.loadTileState(workspaceId, tileId).then((saved: any) => {
      applySavedState(saved)
    }).catch(() => {}).finally(() => {
      stateLoadedRef.current = true
    })
  }, [workspaceId, tileId, reloadToken])

  useEffect(() => {
    if (!stateLoadedRef.current) return
    if (!workspaceId || !linkedSessionEntryId) return
    if (isStreaming) return

    const usePagedHistory = canUsePagedLinkedHistory(linkedSessionEntryId, linkedSessionHint, sessionId)
    let cancelled = false
    void window.electron.canvas.getSessionState(workspaceId, linkedSessionEntryId, {
      entryHint: linkedSessionHint ?? null,
      tailLimit: usePagedHistory ? LINKED_SESSION_HISTORY_PAGE_SIZE : undefined,
    })
      .then((saved: any) => {
        if (cancelled || !saved) return
        const savedProvider = typeof saved.provider === 'string'
          ? saved.provider
          : (latestStateRef.current?.provider ?? DEFAULT_PROVIDER_ID)
        if (Array.isArray(saved.messages)) setMessagesSafe(saved.messages)
        if (typeof saved.provider === 'string') setProvider(saved.provider)
        if (typeof saved.model === 'string') setModel(saved.model)
        if (typeof saved.mode === 'string') setMode(resolveProviderModeId(savedProvider, saved.mode))
        if (typeof saved.hasEarlierMessages === 'boolean') setHasEarlierMessages(saved.hasEarlierMessages)
        if (typeof saved.sessionId === 'string' || saved.sessionId === null) setSessionId(saved.sessionId ?? null)
        if (saved.executionTarget === 'local' || saved.executionTarget === 'cloud') setExecutionTarget(saved.executionTarget)
        if (typeof saved.cloudHostId === 'string' || saved.cloudHostId === null) setCloudHostId(saved.cloudHostId ?? null)
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [workspaceId, linkedSessionEntryId, linkedSessionHint, reloadToken, isStreaming, sessionId, setMessagesSafe])

  // Reset the "last activity" clock every time streaming toggles on so the
  // quiet-indicator starts from zero for each new turn. The message-change
  // effect below then keeps it current while tokens/tool-blocks arrive.
  useEffect(() => {
    isStreamingRef.current = isStreaming
    if (isStreaming) {
      lastActivityAtRef.current = Date.now()
    }
  }, [isStreaming])

  // Run deferred normalization when streaming ends — catches any growth
  // that accumulated while the fast-path skipped normalizeMessagesForMemory.
  useEffect(() => {
    if (!isStreaming && stateLoadedRef.current && !pagedLinkedHistoryEnabledRef.current) {
      setMessages(prev => normalizeMessagesForMemory(prev))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming])

  // Any mutation to messages while streaming counts as activity.
  useEffect(() => {
    if (!isStreaming) return
    lastActivityAtRef.current = Date.now()
  }, [messages, isStreaming])

  // Push permission-mode changes into the running Claude query. Only fires
  // when mode actually changed during an active stream — initial mount and
  // stream start re-baseline the ref so the next user-initiated switch gets
  // detected. Only Claude's SDK supports runtime mode changes; other providers
  // will need a per-turn restart (out of scope).
  useEffect(() => {
    if (!isStreaming) {
      lastPushedModeRef.current = mode
      return
    }
    if (provider !== 'claude') return
    if (lastPushedModeRef.current === mode) return
    lastPushedModeRef.current = mode
    void window.electron?.chat?.setPermissionMode?.({ cardId: tileId, mode })
  }, [mode, isStreaming, provider, tileId])

  // Re-arm a one-shot timer for the soonest tool chip that is still inside
  // the live-collapse grace window. This avoids the old 500ms parent-level
  // rerender loop that made the transcript pulse while streaming.
  useEffect(() => {
    const sourceMessages = historicalMessages.length > 0
      ? [...historicalMessages, ...messages]
      : messages
    const now = Date.now()
    let nextDeadline: number | null = null

    for (const msg of sourceMessages) {
      for (const tb of msg.toolBlocks ?? []) {
        if (tb.status !== 'done') continue
        const completedAt = toolCompletedAtRef.current.get(tb.id)
        if (completedAt == null || completedAt === 0) continue
        const deadline = completedAt + LIVE_TOOL_COLLAPSE_GRACE_MS
        if (deadline <= now) continue
        if (nextDeadline == null || deadline < nextDeadline) nextDeadline = deadline
      }
    }

    if (nextDeadline == null) return
    const timeoutMs = Math.max(0, nextDeadline - now) + 10
    const id = window.setTimeout(() => {
      setToolCollapseTick(n => (n + 1) & 0xffff)
    }, timeoutMs)
    return () => window.clearTimeout(id)
  }, [historicalMessages, messages, toolCollapseTick])

  useEffect(() => {
    if (!workspaceId || !stateLoadedRef.current || isChatTileRuntimeStateDisposed(tileId)) return
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      persistLatestState()
    }, isStreaming ? 2000 : 500)

    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
    }
  }, [workspaceId, tileId, messages, input, attachments, queuedTurns, openChatSurfaces, activeChatSurfaceId, executionTarget, provider, model, mcpEnabled, mode, thinking, effectiveAgentMode, autoAgentMode, preserveSessionSummary, linkedSessionEntryId, linkedSessionHint, hasEarlierMessages, sessionId, jobId, jobSequence, cloudHostId, isStreaming, persistLatestState])

  useEffect(() => {
    // Flush pending state on window close so the last few seconds of a
    // conversation are not lost. The unmount cleanup fires async IPC which
    // may not survive Electron's window teardown — beforeunload fires
    // earlier and gives the main process time to write.
    const handleBeforeUnload = (): void => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      const latest = latestStateRef.current
      if (latest && !isChatTileRuntimeStateDisposed(tileId)) {
        persistLatestState(latest)
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current)
        persistTimerRef.current = null
      }
      const latest = latestStateRef.current
      if (!latest) return
      if (isChatTileRuntimeStateDisposed(tileId)) return
      setChatTileRuntimeState(tileId, latest)
      persistLatestState(latest)
    }
  }, [tileId, persistLatestState])

  useEffect(() => {
    if (!stateLoadedRef.current) return
    if (!jobId) return
    const resumeKey = [
      jobId,
      executionTarget,
      cloudHostId ?? '',
      provider,
      model,
    ].join('::')
    if (resumedJobKeyRef.current === resumeKey) return
    resumedJobKeyRef.current = resumeKey

    void window.electron.chat?.resumeJob?.({
      cardId: tileId,
      provider,
      model,
      workspaceDir: _workspaceDir,
      executionTarget,
      cloudHostId,
      executionPreference: settings?.execution ?? null,
      jobId,
      jobSequence,
    })
  }, [tileId, provider, model, _workspaceDir, executionTarget, cloudHostId, settings?.execution, jobId, jobSequence])

  const builtinProviderEntries = useMemo<Record<BuiltinProvider, ProviderEntry>>(() => ({
    claude: {
      id: 'claude',
      label: PROVIDER_LABELS.claude,
      noun: 'model',
      icon: PROVIDER_ICON.claude,
      models: DEFAULT_MODELS.claude,
      kind: 'builtin',
    },
    codex: {
      id: 'codex',
      label: PROVIDER_LABELS.codex,
      noun: 'model',
      icon: PROVIDER_ICON.codex,
      models: DEFAULT_MODELS.codex,
      kind: 'builtin',
    },
    opencode: {
      id: 'opencode',
      label: PROVIDER_LABELS.opencode,
      noun: 'model',
      icon: PROVIDER_ICON.opencode,
      models: opencodeModels,
      kind: 'builtin',
    },
    openclaw: {
      id: 'openclaw',
      label: PROVIDER_LABELS.openclaw,
      noun: 'agent',
      icon: PROVIDER_ICON.openclaw,
      models: openclawAgents,
      kind: 'builtin',
    },
    hermes: {
      id: 'hermes',
      label: PROVIDER_LABELS.hermes,
      noun: 'model',
      icon: PROVIDER_ICON.hermes,
      models: DEFAULT_MODELS.hermes,
      kind: 'builtin',
    },
  }), [opencodeModels, openclawAgents])

  const extensionProviderEntries = useMemo<ProviderEntry[]>(() => {
    void peerContextVersion
    const entries = new Map<string, ProviderEntry>()

    for (const peer of connectedPeers) {
      const peerContext = peerContextRef.current.get(peer.peerId) ?? {}
      const providers = normalizeExtensionProviders(peerContext['ctx:chat:providers'])
      for (const providerConfig of providers) {
        entries.set(providerConfig.id, {
          id: providerConfig.id,
          label: providerConfig.label,
          description: providerConfig.description,
          noun: providerConfig.noun ?? 'model',
          icon: getExtensionProviderIcon(providerConfig.icon),
          models: providerConfig.models.map(modelOption => ({
            id: modelOption.id,
            label: modelOption.label,
            description: modelOption.description,
          })),
          kind: 'extension',
          transport: providerConfig.transport,
        })
      }
    }

    return Array.from(entries.values()).sort((a, b) => a.label.localeCompare(b.label))
  }, [connectedPeers, peerContextVersion])

  const providerEntries = useMemo<ProviderEntry[]>(() => [
    builtinProviderEntries.claude,
    builtinProviderEntries.codex,
    builtinProviderEntries.opencode,
    builtinProviderEntries.openclaw,
    builtinProviderEntries.hermes,
    ...extensionProviderEntries,
  ], [builtinProviderEntries, extensionProviderEntries])

  const providerEntryById = useMemo(() => {
    const next = new Map<string, ProviderEntry>()
    for (const entry of providerEntries) next.set(entry.id, entry)
    return next
  }, [providerEntries])

  const currentProviderEntry = providerEntryById.get(provider)
    ?? providerEntryById.get(DEFAULT_PROVIDER_ID)
    ?? providerEntries[0]

  const modeOptions = useMemo<ModeOption[]>(() => {
    if (!currentProviderEntry) return [EXTENSION_PROVIDER_MODE]
    return currentProviderEntry.kind === 'builtin'
      ? PROVIDER_MODES[currentProviderEntry.id as BuiltinProvider]
      : [EXTENSION_PROVIDER_MODE]
  }, [currentProviderEntry])

  // Close dropdowns on outside click or Escape
  const anyMenuOpen = showModelMenu || showProviderMenu || showInsertMenu || showModeMenu || showThinkingMenu || showLocationMenu || showBranchMenu || showContextMenu
  const menuRefs = [modelMenuRef, providerMenuRef, insertMenuRef, modeMenuRef, thinkingMenuRef, locationMenuRef, branchMenuRef, contextMenuRef]

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      const targetEl = e.target instanceof Element ? e.target : null
      // If click is inside any menu button or portaled dropdown, let the menu handle it.
      const insideAnyMenu = menuRefs.some(ref => ref.current?.contains(target))
        || Boolean(targetEl?.closest('[data-chat-menu-portal="true"]'))
      if (insideAnyMenu) return
      // Click is outside all menus — close everything
      setShowModelMenu(false)
      setShowProviderMenu(false)
      setShowInsertMenu(false)
      setShowModeMenu(false)
      setShowThinkingMenu(false)
      setShowLocationMenu(false)
      setShowBranchMenu(false)
      setShowContextMenu(false)
      if (acRef.current && !acRef.current.contains(target) && target !== textareaRef.current) {
        setAcType(null)
        setAcQuery('')
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && anyMenuOpen) {
        e.stopPropagation()
        e.preventDefault()
        setShowModelMenu(false)
        setShowProviderMenu(false)
        setShowInsertMenu(false)
        setShowModeMenu(false)
        setShowThinkingMenu(false)
        setShowLocationMenu(false)
        setShowBranchMenu(false)
        setShowContextMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey, true)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey, true)
    }
  }, [anyMenuOpen])

  const optionNoun = currentProviderEntry?.noun ?? 'model'
  const currentModel = currentProviderEntry?.models.find(m => m.id === model)
    ?? currentProviderEntry?.models[0]
    ?? { id: '', label: optionNoun === 'agent' ? 'No agent' : 'No model' }
  const currentMode = modeOptions.find(item => item.id === mode) ?? modeOptions[0] ?? EXTENSION_PROVIDER_MODE
  const contextWindowLimit = useMemo(() => getApproxContextWindowTokens(provider, model), [provider, model])
  const systemOverheadTokens = useMemo(
    () => getApproxSystemOverheadTokens(provider, model),
    [provider, model],
  )
  // Set of attachment paths the model has actually loaded (via Read-style
  // tools). Drives the confirmation tick on attachment chips — must stay
  // authoritative: only paths demonstrably consumed by the model appear here.
  //
  // Keyed on the sorted content of the set so the Set identity is stable
  // across streaming ticks that don't add a new Read tool call. This is
  // load-bearing: ChatMessageContent receives this prop and is React.memo'd;
  // a fresh Set every token would break memo for every completed block on
  // every single token, causing a full message re-render storm.
  const readPathsSnapshot = useMemo(
    () => [...collectModelReadPaths(messages)].sort().join('\u0000'),
    [messages],
  )
  const readAttachmentPaths = useMemo(
    () => new Set(readPathsSnapshot ? readPathsSnapshot.split('\u0000') : []),
    [readPathsSnapshot],
  )
  const conversationTokenEstimate = useMemo(() => {
    const totalChars = messages.reduce((sum, message) => sum + estimateMessageChars(message), 0)
    return Math.max(0, Math.round(totalChars / 4))
  }, [messages])
  const estimatedContextTokens = useMemo(() => {
    const inputTokens = Math.max(0, Math.round(input.length / 4))
    // Include the provider's baseline overhead (system prompt + tool schemas
    // + injected reminders) so the indicator doesn't misleadingly report
    // near-empty usage when the harness has already loaded tens of thousands
    // of tokens before the first user turn.
    return conversationTokenEstimate + inputTokens + systemOverheadTokens
  }, [conversationTokenEstimate, input, systemOverheadTokens])
  const contextUsageRatio = contextWindowLimit > 0 ? Math.min(1, estimatedContextTokens / contextWindowLimit) : 0
  const contextUsagePercent = Math.max(1, Math.round(contextUsageRatio * 100))

  const applyGitState = useCallback((next: CachedGitState) => {
    setGitStatus(next.status)
    setGitBranches(next.branches)
  }, [])

  const refreshGitState = useCallback(async (force = false) => {
    const requestWorkspaceDir = _workspaceDir
    const requestKey = normalizeGitWorkspaceKey(requestWorkspaceDir)
    if (!requestWorkspaceDir) {
      applyGitState(createEmptyGitState(_workspaceDir))
      return
    }

    const cached = getCachedGitState(requestWorkspaceDir)
    if (!force && cached) {
      if (latestGitWorkspaceKeyRef.current === requestKey) applyGitState(cached)
      if (isFreshGitState(cached)) return
    }

    const next = await loadGitState(requestWorkspaceDir, force)
    if (latestGitWorkspaceKeyRef.current !== requestKey) return
    applyGitState(next)
  }, [_workspaceDir, applyGitState])

  useEffect(() => {
    latestGitWorkspaceKeyRef.current = normalizeGitWorkspaceKey(_workspaceDir)
    const cached = getCachedGitState(_workspaceDir)
    applyGitState(cached ?? createEmptyGitState(_workspaceDir))
    void refreshGitState(false)

    const onFocus = () => { void refreshGitState(true) }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [_workspaceDir, applyGitState, refreshGitState])

  const isGitRepo = gitStatus.isRepo || gitBranches.isRepo
  const branchMenuCreateEnabled = isGitRepo
    && branchFilter.trim().length > 0
    && !gitBranches.branches.some(branch => branch.name.toLowerCase() === branchFilter.trim().toLowerCase())
  const activeRepoRoot = gitBranches.isRepo
    ? gitBranches.root
    : gitStatus.isRepo
      ? gitStatus.root
      : _workspaceDir
  const normalizedRepoRoot = activeRepoRoot.replace(/\/+$/, '')
  const projectFolderName = basename(normalizedRepoRoot) || 'No project'
  const currentBranchLabel = gitBranches.current ?? 'No branch'
  const remoteHosts = useMemo(
    () => executionHosts.filter(host => host.type === 'remote-daemon' && host.enabled !== false),
    [executionHosts],
  )
  useEffect(() => {
    if (executionTarget !== 'cloud') return
    if (remoteHosts.length === 0) {
      if (cloudHostId !== null) setCloudHostId(null)
      return
    }
    if (!cloudHostId || !remoteHosts.some(host => host.id === cloudHostId)) {
      setCloudHostId(remoteHosts[0].id)
    }
  }, [executionTarget, remoteHosts, cloudHostId])
  const activeCloudHost = remoteHosts.find(host => host.id === cloudHostId) ?? remoteHosts[0] ?? null
  const locationLabel = executionTarget === 'cloud'
    ? (activeCloudHost?.label ?? (remoteHosts.length > 0 ? 'Cloud' : 'No remote daemon'))
    : localExecutionLabel
  const activeProjectPathLabel = executionTarget === 'cloud'
    ? (activeCloudHost?.url ?? (remoteHosts.length > 0 ? 'Cloud workspace' : 'No remote daemon configured'))
    : (normalizedRepoRoot || 'No project')

  const handleProjectFolderSwitch = useCallback(async () => {
    try {
      const newPath = await window.electron?.workspace?.openFolder?.()
      if (!newPath) return
      const previousPath = normalizedRepoRoot || ''
      if (newPath === previousPath) return
      if (workspaceId) {
        try {
          await window.electron?.workspace?.addProjectFolder?.(workspaceId, newPath)
        } catch (err) {
          console.warn('[ChatTile] addProjectFolder failed:', err)
        }
      }
      const switchMsg: ChatMessage = {
        id: `msg-folder-switch-${Date.now()}`,
        role: 'assistant',
        content: previousPath
          ? `Switched project folder from \`${previousPath}\` to \`${newPath}\`.`
          : `Switched project folder to \`${newPath}\`.`,
        timestamp: Date.now(),
      }
      setMessages(prev => [...prev, switchMsg])
    } catch (err) {
      console.warn('[ChatTile] folder switch failed:', err)
    }
  }, [normalizedRepoRoot, workspaceId])

  const filteredBranches = useMemo(() => {
    const query = branchFilter.trim().toLowerCase()
    if (!query) return gitBranches.branches
    return gitBranches.branches.filter(branch => branch.name.toLowerCase().includes(query))
  }, [gitBranches.branches, branchFilter])

  const handleBranchSelect = useCallback(async (branchName: string) => {
    if (!_workspaceDir || !window.electron?.git?.checkoutBranch) return
    const result = await window.electron.git.checkoutBranch(_workspaceDir, branchName)
    if (result?.ok) {
      setShowBranchMenu(false)
      setBranchFilter('')
      void refreshGitState()
    }
  }, [_workspaceDir, refreshGitState])

  const handleCreateBranch = useCallback(async () => {
    const nextName = branchFilter.trim()
    if (!nextName || !_workspaceDir || !window.electron?.git?.createBranch) return
    const result = await window.electron.git.createBranch(_workspaceDir, nextName)
    if (result?.ok) {
      setShowBranchMenu(false)
      setBranchFilter('')
      void refreshGitState()
    }
  }, [branchFilter, _workspaceDir, refreshGitState])

  useEffect(() => {
    if (!currentProviderEntry) return
    if (currentProviderEntry.id !== provider) {
      setProvider(currentProviderEntry.id)
      setModel(currentProviderEntry.models[0]?.id ?? '')
      setMode(resolveProviderModeId(currentProviderEntry.id, settings?.chatProviderModes?.[currentProviderEntry.id]))
      return
    }

    const options = currentProviderEntry.models
    if (options.length === 0) return
    if (!options.some(option => option.id === model)) {
      setModel(options[0].id)
    }
  }, [currentProviderEntry, provider, settings?.chatProviderModes, model])

  useEffect(() => {
    if (!modeOptions.some(option => option.id === mode)) {
      setMode(resolveProviderModeId(provider, settings?.chatProviderModes?.[provider]))
    }
  }, [modeOptions, mode, provider, settings?.chatProviderModes])

  const handleProviderChange = useCallback((providerId: string) => {
    const nextProvider = providerEntryById.get(providerId)
    if (!nextProvider) return
    setProvider(nextProvider.id)
    setModel(nextProvider.models[0]?.id ?? '')
    setMode(resolveProviderModeId(nextProvider.id, settings?.chatProviderModes?.[nextProvider.id]))
    // Preserve thinking preference across providers
    setShowProviderMenu(false)
  }, [providerEntryById, settings?.chatProviderModes])

  const toggleMenu = useCallback((which: 'model' | 'provider' | 'insert' | 'mode' | 'thinking' | 'location' | 'branch' | 'context') => {
    setShowModelMenu(prev => { const next = which === 'model' ? !prev : false; if (!next) setModelFilter(''); return next })
    setShowProviderMenu(prev => which === 'provider' ? !prev : false)
    setShowInsertMenu(prev => which === 'insert' ? !prev : false)
    setShowModeMenu(prev => which === 'mode' ? !prev : false)
    setShowThinkingMenu(prev => which === 'thinking' ? !prev : false)
    setShowLocationMenu(prev => which === 'location' ? !prev : false)
    setShowBranchMenu(prev => { const next = which === 'branch' ? !prev : false; if (!next) setBranchFilter(''); return next })
    setShowContextMenu(prev => which === 'context' ? !prev : false)
  }, [])

  // ─── Silero VAD: hands-free dictation ───────────────────────────────
  // The VAD hook owns the microphone while listening mode is on. It fires
  // onSpeechEnd with a Float32 PCM buffer each time the user finishes an
  // utterance (~700ms after they stop talking). We pack it into a WAV and
  // send to the configured STT provider — no manual stop required.
  //
  // Listening stays on across multiple utterances until the user clicks
  // mic again. Voice-initiated barge-in (the audio steer): when speech
  // starts mid-TTS-playback, we stop the player so the user's voice cuts
  // through cleanly.
  const vad = useVoiceActivityDetector({
    onSpeechStart: () => {
      // Voice-initiated barge-in: speaking interrupts the AI talking.
      bargeIn()
    },
    onSpeechEnd: async (audio) => {
      const v = voiceSettingsRef.current
      const jobId = ++transcribeJobRef.current
      try {
        const wav = float32ToWav(audio, 16000)
        const result = await window.electron.transcribe.run({
          audio: wav,
          mimeType: 'audio/wav',
          provider: v.sttProvider ?? 'deepgram',
          lang: v.sttLang ?? 'en',
          localBaseUrl: v.sttLocalBaseUrl,
        })
        if (jobId !== transcribeJobRef.current) return  // stale; user moved on
        if (result.ok && result.text) {
          setInput(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + result.text!)
          setDictationError(null)
        } else if (result.error) {
          // eslint-disable-next-line no-console
          console.warn('[dictation] transcribe error:', result.error)
          setDictationError(result.error)
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[dictation] transcribe pipeline failed:', err)
        setDictationError(err instanceof Error ? err.message : String(err))
      }
    },
  })

  // Reflect the VAD lifecycle into the existing isDictating / dictationText
  // state so the indicator UI doesn't need to know which engine is driving it.
  useEffect(() => {
    setIsDictating(vad.isListening)
    if (!vad.isListening) setDictationText('')
    else if (vad.isSpeaking) setDictationText('Listening — speaking…')
    else setDictationText('Listening — say something')
  }, [vad.isListening, vad.isSpeaking])
  useEffect(() => {
    if (vad.error) setDictationError(vad.error)
  }, [vad.error])

  // Click mic / hold space toggles VAD listening mode (not single-shot
  // recording). Holding space briefly is functionally equivalent to a
  // click — both flip listening on or off.
  const toggleDictation = useCallback(() => {
    if (vad.isListening) {
      void vad.stop()
    } else {
      bargeIn()  // any active TTS audio is silenced when we start listening
      void vad.start()
    }
  }, [vad])

  const isNearLatest = useCallback((el: HTMLDivElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= CHAT_AUTO_SCROLL_THRESHOLD
  }, [])

  const syncScrollToLatestVisibility = useCallback((next: boolean) => {
    if (showScrollToLatestRef.current === next) return
    showScrollToLatestRef.current = next
    setShowScrollToLatest(next)
  }, [])

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = messagesRef.current
    if (!el) return
    stickToBottomRef.current = true
    syncScrollToLatestVisibility(false)
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [syncScrollToLatestVisibility])

  const reviewLatestChanges = useCallback(() => {
    const scroller = messagesRef.current
    if (!scroller) return
    const blocks = scroller.querySelectorAll<HTMLElement>('[data-tool-block-kind="file-changes"]')
    const latestBlock = blocks.item(blocks.length - 1)
    if (!latestBlock) {
      scrollToLatest()
      return
    }

    stickToBottomRef.current = false
    syncScrollToLatestVisibility(true)
    latestBlock.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [scrollToLatest, syncScrollToLatestVisibility])

  // Direction-aware user-intent handlers. Only UPWARD input releases
  // stick-to-bottom; downward input is the user following along, so we let
  // the auto-pin mechanism keep working normally. This avoids the previous
  // bug where any wheel (including downward) froze auto-pin for 800ms and
  // left streaming content drifting off-screen above the viewport.
  const handleMessagesWheel = useCallback((ev: React.WheelEvent<HTMLDivElement>) => {
    if (ev.deltaY < 0) {
      // Wheeled UP — user wants to read history. Release stick.
      stickToBottomRef.current = false
      syncScrollToLatestVisibility(true)
    }
    // ev.deltaY >= 0 (down or zero): no-op. Let auto-pin keep working.
  }, [syncScrollToLatestVisibility])

  const handleMessagesKeyDown = useCallback((ev: React.KeyboardEvent<HTMLDivElement>) => {
    if (ev.key === 'ArrowUp' || ev.key === 'PageUp' || ev.key === 'Home') {
      stickToBottomRef.current = false
      syncScrollToLatestVisibility(true)
    }
  }, [syncScrollToLatestVisibility])

  const handleMessagesScroll = useCallback(() => {
    const el = messagesRef.current
    if (!el) return

    const prevTop = lastScrollTopRef.current
    const currentTop = el.scrollTop
    lastScrollTopRef.current = currentTop

    if (currentTop < prevTop) {
      // Scrolled toward the top — release stick. This covers keyboard nav,
      // programmatic "scroll up", and any input we didn't catch at the wheel
      // layer. Safe because auto-pin always goes DOWN (scrollTop=scrollHeight).
      if (stickToBottomRef.current) stickToBottomRef.current = false
      syncScrollToLatestVisibility(true)
    } else if (isNearLatest(el)) {
      // At or near bottom → (re-)stick and collapse the rendered transcript
      // back to the latest two pages. Older messages remain in state/session,
      // but React stops reconciling DOM the user cannot see.
      if (!stickToBottomRef.current) stickToBottomRef.current = true
      if (visibleMessageLimit !== CHAT_INITIAL_RENDER_WINDOW) setVisibleMessageLimit(CHAT_INITIAL_RENDER_WINDOW)
      syncScrollToLatestVisibility(false)
    }

    if (el.scrollTop <= LINKED_SESSION_HISTORY_LOAD_THRESHOLD && !loadingEarlier) {
      pendingHistoryPrependRef.current = { previousHeight: el.scrollHeight, previousTop: el.scrollTop }
      if (hiddenMessageCount > 0) {
        setVisibleMessageLimit(prev => prev + CHAT_RENDER_PAGE_SIZE)
      } else if (pagedLinkedHistoryEnabled && hasEarlierMessages) {
        void loadEarlierMessagesRef.current()
      }
    }
  }, [isNearLatest, syncScrollToLatestVisibility, pagedLinkedHistoryEnabled, hasEarlierMessages, loadingEarlier, hiddenMessageCount, visibleMessageLimit])

  useLayoutEffect(() => {
    const pending = pendingHistoryPrependRef.current
    const el = messagesRef.current
    if (!pending || !el) return
    pendingHistoryPrependRef.current = null
    const delta = el.scrollHeight - pending.previousHeight
    el.scrollTop = pending.previousTop + delta
  }, [historicalMessages, visibleMessageLimit])

  useEffect(() => {
    if (loadingEarlier) return
    const el = messagesRef.current
    if (!el) return
    if (el.scrollHeight > el.clientHeight + LINKED_SESSION_HISTORY_LOAD_THRESHOLD) return

    pendingHistoryPrependRef.current = { previousHeight: el.scrollHeight, previousTop: el.scrollTop }
    if (hiddenMessageCount > 0) {
      setVisibleMessageLimit(prev => prev + CHAT_RENDER_PAGE_SIZE)
    } else if (pagedLinkedHistoryEnabled && hasEarlierMessages) {
      void loadEarlierMessagesRef.current()
    }
  }, [pagedLinkedHistoryEnabled, hasEarlierMessages, loadingEarlier, historicalMessages.length, messages.length, hiddenMessageCount, visibleMessageLimit])

  // Tracks whether a block-note composer is currently active (open AND has
  // non-empty text). While true, auto-scroll is suppressed so the viewport
  // doesn't jump out from under the user while they're typing a note in
  // place. New streamed tokens still land at the bottom of the scroll area,
  // we just don't yank the scroll position to follow them.
  const annotationComposerActiveRef = useRef(false)
  const [_annotationComposerActive, setAnnotationComposerActiveState] = useState(false)
  const setAnnotationComposerActive = useCallback((active: boolean) => {
    annotationComposerActiveRef.current = active
    setAnnotationComposerActiveState(active)
    if (active) {
      // Freezing the scroll position means auto-stick is no longer valid —
      // if the user wants to jump back they can click the "scroll to latest"
      // pill. This matches the behaviour when the user scrolls up manually.
      stickToBottomRef.current = false
      syncScrollToLatestVisibility(true)
    }
  }, [syncScrollToLatestVisibility])

  // Auto-scroll only while the user is already following the latest messages
  // AND there's no active note composer demanding stable scroll.
  useLayoutEffect(() => {
    const el = messagesRef.current
    if (!el) return
    if (annotationComposerActiveRef.current) return
    if (!stickToBottomRef.current) {
      syncScrollToLatestVisibility(true)
      return
    }
    el.scrollTop = el.scrollHeight
    syncScrollToLatestVisibility(false)
  }, [messages, syncScrollToLatestVisibility])

  /**
   * Updates or clears the note attached to a specific block. Passing `text === null`
   * deletes the note. Notes are stored inline on the underlying record (message,
   * tool block, or thinking block) so they persist with the conversation.
   */
  const updateBlockNote = useCallback((
    target:
      | { kind: 'message'; messageId: string }
      | { kind: 'tool'; messageId: string; toolBlockId: string }
      | { kind: 'thinking'; messageId: string; thinkingId: string },
    text: string | null,
  ) => {
    const nextNote: BlockNote | null = text && text.trim().length > 0
      ? { text: text.trim(), createdAt: Date.now() }
      : null
    const applyToCollection = (collection: ChatMessage[]): ChatMessage[] => collection.map(msg => {
      if (msg.id !== target.messageId) return msg
      if (target.kind === 'message') {
        if (nextNote) {
          const merged: BlockNote = msg.note
            ? { ...msg.note, text: nextNote.text, updatedAt: Date.now() }
            : nextNote
          return { ...msg, note: merged }
        }
        const { note: _discard, ...rest } = msg
        return rest
      }
      if (target.kind === 'tool') {
        const blocks = msg.toolBlocks?.map(b => {
          if (b.id !== target.toolBlockId) return b
          if (nextNote) {
            const merged: BlockNote = b.note
              ? { ...b.note, text: nextNote.text, updatedAt: Date.now() }
              : nextNote
            return { ...b, note: merged }
          }
          const { note: _discard, ...rest } = b
          return rest
        })
        return { ...msg, toolBlocks: blocks }
      }
      // thinking
      const thinkingBlocks = msg.thinkingBlocks?.map(tb => {
        if (tb.id !== target.thinkingId) return tb
        if (nextNote) {
          const merged: BlockNote = tb.note
            ? { ...tb.note, text: nextNote.text, updatedAt: Date.now() }
            : nextNote
          return { ...tb, note: merged }
        }
        const { note: _discard, ...rest } = tb
        return rest
      })
      return { ...msg, thinkingBlocks }
    })
    setMessagesSafe(prev => applyToCollection(prev))
    setHistoricalMessages(prev => applyToCollection(prev))
  }, [setMessagesSafe])

  /**
   * Collects every attached note from the conversation into a flat array,
   * tagged with the block kind and source snippet so downstream analysis
   * (or export) can surface them with context.
   */
  const collectAllNotes = useCallback((): Array<{
    kind: 'message' | 'tool' | 'thinking'
    messageId: string
    blockId?: string
    role?: string
    context: string
    note: BlockNote
  }> => {
    const out: Array<{ kind: 'message' | 'tool' | 'thinking'; messageId: string; blockId?: string; role?: string; context: string; note: BlockNote }> = []
    const sourceMessages = historicalMessages.length > 0
      ? [...historicalMessages, ...messages]
      : messages
    for (const m of sourceMessages) {
      if (m.note) {
        const snippet = m.content.trim().slice(0, 200)
        out.push({ kind: 'message', messageId: m.id, role: m.role, context: snippet, note: m.note })
      }
      for (const tb of m.toolBlocks ?? []) {
        if (tb.note) {
          const snippet = `${tb.name}: ${(tb.summary ?? tb.input ?? '').slice(0, 160)}`
          out.push({ kind: 'tool', messageId: m.id, blockId: tb.id, context: snippet, note: tb.note })
        }
      }
      for (const tk of m.thinkingBlocks ?? []) {
        if (tk.note) {
          const snippet = tk.content.slice(0, 200)
          out.push({ kind: 'thinking', messageId: m.id, blockId: tk.id, context: snippet, note: tk.note })
        }
      }
    }
    return out
  }, [historicalMessages, messages])

  /** Copies a Markdown-formatted export of all attached notes to the clipboard. */
  const exportNotesToClipboard = useCallback(async () => {
    const notes = collectAllNotes()
    if (notes.length === 0) {
      try { await navigator.clipboard.writeText('# Chat notes\n\n_No notes yet._') } catch { /* ignore */ }
      return
    }
    const lines = ['# Chat notes', '']
    for (const entry of notes) {
      const header = entry.kind === 'message'
        ? `## ${entry.role ?? 'message'}`
        : entry.kind === 'tool'
          ? '## tool call'
          : '## thinking'
      lines.push(header)
      lines.push(`> ${entry.context.replace(/\n/g, ' ')}`)
      lines.push('')
      lines.push(entry.note.text)
      lines.push('')
    }
    const payload = lines.join('\n')
    try { await navigator.clipboard.writeText(payload) } catch { /* ignore */ }
  }, [collectAllNotes])

  // Stream listener -- handles all rich event types from Claude Agent SDK
  useEffect(() => {
    const cleanup = window.electron?.stream?.onChunk((event: any) => {
      if (event.cardId !== tileId) return

      if (typeof event.sequence === 'number') {
        if (event.sequence <= lastJobSequenceRef.current) return
        lastJobSequenceRef.current = event.sequence
        setJobSequence(event.sequence)
      }
      if (typeof event.jobId === 'string') {
        setJobId(event.jobId)
      }

      const updateLast = (fn: (m: ChatMessage) => ChatMessage) =>
        setMessagesSafe(prev => {
          const last = prev[prev.length - 1]
          if (last?.isStreaming) return [...prev.slice(0, -1), fn(last)]
          return prev
        })

      if (event.type !== 'text') flushPendingStreamText()

      switch (event.type) {
        case 'session':
          if (event.sessionId) setSessionId(event.sessionId)
          break

        case 'text':
          if (event.text) queueStreamText(event.text)
          break

        case 'thinking_start': {
          const thinkingId = typeof event.thinkingId === 'string'
            ? event.thinkingId
            : `think-${Date.now()}`
          updateLast(m => ({
            ...m,
            // Keep legacy `thinking` in sync with the latest block so the
            // fallback indicator keeps working for messages without ids.
            thinking: { content: '', done: false, id: thinkingId },
            thinkingBlocks: [...(m.thinkingBlocks ?? []), { id: thinkingId, content: '', done: false }],
            contentBlocks: [...(m.contentBlocks ?? []), { type: 'thinking' as const, thinkingId }],
          }))
          break
        }

        case 'thinking':
          if (event.text) updateLast(m => {
            const targetId = typeof event.thinkingId === 'string' ? event.thinkingId : m.thinking?.id
            const existing = m.thinkingBlocks ?? []
            const idx = targetId
              ? existing.findIndex(b => b.id === targetId)
              : existing.length - 1
            let nextBlocks: ThinkingBlock[]
            let nextContentBlocks = m.contentBlocks
            if (idx >= 0) {
              nextBlocks = [...existing]
              nextBlocks[idx] = { ...nextBlocks[idx], content: nextBlocks[idx].content + event.text, done: false }
            } else {
              // No start event seen yet — synthesise an entry + content-block so
              // the delta still surfaces inline instead of being lost.
              const syntheticId = targetId ?? `think-${Date.now()}`
              nextBlocks = [...existing, { id: syntheticId, content: event.text, done: false }]
              nextContentBlocks = [...(m.contentBlocks ?? []), { type: 'thinking' as const, thinkingId: syntheticId }]
            }
            return {
              ...m,
              thinking: { content: (m.thinking?.content ?? '') + event.text, done: false, id: m.thinking?.id },
              thinkingBlocks: nextBlocks,
              contentBlocks: nextContentBlocks,
            }
          })
          break

        case 'tool_start': {
          const toolId = event.toolId ?? `tool-${Date.now()}`
          updateLast(m => {
            const nextBlock: ToolBlock = {
              id: toolId,
              name: event.toolName ?? 'tool',
              input: '',
              status: 'running',
            }
            const existingIndex = (m.toolBlocks ?? []).findIndex(block => block.id === toolId)
            const toolBlocks = existingIndex >= 0
              ? (m.toolBlocks ?? []).map((block, index) => index === existingIndex ? mergeToolBlockDuplicate(block, nextBlock) : block)
              : [...(m.toolBlocks ?? []), nextBlock]
            const hasContentRef = (m.contentBlocks ?? []).some(block => block.type === 'tool' && block.toolId === toolId)
            return {
              ...m,
              toolBlocks,
              contentBlocks: hasContentRef
                ? m.contentBlocks
                : [...(m.contentBlocks ?? []), { type: 'tool' as const, toolId }],
            }
          })
          break
        }

        case 'tool_input':
          if (event.text) updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            const targetIndex = event.toolId
              ? blocks.findIndex(b => b.id === event.toolId)
              : blocks.length - 1
            const last = targetIndex >= 0 ? blocks[targetIndex] : null
            if (last && targetIndex >= 0) blocks[targetIndex] = { ...last, input: last.input + event.text }
            return { ...m, toolBlocks: blocks }
          })
          break

        case 'tool_use':
          updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            const idx = event.toolId
              ? blocks.findIndex(b => b.id === event.toolId)
              : blocks.findIndex(b => b.name === event.toolName && b.status === 'running')
            if (idx >= 0) {
              blocks[idx] = {
                ...blocks[idx],
                name: event.toolName ?? blocks[idx].name,
                input: event.toolInput ?? blocks[idx].input,
                status: 'done',
              }
            }
            return { ...m, toolBlocks: blocks }
          })
          break

        case 'tool_summary':
          updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            const target = event.toolId
              ? blocks.findIndex(b => b.id === event.toolId)
              : (() => {
                  const idx = blocks.findLastIndex(b => b.status === 'done' && !b.summary)
                  return idx >= 0 ? idx : blocks.findLastIndex(b => b.status === 'running')
                })()
            if (target >= 0) {
              blocks[target] = {
                ...blocks[target],
                name: event.toolName ?? blocks[target].name,
                summary: typeof event.text === 'string' ? event.text : blocks[target].summary,
                status: 'done',
                fileChanges: Array.isArray(event.fileChanges) ? event.fileChanges : blocks[target].fileChanges,
                commandEntries: Array.isArray(event.commandEntries) ? event.commandEntries : blocks[target].commandEntries,
              }
            }
            return { ...m, toolBlocks: blocks }
          })
          break

        case 'tool_permission_request': {
          const pid = typeof event.toolId === 'string' ? event.toolId : null
          if (!pid) break
          const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
          const request: ToolPermissionRequest = {
            toolId: pid,
            toolName,
            provider: typeof event.provider === 'string' ? event.provider : 'claude',
            title: typeof event.title === 'string' ? event.title : null,
            description: typeof event.description === 'string' ? event.description : null,
            blockedPath: typeof event.blockedPath === 'string' ? event.blockedPath : null,
            workspaceDir: typeof event.workspaceDir === 'string' ? event.workspaceDir : null,
          }
          updateLast(m => {
            const nextBlock: ToolBlock = {
              id: pid,
              name: toolName,
              input: '',
              status: 'running',
            }
            const existingIndex = (m.toolBlocks ?? []).findIndex(block => block.id === pid)
            const toolBlocks = existingIndex >= 0
              ? (m.toolBlocks ?? []).map((block, index) => index === existingIndex ? mergeToolBlockDuplicate(block, nextBlock) : block)
              : [...(m.toolBlocks ?? []), nextBlock]
            const hasContentRef = (m.contentBlocks ?? []).some(block => block.type === 'tool' && block.toolId === pid)
            return {
              ...m,
              toolBlocks,
              contentBlocks: hasContentRef
                ? m.contentBlocks
                : [...(m.contentBlocks ?? []), { type: 'tool' as const, toolId: pid }],
            }
          })
          setPendingToolPermissions(prev => {
            const next = new Map(prev)
            next.set(pid, request)
            return next
          })
          setResolvedToolPermissions(prev => {
            if (!prev.has(pid)) return prev
            const next = new Map(prev)
            next.delete(pid)
            return next
          })
          break
        }

        case 'tool_permission_resolved': {
          const pid = typeof event.toolId === 'string' ? event.toolId : null
          if (!pid) break
          const decision: ToolPermissionDecision =
            event.decision === 'deny' || event.decision === 'never' || event.decision === 'once' || event.decision === 'session'
              || event.decision === 'today' || event.decision === 'forever'
              ? event.decision
              : 'once'
          setPendingToolPermissions(prev => {
            if (!prev.has(pid)) return prev
            const next = new Map(prev)
            next.delete(pid)
            return next
          })
          // Only persist a visible "resolved" banner for denials — allowed
          // tools let the normal chip render the tool result. Denials need a
          // permanent explanation since no tool_result follows.
          if (decision === 'deny' || decision === 'never') {
            updateLast(m => {
              const toolName = typeof event.toolName === 'string' ? event.toolName : 'tool'
              const existingIndex = (m.toolBlocks ?? []).findIndex(block => block.id === pid)
              const toolBlocks = existingIndex >= 0
                ? (m.toolBlocks ?? []).map(block => block.id === pid ? { ...block, name: toolName, status: 'done' as const } : block)
                : [...(m.toolBlocks ?? []), { id: pid, name: toolName, input: '', status: 'done' as const }]
              const hasContentRef = (m.contentBlocks ?? []).some(block => block.type === 'tool' && block.toolId === pid)
              return {
                ...m,
                toolBlocks,
                contentBlocks: hasContentRef
                  ? m.contentBlocks
                  : [...(m.contentBlocks ?? []), { type: 'tool' as const, toolId: pid }],
              }
            })
            setResolvedToolPermissions(prev => {
              const next = new Map(prev)
              next.set(pid, decision)
              return next
            })
          }
          break
        }

        case 'tool_progress':
          updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            const idx = blocks.findIndex(b => b.name === event.toolName && b.status === 'running')
            if (idx >= 0) blocks[idx] = { ...blocks[idx], elapsed: event.elapsed }
            return { ...m, toolBlocks: blocks }
          })
          break

        case 'block_stop':
          // Mark thinking as done and/or the last running tool as done when its block stops
          updateLast(m => {
            const blocks = [...(m.toolBlocks ?? [])]
            const lastRunning = blocks.findLastIndex(b => b.status === 'running')
            if (lastRunning >= 0) {
              blocks[lastRunning] = { ...blocks[lastRunning], status: 'done' }
            }
            const thinkingBlocks = [...(m.thinkingBlocks ?? [])]
            const targetId = typeof event.thinkingId === 'string' ? event.thinkingId : null
            if (targetId) {
              const ti = thinkingBlocks.findIndex(b => b.id === targetId)
              if (ti >= 0) thinkingBlocks[ti] = { ...thinkingBlocks[ti], done: true }
            } else {
              const ti = thinkingBlocks.findLastIndex(b => !b.done)
              if (ti >= 0) thinkingBlocks[ti] = { ...thinkingBlocks[ti], done: true }
            }
            return {
              ...m,
              thinking: m.thinking ? { ...m.thinking, done: true } : m.thinking,
              thinkingBlocks,
              toolBlocks: blocks,
            }
          })
          break

        case 'done':
          if (event.sessionId) setSessionId(event.sessionId)
          updateLast(m => ({
            ...m,
            isStreaming: false,
            cost: event.cost ?? m.cost,
            turns: event.turns ?? m.turns,
            toolBlocks: m.toolBlocks?.map(b => b.status === 'running' ? { ...b, status: 'done' as const } : b),
          }))
          setIsStreaming(false)
          window.electron?.bus?.publish(`tile:${tileId}`, 'activity', `chat:${tileId}`, {
            message: 'Assistant responded', role: 'assistant',
          })
          break

        case 'error':
          updateLast(m => ({
            ...m, content: m.content || `Error: ${event.error}`, isStreaming: false,
          }))
          setIsStreaming(false)
          break
      }
    })
    return cleanup
  }, [tileId, flushPendingStreamText, queueStreamText, setMessagesSafe])

  // Subscribe to incoming MCP peer commands on this tile's bus channel.
  // Strict gating so broadcasts from editor/extension peers don't spam every
  // chat tile: the command must target THIS tileId explicitly, and the
  // injected message id is a content hash so replays dedup instead of piling
  // up identical `[App.tsx] …` noise lines.
  useEffect(() => {
    if (!window.electron?.bus) return
    const seenPeerIds = new Set<string>()
    const unsubscribe = window.electron.bus.subscribe(`tile:${tileId}`, `chat:${tileId}:mcp`, (evt: any) => {
      if (!evt?.type?.startsWith('mcp_') && !String(evt.source || '').startsWith('mcp:')) return
      const payload = (evt.payload as Record<string, unknown>) || {}
      const command = typeof payload.command === 'string' ? payload.command : ''
      if (command !== 'chat_send_message' && command !== 'chat_acknowledge') return

      const targetCardId = typeof payload.cardId === 'string' ? payload.cardId
        : typeof payload.tileId === 'string' ? payload.tileId
        : null
      // Reject broadcasts that don't explicitly target this tile.
      if (!targetCardId || targetCardId !== tileId) return

      const text = typeof payload.message === 'string' ? payload.message.trim() : ''
      if (!text) return

      const sig = `${evt.source ?? 'peer'}::${command}::${text}`
      let hash = 0
      for (let i = 0; i < sig.length; i++) hash = (hash * 31 + sig.charCodeAt(i)) | 0
      const peerMsgId = `peer-${Math.abs(hash).toString(36)}`
      if (seenPeerIds.has(peerMsgId)) return
      seenPeerIds.add(peerMsgId)

      const prefix = command === 'chat_acknowledge' ? '🤝 ' : '📨 '
      const incomingMsg: ChatMessage = {
        id: peerMsgId,
        role: 'user',
        content: `${prefix}${text}`,
        timestamp: Date.now(),
        isStreaming: false,
      }
      setMessagesSafe(prev => (prev.some(m => m.id === peerMsgId) ? prev : [...prev, incomingMsg]))
    })
    return () => unsubscribe?.()
  }, [tileId])

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      const pos = ta.value.length
      ta.setSelectionRange(pos, pos)
    })
  }, [])

  const syncComposerHeight = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.max(CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT, Math.min(ta.scrollHeight, 134))}px`
  }, [])

  const addAttachments = useCallback((paths: string[]) => {
    if (paths.length === 0) return
    setAttachments(prev => {
      const seen = new Set(prev.map(item => item.path))
      const next = [...prev]
      for (const path of paths) {
        if (seen.has(path)) continue
        seen.add(path)
        next.push({ path, kind: isImagePath(path) ? 'image' : 'file' })
      }
      return next
    })
    setAcType(null)
    setAcQuery('')
    requestAnimationFrame(() => {
      syncComposerHeight()
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      const pos = ta.value.length
      ta.setSelectionRange(pos, pos)
    })
  }, [syncComposerHeight])

  const openAttachmentPicker = useCallback(async () => {
    const paths = await window.electron.chat?.selectFiles()
    if (paths && paths.length > 0) addAttachments(paths)
    setShowInsertMenu(false)
  }, [addAttachments])

  const removeAttachment = useCallback((path: string) => {
    setAttachments(prev => prev.filter(item => item.path !== path))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [])

  // ── Chat-surface extensions (e.g. Sketch) ─────────────────────────────────
  // Re-query whenever extensions are enabled/disabled or the global
  // extensions switch is flipped, so newly-installed chat surfaces (Sketch
  // etc.) appear in the composer `+` menu without requiring a tile reload.
  useEffect(() => {
    let cancelled = false
    const extensionsApi = (window.electron as unknown as { extensions?: { listChatSurfaces?: () => Promise<ChatSurfaceMenuEntry[] & Array<any>> } })?.extensions
    const fetchMenu = () => {
      if (!extensionsApi?.listChatSurfaces) {
        setChatSurfaceMenu([])
        return
      }
      extensionsApi.listChatSurfaces().then((entries: any[]) => {
        if (cancelled) return
        setChatSurfaceMenu((entries ?? []).map(e => ({
          extId: String(e.extId),
          surfaceId: String(e.id),
          label: String(e.label ?? e.id),
          description: e.description ? String(e.description) : undefined,
          icon: e.icon ? String(e.icon) : undefined,
          emits: e.emits === 'text' ? 'text' : 'image',
          defaultHeight: Number.isFinite(e.defaultHeight) ? Number(e.defaultHeight) : 260,
          minHeight: Number.isFinite(e.minHeight) ? Number(e.minHeight) : 160,
        })))
      }).catch(() => { if (!cancelled) setChatSurfaceMenu([]) })
    }
    fetchMenu()
    const onChanged = () => fetchMenu()
    window.addEventListener('codesurf:extensions-changed', onChanged)
    return () => {
      cancelled = true
      window.removeEventListener('codesurf:extensions-changed', onChanged)
    }
  }, [])

  const openChatSurface = useCallback(async (entry: ChatSurfaceMenuEntry) => {
    setShowInsertMenu(false)
    const existing = openChatSurfacesRef.current.find(surface => surface.extId === entry.extId && surface.surfaceId === entry.surfaceId)
    if (existing) {
      setActiveChatSurfaceId(existing.instanceId)
      return
    }
    const instanceId = `surf-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    const extensionsApi = (window.electron as unknown as { extensions?: { chatSurfaceEntry?: (ext: string, id: string, inst: string) => Promise<string | null> } })?.extensions
    const url = extensionsApi?.chatSurfaceEntry
      ? await extensionsApi.chatSurfaceEntry(entry.extId, entry.surfaceId, instanceId).catch(() => null)
      : null
    if (!url) {
      // Surface could not be resolved (extension missing / disabled).
      return
    }
    setOpenChatSurfaces(prev => [...prev, {
      extId: entry.extId,
      surfaceId: entry.surfaceId,
      label: entry.label,
      icon: entry.icon,
      instanceId,
      entryUrl: url,
      emits: entry.emits,
      height: Math.max(entry.minHeight, entry.defaultHeight),
      minHeight: entry.minHeight,
      payload: null,
      tileState: {},
      context: {},
      registeredActions: [],
    }])
    setActiveChatSurfaceId(instanceId)
  }, [])
  const openBuilderFromSketch = useCallback(async () => {
    const builderEntry = chatSurfaceMenu.find(entry => entry.extId === 'builder' || entry.surfaceId === 'builder')
    if (!builderEntry) return
    await openChatSurface(builderEntry)
  }, [chatSurfaceMenu, openChatSurface])

  const closeChatSurface = useCallback((instanceId?: string) => {
    const targetId = instanceId ?? activeChatSurfaceRef.current?.instanceId
    if (!targetId) return
    postToChatSurface(targetId, { type: 'contex-event', event: 'surface.clear', data: {} })
    pendingChatSurfaceActionResultsRef.current.forEach((pending, requestId) => {
      pending.reject(new Error('Chat surface closed'))
      pendingChatSurfaceActionResultsRef.current.delete(requestId)
    })
    setOpenChatSurfaces(prev => prev.filter(surface => surface.instanceId !== targetId))
    setActiveChatSurfaceId(prev => (prev === targetId ? null : prev))
  }, [postToChatSurface])

  // Listen for messages from the chat-surface iframes. Beyond surface.setPayload,
  // we support a small peer context/action model so Sketch and Builder can live
  // together as tabs inside chat instead of isolated one-off panels.
  useEffect(() => {
    const handler = async (e: MessageEvent) => {
      const msg = e.data
      if (!msg || typeof msg !== 'object') return
      const sourceWin = e.source as Window | null
      const reply = (result: unknown, error?: string) => {
        sourceWin?.postMessage({ type: 'contex-rpc-response', id: msg.id, result: error ? undefined : result, error }, '*')
      }

      if (msg.type === 'contex-bridge-ready' && typeof msg.tileId === 'string') {
        const surface = openChatSurfacesRef.current.find(candidate => candidate.instanceId === msg.tileId)
        if (!surface) return
        sourceWin?.postMessage({ type: 'contex-theme-vars', vars: chatSurfaceThemeVars }, '*')
        for (const peer of getChatSurfacePeerEntries(surface.instanceId)) {
          for (const entry of peer.contextEntries) {
            sourceWin?.postMessage({
              type: 'contex-event',
              event: 'context.peerChanged',
              data: { peerId: peer.peerId, key: entry.key, value: entry.value },
            }, '*')
          }
        }
        return
      }

      if (msg.type === 'contex-action-result' && typeof msg.requestId === 'string') {
        const pending = pendingChatSurfaceActionResultsRef.current.get(msg.requestId)
        if (!pending) return
        pendingChatSurfaceActionResultsRef.current.delete(msg.requestId)
        if (msg.error) pending.reject(new Error(String(msg.error)))
        else pending.resolve(msg.result)
        return
      }

      if (msg.type !== 'contex-rpc' || typeof msg.tileId !== 'string') return
      const surface = openChatSurfacesRef.current.find(candidate => candidate.instanceId === msg.tileId)
      if (!surface) return

      try {
        const basicRpc = await handleBasicChatSurfaceRpc({
          method: String(msg.method ?? ''),
          params: msg.params,
          surface,
          connectedPeerIds: getChatSurfacePeerEntries(surface.instanceId).map(peer => peer.peerId),
          workspaceId,
          workspacePath: _workspaceDir,
          themeColors: chatSurfaceThemeColors,
          extensionsApi: {
            invoke: window.electron?.extensions?.invoke,
            getSettings: window.electron?.extensions?.getSettings,
            setSettings: window.electron?.extensions?.setSettings,
          },
        })
        if (basicRpc.handled) {
          if ('payload' in basicRpc) {
            setOpenChatSurfaces(prev => prev.map(candidate => candidate.instanceId === surface.instanceId
              ? { ...candidate, payload: basicRpc.payload ?? null }
              : candidate))
          }
          reply(basicRpc.result)
          return
        }

        if (msg.method === 'tile.getState') {
          const key = typeof msg.params?.key === 'string' ? msg.params.key : null
          const liveSurface = openChatSurfacesRef.current.find(candidate => candidate.instanceId === surface.instanceId) ?? surface
          const tileState = liveSurface.tileState && typeof liveSurface.tileState === 'object' ? liveSurface.tileState : {}
          reply(key ? tileState[key] ?? null : tileState)
          return
        }

        if (msg.method === 'tile.setState') {
          let nextSurfaceState: Record<string, unknown> = {}
          const nextSurfaces = openChatSurfacesRef.current.map(candidate => {
            if (candidate.instanceId !== surface.instanceId) return candidate
            const currentState = candidate.tileState && typeof candidate.tileState === 'object' ? candidate.tileState : {}
            if (typeof msg.params?.key === 'string') {
              nextSurfaceState = { ...currentState, [msg.params.key]: msg.params.value }
            } else {
              const data = msg.params?.data ?? msg.params ?? {}
              nextSurfaceState = data && typeof data === 'object' && !Array.isArray(data)
                ? { ...(data as Record<string, unknown>) }
                : {}
            }
            return { ...candidate, tileState: nextSurfaceState }
          })
          openChatSurfacesRef.current = nextSurfaces
          setOpenChatSurfaces(nextSurfaces)
          reply(true)
          return
        }

        if (msg.method === 'context.get') {
          const key = String(msg.params?.key ?? '')
          reply(Object.prototype.hasOwnProperty.call(surface.context, key) ? surface.context[key] ?? null : null)
          return
        }

        if (msg.method === 'context.set') {
          const key = String(msg.params?.key ?? '')
          const value = msg.params?.value ?? null
          setOpenChatSurfaces(prev => prev.map(candidate => candidate.instanceId === surface.instanceId
            ? { ...candidate, context: { ...candidate.context, [key]: value } }
            : candidate))
          for (const peer of getChatSurfacePeerEntries(surface.instanceId)) {
            postToChatSurface(peer.peerId, {
              type: 'contex-event',
              event: 'context.peerChanged',
              data: { peerId: surface.instanceId, key, value },
            })
          }
          reply(true)
          return
        }

        if (msg.method === 'context.getAll') {
          const tagPrefix = typeof msg.params?.tagPrefix === 'string' ? msg.params.tagPrefix : undefined
          reply(Object.entries(surface.context)
            .filter(([key]) => !tagPrefix || key.startsWith(tagPrefix))
            .map(([key, value]) => ({ key, value })))
          return
        }

        if (msg.method === 'context.delete') {
          const key = String(msg.params?.key ?? '')
          setOpenChatSurfaces(prev => prev.map(candidate => {
            if (candidate.instanceId !== surface.instanceId) return candidate
            const nextContext = { ...candidate.context }
            delete nextContext[key]
            return { ...candidate, context: nextContext }
          }))
          for (const peer of getChatSurfacePeerEntries(surface.instanceId)) {
            postToChatSurface(peer.peerId, {
              type: 'contex-event',
              event: 'context.peerChanged',
              data: { peerId: surface.instanceId, key, value: null },
            })
          }
          reply(true)
          return
        }

        if (msg.method === 'context.getPeerContext') {
          const peerId = String(msg.params?.peerId ?? '')
          const peer = openChatSurfacesRef.current.find(candidate => candidate.instanceId === peerId)
          const tagPrefix = typeof msg.params?.tagPrefix === 'string' ? msg.params.tagPrefix : undefined
          reply(peer
            ? Object.entries(peer.context)
              .filter(([key]) => !tagPrefix || key.startsWith(tagPrefix))
              .map(([key, value]) => ({ key, value }))
            : [])
          return
        }

        if (msg.method === 'context.getAllPeerContext') {
          const tagPrefix = typeof msg.params?.tagPrefix === 'string' ? msg.params.tagPrefix : undefined
          const result: Record<string, Array<{ key: string; value: unknown }>> = {}
          for (const peer of getChatSurfacePeerEntries(surface.instanceId)) {
            result[peer.peerId] = peer.contextEntries.filter(entry => !tagPrefix || entry.key.startsWith(tagPrefix))
          }
          reply(result)
          return
        }

        if (msg.method === 'actions.register') {
          const name = String(msg.params?.name ?? '')
          const description = String(msg.params?.description ?? '')
          if (!name) throw new Error('Missing action name')
          setOpenChatSurfaces(prev => prev.map(candidate => candidate.instanceId === surface.instanceId
            ? {
              ...candidate,
              registeredActions: [
                ...candidate.registeredActions.filter(action => action.name !== name),
                { name, description },
              ],
            }
            : candidate))
          reply(true)
          return
        }

        if (msg.method === 'actions.invoke') {
          const peerId = String(msg.params?.peerId ?? '')
          const action = String(msg.params?.action ?? '')
          const peer = openChatSurfacesRef.current.find(candidate => candidate.instanceId === peerId)
          if (!peerId || !action || !peer) throw new Error('Missing peerId or action')
          if (!peer.registeredActions.some(candidate => candidate.name === action)) {
            throw new Error(`Peer ${peer.label} has not registered action ${action}`)
          }
          const requestId = `${surface.instanceId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`
          const result = await new Promise<unknown>((resolve, reject) => {
            pendingChatSurfaceActionResultsRef.current.set(requestId, { resolve, reject })
            postToChatSurface(peer.instanceId, {
              type: 'contex-action-invoke',
              action,
              params: msg.params?.params ?? {},
              requestId,
            })
            window.setTimeout(() => {
              const pending = pendingChatSurfaceActionResultsRef.current.get(requestId)
              if (!pending) return
              pendingChatSurfaceActionResultsRef.current.delete(requestId)
              reject(new Error(`Timed out waiting for ${peer.label}.${action}`))
            }, 10000)
          })
          reply(result)
          return
        }

        throw new Error(`Unsupported chat surface RPC method: ${String(msg.method ?? '')}`)
      } catch (error) {
        reply(null, error instanceof Error ? error.message : String(error))
      }
    }

    window.addEventListener('message', handler)
    return () => window.removeEventListener('message', handler)
  }, [chatSurfaceThemeColors, chatSurfaceThemeVars, getChatSurfacePeerEntries, postToChatSurface])

  const handleTileDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Ignore our own internal drags (queued-turn reorder, etc.) — they
    // advertise themselves via a custom mime type so we don't mistake the
    // drag for a file drop and trigger the attachment overlay.
    const dt = e.dataTransfer
    if (dt.types.includes('application/x-codesurf-queued-turn')) return
    const hasFiles = dt.types.includes('Files')
    const hasUri = dt.types.includes('text/uri-list')
    const hasPlain = dt.types.includes('text/plain')
    const hasFileRef = dt.types.includes('application/file-reference-path')
    if (!hasFiles && !hasUri && !hasPlain && !hasFileRef) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
    setIsDropTarget(true)
  }, [])

  const handleTileDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setIsDropTarget(false)
  }, [])

  const handleTileDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Bail out of file-attachment handling when this is an internal drag
    // (queued-turn reorder). The inner handlers already did the work and
    // the text/plain payload is a queue id, not a path.
    if (e.dataTransfer.types.includes('application/x-codesurf-queued-turn')) {
      setIsDropTarget(false)
      return
    }
    e.preventDefault()
    e.stopPropagation()
    setIsDropTarget(false)
    // Check file-reference-path first (from FileTile drags), then fall back to generic extraction
    const fileRef = e.dataTransfer.getData('application/file-reference-path')
    const droppedPaths = fileRef ? [fileRef] : getDroppedPaths(e.dataTransfer)
    if (droppedPaths.length === 0) return
    addAttachments(droppedPaths)
  }, [addAttachments])

  const dispatchMessageContent = useCallback(async (messageContent: string): Promise<boolean> => {
    const trimmedContent = messageContent.trim()
    if (!trimmedContent) return false
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
    const rawActiveMode = state?.mode ?? mode
    const activeMode = activeModeOptions.some(option => option.id === rawActiveMode)
      ? rawActiveMode
      : resolveProviderModeId(activeProvider, settings?.chatProviderModes?.[activeProvider])
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
      const recentEditContext = await buildRecentEditContext(activeMessages, _workspaceDir, userBodyText)
      const blockNotesContext = buildBlockNotesContext(activeMessages)
      const requestMessages = [...activeMessages, userMsg].map((message, index, allMessages) => {
        const isNewestUserMessage = index === allMessages.length - 1 && message.id === userMsg.id
        if (!isNewestUserMessage || (!recentEditContext && !blockNotesContext)) {
          return { role: message.role, content: message.content }
        }
        // Both context blocks are appended to the newest user turn so they
        // travel with the request the model is actually responding to, not
        // as floating system noise earlier in the transcript.
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
        workspaceDir: _workspaceDir,
        mcpEnabled: activeMcpEnabled,
        executionTarget,
        cloudHostId: nextCloudHostId,
        executionPreference: settings?.execution ?? null,
        messages: requestMessages,
        negotiatedTools: activeMcpEnabled ? peerToolNames : undefined,
        peers: peers.length > 0 ? peers : undefined,
        sessionId: activeSessionId,
      })
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
  }, [provider, model, mode, thinking, sessionId, mcpEnabled, messages, providerEntryById, currentProviderEntry, tileId, connectedPeers, _workspaceDir, executionTarget, cloudHostId, activeCloudHost, settings?.execution, settings?.chatProviderModes, peerToolNames, focusComposer, setMessagesSafe, queuedTurns, effectiveAgentMode, autoAgentMode, linkedSessionEntryId, linkedSessionHint, hasEarlierMessages, persistLatestState])

  const logQueueEvent = useCallback((
    type: 'enqueue' | 'dispatch' | 'delete' | 'complete' | 'clear' | 'reorder',
    details?: { queueId?: string; content?: string; preview?: string; attachmentCount?: number; createdAt?: number; draggedId?: string; targetId?: string; mode?: string; newParentId?: string | null },
  ) => {
    try {
      // Best-effort append to the queued-message event log. Tolerate two
      // failure modes that shouldn't surface as uncaught rejections:
      //   1) IPC API missing entirely (preload hasn't injected yet)
      //   2) Handler not yet registered on the main process (early-boot race)
      // The optional-chain handles (1); the .catch handles (2) and any
      // transient IPC failure. These events are advisory — losing one is
      // acceptable and must never bubble up as a promise rejection.
      const result = (window.electron as any)?.canvas?.queuedMessages?.append?.({
        type,
        at: Date.now(),
        workspaceId,
        tileId,
        ...(details ?? {}),
      })
      if (result && typeof result.catch === 'function') {
        result.catch(() => { /* best-effort; swallow */ })
      }
    } catch { /* best effort */ }
  }, [workspaceId, tileId])

  const flushQueueStateNow = useCallback((nextQueue: QueuedChatTurn[]) => {
    // Bypass the debounced persistLatestState so the tile-state JSON on disk
    // has the very latest queue before any possible crash or restart.
    const base = latestStateRef.current
    if (!base) return
    persistLatestState({ ...base, queuedTurns: nextQueue })
  }, [persistLatestState])

  // Reorder / re-parent a queued turn in response to a drag-drop gesture.
  // Supports three drop modes relative to the target row:
  //   'before' → sibling of target, inserted at the target's slot
  //   'after'  → sibling of target, inserted just after target (+ its kids)
  //   'into'   → nested under target as a child (flattened to one level)
  // Children of the dragged item are orphaned to the top level when the
  // dragged row moves — we intentionally keep the tree shallow (one level
  // of nesting) so the queue stays legible at a glance.
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

    // Orphan any children of dragged (they become top-level), and remove
    // dragged itself so we can re-insert it at the new location.
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
      // Only nest one level deep. If the target is already a child, treat
      // the drop as a sibling 'after' target.
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
      // 'after'
      newParentId = target.parentId ?? null
      if (!target.parentId) {
        // Insert after target AND its existing children so we don't split
        // the visual group.
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
  }, [queuedTurns, flushQueueStateNow, logQueueEvent])

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
  }, [input, attachments, implicitPeerImageAttachments, focusComposer, queuedTurns, linkedSessionEntryId, flushQueueStateNow, logQueueEvent])

  const sendMessage = useCallback(async () => {
    if (isStreaming) {
      queueCurrentDraft()
      return
    }

    // Flush the active chat-surface (Sketch / Builder) to a temp attachment
    // before composing the outgoing message. When Builder is active we persist
    // its HTML payload as a temporary .html file so the normal attachment path
    // can carry it into the turn just like files dropped from Finder.
    let flushedAttachments = mergeAttachments(attachments, implicitPeerImageAttachments)
    const surface = activeChatSurfaceRef.current
    if (surface) {
      try {
        await new Promise<void>((resolve) => {
          let done = false
          const ack = () => { if (done) return; done = true; resolve() }
          const timeout = setTimeout(ack, 1200)
          const onceAck = (e: MessageEvent) => {
            const msg = e.data
            if (!msg || typeof msg !== 'object') return
            if (msg.type === 'contex-rpc' && msg.method === 'surface.setPayload' && msg.tileId === surface.instanceId) {
              window.removeEventListener('message', onceAck)
              clearTimeout(timeout)
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

    // Local-only slash commands — handled client-side, never dispatched to
    // the model. `/export-notes` copies every attached BlockNote (message,
    // tool, thinking) into the clipboard as a Markdown report.
    if (messageContent.trim() === '/export-notes') {
      setInput('')
      setAcType(null)
      setAcQuery('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      await exportNotesToClipboard()
      return
    }

    // Signal the sidebar that the user just submitted a message in this thread
    // so it can promote the session to the top. This is the ONLY path that
    // should move a thread in the sidebar — opening, streaming-resume, or tool
    // continuation must not trigger it.
    recordChatMessageSent({ tileId, sessionId, entryId: linkedSessionEntryId })

    setInput('')
    setAcType(null)
    setAcQuery('')
    setAttachments([])

    // Clear every open surface for the next turn, then reset the tab strip.
    for (const openSurface of openChatSurfacesRef.current) {
      postToChatSurface(openSurface.instanceId, { type: 'contex-event', event: 'surface.clear', data: {} })
    }
    setOpenChatSurfaces([])
    setActiveChatSurfaceId(null)

    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    await dispatchMessageContent(messageContent)
  }, [isStreaming, input, attachments, implicitPeerImageAttachments, queueCurrentDraft, dispatchMessageContent, exportNotesToClipboard, postToChatSurface])

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
  }, [setMessagesSafe, tileId])

  const stopStreaming = useCallback(() => {
    window.electron?.chat?.stop?.(tileId)
    setIsStreaming(false)
    setJobId(null)
    setMessagesSafe(prev => prev.map(m => m.isStreaming ? { ...m, isStreaming: false } : m))
    focusComposer()
  }, [tileId, focusComposer])

  const clearConversation = useCallback(() => {
    if (isStreaming) return
    setMessagesSafe([])
    setAttachments([])
    setQueuedTurns([])
    flushQueueStateNow([])
    logQueueEvent('clear')
    setPreserveSessionSummary(false)
    setLinkedSessionEntryId(null)
    setLinkedSessionHint(null)
    setHasEarlierMessages(false)
    setSessionId(null)
    setJobId(null)
    setJobSequence(0)
    lastJobSequenceRef.current = 0
    setHistoricalMessages([])
    setLoadingEarlier(false)
    setEarlierLoadError(null)
    window.electron?.chat?.clearSession?.(tileId)
  }, [isStreaming, tileId, flushQueueStateNow, logQueueEvent])

  // Drop any previously-loaded older pages whenever the backing linked
  // session changes so the next thread starts from a clean tail view.
  useEffect(() => {
    setHistoricalMessages([])
    setEarlierLoadError(null)
    pendingHistoryPrependRef.current = null
  }, [sessionId, linkedSessionEntryId])

  useEffect(() => {
    if (isStreaming || queuedTurns.length === 0 || isFlushingQueuedTurnRef.current) return

    const nextTurn = queuedTurns[0]
    isFlushingQueuedTurnRef.current = true

    void (async () => {
      const sent = await dispatchMessageContent(nextTurn.content)
      const remaining = queuedTurns.filter(turn => turn.id !== nextTurn.id)
      setQueuedTurns(remaining)
      flushQueueStateNow(remaining)
      logQueueEvent('dispatch', { queueId: nextTurn.id })
      if (!sent) {
        setInput(current => current.trim() ? current : nextTurn.content)
      }
    })().finally(() => {
      isFlushingQueuedTurnRef.current = false
    })
  }, [isStreaming, queuedTurns, dispatchMessageContent, flushQueueStateNow, logQueueEvent])

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
  }, [isStreaming, tileId, queuedTurns, flushQueueStateNow, logQueueEvent, insertSteerMessageIntoStream, dispatchMessageContent, setMessagesSafe])

  const selectAcItem = useCallback((item: AutocompleteItem) => {
    const ta = textareaRef.current
    if (!ta) return
    const pos = ta.selectionStart ?? input.length
    const textBefore = input.slice(0, pos)
    const textAfter = input.slice(pos)

    // Find the trigger start position
    let triggerStart = pos
    if (acType === 'slash') {
      const match = textBefore.match(/(^|\s)(\/\w*)$/)
      if (match) triggerStart = pos - match[2].length
    } else if (acType === 'mention') {
      const match = textBefore.match(/@[\w./]*$/)
      if (match) triggerStart = pos - match[0].length
    }

    const replacement = item.value + ' '
    const newVal = input.slice(0, triggerStart) + replacement + textAfter
    setInput(newVal)
    if (item.attachPath) {
      setAttachments(prev => {
        if (prev.some(existing => existing.path === item.attachPath)) return prev
        return [...prev, { path: item.attachPath, kind: isImagePath(item.attachPath) ? 'image' : 'file' }]
      })
    }
    setAcType(null)
    setAcQuery('')

    // Restore focus and cursor position after React re-render
    requestAnimationFrame(() => {
      syncComposerHeight()
      if (ta) {
        ta.focus()
        const newPos = triggerStart + replacement.length
        ta.setSelectionRange(newPos, newPos)
      }
    })
  }, [input, acType, syncComposerHeight])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ─── Push-to-talk: hold spacebar (when input empty) to record ────────
    // Only triggers when the draft is empty so we don't break normal typing.
    // The keyup handler on the textarea stops recording when the key is released.
    // e.repeat guards against the auto-repeat keydown stream after the first event.
    if (
      e.key === ' '
      && !e.repeat
      && !e.metaKey && !e.ctrlKey && !e.altKey
      && input.length === 0
      && !isDictating
    ) {
      e.preventDefault()
      toggleDictation()
      return
    }
    // While recording, swallow further space events on the textarea so the
    // recognizer's audio gathering isn't visually polluted by " " characters
    // landing in the input. (We append the transcript on stop.)
    if (e.key === ' ' && isDictating) {
      e.preventDefault()
      return
    }

    // Autocomplete keyboard navigation
    if (acType && acItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setAcIndex(i => (i + 1) % acItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setAcIndex(i => (i - 1 + acItems.length) % acItems.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        selectAcItem(acItems[acIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setAcType(null)
        setAcQuery('')
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }, [sendMessage, acType, acItems, acIndex, selectAcItem, input.length, isDictating, toggleDictation])

  // Release push-to-talk on space-up. toggleDictation is idempotent — safe
  // even if the user held space without ever entering recording mode (e.g.
  // ignored because the input wasn't empty).
  const handleKeyUp = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === ' ' && isDictating) {
      e.preventDefault()
      toggleDictation()
    }
  }, [isDictating, toggleDictation])

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInput(val)
    syncComposerHeight()

    // Detect autocomplete triggers based on cursor position
    const pos = e.target.selectionStart ?? val.length
    const textBefore = val.slice(0, pos)

    // Slash command: `/` at start of input or after a space
    const slashMatch = textBefore.match(/(^|\s)\/(\w*)$/)
    if (slashMatch) {
      setAcType('slash')
      setAcQuery(slashMatch[2])
      setAcIndex(0)
      return
    }

    // @ mention: `@` anywhere
    const mentionMatch = textBefore.match(/@([\w./]*)$/)
    if (mentionMatch) {
      setAcType('mention')
      setAcQuery(mentionMatch[1])
      setAcIndex(0)
      return
    }

    // No trigger active
    setAcType(null)
    setAcQuery('')
  }, [syncComposerHeight])

  const isStartScreen = messages.length === 0 && !isStreaming

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

  const fontCtxValue = useMemo(() => ({ sans: fontSans, secondary: fontSecondary, mono: fontMono, size: fontSize, monoSize, lineHeight: fontLineHeight, weight: fontWeight, monoLineHeight, monoWeight, secondarySize, secondaryLineHeight, secondaryWeight }), [fontSans, fontSecondary, fontMono, fontSize, monoSize, fontLineHeight, fontWeight, monoLineHeight, monoWeight, secondarySize, secondaryLineHeight, secondaryWeight])

  const chatDispatchValue = useMemo<ChatDispatchValue>(() => ({
    sendAnswer: async (text: string) => {
      await dispatchMessageContent(text)
    },
  }), [dispatchMessageContent])

  return (
    <ChatDispatchCtx.Provider value={chatDispatchValue}>
    <FontCtx.Provider value={fontCtxValue}>
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

      {/* Horizontal split: [transcript + composer column] | [plan pane] */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'row',
        minHeight: 0,
        minWidth: 0,
      }}>
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        minWidth: 0,
        position: 'relative',
        justifyContent: isStartScreen ? 'center' : undefined,
      }}>

      {/* Messages */}
      <div
        ref={messagesRef}
        className={`chat-messages ${isStartScreen ? '' : 'cs-fade-scroll-y cs-fade-scroll-y-lg'}`}
        onScroll={handleMessagesScroll}
        onWheel={handleMessagesWheel}
        onKeyDown={handleMessagesKeyDown}
        tabIndex={-1}
        style={{
          flex: isStartScreen ? '0 0 auto' : 1,
          overflowY: isStartScreen ? 'visible' : 'auto',
          padding: isStartScreen ? '12px 14px 4px' : '12px 14px',
          overflowX: 'hidden',
          minHeight: 0,
          // Scrollbar hidden for testing — no gutter reservation needed while hidden.
          scrollbarWidth: 'none' as React.CSSProperties['scrollbarWidth'],
          // Disable Chrome's built-in scroll anchoring. React pins scrollTop =
          // scrollHeight on every message update (useLayoutEffect below);
          // anchoring would simultaneously try to preserve visual position as
          // streaming content changes height, producing up-and-down judder on
          // the currently-streaming section.
          overflowAnchor: 'none',
        }}
      >
        <div className="cs-chat-message-stack" style={{
          width: '100%',
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          minHeight: '100%',
        }}>
          {isStartScreen && (
             <div style={{
               display: 'flex', flexDirection: 'column',
               alignItems: 'center', justifyContent: 'center',
               color: theme.chat.text, textAlign: 'center',
             }}>
               <div style={{
                 fontSize: 'clamp(24px, 3vw, 34px)',
                 lineHeight: 1.15,
                 fontWeight: 550,
                 color: theme.chat.text,
                 letterSpacing: 0,
               }}>
                 What do you want to build today with CodeSurf?
               </div>
             </div>
           )}

          {hiddenMessageCount > 0 && (
            <div style={{
              alignSelf: 'center',
              maxWidth: CHAT_MESSAGE_MAX_WIDTH,
              padding: '8px 12px',
              borderRadius: 10,
              border: `1px solid ${theme.chat.divider}`,
              background: theme.chat.userBubble,
              color: theme.chat.muted,
              fontSize: 11,
              textAlign: 'center',
            }}>
              Showing the latest {renderedMessages.length} messages. Scroll up to reveal older pages; {hiddenMessageCount} older message{hiddenMessageCount === 1 ? '' : 's'} are preserved but not mounted.
            </div>
          )}

          {pagedLinkedHistoryEnabled && (loadingEarlier || earlierLoadError) && (
            <div style={{
              alignSelf: 'center',
              padding: '6px 12px 2px',
              borderRadius: 999,
              border: `1px solid ${theme.chat.divider}`,
              background: theme.chat.userBubble,
              color: theme.chat.muted,
              fontSize: 11,
              textAlign: 'center',
            }}>
              {loadingEarlier ? 'Loading older messages…' : earlierLoadError}
            </div>
          )}

          {(() => {
            // Walk the message list and group *consecutive* chip-only
            // assistant messages (thinking + tool calls, no prose text)
            // into a single visual cluster so their chips all live in one
            // wrapping row. The Claude Agent SDK emits a separate assistant
            // message per tool-round, so without this grouping each round
            // would render on its own line and waste horizontal space.
            //
            // Additionally, once a cluster grows past a threshold, older
            // completed tool chips progressively fold into a single "Called
            // N tools" summary — see applyLiveCollapse below. A grace period
            // keeps each freshly-finished chip readable for a few seconds
            // before it tucks into the summary, so the user can click it
            // while it's still fresh.
            const nodes: JSX.Element[] = []
            // Read toolCollapseTick so the transcript only recomputes when a
            // just-finished tool actually crosses the collapse grace window.
            void toolCollapseTick

            // Progressive-collapse tuning. Deliberately conservative so
            // short focused turns don't collapse at all.
            const COLLAPSE_MIN_ITEMS = 5   // cluster must have ≥ this to collapse
            const COLLAPSE_TAIL_SIZE = 2   // always keep at least this many expanded

            // Typed item used to represent one chip slot between extraction
            // and final render. Carries enough data for both live-collapse
            // decisions and the React render step.
            type ChipItem =
              | { kind: 'thinking'; key: string; block: ThinkingBlock }
              | { kind: 'tool-single'; key: string; block: ToolBlock; isLive: boolean }
              | { kind: 'tool-group-same'; key: string; blocks: ToolBlock[] }
              | { kind: 'tool-group-mixed'; key: string; blocks: ToolBlock[] }

            let clusterItems: ChipItem[] = []
            let clusterStartKey: string | null = null
            let clusterMsgIds: string[] = []

            const buildMessageBlockLookup = (msg: ChatMessage) => ({
              thinkingById: new Map((msg.thinkingBlocks ?? []).map(block => [block.id, block])),
              toolById: new Map((msg.toolBlocks ?? []).map(block => [block.id, block])),
            })

            // Extract chip items (thinking + tool groups) from a single
            // message's contentBlocks. Text blocks are ignored — callers
            // only invoke this on chip-only messages.
            const extractChipsFromMessage = (msg: ChatMessage, isLiveMessage: boolean): ChipItem[] => {
              const items: ChipItem[] = []
              const blocks = msg.contentBlocks ?? []
              if (blocks.length === 0 && isExternalAgentToolOnlyText(msg.content ?? '')) {
                for (const tb of getExternalAgentToolBlocks(msg.content ?? '')) {
                  if (!shouldRenderToolBlock(tb)) continue
                  items.push({
                    kind: 'tool-single',
                    key: `${msg.id}-${tb.id}`,
                    block: tb,
                    isLive: isLiveMessage,
                  })
                }
                return items
              }
              const { thinkingById, toolById } = buildMessageBlockLookup(msg)
              let i = 0
              while (i < blocks.length) {
                const block = blocks[i]
                if (block.type === 'thinking') {
                  const tb = thinkingById.get(block.thinkingId)
                  // Active thinking for the live message renders above the input bar — skip here
                  if (tb && (!isLiveMessage || tb.done)) items.push({
                    kind: 'thinking',
                    key: `${msg.id}-think-${block.thinkingId}`,
                    block: !isLiveMessage && !tb.done ? { ...tb, done: true } : tb,
                  })
                  i++; continue
                }
                if (block.type === 'tool') {
                  const rawTools: ToolBlock[] = []
                  while (i < blocks.length) {
                    const cb = blocks[i]
                    if (cb.type !== 'tool') break
                    const tb = toolById.get(cb.toolId)
                    if (tb && shouldRenderToolBlock(tb)) rawTools.push(tb)
                    i++
                  }
                  const collapsibleTools = rawTools.filter(tb => tb.status === 'done' && !(tb.fileChanges?.length) && !isCheckpointToolBlock(tb) && !isDreamToolBlock(tb))
                  const collapsibleIds = new Set(collapsibleTools.map(t => t.id))
                  const uniqueNames = new Set(collapsibleTools.map(t => t.name))
                  const useSameNameGroup = collapsibleTools.length >= 3 && uniqueNames.size === 1
                  const useMixedGroup = collapsibleTools.length >= 3 && uniqueNames.size > 1
                  let groupEmitted = false
                  for (const tb of rawTools) {
                    if (collapsibleIds.has(tb.id) && (useSameNameGroup || useMixedGroup)) {
                      if (!groupEmitted) {
                        groupEmitted = true
                        if (useSameNameGroup) items.push({
                          kind: 'tool-group-same',
                          key: `${msg.id}-grp-${tb.id}`,
                          blocks: collapsibleTools,
                        })
                        else items.push({
                          kind: 'tool-group-mixed',
                          key: `${msg.id}-mgrp-${tb.id}`,
                          blocks: collapsibleTools,
                        })
                      }
                      continue
                    }
                    items.push({
                      kind: 'tool-single',
                      key: `${msg.id}-${tb.id}`,
                      block: tb,
                      isLive: isLiveMessage,
                    })
                  }
                  continue
                }
                i++
              }
              return items
            }

            const renderChipItem = (item: ChipItem): JSX.Element => {
              if (item.kind === 'thinking') {
                return <ThinkingBlockView key={item.key} thinking={item.block} />
              }
              if (item.kind === 'tool-single') {
                return <ToolBlockView key={item.key} block={item.block} isLive={item.isLive} />
              }
              if (item.kind === 'tool-group-same') {
                return <CollapsedToolGroup key={item.key} name={item.blocks[0]?.name ?? ''} blocks={item.blocks} />
              }
              return <MixedToolGroup key={item.key} blocks={item.blocks} />
            }

            const renderChipRow = (items: JSX.Element[], key: string): JSX.Element => {
              return (
                <div key={key} style={CHAT_CHIP_ROW_STYLE}>
                  {items}
                </div>
              )
            }

            // Progressive collapse: walk the cluster's item list, figure out
            // how much of the tail should stay expanded (all items that are
            // running, or completed within the grace window, plus at least
            // COLLAPSE_TAIL_SIZE items), and fold everything before that into
            // a single synthetic "Called N tools" summary chip. Does nothing
            // when the cluster is short, or when the foldable prefix has
            // fewer than 2 items (a 1-item summary is pointless noise).
            const applyLiveCollapse = (items: ChipItem[]): ChipItem[] => {
              if (items.length < COLLAPSE_MIN_ITEMS) return items
              const now = Date.now()
              const isEligibleToFold = (item: ChipItem): boolean => {
                if (item.kind === 'thinking') return item.block.done
                if (item.kind === 'tool-single') {
                  if (item.block.status !== 'done') return false
                  const at = toolCompletedAtRef.current.get(item.block.id) ?? now
                  return now - at >= LIVE_TOOL_COLLAPSE_GRACE_MS
                }
                return true // already-grouped chips are always foldable
              }
              // Start by keeping the last COLLAPSE_TAIL_SIZE items, then
              // extend the tail backward across any non-eligible items.
              let cut = Math.max(items.length - COLLAPSE_TAIL_SIZE, 0)
              while (cut > 0 && !isEligibleToFold(items[cut - 1])) cut -= 1
              const head = items.slice(0, cut)
              const tail = items.slice(cut)
              if (head.length < 2) return items
              // Flatten head items into a ToolBlock[] for the summary.
              // Thinking chips don't contribute to the tool count but we
              // still fold them away (their timing is already summarized).
              const folded: ToolBlock[] = []
              for (const item of head) {
                if (item.kind === 'tool-single') folded.push(item.block)
                else if (item.kind === 'tool-group-same' || item.kind === 'tool-group-mixed') {
                  folded.push(...item.blocks)
                }
              }
              if (folded.length === 0) return items
              const summary: ChipItem = {
                kind: 'tool-group-mixed',
                key: `live-collapse-${head[0].key}`,
                blocks: folded,
              }
              return [summary, ...tail]
            }

            // A message qualifies for clustering only when it is an assistant
            // turn that is pure chip content — any prose text (content or a
            // 'text' contentBlock) breaks the cluster so prose lines keep
            // their normal bubble rendering.
            const isChipOnly = (msg: ChatMessage): boolean => {
              if (msg.role !== 'assistant') return false
              const blocks = msg.contentBlocks ?? []
              if (blocks.length === 0) return isExternalAgentToolOnlyText(msg.content ?? '')
              if (blocks.some(b => b.type === 'text')) return false
              if ((msg.content ?? '').trim().length > 0) return false
              return blocks.some(b => b.type === 'tool' || b.type === 'thinking')
            }

            const flushCluster = () => {
              if (clusterItems.length === 0) return
              const lastId = clusterMsgIds[clusterMsgIds.length - 1]
              const lastMsg = renderedMessages.find(m => m.id === lastId)
              const clusterId = clusterStartKey ?? 'cluster'
              const finalItems = applyLiveCollapse(clusterItems)
              nodes.push(
                <BlockNoteAffordance
                  key={`cluster-${clusterId}`}
                  note={lastMsg?.note}
                  side="right"
                  onComposerActiveChange={setAnnotationComposerActive}
                  onUpdateNote={(text) => updateBlockNote({ kind: 'message', messageId: lastId }, text)}
                >
                  {renderChipRow(finalItems.map(renderChipItem), `cluster-row-${clusterId}`)}
                </BlockNoteAffordance>
              )
              clusterItems = []
              clusterStartKey = null
              clusterMsgIds = []
            }

            for (const msg of renderedMessages) {
              const isLiveMessage = Boolean(
                msg.role === 'assistant'
                && isStreaming
                && msg.isStreaming
                && msg.id === renderedMessages[renderedMessages.length - 1]?.id
              )
              if (isChipOnly(msg)) {
                const items = extractChipsFromMessage(msg, isLiveMessage)
                if (clusterItems.length === 0) clusterStartKey = msg.id
                clusterItems.push(...items)
                clusterMsgIds.push(msg.id)
                continue
              }
              flushCluster()
              const { thinkingById, toolById } = buildMessageBlockLookup(msg)
              const visibleToolBlocks = msg.toolBlocks?.filter(shouldRenderToolBlock) ?? []
              const hasVisibleToolBlocks = visibleToolBlocks.length > 0
              // Smart-side: user bubbles are right-aligned, so the annotation
              // icon sits on their LEFT where the gutter is; for assistant /
              // tool / thinking content that's left-aligned, the icon sits on
              // the RIGHT. This gives symmetrical "note in the empty space"
              // behaviour without the user having to choose a side.
              const annotationSide: 'left' | 'right' = msg.role === 'user' ? 'left' : 'right'
              nodes.push(
              <BlockNoteAffordance
                key={msg.id}
                note={msg.note}
                side={annotationSide}
                onComposerActiveChange={setAnnotationComposerActive}
                onUpdateNote={(text) => updateBlockNote({ kind: 'message', messageId: msg.id }, text)}
              >
              <div style={{
                display: 'flex', flexDirection: 'column',
                alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
                width: msg.role === 'user' ? 'auto' : '100%',
                maxWidth: msg.role === 'user' ? '60%' : '100%',
                minWidth: 0,
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                marginBottom: msg.role === 'user' ? 5 : 0,
                gap: 2,
                ...(isLiveMessage ? {} : CHAT_OFFSCREEN_MESSAGE_STYLE),
              }}>
                {/* Thinking block — show the pre-tools indicator only when there
                    are no inline thinking content-blocks yet, so we don't render
                    the first thinking block twice. */}
                {(() => {
                  const hasInlineThinking = (msg.contentBlocks ?? []).some(b => b.type === 'thinking')
                  const legacyThinking = msg.thinking
                    ? (!isLiveMessage && !msg.thinking.done ? { ...msg.thinking, done: true } : msg.thinking)
                    : (isLiveMessage && !msg.content ? { content: '', done: false } : null)
                  // Skip active legacy thinking for live messages — shown above input bar instead
                  const showLegacy = !hasInlineThinking && Boolean(legacyThinking) && (!isLiveMessage || legacyThinking?.done)
                  return showLegacy
                    ? <ThinkingBlockView thinking={legacyThinking ?? { content: '', done: false }} />
                    : null
                })()}

                {/* Interleaved content blocks — text and tool calls in stream order */}
                {(msg.contentBlocks?.length ?? 0) > 0 ? (
                  <>
                    {(() => {
                      const elements: JSX.Element[] = []
                      const blocks = msg.contentBlocks!
                      let i = 0
                      // Accumulator for a contiguous run of "chip-row" content
                      // (thinking + tool blocks). Text blocks break the run and
                      // cause the accumulator to flush into a single flex
                      // container so thinking chips sit inline with tool chips
                      // on the same wrapping row.
                      let chipRow: JSX.Element[] = []
                      let chipRowStartIdx = i
                      const flushChipRow = () => {
                        if (chipRow.length === 0) return
                        elements.push(renderChipRow(chipRow, `chiprow-${chipRowStartIdx}`))
                        chipRow = []
                      }
                      while (i < blocks.length) {
                        const block = blocks[i]
                        if (block.type === 'thinking') {
                          if (chipRow.length === 0) chipRowStartIdx = i
                          const tb = thinkingById.get(block.thinkingId)
                          // Active (not-done) thinking blocks for the live message render
                          // in the fixed zone above the input bar — skip them here so they
                          // don't also appear inside the message scroll area. Once done they
                          // fall through and render as the static "copy" in the chip row.
                          if (tb && (!isLiveMessage || tb.done)) {
                            chipRow.push(
                              <ThinkingBlockView
                                key={`think-${block.thinkingId}`}
                                thinking={!isLiveMessage && !tb.done ? { ...tb, done: true } : tb}
                              />
                            )
                          }
                          i++
                          continue
                        }
                        if (block.type === 'tool') {
                          if (chipRow.length === 0) chipRowStartIdx = i
                          // Collect consecutive tool blocks, then sub-group same-name completed ones
                          const rawTools: ToolBlock[] = []
                          while (i < blocks.length) {
                            const cb = blocks[i]
                            if (cb.type !== 'tool') break
                            const tb = toolById.get(cb.toolId)
                            if (tb && shouldRenderToolBlock(tb)) rawTools.push(tb)
                            i++
                          }
                          // Grouping rules:
                          //   - 3+ collapsible tool blocks all with the same name → "Read x6" chip.
                          //   - 3+ collapsible tool blocks with mixed names → "Called N tools" chip.
                          //   - Otherwise each chip renders inline.
                          //   - Non-collapsible tools (running / file-change / checkpoints) always stay inline.
                          const collapsibleTools = rawTools.filter(tb => tb.status === 'done' && !(tb.fileChanges?.length) && !isCheckpointToolBlock(tb) && !isDreamToolBlock(tb))
                          const collapsibleIds = new Set(collapsibleTools.map(t => t.id))
                          const uniqueNames = new Set(collapsibleTools.map(t => t.name))
                          const useSameNameGroup = collapsibleTools.length >= 3 && uniqueNames.size === 1
                          const useMixedGroup = collapsibleTools.length >= 3 && uniqueNames.size > 1
                          let groupEmitted = false
                          for (const tb of rawTools) {
                            if (collapsibleIds.has(tb.id) && (useSameNameGroup || useMixedGroup)) {
                              if (!groupEmitted) {
                                groupEmitted = true
                                if (useSameNameGroup) {
                                  chipRow.push(<CollapsedToolGroup key={`grp-${tb.id}`} name={tb.name} blocks={collapsibleTools} />)
                                } else {
                                  chipRow.push(<MixedToolGroup key={`mgrp-${tb.id}`} blocks={collapsibleTools} />)
                                }
                              }
                              continue
                            }
                            chipRow.push(<ToolBlockView key={tb.id} block={tb} isLive={isLiveMessage} />)
                          }
                          continue
                        }
                        {
                          // Any non-chip block (text) flushes the pending chip row
                          // first, then renders itself at block level.
                          flushChipRow()
                          const isLastBlock = i === blocks.length - 1
                          elements.push(
                            <div key={`text-${i}`} style={{
                              background: msg.role === 'user' ? theme.chat.userBubble : 'transparent',
                              border: msg.role === 'user' ? '1px solid transparent' : '0',
                              boxShadow: msg.role === 'user'
                                ? theme.mode === 'light'
                                  ? 'var(--cs-edge-shadow), 0 0 0 1px rgba(15,23,42,0.12)'
                                  : 'var(--cs-edge-shadow)'
                                : undefined,
                              borderRadius: 14,
                              padding: '8px 12px',
                              fontSize, lineHeight: fontLineHeight,
                              wordBreak: 'break-word',
                              color: theme.chat.text, position: 'relative',
                              width: '100%', minWidth: 0, overflow: 'visible', boxSizing: 'border-box',
                            }}>
                              <ChatMessageContent text={block.text} isStreaming={isLiveMessage && isLastBlock} isUser={msg.role === 'user'} readAttachmentPaths={readAttachmentPaths} />
                            </div>
                          )
                          i++
                        }
                      }
                      // Flush any trailing chip row (e.g. stream ended on a
                      // thinking or tool block without a subsequent text block).
                      flushChipRow()
                      // WorkingChipView moved to the fixed zone above the input bar.
                      return elements
                    })()}
                  </>
                ) : (
                  <>
                    {/* Fallback: legacy layout for messages without contentBlocks */}
                    {hasVisibleToolBlocks && (
                      (() => {
                        const out: JSX.Element[] = []
                        const collapsibleTools = visibleToolBlocks.filter(tb => tb.status === 'done' && !(tb.fileChanges?.length))
                        const collapsibleIds = new Set(collapsibleTools.map(t => t.id))
                        const uniqueNames = new Set(collapsibleTools.map(t => t.name))
                        const useSameNameGroup = collapsibleTools.length >= 3 && uniqueNames.size === 1
                        const useMixedGroup = collapsibleTools.length >= 3 && uniqueNames.size > 1
                        let groupEmitted = false
                        for (const tb of visibleToolBlocks) {
                          if (collapsibleIds.has(tb.id) && (useSameNameGroup || useMixedGroup)) {
                            if (!groupEmitted) {
                              groupEmitted = true
                              if (useSameNameGroup) {
                                out.push(<CollapsedToolGroup key={`grp-${tb.id}`} name={tb.name} blocks={collapsibleTools} />)
                              } else {
                                out.push(<MixedToolGroup key={`mgrp-${tb.id}`} blocks={collapsibleTools} />)
                              }
                            }
                            continue
                          }
                          out.push(<ToolBlockView key={tb.id} block={tb} isLive={isLiveMessage} />)
                        }
                        return renderChipRow(out, `legacy-tools-${msg.id}`)
                      })()
                    )}
                    {msg.content && (
                      <div style={{
                        background: msg.role === 'user' ? theme.chat.userBubble : 'transparent',
                        border: msg.role === 'user' ? '1px solid transparent' : '0',
                        boxShadow: msg.role === 'user'
                          ? theme.mode === 'light'
                            ? 'var(--cs-edge-shadow), 0 0 0 1px rgba(15,23,42,0.12)'
                            : 'var(--cs-edge-shadow)'
                          : undefined,
                        borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                        padding: '8px 12px',
                        fontSize, lineHeight: fontLineHeight,
                        wordBreak: 'break-word',
                        color: theme.chat.text, position: 'relative',
                        width: '100%', minWidth: 0, overflow: 'visible', boxSizing: 'border-box',
                      }}>
                        <ChatMessageContent text={msg.content} isStreaming={isLiveMessage} isUser={msg.role === 'user'} readAttachmentPaths={readAttachmentPaths} />
                        {isLiveMessage && msg.content.length === 0 && !hasVisibleToolBlocks && (
                          <WorkingDots />
                        )}
                      </div>
                    )}
                  </>
                )}
                {/* Cost/turns/time footer */}
                {msg.role === 'assistant' && (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    fontSize: monoSize - 2, color: theme.chat.subtle, fontFamily: fontMono,
                    padding: '0 4px',
                    marginTop: -5,
                    // Reserve a stable footer line so the layout doesn't jump
                    // ~10px when streaming finishes and cost/turns/time first
                    // appear. Without this the auto-pin shifts content up.
                    minHeight: monoSize + 2,
                    visibility: (!isLiveMessage && msg.cost != null) ? 'visible' : 'hidden',
                  }}>
                    {!isLiveMessage && msg.cost != null && (<>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <DollarSign size={9} /> ${msg.cost.toFixed(4)}
                    </span>
                    {msg.turns != null && (
                      <span>{msg.turns} turn{msg.turns !== 1 ? 's' : ''}</span>
                    )}
                    <span>{relativeTime(msg.timestamp)}</span>
                    {/* Per-message speak / stop button — appears on every
                        completed assistant message. Click speaks (or
                        re-speaks) this message; if it's currently being
                        spoken, click stops just that message. */}
                    <button
                      type="button"
                      onClick={() => {
                        if (ttsState.currentMessageId === msg.id) {
                          ttsPlayer.stopMessage(msg.id)
                        } else {
                          void speakMessage({
                            messageId: msg.id,
                            text: msg.content,
                            ttsProvider: voiceSettings.ttsProvider,
                            ttsVoice: voiceSettings.ttsVoice,
                            spokifyModel: voiceSettings.spokifyModel,
                            force: true,
                          })
                        }
                      }}
                      onMouseDown={e => e.preventDefault()}
                      title={ttsState.currentMessageId === msg.id ? 'Stop speaking' : 'Speak this message'}
                      style={{
                        marginLeft: 'auto', background: 'transparent', border: 'none',
                        cursor: 'pointer', padding: 2, display: 'flex',
                        color: ttsState.currentMessageId === msg.id ? theme.accent.base : theme.chat.subtle,
                      }}
                    >
                      <Mic size={10} strokeWidth={2.2} />
                    </button>
                    </>)}
                  </div>
                )}
                {/* User message time footer */}
                {!isLiveMessage && msg.role === 'user' && (
                  <div style={{
                    fontSize: monoSize - 2, color: theme.chat.subtle, fontFamily: fontMono,
                    padding: '0 6px', textAlign: 'right',
                    marginTop: 2,
                    lineHeight: 1.2,
                    alignSelf: 'flex-end',
                    overflow: 'visible',
                  }}>
                    {relativeTime(msg.timestamp)}
                  </div>
                )}

              </div>
              </BlockNoteAffordance>
              )
            }
            flushCluster()
            return nodes
          })()}
        </div>
      </div>

      <div style={{ flexShrink: 0, position: 'relative', overflow: 'visible' }}>
        {showScrollToLatest && (
          <div style={{
            position: 'absolute',
            top: 0,
            left: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'flex',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 3,
          }}>
            <button
              onClick={() => scrollToLatest()}
              title="Jump to latest"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 30,
                height: 30,
                minWidth: 30,
                padding: 0,
                borderRadius: '50%',
                border: `0.5px solid ${theme.border.strong}`,
                background: theme.surface.panelElevated,
                color: theme.text.secondary,
                cursor: 'pointer',
                boxShadow: theme.shadow.panel,
                backdropFilter: 'blur(10px)',
                pointerEvents: 'auto',
                ...NON_SELECTABLE_UI_STYLE,
              }}
            >
              <ArrowDown size={15} strokeWidth={1.8} />
            </button>
          </div>
        )}

        {liveComposerActivityChip}

        {latestChangeDrawer && (
          <ChatComposerDrawerFrame style={{
            // Match the queued-messages drawer's indent + bottom-tuck so the
            // changes drawer reads as pulled out from behind the composer
            // rather than sitting on top of it.
            width: `calc(${CHAT_COMPOSER_WIDTH} - 24px)`,
            minWidth: `calc(${CHAT_COMPOSER_MIN_WIDTH_STYLE} - 24px)`,
            margin: '0 auto 0 auto',
          }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '10px 14px',
                ...NON_SELECTABLE_UI_STYLE,
              }}
            >
              <button
                type="button"
                onClick={() => setLatestChangeDrawerExpanded(v => !v)}
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  flexWrap: 'wrap',
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  cursor: 'pointer',
                  textAlign: 'left',
                  color: theme.chat.textSecondary,
                  fontFamily: fontSans,
                  ...NON_SELECTABLE_UI_STYLE,
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 600, color: theme.chat.text }}>
                  {latestChangeDrawer.fileCount} file{latestChangeDrawer.fileCount === 1 ? '' : 's'} changed
                </span>
                {latestChangeDrawerHasStats && (
                  <>
                    <span style={{ fontSize: 12, fontWeight: 600, color: theme.status.success }}>
                      +{latestChangeDrawer.additions}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: theme.status.danger }}>
                      -{latestChangeDrawer.deletions}
                    </span>
                  </>
                )}
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
                {latestCheckpointId && (
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation()
                      void restoreLatestCheckpoint()
                    }}
                    disabled={isRestoringLatestCheckpoint}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: isRestoringLatestCheckpoint ? theme.chat.muted : theme.chat.text,
                      fontSize: 12,
                      fontFamily: fontSans,
                      fontWeight: 500,
                      cursor: isRestoringLatestCheckpoint ? 'default' : 'pointer',
                      padding: 0,
                      opacity: isRestoringLatestCheckpoint ? 0.6 : 1,
                      ...NON_SELECTABLE_UI_STYLE,
                    }}
                  >
                    {isRestoringLatestCheckpoint ? 'Undoing…' : 'Undo'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation()
                    setLatestChangeDrawerExpanded(v => !v)
                  }}
                  title={latestChangeDrawerExpanded ? 'Collapse changes' : 'Expand changes'}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 22,
                    height: 22,
                    border: 'none',
                    background: 'transparent',
                    color: theme.chat.textSecondary,
                    cursor: 'pointer',
                    padding: 0,
                    ...NON_SELECTABLE_UI_STYLE,
                  }}
                >
                  <ChevronRight size={14} style={{
                    transform: latestChangeDrawerExpanded ? 'rotate(90deg)' : 'none',
                    transition: 'transform 0.15s',
                    opacity: 0.55,
                  }} />
                </button>
              </div>
            </div>
            {latestChangeDrawerExpanded && (
              <div style={{
                borderTop: `1px solid ${theme.chat.divider}`,
                display: 'flex',
                flexDirection: 'column',
              }}>
                {latestChangeDrawer.fileChanges.map((change, index) => {
                  const fileKey = `${latestChangeDrawer.key}:${change.path}:${index}`
                  const fileHasDiff = hasRenderableFileChangeDiff(change)
                  const isExpanded = latestChangeDrawerExpandedFiles[fileKey] ?? false
                  const fileHasStats = hasVisibleFileChangeStats(change)
                  return (
                    <div
                      key={fileKey}
                      style={{
                        borderTop: index > 0 ? `1px solid ${theme.chat.divider}` : 'none',
                        background: theme.surface.panelMuted,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (fileHasDiff) toggleLatestChangeDrawerFile(fileKey)
                        }}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '12px 14px',
                          border: 'none',
                          background: 'transparent',
                          cursor: fileHasDiff ? 'pointer' : 'default',
                          textAlign: 'left',
                          color: theme.chat.text,
                          fontFamily: fontSans,
                          fontSize: 12,
                          ...NON_SELECTABLE_UI_STYLE,
                        }}
                      >
                        <span style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}>
                          {change.path}
                        </span>
                        {fileHasStats && (
                          <>
                            <span style={{ color: theme.status.success, fontWeight: 600, flexShrink: 0 }}>
                              +{change.additions}
                            </span>
                            <span style={{ color: theme.status.danger, fontWeight: 600, flexShrink: 0 }}>
                              -{change.deletions}
                            </span>
                          </>
                        )}
                        <ChevronRight size={14} style={{
                          transform: isExpanded ? 'rotate(90deg)' : 'none',
                          transition: 'transform 0.15s',
                          opacity: fileHasDiff ? 0.55 : 0,
                          flexShrink: 0,
                        }} />
                      </button>
                      {isExpanded && fileHasDiff && (
                        <div style={{ borderTop: `1px solid ${theme.chat.divider}` }}>
                          <DiffView
                            diff={change.diff}
                            path={change.path}
                            fontSize={Math.max(10, monoSize - 2)}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
                <div style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  padding: '10px 14px 12px',
                  borderTop: `1px solid ${theme.chat.divider}`,
                  background: theme.surface.panelMuted,
                }}>
                  <button
                    type="button"
                    onClick={reviewLatestChanges}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: theme.chat.textSecondary,
                      fontSize: 11,
                      fontFamily: fontSans,
                      fontWeight: 500,
                      cursor: 'pointer',
                      padding: 0,
                      ...NON_SELECTABLE_UI_STYLE,
                    }}
                  >
                    Jump to message
                  </button>
                </div>
              </div>
            )}
          </ChatComposerDrawerFrame>
        )}

        {queuedTurns.length > 0 && (() => {
          // Count crash/error-looking items once per render so the summary
          // row can call them out in red — urgent rows are rendered with a
          // red left-bar when expanded, but when collapsed the only tell
          // is the "N errors" suffix in the summary row.
          const urgentCount = queuedTurns.filter(t => isUrgentQueuedContent(t.content)).length
          const showCollapsed = queueCollapsed && queuedTurns.length >= 3
          return (
          <ChatComposerDrawerFrame
            joinedToPrevious={Boolean(latestChangeDrawer)}
            collapsed={showCollapsed}
            style={{
              // Match the "changes" drawer's indent + tucks the bottom edge under
              // the composer so it reads as a drawer pulled out from behind it.
              width: `calc(${CHAT_COMPOSER_WIDTH} - 24px)`,
              minWidth: `calc(${CHAT_COMPOSER_MIN_WIDTH_STYLE} - 24px)`,
              margin: '0 auto 0 auto',
            }}
          >
            {/* Header / summary row. When collapsed it's the ONLY visible
                row and clicking anywhere on it expands. When expanded it
                becomes a compact toggle at the top so the user can tuck the
                queue back away. */}
            {queuedTurns.length >= 3 && (
              <button
                type="button"
                onClick={() => setQueueCollapsed(v => !v)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: showCollapsed ? '6px 14px' : '6px 14px',
                  border: 'none',
                  borderBottom: showCollapsed ? 'none' : `1px solid ${theme.chat.divider}`,
                  background: 'transparent',
                  color: theme.chat.textSecondary,
                  cursor: 'pointer',
                  fontFamily: fontSans,
                  // Pin text to 11px regardless of the user's chat font —
                  // this is UI chrome, not conversation content, so it should
                  // match the composer toolbar pills rather than message body.
                  fontSize: 11,
                  // Tight line-height so the text's visual centre lines up
                  // with the 14px icons on the same row (avoids the baseline
                  // hang we had at 1.35).
                  lineHeight: 1,
                  textAlign: 'left',
                  ...NON_SELECTABLE_UI_STYLE,
                }}
                title={showCollapsed ? 'Expand queued messages' : 'Collapse queued messages'}
              >
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 14,
                  height: 14,
                  color: theme.chat.muted,
                  flexShrink: 0,
                }}>
                  {showCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                </span>
                <span style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 14,
                  height: 14,
                  color: urgentCount > 0 ? theme.status.danger : theme.chat.muted,
                  flexShrink: 0,
                }}>
                  {urgentCount > 0 ? <AlertTriangle size={12} /> : <MessageSquare size={12} />}
                </span>
                <span style={{
                  flex: 1, minWidth: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  lineHeight: 1,
                }}>
                  <span style={{ fontWeight: 600 }}>
                    {queuedTurns.length} queued {queuedTurns.length === 1 ? 'message' : 'messages'}
                  </span>
                  {urgentCount > 0 && (
                    <>
                      <span style={{ color: theme.chat.muted }}>, </span>
                      <span style={{ color: theme.status.danger, fontWeight: 600 }}>
                        {urgentCount} {urgentCount === 1 ? 'error' : 'errors'}
                      </span>
                    </>
                  )}
                </span>
              </button>
            )}
            {!showCollapsed && queuedTurns.map((turn, index) => {
              const depth = turn.parentId ? 1 : 0
              const isDraggingThis = draggingTurnId === turn.id
              const dropHere = dragOverTurn?.id === turn.id ? dragOverTurn.mode : null
              // Flag pasted error/warning/stack-trace dumps so the row can
              // render with a red tint — makes it obvious at a glance that
              // this queued turn is a crash report rather than a normal prompt.
              const isUrgent = isUrgentQueuedContent(turn.content)
              return (
              <div
                key={turn.id}
                onDragOver={(ev) => {
                  // Only accept our own internal queue-turn drags. The
                  // custom mime type is set in onDragStart below.
                  if (!ev.dataTransfer.types.includes('application/x-codesurf-queued-turn')) return
                  if (draggingTurnId === turn.id) return
                  ev.preventDefault()
                  ev.stopPropagation()
                  ev.dataTransfer.dropEffect = 'move'
                  const rect = ev.currentTarget.getBoundingClientRect()
                  const y = ev.clientY - rect.top
                  const h = rect.height
                  // Zone thresholds: top quarter → before, middle half → into,
                  // bottom quarter → after. Child rows can't be nested further,
                  // so dropping onto a child collapses to sibling mode.
                  let mode: 'before' | 'after' | 'into'
                  if (y < h * 0.25) mode = 'before'
                  else if (y > h * 0.75) mode = 'after'
                  else mode = turn.parentId ? 'after' : 'into'
                  if (dragOverTurn?.id !== turn.id || dragOverTurn.mode !== mode) {
                    setDragOverTurn({ id: turn.id, mode })
                  }
                }}
                onDragLeave={(ev) => {
                  // Only clear if the pointer actually left this row (not
                  // just moved to a child element).
                  const related = ev.relatedTarget as Node | null
                  if (related && ev.currentTarget.contains(related)) return
                  if (dragOverTurn?.id === turn.id) setDragOverTurn(null)
                }}
                onDrop={(ev) => {
                  // Source-of-truth is the dataTransfer payload plus the
                  // row's own id (from closure) and the cursor position —
                  // NOT React state. Some browsers fire a dragleave between
                  // the last dragover and drop, which would clear the
                  // dragOverTurn state and leave us unable to reorder. The
                  // data-transfer + geometry approach is immune to that.
                  const draggedId = ev.dataTransfer.getData('application/x-codesurf-queued-turn')
                    || ev.dataTransfer.getData('text/plain')
                  if (!draggedId || draggedId === turn.id) return
                  ev.preventDefault()
                  ev.stopPropagation()
                  const rect = ev.currentTarget.getBoundingClientRect()
                  const y = ev.clientY - rect.top
                  const h = rect.height
                  let mode: 'before' | 'after' | 'into'
                  if (y < h * 0.25) mode = 'before'
                  else if (y > h * 0.75) mode = 'after'
                  else mode = turn.parentId ? 'after' : 'into'
                  reorderQueuedTurn(draggedId, turn.id, mode)
                  setDragOverTurn(null)
                  setDraggingTurnId(null)
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '6px 14px',
                  paddingLeft: 14 + depth * 22,
                  borderTop: index > 0 ? `1px solid ${theme.chat.divider}` : undefined,
                  background: dropHere === 'into'
                    ? theme.surface.hover
                    : (isDraggingThis
                      ? theme.surface.selection
                      // Urgent rows get a soft red tint so a pasted crash/error
                      // log stands out without drowning the rest of the queue.
                      : (isUrgent ? 'rgba(220, 60, 60, 0.14)' : 'transparent')),
                  // Top/bottom indicator lines for before/after drop zones.
                  // Urgent rows additionally get a left accent bar in danger
                  // color; if a drop indicator is active, it takes precedence.
                  boxShadow: dropHere === 'before'
                    ? `inset 0 2px 0 0 ${theme.accent.base}`
                    : dropHere === 'after'
                      ? `inset 0 -2px 0 0 ${theme.accent.base}`
                      : (isUrgent ? `inset 3px 0 0 0 ${theme.status.danger}` : undefined),
                  opacity: isDraggingThis ? 0.5 : 1,
                  transition: 'background 0.12s, opacity 0.12s',
                  position: 'relative',
                }}
              >
                {/* Drag handle — native HTML5 DnD is initiated here; setting
                    draggable on the row itself would steal text selection.
                    Hit area is deliberately generous (24×24) with the grip
                    icon visually centered, so users don't have to aim at
                    the 14px glyph precisely. */}
                <div
                  draggable
                  onDragStart={(ev) => {
                    ev.stopPropagation()
                    ev.dataTransfer.effectAllowed = 'move'
                    // Custom mime type marks this as an internal queue-turn
                    // drag so tile-level file-drop handlers can ignore it.
                    // Keep text/plain for backwards compat and because some
                    // drop targets only read text/plain.
                    try {
                      ev.dataTransfer.setData('application/x-codesurf-queued-turn', turn.id)
                    } catch { /* older browsers reject custom types silently */ }
                    ev.dataTransfer.setData('text/plain', turn.id)
                    setDraggingTurnId(turn.id)
                  }}
                  onDragEnd={() => {
                    setDraggingTurnId(null)
                    setDragOverTurn(null)
                  }}
                  title="Drag to reorder — drop on a row to nest as a sub-item"
                  style={{
                    width: 24,
                    height: 24,
                    marginLeft: -4,
                    marginRight: -4,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: theme.chat.muted,
                    cursor: 'grab',
                    flexShrink: 0,
                    opacity: 0.6,
                    borderRadius: 4,
                    ...NON_SELECTABLE_UI_STYLE,
                  }}
                  onMouseEnter={(ev) => {
                    ev.currentTarget.style.opacity = '1'
                    ev.currentTarget.style.background = theme.surface.hover
                  }}
                  onMouseLeave={(ev) => {
                    ev.currentTarget.style.opacity = '0.6'
                    ev.currentTarget.style.background = 'transparent'
                  }}
                >
                  <GripVertical size={14} />
                </div>
                <div style={{
                  width: 18,
                  height: 18,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: isUrgent ? theme.status.danger : theme.chat.muted,
                  flexShrink: 0,
                  ...NON_SELECTABLE_UI_STYLE,
                }}>
                  {isUrgent ? <AlertTriangle size={14} /> : <MessageSquare size={14} />}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    title={isUrgent ? 'This queued message looks like a pasted error/crash log' : undefined}
                    style={{
                      color: isUrgent ? theme.status.danger : theme.chat.textSecondary,
                      fontWeight: isUrgent ? 600 : undefined,
                      fontSize: Math.max(12, fontSize),
                      fontFamily: fontSans,
                      lineHeight: 1.35,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {turn.preview}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void handleQueuedTurnSteer(turn)
                  }}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: theme.chat.textSecondary,
                    fontSize: 12,
                    fontFamily: fontSans,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: 0,
                    opacity: 1,
                    flexShrink: 0,
                    ...NON_SELECTABLE_UI_STYLE,
                  }}
                  title={isStreaming ? 'Send this message into the running stream' : 'Send this queued message now'}
                >
                  <CornerDownRight size={14} />
                  <span>Steer</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const remaining = queuedTurns.filter(item => item.id !== turn.id)
                    setQueuedTurns(remaining)
                    flushQueueStateNow(remaining)
                    logQueueEvent('delete', { queueId: turn.id })
                  }}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: theme.chat.muted,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    flexShrink: 0,
                    ...NON_SELECTABLE_UI_STYLE,
                  }}
                  title="Remove queued message"
                >
                  <Trash2 size={14} />
                </button>
              </div>
              )
            })}
          </ChatComposerDrawerFrame>
          )
        })()}

        {/* Input bar */}
        <ChatComposerWrap style={{
          flexShrink: 0,
          width: CHAT_COMPOSER_WIDTH,
          minWidth: CHAT_COMPOSER_MIN_WIDTH_STYLE,
          margin: isStartScreen ? '12px auto 6px auto' : '0 auto 6px auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}>
        <ChatComposerCard style={{
        minHeight: CHAT_COMPOSER_MIN_HEIGHT,
        border: isDropTarget ? `1px solid ${theme.accent.base}` : `1px solid ${composerBorder}`, borderRadius: 14,
        // Keep the fill on the actual input surface. The dimensional edge is
        // handled by ChatComposerCard's stacked shadow, not by painting a gray
        // border colour across the whole composer.
        background: isDropTarget ? theme.surface.accentSoft : composerBackground,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: isDropTarget
          ? `0 0 0 1px ${theme.border.accent}, 0 0 22px ${theme.accent.soft}`
          : theme.mode === 'light'
            ? '0 0 0 1px rgba(15,23,42,0.12), 0 10px 28px rgba(15,23,42,0.09)'
            : '0 10px 28px rgba(0,0,0,0.18)',
        transition: 'border-color 120ms ease, background 120ms ease, box-shadow 120ms ease',
      }}>
        <ChatComposerAutocompletePopup
          popupRef={acRef}
          autocompleteType={acType}
          query={acQuery}
          items={acItems}
          activeIndex={acIndex}
          fontSans={fontSans}
          fontMono={fontMono}
          onHoverIndex={setAcIndex}
          onSelect={selectAcItem}
        />

        <ChatComposerVoiceStatus
          isDictating={isDictating}
          dictationText={dictationText}
          dictationError={dictationError}
          ttsState={ttsState}
          onStopVoicePlayback={() => bargeIn()}
        />

        <ChatComposerSurfaceHost
          surfaces={openChatSurfaces}
          activeSurface={activeChatSurface}
          fontMono={fontMono}
          showBuilderEnhance={activeChatSurface?.extId === 'sketch' && chatSurfaceMenu.some(entry => entry.extId === 'builder' || entry.surfaceId === 'builder')}
          renderSurfaceIcon={renderChatSurfaceIcon}
          onActivateSurface={setActiveChatSurfaceId}
          onCloseSurface={closeChatSurface}
          onOpenBuilderFromSketch={() => { void openBuilderFromSketch() }}
          onSetSurfaceIframeRef={setChatSurfaceIframeRef}
        />

        <ChatComposerAttachments
          attachments={attachments}
          fontMono={fontMono}
          onRemoveAttachment={removeAttachment}
        />

        <ChatComposerInput
          textareaRef={textareaRef}
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          placeholder={isDictating ? 'Listening...' : 'Message the agent, or use /commands and /skills'}
          fontSize={fontSize}
          fontFamily={fontSans}
          lineHeight={fontLineHeight}
          minHeight={CHAT_COMPOSER_TEXTAREA_MIN_HEIGHT}
          textColor={theme.chat.text}
        />

        {/* Primary toolbar */}
        <ChatComposerPrimaryToolbar>
          {/* Insert menu */}
          <div ref={insertMenuRef} style={{ position: 'relative' }}>
            <button
              type="button"
              aria-label="Open attachments and tools menu"
              title="Open attachments and tools menu"
              onClick={() => toggleMenu('insert')}
              onMouseDown={e => e.preventDefault()}
              style={{
                width: 28,
                height: 28,
                minWidth: 28,
                borderRadius: '50%',
                border: 'none',
                background: 'transparent',
                color: showInsertMenu ? theme.chat.text : theme.chat.muted,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                transition: 'background 0.15s, color 0.15s',
                flexShrink: 0,
              }}
              onMouseEnter={e => {
                e.currentTarget.style.color = theme.chat.text
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = 'transparent'
                e.currentTarget.style.color = showInsertMenu ? theme.chat.text : theme.chat.muted
              }}
            >
              <Plus size={16} strokeWidth={2.2} />
            </button>
            {showInsertMenu && (
              <MenuPortal anchorRef={insertMenuRef}>
                <ComposerInsertMenu
                  onAttachFiles={openAttachmentPicker}
                  mcpEnabled={mcpEnabled}
                  onToggleMcpEnabled={() => setMcpEnabled(v => !v)}
                  mcpServers={mcpServers}
                  disabledServers={disabledServers}
                  setDisabledServers={setDisabledServers}
                  peerToolNames={peerToolNames}
                  chatSurfaces={chatSurfaceMenu}
                  activeChatSurfaceId={activeChatSurface ? `${activeChatSurface.extId}:${activeChatSurface.surfaceId}` : null}
                  onOpenChatSurface={openChatSurface}
                  renderChatSurfaceIcon={renderChatSurfaceIcon}
                />
              </MenuPortal>
            )}
          </div>

          {/* Provider — shown only before the conversation starts. Different
              CLI agents have incompatible session formats (Claude SDK session
              resumption vs. Codex subprocess streams vs. OpenCode HTTP), so
              swapping mid-conversation would break history continuity. The
              current provider is still implicit in the Model pill's icon.
              Clear the conversation to expose the picker again. */}
          {messages.length === 0 && (
            <div ref={providerMenuRef} style={{ position: 'relative' }}>
              <ToolbarPill
                prefix={currentProviderEntry?.icon ?? <Bot size={TOOLBAR_PILL_ICON_SIZE} />}
                label={currentProviderEntry?.label ?? 'Provider'}
                active={showProviderMenu}
                onClick={() => toggleMenu('provider')}
                title="Choose the CLI agent (hidden once the conversation starts)"
              />
              {showProviderMenu && (
                <MenuPortal anchorRef={providerMenuRef}>
                  <Dropdown>
                    {providerEntries.map(entry => (
                      <DropdownItem
                        key={entry.id}
                        icon={entry.icon}
                        label={entry.label}
                        sublabel={entry.description}
                        active={provider === entry.id}
                        onClick={() => handleProviderChange(entry.id)}
                      />
                    ))}
                  </Dropdown>
                </MenuPortal>
              )}
            </div>
          )}

          {/* Model */}
          <div ref={modelMenuRef} style={{ position: 'relative' }}>
            <ToolbarPill
              prefix={currentProviderEntry?.icon ?? <Bot size={TOOLBAR_PILL_ICON_SIZE} />}
              label={currentModel.label}
              active={showModelMenu}
              onClick={() => toggleMenu('model')}
            />
            {showModelMenu && (
              <MenuPortal anchorRef={modelMenuRef}>
                <ModelDropdown
                  models={currentProviderEntry?.models ?? []}
                  activeId={model}
                  filter={modelFilter}
                  onFilterChange={setModelFilter}
                  providerIcon={currentProviderEntry?.icon ?? <Bot size={TOOLBAR_PILL_ICON_SIZE} />}
                  noun={optionNoun}
                  onSelect={(id) => { setModel(id); setShowModelMenu(false); setModelFilter('') }}
                />
              </MenuPortal>
            )}
          </div>

          {/* Thinking — brain + signal bars icon, label in dropdown */}
          <div ref={thinkingMenuRef} style={{ position: 'relative' }}>
            <ToolbarBtn
              icon={<ThinkingIcon level={thinking} />}
              tooltip={`Thinking: ${THINKING_OPTIONS.find(t => t.id === thinking)?.label ?? 'Adaptive'}`}
              color={thinking === 'none' ? theme.chat.muted : theme.chat.textSecondary}
              onClick={() => toggleMenu('thinking')}
            />
            {showThinkingMenu && (
              <MenuPortal anchorRef={thinkingMenuRef}>
                <Dropdown>
                  {THINKING_OPTIONS.map(t => (
                    <DropdownItem
                      key={t.id}
                      icon={<Brain size={11} />}
                      label={t.label}
                      sublabel={t.description}
                      active={thinking === t.id}
                      onClick={() => { setThinking(t.id); setShowThinkingMenu(false) }}
                    />
                  ))}
                </Dropdown>
              </MenuPortal>
            )}
          </div>

          <div style={{ flex: 1 }} />

          <ToolbarBtn
            icon={<Maximize2 size={TOOLBAR_ICON_SIZE - 1} />}
            tooltip="Open this chat in a mini window"
            color={theme.chat.textSecondary}
            onClick={openMiniChat}
          />

          {/* Subtle liveness indicator — a breathing dot that sits next to the
              Stop button while streaming. If the server has been quiet for
              >2.5s we also surface a tiny "Xs" counter so the user knows the
              turn is still alive even when nothing visible has changed. */}
          {isStreaming && <StreamingLivenessIndicator lastActivityAtMs={lastActivityAtRef.current} />}

          {/* Voice dictation — sits next to send/stop. Click toggles, or
              hold spacebar in the empty composer for push-to-talk. The
              underlying recognizer is the existing toggleDictation/isDictating
              flow (Web Speech API in Electron's Chromium). */}
          {!isStreaming && (
            <button
              onClick={toggleDictation}
              onMouseDown={e => e.preventDefault()}
              style={{
                width: 28, height: 28, minWidth: 28, borderRadius: '50%',
                background: isDictating ? theme.status.danger : theme.surface.panelMuted,
                border: 'none',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'background 0.15s, transform 0.15s', flexShrink: 0,
                transform: isDictating ? 'scale(1.05)' : 'scale(1)',
                animation: isDictating ? 'chat-pulse 1.4s ease-in-out infinite' : 'none',
              }}
              onMouseEnter={e => {
                if (!isDictating) e.currentTarget.style.background = theme.chat.inputBorder ?? theme.surface.panelMuted
              }}
              onMouseLeave={e => {
                if (!isDictating) e.currentTarget.style.background = theme.surface.panelMuted
              }}
              title={isDictating ? 'Stop recording (or release Space)' : 'Hold Space (empty composer) or click to dictate'}
            >
              <Mic
                size={14}
                color={isDictating ? '#fff' : theme.chat.muted}
                strokeWidth={2.2}
              />
            </button>
          )}

          {/* Stop / Send */}
          {isStreaming ? (
            <button
              onClick={stopStreaming}
              onMouseDown={e => e.preventDefault()}
              style={{
                width: 28, height: 28, minWidth: 28, borderRadius: '50%',
                background: theme.text.primary, border: 'none',
                cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'opacity 0.15s', flexShrink: 0,
                opacity: 0.92,
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '1')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0.92')}
              title="Stop generation"
            >
              <Square size={10} fill={theme.chat.background} color={theme.chat.background} />
            </button>
          ) : (
            <button
              onClick={sendMessage}
              onMouseDown={e => e.preventDefault()}
              disabled={!hasSendableDraft}
              style={{
                width: 28, height: 28, minWidth: 28, borderRadius: '50%',
                background: hasSendableDraft ? theme.accent.base : theme.surface.panelMuted,
                border: 'none',
                cursor: hasSendableDraft ? 'pointer' : 'default',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: 0, transition: 'background 0.15s', flexShrink: 0,
              }}
              onMouseEnter={e => { if (hasSendableDraft) e.currentTarget.style.background = theme.accent.hover }}
              onMouseLeave={e => { if (hasSendableDraft) e.currentTarget.style.background = theme.accent.base }}
              title="Send message"
            >
              <ArrowUp size={16} color="#fff" strokeWidth={2.5} style={{ opacity: hasSendableDraft ? 1 : 0.3 }} />
            </button>
          )}
        </ChatComposerPrimaryToolbar>
        </ChatComposerCard>

        {/* Secondary toolbar */}
        <ChatComposerSecondaryToolbar>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <ChatComposerLocationMenu
              anchorRef={locationMenuRef}
              showMenu={showLocationMenu}
              executionTarget={executionTarget}
              locationLabel={locationLabel}
              localExecutionLabel={localExecutionLabel}
              normalizedRepoRoot={normalizedRepoRoot}
              remoteHosts={remoteHosts}
              activeCloudHost={activeCloudHost}
              fontSans={fontSans}
              onToggleMenu={() => toggleMenu('location')}
              onSelectLocal={() => {
                setExecutionTarget('local')
                setShowLocationMenu(false)
              }}
              onSelectCloud={() => {
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
            />

            <ChatComposerBranchMenu
              anchorRef={branchMenuRef}
              showMenu={showBranchMenu}
              isGitRepo={isGitRepo}
              branches={filteredBranches}
              branchFilter={branchFilter}
              branchCreateEnabled={branchMenuCreateEnabled}
              currentBranchLabel={currentBranchLabel}
              projectFolderName={projectFolderName}
              normalizedRepoRoot={normalizedRepoRoot}
              changedCount={gitStatus.changedCount}
              fontSans={fontSans}
              nonSelectableStyle={NON_SELECTABLE_UI_STYLE}
              onToggleMenu={() => toggleMenu('branch')}
              onBranchFilterChange={setBranchFilter}
              onSelectBranch={handleBranchSelect}
              onCreateBranch={handleCreateBranch}
            />

            <ChatComposerProjectPathButton
              title={executionTarget === 'cloud' ? activeProjectPathLabel : `${activeProjectPathLabel} — click to switch folder`}
              disabled={executionTarget === 'cloud'}
              label={activeProjectPathLabel}
              fontSans={fontSans}
              onClick={handleProjectFolderSwitch}
            />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            <ChatComposerModeMenu
              anchorRef={modeMenuRef}
              showMenu={showModeMenu}
              mode={mode}
              currentMode={currentMode}
              modeOptions={modeOptions}
              onToggleMenu={() => toggleMenu('mode')}
              onSelectMode={modeId => {
                setMode(modeId)
                onChatModePreferenceChange?.(provider, modeId)
                setShowModeMenu(false)
              }}
            />

            {/* Plan / Tasks chip — only visible when the agent has emitted a
                TodoWrite block. Toggles the right-docked PlanPane. */}
            {planTodos && planTodos.length > 0 && (
              <PlanChip
                todos={planTodos}
                active={isPlanOpen}
                onClick={() => setIsPlanOpen(v => !v)}
              />
            )}

            {/* Context indicator sits in a 28×28 hit-box so its centre-line
                aligns with the Stop/Send button in the primary toolbar above
                (both buttons are now 28px wide with matching 8px container
                padding → same centre X). The 18×18 visible dial is centred
                inside via flex alignment. */}
            <ChatComposerContextUsageDial
              anchorRef={contextMenuRef}
              showMenu={showContextMenu}
              contextUsageRatio={contextUsageRatio}
              contextUsagePercent={contextUsagePercent}
              estimatedContextTokens={estimatedContextTokens}
              contextWindowLimit={contextWindowLimit}
              systemOverheadTokens={systemOverheadTokens}
              composerBackground={composerBackground}
              fontSans={fontSans}
              nonSelectableStyle={NON_SELECTABLE_UI_STYLE}
              onToggleMenu={() => toggleMenu('context')}
            />
          </div>
        </ChatComposerSecondaryToolbar>
        </ChatComposerWrap>
      </div>
      </div>
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
    </FontCtx.Provider>
    </ChatDispatchCtx.Provider>
  )
}

// --- Rich message sub-components -------------------------------------------------

const ThinkingBlockView = React.memo(function ThinkingBlockView({ thinking }: { thinking: ThinkingBlock }): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)
  const isActive = !thinking.done
  const hasContent = thinking.content.length > 0

  // Track elapsed thinking time so we can show "Thought for Xs"
  const startTimeRef = useRef<number | null>(null)
  const finalElapsedRef = useRef<number | null>(null)
  const [elapsedSec, setElapsedSec] = useState(0)

  if (startTimeRef.current == null && isActive) {
    startTimeRef.current = Date.now()
  }

  useEffect(() => {
    if (!isActive) return
    const id = setInterval(() => {
      if (startTimeRef.current != null) {
        setElapsedSec(Math.floor((Date.now() - startTimeRef.current) / 1000))
      }
    }, 250)
    return () => clearInterval(id)
  }, [isActive])

  useEffect(() => {
    if (thinking.done && finalElapsedRef.current == null) {
      const start = startTimeRef.current ?? Date.now()
      const finalSec = Math.max(1, Math.round((Date.now() - start) / 1000))
      finalElapsedRef.current = finalSec
      setElapsedSec(finalSec)
    }
  }, [thinking.done])

  // No auto-expand — user opens thinking content on demand only

  const displayedElapsed = finalElapsedRef.current ?? elapsedSec

  // Styled to mirror the tool chip (CollapsedToolGroup / ToolBlockView) so it
  // can sit inline in the same chip row without breaking the visual rhythm.
  // The outer container is a column so the expanded quote content can still
  // render underneath the chip in full width when opened.
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: expanded ? 6 : 0,
      width: 'fit-content',
      maxWidth: `min(100%, ${TOOL_BLOCK_MAX_WIDTH}px)`,
      minWidth: 0,
      flex: '0 0 auto',
    }}>
      {/* Chip — matches tool chip sizing, border, and padding */}
      <button
        onClick={() => hasContent && setExpanded(e => !e)}
        style={{
          background: theme.chat.assistantBubble,
          border: '0.5px solid transparent',
          boxShadow: theme.mode === 'light'
            ? 'var(--cs-edge-shadow), 0 0 0 1px rgba(15,23,42,0.12)'
            : 'var(--cs-edge-shadow)',
          margin: 1,
          borderRadius: 8,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 8px',
          minHeight: 22,
          boxSizing: 'border-box',
          cursor: hasContent ? 'pointer' : 'default',
          color: theme.chat.muted,
          fontSize: 10.5,
          fontFamily: fonts.sans,
          fontWeight: 500,
          lineHeight: 1,
          width: 'fit-content',
          maxWidth: '100%',
        }}
      >
        <Brain size={11} style={{ opacity: isActive ? 0.75 : 0.5, flexShrink: 0 }} />
        {isActive ? (
          <ShimmerText baseColor={theme.chat.muted} style={{
            fontSize: 10.5, fontWeight: 500, lineHeight: 1,
            minWidth: 0, flex: '1 1 auto',
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          }}>
            {`Thinking for ${elapsedSec}s`}
          </ShimmerText>
        ) : (
          <span style={{
            fontSize: 10.5, fontWeight: 500, lineHeight: 1,
            minWidth: 0, flex: '1 1 auto',
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
          }}>
            {`Thought for ${displayedElapsed}s`}
          </span>
        )}
        {hasContent && (
          <ChevronRight size={12} style={{
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s',
            opacity: 0.4, flexShrink: 0,
          }} />
        )}
      </button>

      {/* Expanded thinking content — quote-indent style, no background.
          Rendered on its own row beneath the chip when expanded. */}
      {expanded && hasContent && (
        <div style={{
          marginLeft: 6,
          paddingLeft: 10,
          paddingTop: 2,
          paddingBottom: 2,
          borderLeft: `2px solid ${theme.chat.muted}`,
          fontSize: 12, lineHeight: fonts.lineHeight, color: theme.chat.muted,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          fontFamily: fonts.sans, maxHeight: 200, overflowY: 'auto',
          background: 'transparent',
          borderRadius: 0,
          backdropFilter: 'none',
          opacity: 0.85,
        }}>
          {thinking.content}
          {isActive && (
            <span style={{
              display: 'inline-block', width: 5, height: 12,
              marginLeft: 2, verticalAlign: 'text-bottom',
              background: theme.chat.muted, borderRadius: 1,
              animation: 'chat-pulse 1s ease-in-out infinite',
            }} />
          )}
        </div>
      )}
    </div>
  )
})

/**
 * WorkingChipView — sibling to ThinkingBlockView, shown at the end of a
 * streaming assistant message when the agent is "doing something" that isn't
 * thinking and isn't producing text.
 *
 * Two states, picked automatically:
 *   - A ToolBlock with `status: 'running'` exists → `Running {toolName}` chip
 *     with a live-ticking elapsed counter measured from the tool's first-seen
 *     running moment.
 *   - No running tool, but the message has been streaming for ≥ 2s → generic
 *     `Working for Ns` chip measured from message-stream start.
 *
 * Hidden whenever a thinking block is currently active — the ThinkingBlockView
 * chip is already occupying that visual slot. Also hidden on non-streaming
 * messages. The 2s grace keeps fast responses (< 2s, no tools) from flashing a
 * chip the user never reads.
 *
 * Mirrors the ThinkingBlockView chip shell so the two read as one family.
 */
const WorkingChipView = React.memo(function WorkingChipView({ message }: { message: ChatMessage }): JSX.Element | null {
  const theme = useTheme()
  const fonts = useFonts()

  const activeThinking = (message.thinkingBlocks ?? []).find(t => !t.done)
  const activeTool = (() => {
    const blocks = message.toolBlocks ?? []
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].status === 'running') return blocks[i]
    }
    return null
  })()

  if (!message.isStreaming) return null
  if (activeThinking) return null

  const label = activeTool
    ? `Running ${getToolDisplayName(activeTool.name)}`
    : 'Working'

  return (
    <div style={{
      background: theme.chat.assistantBubble,
      border: '0.5px solid transparent',
      boxShadow: theme.mode === 'light'
        ? 'var(--cs-edge-shadow), 0 0 0 1px rgba(15,23,42,0.12)'
        : 'var(--cs-edge-shadow)',
      margin: 1,
      borderRadius: 8,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '0 8px',
      minHeight: 24,
      boxSizing: 'border-box',
      color: theme.chat.muted,
      fontSize: 10.5,
      fontFamily: fonts.sans,
      fontWeight: 500,
      lineHeight: 1,
      width: 'fit-content',
      maxWidth: `min(100%, ${TOOL_BLOCK_MAX_WIDTH}px)`,
      flex: '0 0 auto',
    }}>
      <Cog size={11} style={{
        opacity: 0.75,
        flexShrink: 0,
        animation: 'chat-spin 2.4s linear infinite',
      }} />
      <ShimmerText baseColor={theme.chat.muted} style={{
        fontSize: 10.5, fontWeight: 500, lineHeight: 1,
        minWidth: 0,
        overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
      }}>
        {label}
      </ShimmerText>
    </div>
  )
})

const StreamingLivenessIndicator = React.memo(function StreamingLivenessIndicator({ lastActivityAtMs }: {
  lastActivityAtMs: number
}): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const [, setTick] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => {
      setTick(t => (t + 1) & 0xffff)
    }, 500)
    return () => window.clearInterval(id)
  }, [])

  const quietMs = Math.max(0, Date.now() - lastActivityAtMs)
  const showCounter = quietMs > 2500
  const elapsedSec = Math.floor(quietMs / 1000)

  return (
    <div
      title={showCounter
        ? `Waiting on server — ${elapsedSec}s since last update`
        : 'Working…'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        marginRight: 4,
        color: theme.chat.muted,
        fontSize: 10.5,
        fontFamily: fonts.sans,
        lineHeight: 1,
        userSelect: 'none',
        flexShrink: 0,
      }}
    >
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: showCounter ? theme.status.warning : theme.accent.base,
        animation: 'chat-pulse 1.6s ease-in-out infinite',
        display: 'inline-block',
      }} />
      {showCounter && (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {elapsedSec}s
        </span>
      )}
    </div>
  )
})

/**
 * Collapses a mixed-name run of completed tool blocks into a single
 * "Called N tools" chip that expands horizontally to reveal the originals.
 */
const MixedToolGroup = React.memo(function MixedToolGroup({ blocks }: { blocks: ToolBlock[] }): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: expanded ? 6 : 0,
      width: 'fit-content',
      maxWidth: '100%',
      minWidth: 0,
      flex: '0 0 auto',
    }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          background: theme.chat.assistantBubble,
          border: '0.5px solid transparent',
          boxShadow: theme.mode === 'light'
            ? 'var(--cs-edge-shadow), 0 0 0 1px rgba(15,23,42,0.12)'
            : 'var(--cs-edge-shadow)',
          margin: 1,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 8px',
          minHeight: 22,
          boxSizing: 'border-box',
          cursor: 'pointer',
          color: theme.chat.muted,
          fontSize: 10,
          fontFamily: fonts.sans,
          lineHeight: 1,
          width: 'fit-content',
          maxWidth: `min(100%, ${TOOL_BLOCK_MAX_WIDTH}px)`,
        }}
      >
        <Wrench size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
        <span style={{
          fontWeight: 500, fontSize: 10.5, lineHeight: 1,
          minWidth: 0, flex: '1 1 auto',
          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        }}>
          Called {blocks.length} tools
        </span>
        <Check size={11} color={theme.status.success} style={{ flexShrink: 0 }} />
        <ChevronRight size={12} style={{
          transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s',
          opacity: 0.4,
          flexShrink: 0,
        }} />
      </div>
      {expanded && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          alignItems: 'flex-start',
          alignContent: 'flex-start',
          maxWidth: '100%',
          overflow: 'visible',
        }}>
          {blocks.map(b => <ToolBlockView key={b.id} block={b} />)}
        </div>
      )}
    </div>
  )
})

/** Collapses consecutive same-name completed tool chips into "Read x6" style. */
/**
 * Human-friendly label for a collapsed group of same-tool calls.
 * Falls back to "Ran N <tool> calls" for unrecognised tools so the chip
 * still reads as a past-tense summary instead of raw tool-name + ×N badge.
 */
function getGroupedToolLabel(name: string, count: number): string {
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${count} file${count === 1 ? '' : 's'}`
    case 'Write':
      return `Wrote ${count} file${count === 1 ? '' : 's'}`
    case 'Read':
      return `Read ${count} file${count === 1 ? '' : 's'}`
    case 'Bash':
    case 'exec_command':
      return `Ran ${count} command${count === 1 ? '' : 's'}`
    case 'Grep':
      return `Searched ${count} time${count === 1 ? '' : 's'}`
    case 'Glob':
      return `Matched ${count} pattern${count === 1 ? '' : 's'}`
    case 'WebFetch':
      return `Fetched ${count} URL${count === 1 ? '' : 's'}`
    case 'WebSearch':
      return `Searched the web ${count} time${count === 1 ? '' : 's'}`
    case 'TodoWrite':
      return `Updated todos ${count} time${count === 1 ? '' : 's'}`
    case 'update_plan':
      return `Updated plan ${count} time${count === 1 ? '' : 's'}`
    case 'Task':
      return `Ran ${count} sub-agent${count === 1 ? '' : 's'}`
    default:
      return `Used ${getToolDisplayName(name)} ${count} time${count === 1 ? '' : 's'}`
  }
}

const CollapsedToolGroup = React.memo(function CollapsedToolGroup({ name, blocks }: { name: string; blocks: ToolBlock[] }): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: expanded ? 6 : 0,
      width: 'fit-content',
      maxWidth: '100%',
      minWidth: 0,
      flex: '0 0 auto',
    }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          background: theme.chat.assistantBubble,
          border: '0.5px solid transparent',
          boxShadow: theme.mode === 'light'
            ? 'var(--cs-edge-shadow), 0 0 0 1px rgba(15,23,42,0.12)'
            : 'var(--cs-edge-shadow)',
          margin: 1,
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 8px',
          minHeight: 22,
          boxSizing: 'border-box',
          cursor: 'pointer',
          color: theme.chat.muted,
          fontSize: 10,
          fontFamily: fonts.sans,
          lineHeight: 1,
          width: 'fit-content',
          maxWidth: `min(100%, ${TOOL_BLOCK_MAX_WIDTH}px)`,
        }}
      >
        <Wrench size={11} style={{ opacity: 0.5, flexShrink: 0 }} />
        <span style={{
          fontWeight: 500, fontSize: 10.5, lineHeight: 1,
          minWidth: 0, flex: '1 1 auto',
          overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
        }}>
          {getGroupedToolLabel(name, blocks.length)}
        </span>
        <Check size={11} color={theme.status.success} style={{ flexShrink: 0 }} />
        <ChevronRight size={12} style={{
          transform: expanded ? 'rotate(90deg)' : 'none',
          transition: 'transform 0.15s',
          opacity: 0.4,
          flexShrink: 0,
        }} />
      </div>
      {expanded && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          alignItems: 'flex-start',
          alignContent: 'flex-start',
          maxWidth: '100%',
          overflow: 'visible',
        }}>
          {blocks.map(b => <ToolBlockView key={b.id} block={b} />)}
        </div>
      )}
    </div>
  )
})


const ToolBlockView = React.memo(function ToolBlockView({ block, isLive = false }: { block: ToolBlock; isLive?: boolean }): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const codePanelFontSize = Math.max(11, fonts.size - 1)
  const isFileChangeBlock = (block.fileChanges?.length ?? 0) > 0
  const checkpointRestoreCtx = React.useContext(CheckpointRestoreContext)

  // Intercept tool-permission requests — when the agent needs user approval for
  // this tool call, show an inline Allow/Deny prompt instead of (or alongside)
  // the raw tool chip. Mirrors the AskUserQuestion pattern.
  const permissionCtx = useToolPermissionContext()
  const permissionRequest = permissionCtx?.pending.get(block.id) ?? null
  const resolvedDecision = permissionCtx?.resolved.get(block.id) ?? null
  if (permissionRequest || resolvedDecision) {
    return (
      <ToolPermissionCard
        toolId={block.id}
        fallbackToolName={block.name}
        request={permissionRequest}
        resolvedDecision={resolvedDecision}
        theme={theme}
        fonts={{ sans: fonts.sans, mono: fonts.mono }}
      />
    )
  }

  // Intercept AskUserQuestion tool blocks: render an interactive form so the user
  // can actually answer the question instead of seeing a raw JSON chip.
  // Once submitted, the main process emits a tool_summary so `block.summary`
  // is set, at which point we fall through to the normal chip rendering.
  if (block.name === 'AskUserQuestion' && !block.summary) {
    const askPayload = parseAskUserQuestionInput(block.input)
    if (askPayload && askPayload.questions.length > 0) {
      return (
        <AskUserQuestionChip
          block={block}
          payload={askPayload}
        />
      )
    }
  }
  const fileChangeSummary = useMemo(() => {
    const fileChanges = block.fileChanges ?? []
    return {
      fileCount: fileChanges.length,
      additions: fileChanges.reduce((sum, change) => sum + change.additions, 0),
      deletions: fileChanges.reduce((sum, change) => sum + change.deletions, 0),
    }
  }, [block.fileChanges])
  const [expanded, setExpanded] = useState(isFileChangeBlock)
  // For file-change blocks default the per-file diff panels to open: the
  // whole reason we're showing a file-change block is the diff itself. For
  // regular tool blocks (Bash output, etc.) default to closed — users click
  // to drill in.
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>(() => {
    if (!isFileChangeBlock) return {}
    const map: Record<string, boolean> = {}
    block.fileChanges?.forEach((change, index) => {
      map[`${change.path}:${index}`] = hasRenderableFileChangeDiff(change)
    })
    return map
  })
  const isRunning = isLive && block.status === 'running'
  const hasNestedData = (block.fileChanges?.length ?? 0) > 0 || (block.commandEntries?.length ?? 0) > 0
  const isCheckpoint = isCheckpointToolBlock(block)
  const isDream = isDreamToolBlock(block)
  const checkpointRestoreAction = checkpointRestoreCtx
    ? getCheckpointRestoreAction(block, checkpointRestoreCtx)
    : null
  const isRestoringCheckpoint = Boolean(
    checkpointRestoreAction
    && checkpointRestoreCtx?.restoringCheckpointId === checkpointRestoreAction.checkpointId,
  )

  const toggleFile = useCallback((key: string) => {
    setExpandedFiles(prev => {
      const current = prev[key] ?? false
      return { ...prev, [key]: !current }
    })
  }, [])

  return (
    <div
      data-tool-block-kind={isFileChangeBlock ? 'file-changes' : 'tool'}
      style={{
        background: theme.chat.assistantBubble,
        border: '0.5px solid transparent',
        boxShadow: theme.mode === 'light'
          ? 'var(--cs-edge-shadow), 0 0 0 1px rgba(15,23,42,0.12)'
          : 'var(--cs-edge-shadow)',
        margin: 1,
        borderRadius: 8,
        overflow: 'hidden',
        maxWidth: expanded || isFileChangeBlock ? 'calc(100% - 2px)' : `min(calc(100% - 2px), ${TOOL_BLOCK_MAX_WIDTH}px)`,
        width: expanded || isFileChangeBlock ? 'calc(100% - 2px)' : 'fit-content',
        alignSelf: 'stretch',
        flex: expanded || isFileChangeBlock ? '1 1 100%' : '0 0 auto',
        minWidth: 0,
      }}
    >
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          width: '100%',
          maxWidth: expanded || isFileChangeBlock ? '100%' : `min(100%, ${TOOL_BLOCK_MAX_WIDTH}px)`,
          padding: isFileChangeBlock ? '12px 16px' : '0 8px',
          // ToolBlockView is a nested chip: the outer <div> carries the 1px
          // border, so we shave 2px off the inner button's minHeight to land
          // at an outer rendered height of 22px — matching the single-layer
          // ThinkingBlockView / CollapsedToolGroup / MixedToolGroup chips so
          // they line up on a shared chip row.
          minHeight: isFileChangeBlock ? undefined : 20,
          boxSizing: 'border-box',
          background: 'none', border: 'none',
          cursor: 'pointer',
          color: isDream
            ? theme.accent.base
            : (isRunning ? theme.chat.textSecondary : theme.chat.muted),
          fontSize: 10, fontFamily: fonts.sans, lineHeight: 1, minWidth: 0,
        }}
      >
        {isDream
          ? <Sparkles size={11} style={{ color: theme.accent.base, opacity: 0.95, flexShrink: 0 }} />
          : isCheckpoint
            ? <History size={11} style={{ opacity: 0.62, flexShrink: 0 }} />
            : <Wrench size={11} style={{ opacity: isRunning ? 0.7 : 0.5, flexShrink: 0 }} />}

        {/* Collapsed chip header shows only the tool name. Detailed summaries stay in the expanded body. */}
        {isRunning ? (
          <ShimmerText baseColor={theme.chat.textSecondary} style={{
            fontSize: 10.5,
            fontFamily: fonts.sans,
            fontWeight: 500,
            minWidth: 0,
            flex: expanded || isFileChangeBlock ? 1 : '0 1 auto',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {getToolDisplayName(block.name)}
          </ShimmerText>
        ) : (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            minWidth: 0,
            flex: expanded || isFileChangeBlock ? 1 : '0 1 auto',
            overflow: 'hidden',
          }}>
            {isFileChangeBlock ? (
              <div style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                minWidth: 0,
                flexWrap: 'nowrap',
                overflow: 'hidden',
              }}>
                <span style={{
                  display: 'block',
                  fontWeight: 600,
                  fontSize: 10.5,
                  color: theme.chat.text,
                  flexShrink: 1,
                  minWidth: 0,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                  textOverflow: 'ellipsis',
                }}>
                  {fileChangeSummary.fileCount} file{fileChangeSummary.fileCount === 1 ? '' : 's'} changed
                </span>
                {hasVisibleFileChangeStats(fileChangeSummary) && (
                  <>
                    <span style={{ color: theme.status.success, fontSize: 10.5, fontWeight: 600, flexShrink: 0 }}>
                      +{fileChangeSummary.additions}
                    </span>
                    <span style={{ color: theme.status.danger, fontSize: 10.5, fontWeight: 600, flexShrink: 0 }}>
                      -{fileChangeSummary.deletions}
                    </span>
                  </>
                )}
              </div>
            ) : (
              <span style={{
                fontWeight: 500,
                fontSize: 10.5,
                flex: '1 1 auto',
                flexShrink: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}>
                {getToolDisplayName(block.name)}
              </span>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginLeft: 'auto', flexShrink: 0 }}>
          {block.elapsed != null && (
            <span style={{
              fontSize: 10, color: theme.chat.muted, display: 'flex', alignItems: 'center', gap: 3,
              fontFamily: fonts.mono, flexShrink: 0,
            }}>
              <Clock size={9} /> {block.elapsed.toFixed(1)}s
            </span>
          )}
          {!isRunning && !block.elapsed && (
            <Check size={11} color={isCheckpoint ? theme.chat.muted : theme.status.success} style={{ flexShrink: 0, opacity: isCheckpoint ? 0.75 : 1 }} />
          )}
          <ChevronRight size={12} style={{
            transform: expanded ? 'rotate(90deg)' : 'none',
            transition: 'transform 0.15s',
            opacity: 0.4, flexShrink: 0,
          }} />
        </div>
      </button>

      {/* Expanded: show imported file-change structure first when available */}
      {expanded && hasNestedData && (
        <div style={{
          padding: isFileChangeBlock ? 0 : '4px 10px 8px 10px',
          borderTop: `1px solid ${theme.chat.assistantBubbleBorder}`,
        }}>
          {(block.fileChanges?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: isFileChangeBlock ? 0 : 6 }}>
              {block.fileChanges?.map((change, index) => {
                const fileKey = `${change.path}:${index}`
                const fileHasDiff = hasRenderableFileChangeDiff(change)
                const isExpanded = expandedFiles[fileKey] ?? false
                return (
                  <div key={fileKey} style={{
                    borderRadius: isFileChangeBlock ? 0 : 8,
                    border: isFileChangeBlock
                      ? 'none'
                      : `1px solid ${theme.chat.assistantBubbleBorder}`,
                    overflow: 'hidden',
                    background: isFileChangeBlock ? 'transparent' : theme.surface.panelMuted,
                    borderTop: isFileChangeBlock && index > 0 ? `1px solid ${theme.chat.assistantBubbleBorder}` : undefined,
                  }}>
                    <button
                      type="button"
                      onClick={() => {
                        if (fileHasDiff) toggleFile(fileKey)
                      }}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        background: 'transparent',
                        border: 'none',
                        padding: isFileChangeBlock ? '14px 16px' : '8px 10px',
                        cursor: fileHasDiff ? 'pointer' : 'default',
                        color: theme.chat.text,
                        fontFamily: isFileChangeBlock ? fonts.sans : fonts.mono,
                        fontSize: isFileChangeBlock ? fonts.size : 11,
                        fontWeight: isFileChangeBlock ? 500 : fonts.monoWeight,
                        textAlign: 'left',
                      }}
                    >
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {change.path}
                      </span>
                      {hasVisibleFileChangeStats(change) && (
                        <>
                          <span style={{ color: theme.status.success, flexShrink: 0 }}>+{change.additions}</span>
                          <span style={{ color: theme.status.danger, flexShrink: 0 }}>-{change.deletions}</span>
                        </>
                      )}
                      <ChevronRight size={12} style={{
                        transform: isExpanded ? 'rotate(90deg)' : 'none',
                        transition: 'transform 0.15s',
                        opacity: fileHasDiff ? 0.5 : 0,
                        flexShrink: 0,
                      }} />
                    </button>
                    {isExpanded && fileHasDiff && (
                      <div style={{ borderTop: `1px solid ${theme.chat.assistantBubbleBorder}` }}>
                        <DiffView
                          diff={change.diff}
                          path={change.path}
                          fontSize={codePanelFontSize}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {(block.commandEntries?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: (block.fileChanges?.length ?? 0) > 0 ? 8 : 0 }}>
              {block.commandEntries?.map((entry, index) => (
                <div key={`${entry.command ?? entry.label}:${index}`} style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: theme.chat.background,
                  border: `1px solid ${theme.chat.assistantBubbleBorder}`,
                }}>
                  <div style={{
                    fontSize: codePanelFontSize,
                    color: theme.chat.text,
                    fontFamily: fonts.mono,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {entry.command ?? entry.label}
                  </div>
                  {entry.output && (
                    <pre style={{
                      margin: '6px 0 0',
                      fontSize: codePanelFontSize,
                      lineHeight: fonts.monoLineHeight,
                      color: theme.chat.muted,
                      fontFamily: fonts.mono,
                      fontWeight: fonts.monoWeight,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: 120,
                      overflowY: 'auto',
                    }}>
                      {entry.output}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

        </div>
      )}

      {expanded && checkpointRestoreAction && (
        <div style={{
          padding: '8px 10px',
          borderTop: `1px solid ${theme.chat.assistantBubbleBorder}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}>
          {block.input && (
            <ToolInputView
              toolName={getToolDisplayName(block.name)}
              input={block.input}
              codePanelFontSize={codePanelFontSize}
            />
          )}
          {block.summary && (
            <div style={{
              fontSize: 11,
              color: theme.chat.muted,
              fontFamily: fonts.sans,
              lineHeight: 1.4,
            }}>
              {block.summary}
            </div>
          )}
          <button
            type="button"
            onClick={event => {
              event.stopPropagation()
              if (!checkpointRestoreCtx || !checkpointRestoreAction || isRestoringCheckpoint) return
              void checkpointRestoreCtx.restoreCheckpoint(
                checkpointRestoreAction.checkpointId,
                checkpointRestoreAction.sessionEntryId,
                checkpointRestoreAction.label,
              )
            }}
            disabled={isRestoringCheckpoint || !checkpointRestoreCtx}
            title="Restore workspace files from this checkpoint"
            style={{
              alignSelf: 'flex-start',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              border: `1px solid ${theme.chat.assistantBubbleBorder}`,
              background: theme.surface.panelMuted,
              color: isRestoringCheckpoint ? theme.chat.muted : theme.chat.text,
              borderRadius: 999,
              padding: '5px 9px',
              fontSize: 11,
              fontFamily: fonts.sans,
              fontWeight: 600,
              cursor: isRestoringCheckpoint ? 'default' : 'pointer',
              opacity: isRestoringCheckpoint ? 0.65 : 1,
              ...NON_SELECTABLE_UI_STYLE,
            }}
          >
            <RotateCcw size={12} />
            {isRestoringCheckpoint ? 'Restoring…' : 'Restore this checkpoint'}
          </button>
        </div>
      )}

      {expanded && !checkpointRestoreAction && !hasNestedData && block.input && (
        <div style={{
          padding: '4px 10px 8px 10px',
          borderTop: `1px solid ${theme.chat.assistantBubbleBorder}`,
        }}>
          <ToolInputView
            toolName={getToolDisplayName(block.name)}
            input={block.input}
            codePanelFontSize={codePanelFontSize}
          />
          {block.summary && (
            <div style={{
              marginTop: 6, padding: '4px 0',
              fontSize: 11, color: theme.chat.muted, fontFamily: fonts.mono,
            }}>
              {block.summary}
            </div>
          )}
        </div>
      )}

    </div>
  )
})

function formatToolInput(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

// Strip the "[CodeSurf memory guard] Older … truncated …" preamble that gets
// prepended to stale tool inputs, returning { notice, rest } so the UI can
// render a small badge instead of dumping the message inline.
function splitMemoryGuard(raw: string): { notice: string | null; body: string } {
  const trimmed = raw.trimStart()
  const m = /^\[CodeSurf memory guard\][^\n]*\n\n?/i.exec(trimmed)
  if (!m) return { notice: null, body: raw }
  return { notice: m[0].trim(), body: trimmed.slice(m[0].length) }
}

function tryParseToolInput(input: string): unknown {
  try { return JSON.parse(input) } catch { return null }
}

function getStr(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : null
}

function getNum(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== 'object') return null
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : null
}

function getBool(obj: unknown, key: string): boolean | null {
  if (!obj || typeof obj !== 'object') return null
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'boolean' ? v : null
}

function isPlanToolName(toolName: string): boolean {
  return toolName === 'TodoWrite' || toolName === 'update_plan'
}

function extractPlanTodosFromParsedInput(toolName: string, parsed: unknown): TileTodoItem[] {
  if (!parsed || typeof parsed !== 'object') return []

  if (toolName === 'TodoWrite') {
    const todosRaw = Array.isArray((parsed as Record<string, unknown>).todos)
      ? (parsed as Record<string, unknown>).todos as unknown[]
      : []
    const normalized: TileTodoItem[] = []
    for (const t of todosRaw) {
      const content = getStr(t, 'content') ?? ''
      if (!content) continue
      const status = (getStr(t, 'status') ?? 'pending') as TileTodoItem['status']
      const activeForm = getStr(t, 'activeForm') ?? undefined
      normalized.push({ content, status, activeForm })
    }
    return normalized
  }

  if (toolName === 'update_plan') {
    const planRaw = Array.isArray((parsed as Record<string, unknown>).plan)
      ? (parsed as Record<string, unknown>).plan as unknown[]
      : []
    const normalized: TileTodoItem[] = []
    for (const step of planRaw) {
      const content = getStr(step, 'step') ?? getStr(step, 'content') ?? ''
      if (!content) continue
      const status = (getStr(step, 'status') ?? 'pending') as TileTodoItem['status']
      normalized.push({ content, status })
    }
    return normalized
  }

  return []
}

function parsePlanToolTodos(toolName: string, input: string): { todos: TileTodoItem[] } | null {
  if (!isPlanToolName(toolName)) return null
  const parsed = tryParseToolInput(input)
  if (!parsed || typeof parsed !== 'object') return null
  return { todos: extractPlanTodosFromParsedInput(toolName, parsed) }
}

function ToolInputView({ toolName, input, codePanelFontSize }: {
  toolName: string
  input: string
  codePanelFontSize: number
}): JSX.Element {
  const fonts = useFonts()
  const theme = useTheme()
  const { notice, body } = splitMemoryGuard(input)
  const parsed = tryParseToolInput(body)

  // Tool-input payloads are often dense — force a tighter font than the
  // general code-panel size so long Edit/Write payloads don't dominate the
  // chat. Cap at 11px to match our Streamdown code-block font; small
  // reductions from the caller's font-size still apply below 11px.
  const toolInputFontSize = Math.min(11, codePanelFontSize)
  const codeStyle: React.CSSProperties = {
    margin: 0, padding: 8, borderRadius: 6,
    background: theme.surface.panelMuted, color: theme.chat.textSecondary,
    fontSize: toolInputFontSize, lineHeight: 1.45,
    fontFamily: fonts.mono, fontWeight: fonts.monoWeight,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    maxHeight: 240, overflowY: 'auto',
  }
  const labelStyle: React.CSSProperties = {
    fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
    color: theme.chat.muted, fontFamily: fonts.sans,
    textTransform: 'uppercase', marginBottom: 3,
  }
  const pathStyle: React.CSSProperties = {
    fontSize: toolInputFontSize, fontFamily: fonts.mono,
    color: theme.chat.text, wordBreak: 'break-all', padding: '2px 0',
  }
  const diffBlockStyle = (kind: 'add' | 'del'): React.CSSProperties => ({
    ...codeStyle,
    background: kind === 'add'
      ? `color-mix(in srgb, ${theme.status.success} 12%, ${theme.surface.panelMuted})`
      : `color-mix(in srgb, ${theme.status.danger} 12%, ${theme.surface.panelMuted})`,
    borderLeft: `3px solid ${kind === 'add' ? theme.status.success : theme.status.danger}`,
  })

  const noticeBanner = notice
    ? (
        <div style={{
          fontSize: 10, color: theme.chat.muted, fontFamily: fonts.sans,
          padding: '3px 8px', marginBottom: 6, borderRadius: 4,
          border: `1px dashed ${theme.chat.divider}`,
          background: 'transparent',
        }}>
          Older tool input truncated to save memory
        </div>
      )
    : null

  const renderKeyValue = (label: string, value: string, mono = true) => (
    <div key={label} style={{ marginBottom: 6 }}>
      <div style={labelStyle}>{label}</div>
      <div style={mono ? pathStyle : { ...pathStyle, fontFamily: fonts.sans }}>{value}</div>
    </div>
  )

  // --- Per-tool layouts ----------------------------------------------------
  if (toolName === 'Edit' && parsed) {
    const filePath = getStr(parsed, 'file_path')
    const oldStr = getStr(parsed, 'old_string') ?? ''
    const newStr = getStr(parsed, 'new_string') ?? ''
    const replaceAll = getBool(parsed, 'replace_all')
    return (
      <>
        {noticeBanner}
        {filePath && renderKeyValue('File', filePath)}
        {replaceAll && (
          <div style={{ ...labelStyle, color: theme.status.warning, marginBottom: 4 }}>Replace all occurrences</div>
        )}
        <div style={labelStyle}>Old</div>
        <pre style={diffBlockStyle('del')}>{oldStr}</pre>
        <div style={{ ...labelStyle, marginTop: 6 }}>New</div>
        <pre style={diffBlockStyle('add')}>{newStr}</pre>
      </>
    )
  }

  if (toolName === 'MultiEdit' && parsed) {
    const filePath = getStr(parsed, 'file_path')
    const edits = Array.isArray((parsed as Record<string, unknown>).edits)
      ? ((parsed as Record<string, unknown>).edits as unknown[])
      : []
    return (
      <>
        {noticeBanner}
        {filePath && renderKeyValue('File', filePath)}
        {edits.map((edit, index) => {
          const oldStr = getStr(edit, 'old_string') ?? ''
          const newStr = getStr(edit, 'new_string') ?? ''
          return (
            <div key={index} style={{ marginTop: index > 0 ? 10 : 0 }}>
              <div style={labelStyle}>Edit {index + 1} — Old</div>
              <pre style={diffBlockStyle('del')}>{oldStr}</pre>
              <div style={{ ...labelStyle, marginTop: 4 }}>Edit {index + 1} — New</div>
              <pre style={diffBlockStyle('add')}>{newStr}</pre>
            </div>
          )
        })}
      </>
    )
  }

  if (toolName === 'Write' && parsed) {
    const filePath = getStr(parsed, 'file_path')
    const content = getStr(parsed, 'content') ?? ''
    return (
      <>
        {noticeBanner}
        {filePath && renderKeyValue('File', filePath)}
        <div style={labelStyle}>Content</div>
        <pre style={codeStyle}>{content}</pre>
      </>
    )
  }

  if (toolName === 'Bash' && parsed) {
    const command = getStr(parsed, 'command') ?? ''
    const description = getStr(parsed, 'description')
    const timeout = getNum(parsed, 'timeout')
    return (
      <>
        {noticeBanner}
        {description && renderKeyValue('Description', description, false)}
        <div style={labelStyle}>Command</div>
        <pre style={codeStyle}>{command}</pre>
        {timeout != null && (
          <div style={{ ...labelStyle, marginTop: 4 }}>Timeout: {timeout}ms</div>
        )}
      </>
    )
  }

  if ((toolName === 'Read' || toolName === 'NotebookEdit') && parsed) {
    const filePath = getStr(parsed, 'file_path') ?? getStr(parsed, 'notebook_path')
    const offset = getNum(parsed, 'offset')
    const limit = getNum(parsed, 'limit')
    const pages = getStr(parsed, 'pages')
    const newSource = getStr(parsed, 'new_source')
    return (
      <>
        {noticeBanner}
        {filePath && renderKeyValue('File', filePath)}
        {(offset != null || limit != null) && (
          <div style={pathStyle}>
            {offset != null && <>offset: {offset}</>}
            {offset != null && limit != null && ' · '}
            {limit != null && <>limit: {limit}</>}
          </div>
        )}
        {pages && renderKeyValue('Pages', pages)}
        {newSource != null && (
          <>
            <div style={{ ...labelStyle, marginTop: 6 }}>New source</div>
            <pre style={codeStyle}>{newSource}</pre>
          </>
        )}
      </>
    )
  }

  if ((toolName === 'Grep' || toolName === 'Glob') && parsed) {
    const pattern = getStr(parsed, 'pattern') ?? ''
    const path = getStr(parsed, 'path')
    const glob = getStr(parsed, 'glob')
    const ftype = getStr(parsed, 'type')
    const outputMode = getStr(parsed, 'output_mode')
    return (
      <>
        {noticeBanner}
        <div style={labelStyle}>Pattern</div>
        <pre style={codeStyle}>{pattern}</pre>
        {path && renderKeyValue('Path', path)}
        {glob && renderKeyValue('Glob', glob)}
        {ftype && renderKeyValue('Type', ftype, false)}
        {outputMode && renderKeyValue('Output mode', outputMode, false)}
      </>
    )
  }

  if (toolName === 'WebFetch' && parsed) {
    const url = getStr(parsed, 'url') ?? ''
    const prompt = getStr(parsed, 'prompt')
    return (
      <>
        {noticeBanner}
        {renderKeyValue('URL', url)}
        {prompt && (
          <>
            <div style={labelStyle}>Prompt</div>
            <pre style={codeStyle}>{prompt}</pre>
          </>
        )}
      </>
    )
  }

  if (toolName === 'WebSearch' && parsed) {
    const query = getStr(parsed, 'query') ?? ''
    return (
      <>
        {noticeBanner}
        {renderKeyValue('Query', query, false)}
      </>
    )
  }

  if (parsed && isPlanToolName(toolName)) {
    const normalized = extractPlanTodosFromParsedInput(toolName, parsed)
    if (normalized.length === 0) {
      return (
        <>
          {noticeBanner}
          <pre style={codeStyle}>{formatToolInput(body)}</pre>
        </>
      )
    }
    return (
      <>
        {noticeBanner}
        <PlanCard todos={normalized} variant="inline" />
      </>
    )
  }

  // Shape-based fallback: some providers emit tool calls whose toolName
  // doesn't match our exact whitelist above (e.g. "str_replace_based_edit_tool"
  // instead of "Edit"), but the payload shape is recognisable. Detect by keys
  // so we still render the pretty diff layout instead of a raw JSON dump.
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const looksLikeEdit = typeof obj.old_string === 'string' && typeof obj.new_string === 'string'
    if (looksLikeEdit) {
      const filePath = getStr(parsed, 'file_path')
      const oldStr = getStr(parsed, 'old_string') ?? ''
      const newStr = getStr(parsed, 'new_string') ?? ''
      const replaceAll = getBool(parsed, 'replace_all')
      return (
        <>
          {noticeBanner}
          {filePath && renderKeyValue('File', filePath)}
          {replaceAll && (
            <div style={{ ...labelStyle, color: theme.status.warning, marginBottom: 4 }}>Replace all occurrences</div>
          )}
          <div style={labelStyle}>Old</div>
          <pre style={diffBlockStyle('del')}>{oldStr}</pre>
          <div style={{ ...labelStyle, marginTop: 6 }}>New</div>
          <pre style={diffBlockStyle('add')}>{newStr}</pre>
        </>
      )
    }
  }

  // Fallback: unescape JSON strings so embedded newlines render as actual line
  // breaks instead of literal "\n" sequences, and drop the memory-guard banner.
  // Unescaping is applied EVEN when parsing failed — some providers emit
  // slightly malformed JSON (trailing comma, unquoted key) but the string
  // is still readable once \n / \" / \t are decoded.
  const unescape = (s: string): string => s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t')
  const prettyFallback = parsed != null
    ? unescape(JSON.stringify(parsed, null, 2))
    : unescape(body)
  return (
    <>
      {noticeBanner}
      <pre style={codeStyle}>{prettyFallback}</pre>
    </>
  )
}
