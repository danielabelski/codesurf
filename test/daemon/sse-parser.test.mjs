import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSseJsonBuffer } from '@codesurf/daemon/sse'

test('SSE parser preserves existing daemon chat data-line behavior', () => {
  const input = [
    ': ping',
    '',
    'event: ignored',
    'data: {"type":"text","text":"hello"}',
    '',
    'data: {bad json}',
    '',
    'data: {"type":"tool_summary",',
    'data: "text":"ok"}',
    '',
    'data: {"type":"partial"}',
  ].join('\n')

  const parsed = parseSseJsonBuffer(input)

  assert.deepEqual(parsed.events, [
    { type: 'text', text: 'hello' },
    { type: 'tool_summary', text: 'ok' },
  ])
  assert.equal(parsed.errors.length, 1)
  assert.equal(parsed.remaining, 'data: {"type":"partial"}')
})

test('SSE parser keeps split chunks resumable', () => {
  const first = parseSseJsonBuffer('data: {"type":"text"')
  assert.deepEqual(first.events, [])
  assert.equal(first.remaining, 'data: {"type":"text"')

  const second = parseSseJsonBuffer(`${first.remaining},"text":"hi"}\n\n`)
  assert.deepEqual(second.events, [{ type: 'text', text: 'hi' }])
  assert.equal(second.remaining, '')
})
