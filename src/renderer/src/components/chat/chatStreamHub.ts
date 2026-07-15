/**
 * Single global chat stream demux.
 *
 * Without this, each ChatTile mounts its own `stream.onChunk` listener and
 * every tile filters every event by cardId. With N chat tiles that is N IPC
 * handlers firing per chunk.
 *
 * The hub attaches at most one transport subscription and fans out by cardId.
 * Pure / testable: inject `attachTransport` instead of `window.electron`.
 */

export type ChatStreamChunk = {
  cardId: string
  type: string
  text?: string
  toolName?: string
  error?: string
  [key: string]: unknown
}

export type ChatStreamListener = (event: ChatStreamChunk) => void

/** Attach a global transport; return unsubscribe. */
export type ChatStreamTransportAttach = (
  onChunk: (event: ChatStreamChunk) => void,
) => () => void

const listenersByTile = new Map<string, Set<ChatStreamListener>>()
let transportUnsub: (() => void) | null = null
let transportAttach: ChatStreamTransportAttach | null = null
/** Test override — when set, used instead of window.electron.stream.onChunk. */
let transportOverride: ChatStreamTransportAttach | null = null

function defaultTransportAttach(onChunk: (event: ChatStreamChunk) => void): () => void {
  const api = typeof window !== 'undefined' ? window.electron?.stream?.onChunk : undefined
  if (typeof api !== 'function') {
    return () => {}
  }
  return api((event: ChatStreamChunk) => {
    onChunk(event)
  })
}

function dispatch(event: ChatStreamChunk): void {
  const cardId = typeof event?.cardId === 'string' ? event.cardId : ''
  if (!cardId) return
  const set = listenersByTile.get(cardId)
  if (!set || set.size === 0) return
  for (const listener of set) {
    try {
      listener(event)
    } catch {
      /* ignore listener errors */
    }
  }
}

function ensureTransport(): void {
  if (transportUnsub) return
  const attach = transportOverride ?? transportAttach ?? defaultTransportAttach
  transportUnsub = attach(dispatch)
}

function maybeTeardownTransport(): void {
  if (listenersByTile.size > 0) return
  if (transportUnsub) {
    try { transportUnsub() } catch { /* ignore */ }
    transportUnsub = null
  }
}

/**
 * Subscribe to stream chunks for one tile/card id.
 * Returns unsubscribe. Global transport tears down when the last tile leaves.
 */
export function subscribeChatStream(
  tileId: string,
  listener: ChatStreamListener,
): () => void {
  if (!tileId) return () => {}
  let set = listenersByTile.get(tileId)
  if (!set) {
    set = new Set()
    listenersByTile.set(tileId, set)
  }
  set.add(listener)
  ensureTransport()

  return () => {
    const current = listenersByTile.get(tileId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listenersByTile.delete(tileId)
    maybeTeardownTransport()
  }
}

/** How many tiles currently have at least one stream listener. */
export function getChatStreamHubTileCount(): number {
  return listenersByTile.size
}

/** Total listener callbacks registered (may be > tile count). */
export function getChatStreamHubListenerCount(): number {
  let n = 0
  for (const set of listenersByTile.values()) n += set.size
  return n
}

/** True when the hub holds an active transport subscription. */
export function isChatStreamHubTransportActive(): boolean {
  return transportUnsub != null
}

/**
 * Test-only: inject a fake transport. Pass null to restore default.
 * Clears any active transport so the next subscribe re-attaches.
 */
export function setChatStreamHubTransportForTests(
  attach: ChatStreamTransportAttach | null,
): void {
  if (transportUnsub) {
    try { transportUnsub() } catch { /* ignore */ }
    transportUnsub = null
  }
  transportOverride = attach
  if (listenersByTile.size > 0) ensureTransport()
}

/** Test-only: drop all listeners and transport. */
export function resetChatStreamHubForTests(): void {
  listenersByTile.clear()
  if (transportUnsub) {
    try { transportUnsub() } catch { /* ignore */ }
    transportUnsub = null
  }
  transportOverride = null
  transportAttach = null
}
