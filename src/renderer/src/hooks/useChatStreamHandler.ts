import { useEffect } from 'react'
import type { ChatMessage, ToolBlock, ThinkingBlock } from '../../../shared/chat-types'
import type { ToolPermissionDecision, ToolPermissionRequest } from '../components/ai-elements/ToolPermission'

/** Merge a duplicate tool block entry, preferring non-empty / more-advanced state. */
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

export interface ChatStreamHandlerArgs {
  tileId: string
  setMessagesSafe: (fn: (prev: ChatMessage[]) => ChatMessage[]) => void
  setSessionId: (id: string) => void
  setIsStreaming: (v: boolean) => void
  setJobId: (id: string) => void
  setJobSequence: (seq: number) => void
  flushPendingStreamText: () => void
  queueStreamText: (text: string) => void
  lastJobSequenceRef: React.MutableRefObject<number>
  setPendingToolPermissions: React.Dispatch<React.SetStateAction<Map<string, ToolPermissionRequest>>>
  setResolvedToolPermissions: React.Dispatch<React.SetStateAction<Map<string, ToolPermissionDecision>>>
}

export function useChatStreamHandler({
  tileId,
  setMessagesSafe,
  setSessionId,
  setIsStreaming,
  setJobId,
  setJobSequence,
  flushPendingStreamText,
  queueStreamText,
  lastJobSequenceRef,
  setPendingToolPermissions,
  setResolvedToolPermissions,
}: ChatStreamHandlerArgs): void {

  useEffect(() => {
    const updateLast = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessagesSafe(prev => {
        const last = prev[prev.length - 1]
        if (last?.isStreaming) return [...prev.slice(0, -1), fn(last)]
        return prev
      })

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
}
