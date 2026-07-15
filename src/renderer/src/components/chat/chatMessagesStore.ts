/**
 * Per-tile chat message store with stream isolation.
 *
 * Transcript subscribers observe the messages snapshot (new reference whenever
 * messages change). Non-transcript "chrome" subscribers observe a chrome
 * snapshot that stays referentially stable across pure assistant-text stream
 * flushes (content / contentBlocks text growth on the last streaming message).
 *
 * One source of truth for live messages per tile — React tiles subscribe via
 * useSyncExternalStore; stream buffer and stream handler write here.
 */

import type { ChatMessage } from '../../../../shared/chat-types'

export type ChatChromeSnapshot = {
  /** Bumps only when a non-text-only messages update lands. */
  revision: number
}

export type ChatMessagesSnapshot = {
  messages: readonly ChatMessage[]
  /** Bumps on every messages change (including pure text stream). */
  revision: number
}

type TileEntry = {
  messages: ChatMessage[]
  messagesRevision: number
  chromeRevision: number
  messagesSnapshot: ChatMessagesSnapshot
  chromeSnapshot: ChatChromeSnapshot
  listeners: Set<() => void>
}

const tiles = new Map<string, TileEntry>()

const EMPTY_MESSAGES: ChatMessage[] = []

function emptyMessagesSnapshot(): ChatMessagesSnapshot {
  return { messages: EMPTY_MESSAGES, revision: 0 }
}

function emptyChromeSnapshot(): ChatChromeSnapshot {
  return { revision: 0 }
}

function ensureTile(tileId: string): TileEntry {
  let entry = tiles.get(tileId)
  if (entry) return entry
  entry = {
    messages: [],
    messagesRevision: 0,
    chromeRevision: 0,
    messagesSnapshot: emptyMessagesSnapshot(),
    chromeSnapshot: emptyChromeSnapshot(),
    listeners: new Set(),
  }
  tiles.set(tileId, entry)
  return entry
}

/**
 * True when `next` only appends/extends streaming assistant text on the last
 * message vs `prev` (same length, same prefix refs, last message still streaming).
 */
export function isPureTextStreamUpdate(
  prev: readonly ChatMessage[],
  next: readonly ChatMessage[],
): boolean {
  if (prev.length !== next.length || prev.length === 0) return false
  for (let i = 0; i < prev.length - 1; i++) {
    if (prev[i] !== next[i]) return false
  }
  const a = prev[prev.length - 1]
  const b = next[prev.length - 1]
  if (!a || !b) return false
  if (a.id !== b.id || a.role !== 'assistant') return false
  if (!a.isStreaming || !b.isStreaming) return false
  // Structural / tool / thinking identity must be unchanged (same refs preferred).
  if (a.toolBlocks !== b.toolBlocks) return false
  if (a.thinkingBlocks !== b.thinkingBlocks) return false
  if (a.thinking !== b.thinking) return false
  if (a.note !== b.note) return false
  if (a.cost !== b.cost || a.turns !== b.turns) return false
  // Content must actually change for this to count as a text stream update.
  if (a.content === b.content && a.contentBlocks === b.contentBlocks) return false
  return true
}

function publish(
  entry: TileEntry,
  nextMessages: ChatMessage[],
  pureText: boolean,
): void {
  entry.messages = nextMessages
  entry.messagesRevision += 1
  if (!pureText) {
    entry.chromeRevision += 1
    entry.chromeSnapshot = { revision: entry.chromeRevision }
  }
  entry.messagesSnapshot = {
    messages: nextMessages,
    revision: entry.messagesRevision,
  }
  for (const listener of entry.listeners) {
    try { listener() } catch { /* ignore subscriber errors */ }
  }
}

export function getTileMessages(tileId: string): ChatMessage[] {
  return ensureTile(tileId).messages
}

export function getTileMessagesSnapshot(tileId: string): ChatMessagesSnapshot {
  return ensureTile(tileId).messagesSnapshot
}

export function getTileChromeSnapshot(tileId: string): ChatChromeSnapshot {
  return ensureTile(tileId).chromeSnapshot
}

export function subscribeTileMessages(
  tileId: string,
  listener: () => void,
): () => void {
  const entry = ensureTile(tileId)
  entry.listeners.add(listener)
  return () => { entry.listeners.delete(listener) }
}

/** Replace or update messages for a tile. Detects pure text stream updates. */
export function updateTileMessages(
  tileId: string,
  updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
): ChatMessage[] {
  const entry = ensureTile(tileId)
  const prev = entry.messages
  const next = typeof updater === 'function' ? updater(prev) : updater
  if (next === prev) return prev
  // Shallow equality of array contents (same refs, same length)
  if (
    next.length === prev.length
    && next.every((m, i) => m === prev[i])
  ) {
    return prev
  }
  const pureText = isPureTextStreamUpdate(prev, next)
  publish(entry, next, pureText)
  return next
}

/** Seed or hard-replace messages (e.g. session load). Always bumps chrome. */
export function replaceTileMessages(tileId: string, messages: ChatMessage[]): void {
  const entry = ensureTile(tileId)
  publish(entry, messages, false)
}

/**
 * Append text onto the last streaming assistant message (stream buffer flush).
 * Pure-text path — chrome snapshot stays stable.
 */
export function appendStreamingAssistantText(
  tileId: string,
  text: string,
): ChatMessage[] {
  if (!text) return getTileMessages(tileId)
  return updateTileMessages(tileId, prev => {
    const last = prev[prev.length - 1]
    if (!last?.isStreaming || last.role !== 'assistant') return prev
    const blocks = [...(last.contentBlocks ?? [])]
    const lastBlock = blocks[blocks.length - 1]
    if (lastBlock?.type === 'text') {
      blocks[blocks.length - 1] = { ...lastBlock, text: lastBlock.text + text }
    } else {
      blocks.push({ type: 'text', text })
    }
    return [
      ...prev.slice(0, -1),
      { ...last, content: last.content + text, contentBlocks: blocks },
    ]
  })
}

/** Test / session teardown helper. */
export function clearTileMessages(tileId: string): void {
  tiles.delete(tileId)
}

/** Test helper: clear all tiles. */
export function clearAllTileMessages(): void {
  tiles.clear()
}
