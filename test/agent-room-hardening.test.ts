import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, beforeEach, describe, test } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'codesurf-agent-room-store-'))
process.env.CODESURF_HOME = testHome

const room = await import('../src/main/agent-room/store.ts')
const limits = await import('../src/main/agent-room/validation.ts')

beforeEach(async () => {
  await room.disposeAgentRooms()
})

after(async () => {
  await room.disposeAgentRooms()
  await rm(testHome, { recursive: true, force: true })
})

describe('agent-room validation and bounds', () => {
  test('rejects traversal, absolute, separator, control, NUL, and non-ASCII IDs before mutation', async () => {
    const outsidePath = join(tmpdir(), `${basename(testHome)}-outside`)
    await assert.rejects(access(outsidePath))
    const invalidIds = [
      '',
      '.',
      '..',
      '../escape',
      outsidePath,
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
      `a${'b'.repeat(limits.MAX_TILE_ID_BYTES)}`,
    ]

    for (const invalidId of invalidIds) {
      assert.equal(room.updateLinks(invalidId, ['safe-peer']), null)
      assert.equal(room.updateLinks('safe-owner', [invalidId]), null)
      assert.equal(room.post({ fromTileId: invalidId, text: 'nope' }), null)
      assert.equal(room.getRoomForTile(invalidId), null)
      assert.equal(room.setState(invalidId, { task: 'nope' }).tileId, 'invalid')
      assert.equal(room.sendMessage(invalidId, 'safe-peer', 'nope').from, 'invalid')
    }
    assert.equal(
      room.updateLinks(
        'safe-owner',
        Array.from({ length: limits.MAX_ROOM_MEMBERS }, () => 'safe-peer'),
      ),
      null,
    )

    await room.flushAgentRooms()
    assert.deepEqual(room.getAgentRoomStats(), {
      rooms: 0,
      memberships: 0,
      todos: 0,
      ownedRoomFiles: 0,
      ownedInboxFiles: 0,
      pendingPersistencePaths: 0,
      retainedEventBytes: 0,
    })
    assert.deepEqual(await readdir(testHome), [])
    await assert.rejects(access(outsidePath))
  })

  test('bounds posts, targets, metadata, retained bytes, and injected prompt bytes with markers', async () => {
    const a = 'bounds-a'
    const b = 'bounds-b'
    assert.ok(room.updateLinks(a, [b], { [a]: 'chat', [b]: 'chat' }))

    const cyclic: Record<string, unknown> = {
      huge: 'm'.repeat(limits.MAX_METADATA_BYTES * 2),
      array: Array.from({ length: limits.MAX_METADATA_ARRAY_ITEMS * 2 }, (_, index) => index),
    }
    cyclic.self = cyclic

    for (let index = 0; index < limits.MAX_EVENTS_PER_ROOM * 2; index += 1) {
      const event = room.post({
        fromTileId: a,
        text: `${index}:${'x'.repeat(limits.MAX_EVENT_TEXT_BYTES * 2)}`,
        targetTileIds: [
          b,
          ...Array.from(
            { length: limits.MAX_EVENT_TARGETS * 2 },
            (_, targetIndex) => `target-${targetIndex}`,
          ),
        ],
        meta: cyclic,
      })
      assert.ok(event)
      assert.ok(Buffer.byteLength(event!.text, 'utf8') <= limits.MAX_EVENT_TEXT_BYTES)
      assert.match(event!.text, /\[truncated\]$/)
      assert.ok(event!.targetTileIds.length <= limits.MAX_EVENT_TARGETS)
      assert.ok(Buffer.byteLength(JSON.stringify(event!.meta), 'utf8') <= limits.MAX_METADATA_BYTES)
      assert.match(JSON.stringify(event!.meta), /truncated/i)
      assert.match(JSON.stringify(event!.meta), /TruncatedTargets/)
    }

    const prepared = room.prepareTurnContext(b)
    assert.ok(Buffer.byteLength(prepared.systemExtra, 'utf8') <= limits.MAX_PROMPT_BYTES)
    assert.match(prepared.systemExtra, /omitted|truncated/i)
    assert.match(prepared.systemExtra, /retained room traffic unavailable/i)
    const snapshot = room.getRoomForTile(a)
    assert.ok(snapshot)
    assert.ok(snapshot!.eventCount <= limits.MAX_EVENTS_PER_ROOM)
    assert.ok(room.getAgentRoomStats().retainedEventBytes! <= limits.MAX_RETAINED_EVENT_BYTES)
  })

  test('bounds member names, tasks, and file lists deterministically', () => {
    const a = 'member-a'
    const b = 'member-b'
    room.updateLinks(a, [b])

    const member = room.setMemberState(a, {
      displayName: 'n'.repeat(limits.MAX_DISPLAY_NAME_BYTES * 2),
      task: 't'.repeat(limits.MAX_MEMBER_TASK_BYTES * 2),
      files: Array.from(
        { length: limits.MAX_MEMBER_FILES * 2 },
        (_, index) => `/very/long/${index}/${'f'.repeat(limits.MAX_MEMBER_FILE_BYTES * 2)}`,
      ),
    })

    assert.ok(member)
    assert.ok(Buffer.byteLength(member!.displayName!, 'utf8') <= limits.MAX_DISPLAY_NAME_BYTES)
    assert.match(member!.displayName!, /\[truncated\]$/)
    assert.ok(Buffer.byteLength(member!.task, 'utf8') <= limits.MAX_MEMBER_TASK_BYTES)
    assert.match(member!.task, /\[truncated\]$/)
    assert.equal(member!.files.length, limits.MAX_MEMBER_FILES)
    assert.ok(member!.files.every(file => Buffer.byteLength(file, 'utf8') <= limits.MAX_MEMBER_FILE_BYTES))
    assert.equal(member!.files.at(-1), limits.TRUNCATION_MARKER)

    member!.files[0] = 'mutated-by-caller'
    assert.notEqual(
      room.getRoomForTile(a)!.members.find(candidate => candidate.tileId === a)!.files[0],
      'mutated-by-caller',
    )
  })

  test('invalid direct-message targets cannot broaden into a room-wide post', () => {
    room.updateLinks('target-a', ['target-b'])
    assert.equal(room.post({
      fromTileId: 'target-a',
      targetTileIds: [
        ...Array.from(
          { length: limits.MAX_EVENT_TARGETS },
          () => '../invalid-target',
        ),
        'target-b',
      ],
      text: 'must not broadcast',
    }), null)
    assert.deepEqual(room.consume('target-b').events, [])
  })
})

describe('agent-room lifecycle', () => {
  test('rejects case-folded tile collisions and clears the index on dispose', async () => {
    assert.ok(room.updateLinks('Case-A', ['case-peer']))
    assert.equal(room.updateLinks('case-a', ['other-peer']), null)
    assert.ok(room.getRoomForTile('Case-A'))
    assert.equal(room.getRoomForTile('case-a'), null)

    await room.disposeAgentRooms()
    assert.ok(room.updateLinks('case-a', ['other-peer']))
  })

  test('does not resurrect todos after leave and rejoin', async () => {
    room.updateLinks('todo-a', ['todo-b'])
    room.addTodo('todo-a', 'must disappear')
    room.leaveRoom('todo-a')
    room.leaveRoom('todo-b')
    room.updateLinks('todo-a', ['todo-c'])

    assert.deepEqual(room.getState('todo-a')?.todos, [])
    await room.flushAgentRooms()
  })

  test('leave and dispose preserve untracked files under the app home', async () => {
    const untrackedDir = join(testHome, 'room-inboxes', 'untracked-tile')
    const untrackedFile = join(untrackedDir, 'ROOM.md')
    await mkdir(untrackedDir, { recursive: true })
    await writeFile(untrackedFile, 'sentinel')

    room.leaveRoom('untracked-tile')
    await room.disposeAgentRooms()
    assert.equal(await readFile(untrackedFile, 'utf8'), 'sentinel')

    await rm(join(testHome, 'room-inboxes'), { recursive: true, force: true })
  })

  test('100 update cycles flush deterministically and repeated lifecycle returns memory and disk to baseline', async () => {
    for (let cycle = 0; cycle < 100; cycle += 1) {
      const a = `cycle-${cycle}-a`
      const b = `cycle-${cycle}-b`
      room.updateLinks(a, [b], { [a]: 'chat', [b]: 'terminal' })
      room.setMemberState(a, { status: 'working', task: `revision-${cycle}` })
      room.post({ fromTileId: a, text: `event-${cycle}` })
      room.removeTile(a)
      room.removeTile(b)
    }

    await room.flushAgentRooms()
    assert.deepEqual(room.getAgentRoomStats(), {
      rooms: 0,
      memberships: 0,
      todos: 0,
      ownedRoomFiles: 0,
      ownedInboxFiles: 0,
      pendingPersistencePaths: 0,
      retainedEventBytes: 0,
    })
    assert.deepEqual(await readdir(testHome), [])
  })

  test('dispose clears the terminal notifier reference before a new lifecycle', async () => {
    let notifications = 0
    room.setTerminalNotifier(() => {
      notifications += 1
    })
    room.updateLinks('notify-a', ['notify-b'], {
      'notify-a': 'chat',
      'notify-b': 'terminal',
    })
    room.post({ fromTileId: 'notify-a', text: 'before dispose' })
    assert.equal(notifications, 1)

    await room.disposeAgentRooms()
    room.updateLinks('notify-c', ['notify-d'], {
      'notify-c': 'chat',
      'notify-d': 'terminal',
    })
    room.post({ fromTileId: 'notify-c', text: 'after dispose' })
    assert.equal(notifications, 1)
  })
})
