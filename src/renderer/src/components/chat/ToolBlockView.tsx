import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { Brain, Check, ChevronRight, Clock, Cog, History, RotateCcw, Sparkles, Wrench } from 'lucide-react'
import type { ToolBlock, ThinkingBlock, ChatMessage } from '../../../../shared/chat-types'
import type { TileTodoItem } from '../../state/tileTodosStore'
import { useTheme } from '../../ThemeContext'
import { ShimmerText } from '../shared/streamdown-utils'
import { DiffView } from './DiffView'
import { PlanCard } from './PlanCard'
import { isCheckpointToolBlock, getCheckpointRestoreAction } from './checkpointToolActions'
import { isDreamToolBlock } from './dreamToolActions'
import {
  parseAskUserQuestionInput,
  AskUserQuestionChip,
} from './AskUserQuestionForm'
import {
  ToolPermissionCard,
  useToolPermissionContext,
} from '../ai-elements/ToolPermission'
import {
  useFonts,
  CheckpointRestoreContext,
  TOOL_BLOCK_MAX_WIDTH,
  NON_SELECTABLE_UI_STYLE,
  getToolDisplayName,
  hasVisibleFileChangeStats,
  hasRenderableFileChangeDiff,
} from '../ChatTile'

// --- Rich message sub-components -------------------------------------------------

export const ThinkingBlockView = React.memo(function ThinkingBlockView({ thinking }: { thinking: ThinkingBlock }): JSX.Element {
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
            ? `var(--cs-edge-shadow), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
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
export const WorkingChipView = React.memo(function WorkingChipView({ message }: { message: ChatMessage }): JSX.Element | null {
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
        ? `var(--cs-edge-shadow), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
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

export const StreamingLivenessIndicator = React.memo(function StreamingLivenessIndicator({ lastActivityAtMs }: {
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
export const MixedToolGroup = React.memo(function MixedToolGroup({ blocks }: { blocks: ToolBlock[] }): JSX.Element {
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
            ? `var(--cs-edge-shadow), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
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

export const CollapsedToolGroup = React.memo(function CollapsedToolGroup({ name, blocks }: { name: string; blocks: ToolBlock[] }): JSX.Element {
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
            ? `var(--cs-edge-shadow), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
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


export const ToolBlockView = React.memo(function ToolBlockView({ block, isLive = false }: { block: ToolBlock; isLive?: boolean }): JSX.Element {
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
          ? `var(--cs-edge-shadow), 0 0 0 0.5px color-mix(in srgb, ${theme.text.primary} 12%, transparent)`
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

export function parsePlanToolTodos(toolName: string, input: string): { todos: TileTodoItem[] } | null {
  if (!isPlanToolName(toolName)) return null
  const parsed = tryParseToolInput(input)
  if (!parsed || typeof parsed !== 'object') return null
  return { todos: extractPlanTodosFromParsedInput(toolName, parsed) }
}

export function ToolInputView({ toolName, input, codePanelFontSize }: {
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
