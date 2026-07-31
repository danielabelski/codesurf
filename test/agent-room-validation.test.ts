import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  MAX_EVENT_TEXT_BYTES,
  MAX_EVENT_TARGETS,
  MAX_MEMBER_FILES,
  MAX_METADATA_ARRAY_ITEMS,
  MAX_METADATA_BYTES,
  MAX_RETAINED_EVENT_BYTES,
  MAX_TILE_ID_BYTES,
  assertValidAgentRoomId,
  boundEventText,
  boundMemberFiles,
  boundMetadata,
  boundTargetTileIds,
  capRetainedEvents,
  isValidAgentRoomId,
  retainedEventBytes,
} from '../src/main/agent-room/validation.ts'
import type { RoomEvent } from '../src/main/agent-room/types.ts'

describe('agent-room validation primitives', () => {
  test('accepts ordinary generated IDs and rejects unsafe path/Unicode forms', () => {
    assert.equal(assertValidAgentRoomId('tile-1723456789'), 'tile-1723456789')
    assert.equal(assertValidAgentRoomId('7b7fe977-eaf2-4f18-a234-099bdf3b444f'), '7b7fe977-eaf2-4f18-a234-099bdf3b444f')

    for (const value of [
      '',
      '.',
      '..',
      '../escape',
      '/tmp/escape',
      'a/b',
      'a\\b',
      'a\0b',
      'a\nb',
      'a\u007fb',
      'tîle',
      'a\u202eb',
      'tile.',
      'CON',
      'nul.txt',
      'COM9',
      'lpt1.log',
      `a${'b'.repeat(MAX_TILE_ID_BYTES)}`,
    ]) {
      assert.equal(isValidAgentRoomId(value), false, JSON.stringify(value))
      assert.throws(() => assertValidAgentRoomId(value), /Invalid tileId/)
    }
  })

  test('truncates event text on a UTF-8 boundary with an explicit marker', () => {
    const bounded = boundEventText(`prefix:${'😀'.repeat(MAX_EVENT_TEXT_BYTES)}`)
    assert.ok(Buffer.byteLength(bounded, 'utf8') <= MAX_EVENT_TEXT_BYTES)
    assert.match(bounded, /\[truncated\]$/)
    assert.equal(bounded.includes('\ufffd'), false)
  })

  test('normalizes cyclic and oversized metadata to bounded JSON', () => {
    const input: Record<string, unknown> = {
      huge: 'x'.repeat(MAX_METADATA_BYTES * 2),
      items: Array.from({ length: MAX_METADATA_ARRAY_ITEMS * 2 }, (_, index) => index),
    }
    input.self = input

    const bounded = boundMetadata(input)
    const json = JSON.stringify(bounded)
    assert.ok(Buffer.byteLength(json, 'utf8') <= MAX_METADATA_BYTES)
    assert.match(json, /truncated/i)
    assert.equal(json.includes('"self":{'), false)

    let getterCalls = 0
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'throwing', {
      enumerable: true,
      get() {
        getterCalls += 1
        throw new Error('getter must not run during validation')
      },
    })
    assert.match(JSON.stringify(boundMetadata(hostile)), /accessor property/i)
    assert.equal(getterCalls, 0)
  })

  test('bounds target and file array inspection to the retained prefix', () => {
    assert.deepEqual(boundTargetTileIds([
      ...Array.from({ length: MAX_EVENT_TARGETS }, () => '../invalid'),
      'valid-beyond-limit',
    ]), [])
    assert.deepEqual(boundMemberFiles([
      ...Array.from({ length: MAX_MEMBER_FILES }, () => null),
      'valid-beyond-limit',
    ]), ['[truncated]'])
  })

  test('caps retained room bytes using newest events', () => {
    const events: RoomEvent[] = Array.from({ length: 400 }, (_, index) => ({
      id: `event-${index}`,
      sequence: index + 1,
      roomId: 'room-a',
      kind: 'message',
      fromTileId: 'tile-a',
      fromTileType: 'chat',
      text: boundEventText(`${index}:${'x'.repeat(MAX_EVENT_TEXT_BYTES)}`),
      targetTileIds: [],
      createdAt: index,
    }))

    const capped = capRetainedEvents(events)
    assert.ok(retainedEventBytes(capped) <= MAX_RETAINED_EVENT_BYTES)
    assert.equal(capped.at(-1)?.id, events.at(-1)?.id)
    assert.ok(capped[0]!.sequence > 1)
  })
})
