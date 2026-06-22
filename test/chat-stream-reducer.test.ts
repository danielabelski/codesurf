import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import type { ChatMessage } from '../src/shared/chat-types.ts'
import { applyChatStreamEvent, isReducerEvent, type ChatStreamEvent } from '../src/renderer/src/hooks/chatStreamReducer.ts'

/**
 * Characterisation tests for the pure stream reducer extracted from
 * useChatStreamHandler. Fixtures are representative normalised event sequences
 * (the 14 event types the hook consumes). All events carry explicit ids so the
 * `Date.now()` synthetic-id fallback never fires — the reduced output is fully
 * deterministic and snapshot-stable.
 */

function freshAssistant(): ChatMessage {
  return { id: 'm1', role: 'assistant', content: '', timestamp: 0, isStreaming: true }
}

/** Fold an event sequence over a fresh streaming assistant message. */
function reduce(events: ChatStreamEvent[], start: ChatMessage = freshAssistant()): ChatMessage {
  return events.reduce(applyChatStreamEvent, start)
}

describe('chat stream reducer', () => {
  test('isReducerEvent owns block-model events, not side-effect events', () => {
    for (const t of ['thinking_start', 'thinking', 'tool_start', 'tool_input', 'tool_use', 'tool_summary', 'tool_progress', 'block_stop', 'done', 'error']) {
      expect(isReducerEvent(t)).toBe(true)
    }
    for (const t of ['session', 'text', 'tool_permission_request', 'tool_permission_resolved', 'unknown']) {
      expect(isReducerEvent(t)).toBe(false)
    }
  })

  test('non-owned events leave the message unchanged', () => {
    const start = freshAssistant()
    expect(applyChatStreamEvent(start, { type: 'session', sessionId: 's1' })).toBe(start)
    expect(applyChatStreamEvent(start, { type: 'text', text: 'hi' })).toBe(start)
    expect(applyChatStreamEvent(start, { type: 'unknown' })).toBe(start)
  })

  test('full assistant turn: thinking, two tools, summaries, block_stop, done', (t) => {
    const result = reduce([
      { type: 'thinking_start', thinkingId: 'th1' },
      { type: 'thinking', thinkingId: 'th1', text: 'Let me check the file' },
      { type: 'thinking', thinkingId: 'th1', text: ' and search.' },
      { type: 'tool_start', toolId: 't1', toolName: 'Read' },
      { type: 'tool_input', toolId: 't1', text: '{"path":' },
      { type: 'tool_input', toolId: 't1', text: '"a.ts"}' },
      { type: 'tool_use', toolId: 't1', toolName: 'Read', toolInput: '{"path":"a.ts"}' },
      { type: 'tool_summary', toolId: 't1', text: 'Read a.ts', commandEntries: [{ label: 'a.ts', kind: 'read' }] },
      { type: 'tool_start', toolId: 't2', toolName: 'Grep' },
      { type: 'tool_use', toolId: 't2', toolName: 'Grep', toolInput: '{"pattern":"foo"}' },
      { type: 'tool_summary', toolId: 't2', text: 'Searched for foo', commandEntries: [{ label: 'foo', kind: 'search' }] },
      { type: 'block_stop', thinkingId: 'th1' },
      { type: 'done', cost: 0.012, turns: 1 },
    ])
    t.assert.snapshot(result)
  })

  test('streaming tool input accumulates across deltas', (t) => {
    const result = reduce([
      { type: 'tool_start', toolId: 't1', toolName: 'Bash' },
      { type: 'tool_input', toolId: 't1', text: 'npm ' },
      { type: 'tool_input', toolId: 't1', text: 'run ' },
      { type: 'tool_input', toolId: 't1', text: 'test' },
      { type: 'tool_use', toolId: 't1', toolName: 'Bash' },
    ])
    t.assert.snapshot(result)
  })

  test('interleaved thinking and tool blocks preserve contentBlocks order', (t) => {
    const result = reduce([
      { type: 'thinking_start', thinkingId: 'th1' },
      { type: 'thinking', thinkingId: 'th1', text: 'first' },
      { type: 'tool_start', toolId: 't1', toolName: 'Read' },
      { type: 'tool_use', toolId: 't1', toolName: 'Read' },
      { type: 'thinking_start', thinkingId: 'th2' },
      { type: 'thinking', thinkingId: 'th2', text: 'second' },
      { type: 'block_stop', thinkingId: 'th2' },
    ])
    t.assert.snapshot(result)
  })

  test('done marks any still-running tool blocks as done', (t) => {
    const result = reduce([
      { type: 'tool_start', toolId: 't1', toolName: 'Read' },
      { type: 'done', cost: 0.001, turns: 2 },
    ])
    t.assert.snapshot(result)
  })

  test('tool events preserve raw name and add canonical metadata', () => {
    const result = reduce([
      { type: 'tool_start', toolId: 't1', toolName: 'Codex: Read_file' },
      { type: 'tool_use', toolId: 't1', toolName: 'mcp__codesurf__read_file', toolInput: '{"path":"a.ts"}' },
      { type: 'tool_summary', toolId: 't1', text: 'Read a.ts' },
    ])
    const block = result.toolBlocks?.[0]
    expect(block?.name).toBe('mcp__codesurf__read_file')
    expect(block?.rawName).toBe('mcp__codesurf__read_file')
    expect(block?.displayName).toBe('Read file')
    expect(block?.groupKey).toBe('read_file')
    expect(block?.namespace).toBe('codesurf')
  })

  test('orphan tool summaries become visible activity chips', () => {
    const result = reduce([
      { type: 'tool_summary', toolId: 'bg1', toolName: 'Background job', text: 'Started detached job.' },
    ])
    const block = result.toolBlocks?.[0]
    expect(block?.displayName).toBe('Background job')
    expect(block?.summary).toBe('Started detached job.')
    expect(result.contentBlocks?.[0]).toEqual({ type: 'tool', toolId: 'bg1' })
  })

  test('error fills empty content and stops streaming', (t) => {
    const result = reduce([
      { type: 'error', error: 'boom' },
    ])
    t.assert.snapshot(result)
  })

  test('error preserves existing content', () => {
    const start: ChatMessage = { ...freshAssistant(), content: 'partial answer' }
    const result = applyChatStreamEvent(start, { type: 'error', error: 'boom' })
    expect(result.content).toBe('partial answer')
    expect(result.isStreaming).toBe(false)
  })
})
