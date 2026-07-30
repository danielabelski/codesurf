import test from 'node:test'
import assert from 'node:assert/strict'
import { createDaemonClient } from '../../packages/codesurf-daemon/src/client.ts'

function makeClient(calls) {
  return createDaemonClient({
    ensureRunning: async () => ({
      pid: 123,
      port: 4567,
      token: 'secret-token',
      startedAt: new Date(0).toISOString(),
      protocolVersion: 1,
      appVersion: 'test',
    }),
    getStatus: async () => ({ running: true, info: null }),
    invalidate: () => {
      calls.invalidated = true
    },
    requestTimeoutMs: 25,
  })
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('typed chat-job client methods call daemon routes with bearer auth', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url))
    const body = typeof options.body === 'string' ? JSON.parse(options.body) : null
    calls.push({ url: String(url), path: parsed.pathname, search: parsed.search, options, body })
    assert.equal(options.headers.Authorization, 'Bearer secret-token')
    assert.equal(parsed.searchParams.has('token'), false)

    if (parsed.pathname === '/chat/job/start') return jsonResponse({ id: 'job-1', status: 'running', lastSequence: 0 })
    if (parsed.pathname === '/chat/job/state') return jsonResponse({ id: parsed.searchParams.get('jobId'), status: 'completed', lastSequence: 2 })
    if (parsed.pathname === '/chat/job/cancel') return jsonResponse({ ok: true })
    if (parsed.pathname === '/chat/job/permission/answer') return jsonResponse({ ok: true })
    throw new Error(`unexpected path ${parsed.pathname}`)
  }

  const client = makeClient(calls)
  await client.startChatJob({ provider: 'claude', model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  await client.getJobState('job-1')
  await client.cancelJob('job-1')
  await client.answerPermission({ jobId: 'job-1', toolId: 'tool-1', decision: 'once' })

  assert.deepEqual(calls.map(call => call.path), [
    '/chat/job/start',
    '/chat/job/state',
    '/chat/job/cancel',
    '/chat/job/permission/answer',
  ])
  assert.deepEqual(calls[0].body, {
    request: { provider: 'claude', model: 'm', messages: [{ role: 'user', content: 'hi' }] },
  })
  assert.equal(calls[1].search, '?jobId=job-1')
  assert.deepEqual(calls[2].body, { jobId: 'job-1' })
  assert.deepEqual(calls[3].body, { jobId: 'job-1', toolId: 'tool-1', decision: 'once' })
})

test('streamJobEvents parses SSE without putting bearer token in the URL', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const parsed = new URL(String(url))
    assert.equal(parsed.pathname, '/chat/job/events')
    assert.equal(parsed.searchParams.get('jobId'), 'job-1')
    assert.equal(parsed.searchParams.get('since'), '3')
    assert.equal(parsed.searchParams.has('token'), false)
    assert.equal(options.headers.Authorization, 'Bearer secret-token')
    assert.equal(options.headers.Accept, 'text/event-stream')

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"jobId":"job-1","sequence":4,"timestamp":1,"type":"text","text":"hi"}\n\n'))
        controller.enqueue(encoder.encode(': ping\n\n'))
        controller.enqueue(encoder.encode('data: {"jobId":"job-1","sequence":5,"timestamp":2,"type":"done"}\n\n'))
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }

  const client = makeClient(calls)
  const events = []
  await client.streamJobEvents({
    jobId: 'job-1',
    since: 3,
    onEvent: event => {
      events.push(event)
    },
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(events.map(event => event.type), ['text', 'done'])
  assert.equal(events[0].text, 'hi')
})

test('read-only daemon requests retry once after a transient response', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async () => {
    calls.push('fetch')
    if (calls.length === 1) return jsonResponse({ error: 'temporarily unavailable' }, 503)
    return jsonResponse({ id: 'job-1', status: 'completed', lastSequence: 2 })
  }

  const client = makeClient(calls)
  const state = await client.getJobState('job-1')

  assert.equal(state.id, 'job-1')
  assert.equal(calls.length, 2)
  assert.equal(calls.invalidated, true)
})

test('startChatJob never retries when delivery times out', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async () => {
    calls.push('fetch')
    throw new DOMException('request timed out', 'TimeoutError')
  }

  const client = makeClient(calls)
  await assert.rejects(
    client.startChatJob({ provider: 'claude', model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
    /outcome is unknown.*check daemon state before retrying/i,
  )
  assert.equal(calls.length, 1)
})

test('startChatJob never retries a transient HTTP response', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async () => {
    calls.push('fetch')
    return jsonResponse({ error: 'temporarily unavailable' }, 503)
  }

  const client = makeClient(calls)
  await assert.rejects(
    client.startChatJob({ provider: 'claude', model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  )
  assert.equal(calls.length, 1)
})

test('cancel and permission mutations use the declared no-retry policy', async t => {
  const originalFetch = globalThis.fetch
  const calls = []
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  globalThis.fetch = async (url) => {
    calls.push(new URL(String(url)).pathname)
    return jsonResponse({ error: 'temporarily unavailable' }, 503)
  }

  const client = makeClient(calls)
  await assert.rejects(client.cancelJob('job-1'))
  await assert.rejects(client.answerPermission({
    jobId: 'job-1',
    toolId: 'tool-1',
    decision: 'once',
  }))

  assert.deepEqual([...calls], [
    '/chat/job/cancel',
    '/chat/job/permission/answer',
  ])
  assert.equal(calls.invalidated, true)
})
