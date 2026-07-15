import { clearTileMessages } from './chat/chatMessagesStore.ts'

const chatTileRuntimeState = new Map<string, unknown>()
const disposedChatTileIds = new Set<string>()
// The tombstone set only needs to reject late async writes that race a recent
// disposal, so bound it — without a cap it grows by one UUID per chat tile ever
// deleted for the whole renderer session.
const DISPOSED_TOMBSTONE_CAP = 256

export function getChatTileRuntimeState<T>(tileId: string): T | null {
  if (disposedChatTileIds.has(tileId)) return null
  return (chatTileRuntimeState.get(tileId) as T | undefined) ?? null
}

export function setChatTileRuntimeState<T>(tileId: string, state: T): void {
  if (disposedChatTileIds.has(tileId)) return
  chatTileRuntimeState.set(tileId, state)
}

export function disposeChatTileRuntimeState(tileId: string): void {
  disposedChatTileIds.add(tileId)
  chatTileRuntimeState.delete(tileId)
  clearTileMessages(tileId)
  if (disposedChatTileIds.size > DISPOSED_TOMBSTONE_CAP) {
    // Sets preserve insertion order; evict the oldest tombstone.
    const oldest = disposedChatTileIds.values().next().value
    if (oldest !== undefined) disposedChatTileIds.delete(oldest)
  }
}

export function reviveChatTileRuntimeState(tileId: string): void {
  disposedChatTileIds.delete(tileId)
}

export function isChatTileRuntimeStateDisposed(tileId: string): boolean {
  return disposedChatTileIds.has(tileId)
}
