import assert from 'node:assert/strict'
import { describe, test, beforeEach } from 'node:test'
import {
  getChatStreamHubListenerCount,
  getChatStreamHubTileCount,
  isChatStreamHubTransportActive,
  resetChatStreamHubForTests,
  setChatStreamHubTransportForTests,
  subscribeChatStream,
  type ChatStreamChunk,
} from '../src/renderer/src/components/chat/chatStreamHub.ts'

beforeEach(() => {
  resetChatStreamHubForTests()
})

describe('chatStreamHub demux', () => {
  test('attaches transport once for multiple tile subscribers', () => {
    let attachCount = 0
    let detachCount = 0
    let push: ((e: ChatStreamChunk) => void) | null = null

    setChatStreamHubTransportForTests((onChunk) => {
      attachCount += 1
      push = onChunk
      return () => { detachCount += 1; push = null }
    })

    const a: ChatStreamChunk[] = []
    const b: ChatStreamChunk[] = []
    const unsubA = subscribeChatStream('tile-a', e => { a.push(e) })
    const unsubB = subscribeChatStream('tile-b', e => { b.push(e) })

    assert.equal(attachCount, 1)
    assert.equal(isChatStreamHubTransportActive(), true)
    assert.equal(getChatStreamHubTileCount(), 2)
    assert.equal(getChatStreamHubListenerCount(), 2)

    push!({ cardId: 'tile-a', type: 'text', text: 'only-a' })
    push!({ cardId: 'tile-b', type: 'text', text: 'only-b' })
    push!({ cardId: 'tile-a', type: 'text', text: 'a2' })

    assert.deepEqual(a.map(e => e.text), ['only-a', 'a2'])
    assert.deepEqual(b.map(e => e.text), ['only-b'])

    unsubA()
    assert.equal(getChatStreamHubTileCount(), 1)
    assert.equal(detachCount, 0) // still one tile

    unsubB()
    assert.equal(getChatStreamHubTileCount(), 0)
    assert.equal(detachCount, 1)
    assert.equal(isChatStreamHubTransportActive(), false)
  })

  test('second listener on same tile does not re-attach transport', () => {
    let attachCount = 0
    setChatStreamHubTransportForTests((onChunk) => {
      attachCount += 1
      return () => {}
    })

    const u1 = subscribeChatStream('tile-a', () => {})
    const u2 = subscribeChatStream('tile-a', () => {})
    assert.equal(attachCount, 1)
    assert.equal(getChatStreamHubListenerCount(), 2)
    assert.equal(getChatStreamHubTileCount(), 1)
    u1()
    assert.equal(isChatStreamHubTransportActive(), true)
    u2()
    assert.equal(isChatStreamHubTransportActive(), false)
  })

  test('drops events with missing cardId', () => {
    let push: ((e: ChatStreamChunk) => void) | null = null
    setChatStreamHubTransportForTests((onChunk) => {
      push = onChunk
      return () => {}
    })
    const seen: ChatStreamChunk[] = []
    const unsub = subscribeChatStream('tile-a', e => { seen.push(e) })
    push!({ cardId: '', type: 'text', text: 'nope' } as ChatStreamChunk)
    push!({ type: 'text', text: 'nope2' } as ChatStreamChunk)
    push!({ cardId: 'tile-a', type: 'text', text: 'ok' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.text, 'ok')
    unsub()
  })
})
