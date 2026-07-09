import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  updateLinks,
  post,
  consume,
  digest,
  prepareTurnContext,
  publishTurnSummary,
  getRoomForTile,
  leaveRoom,
} from '../src/main/agent-room/store.ts'

describe('agent-room', () => {
  it('creates a room when two tiles are wired', () => {
    const a = 'tile-a-test'
    const b = 'tile-b-test'
    leaveRoom(a)
    leaveRoom(b)

    const room = updateLinks(a, [b], { [a]: 'chat', [b]: 'chat' })
    assert.ok(room)
    assert.equal(room!.members.length, 2)
    assert.equal(getRoomForTile(a)?.id, room!.id)
    assert.equal(getRoomForTile(b)?.id, room!.id)

    const d = digest(a)
    assert.equal(d.roomId, room!.id)
    assert.match(d.standingText, /Agent Room/)
  })

  it('delivers posts via consume once (cursor-gated)', () => {
    const a = 'tile-a-consume'
    const b = 'tile-b-consume'
    leaveRoom(a)
    leaveRoom(b)
    updateLinks(a, [b], { [a]: 'chat', [b]: 'terminal' })

    const event = post({ fromTileId: a, text: 'hello peer', kind: 'task' })
    assert.ok(event)

    const first = consume(b)
    assert.equal(first.events.length, 1)
    assert.match(first.text, /hello peer/)
    assert.match(first.text, /Shared agent room traffic/)

    const second = consume(b)
    assert.equal(second.events.length, 0)
    assert.equal(second.text, '')
  })

  it('prepareTurnContext injects pending room traffic', () => {
    const a = 'tile-a-turn'
    const b = 'tile-b-turn'
    leaveRoom(a)
    leaveRoom(b)
    updateLinks(a, [b], { [a]: 'chat', [b]: 'chat' })
    post({ fromTileId: a, text: 'please review the PR', kind: 'handoff' })

    const prepared = prepareTurnContext(b, 'chat')
    assert.ok(prepared.roomId)
    assert.match(prepared.systemExtra, /please review the PR/)
    assert.match(prepared.systemExtra, /Agent Room|Shared agent room/)
  })

  it('publishTurnSummary shares assistant output', () => {
    const a = 'tile-a-sum'
    const b = 'tile-b-sum'
    leaveRoom(a)
    leaveRoom(b)
    updateLinks(a, [b], { [a]: 'chat', [b]: 'chat' })
    publishTurnSummary(a, 'I finished the refactor.', 'chat')
    const forB = consume(b)
    assert.ok(forB.events.some(e => e.kind === 'summary'))
    assert.match(forB.text, /finished the refactor/)
  })
})
