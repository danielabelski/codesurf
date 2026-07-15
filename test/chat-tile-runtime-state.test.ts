import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  disposeChatTileRuntimeState,
  getChatTileRuntimeState,
  reviveChatTileRuntimeState,
  setChatTileRuntimeState,
} from '../src/renderer/src/components/chatTileRuntimeState.ts'
import {
  getTileMessages,
  replaceTileMessages,
} from '../src/renderer/src/components/chat/chatMessagesStore.ts'

test('disposing a chat tile releases both runtime state and transcript messages', () => {
  const tileId = 'chat-dispose-test'
  reviveChatTileRuntimeState(tileId)
  setChatTileRuntimeState(tileId, { input: 'draft' })
  replaceTileMessages(tileId, [
    { id: 'm1', role: 'assistant', content: 'retained transcript', timestamp: 1 },
  ])

  disposeChatTileRuntimeState(tileId)

  assert.equal(getChatTileRuntimeState(tileId), null)
  assert.deepEqual(getTileMessages(tileId), [])
})
