import { spawnSync } from 'node:child_process'
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = new URL('..', import.meta.url).pathname
const chatStreamsUrl = pathToFileURL(join(repoRoot, 'electrobun/bun/chat-streams.ts')).href

function runParserSmoke(exportName, sample) {
  const script = `
    import { ${exportName} } from ${JSON.stringify(chatStreamsUrl)};
    const sample = ${JSON.stringify(sample)};
    console.log(JSON.stringify(${exportName}(sample)));
  `
  const result = spawnSync('bun', ['--eval', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

function runClaudeParserSmoke(sample) {
  return runParserSmoke('parseClaudeStreamJsonLine', sample)
}

describe('Electrobun chat stream parsers', () => {
  test('extracts Claude session ids without leaking hook/system payload text', () => {
    const events = runClaudeParserSmoke(JSON.stringify({
      type: 'system',
      subtype: 'hook_response',
      session_id: 'claude-session-1',
      output: 'huge hook payload that must not become chat text',
    }))

    assert.deepEqual(events, [{ type: 'session', sessionId: 'claude-session-1' }])
  })

  test('extracts only assistant text deltas from Claude stream-json', () => {
    const events = runClaudeParserSmoke(JSON.stringify({
      type: 'stream_event',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hello' },
      },
    }))

    assert.deepEqual(events, [
      { type: 'session', sessionId: 'claude-session-1' },
      { type: 'text', text: 'hello' },
    ])
  })

  test('ignores Claude thinking deltas so private reasoning never hits ChatTile', () => {
    const events = runClaudeParserSmoke(JSON.stringify({
      type: 'stream_event',
      session_id: 'claude-session-1',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'hidden chain of thought' },
      },
    }))

    assert.deepEqual(events, [{ type: 'session', sessionId: 'claude-session-1' }])
  })

  test('extracts OpenCode assistant text and session ids from JSONL events', () => {
    const events = runParserSmoke('parseOpenCodeJsonLine', JSON.stringify({
      type: 'message',
      role: 'assistant',
      sessionId: 'opencode-session-1',
      content: [{ type: 'text', text: 'open-code-ok' }],
    }))

    assert.deepEqual(events, [
      { type: 'session', sessionId: 'opencode-session-1' },
      { type: 'text', text: 'open-code-ok' },
    ])
  })

  test('extracts OpenClaw session ids and payload text from JSON output', () => {
    const events = runParserSmoke('parseOpenClawOutput', JSON.stringify({
      meta: { sessionId: 'openclaw-session-1' },
      payloads: [
        { text: 'first' },
        { parts: [{ text: 'second' }] },
      ],
    }))

    assert.deepEqual(events, [
      { type: 'session', sessionId: 'openclaw-session-1' },
      { type: 'text', text: 'first\n\nsecond' },
    ])
  })
})
