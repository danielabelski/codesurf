import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createChatJobManager,
  createSseSubscriberRegistry,
} from '../bin/chat-jobs.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitFor(check, timeoutMs = 3_000, intervalMs = 10) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function textDelta(text) {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  }
}

class FakeResponse extends EventEmitter {
  constructor(writeBehavior = () => true) {
    super()
    this.writeBehavior = writeBehavior
    this.writes = []
    this.endCalls = 0
    this.destroyCalls = 0
    this.destroyed = false
    this.writableEnded = false
  }

  write(chunk) {
    if (this.destroyed || this.writableEnded) throw new Error('write after close')
    const text = String(chunk)
    this.writes.push(text)
    const result = this.writeBehavior(text, this.writes.length)
    if (result instanceof Error) throw result
    return result
  }

  end() {
    this.endCalls += 1
    this.writableEnded = true
  }

  destroy() {
    this.destroyCalls += 1
    this.destroyed = true
    this.emit('close')
  }
}

function writtenEvents(response) {
  return response.writes
    .filter(chunk => chunk.startsWith('data: '))
    .map(chunk => JSON.parse(chunk.slice('data: '.length).trim()))
}

function payload(sequence, text = `event-${sequence}`) {
  return {
    jobId: 'job-1',
    sequence,
    timestamp: sequence,
    type: 'text',
    text,
  }
}

test('subscriber backpressure waits for drain without starving or duplicating sibling delivery', () => {
  const registry = createSseSubscriberRegistry({ heartbeatMs: 0 })
  const slow = new FakeResponse((_chunk, writeNumber) => writeNumber !== 1)
  const fast = new FakeResponse()
  const throwing = new FakeResponse(() => new Error('socket failed'))

  registry.register('job-1', slow, { replaying: false })
  registry.register('job-1', fast, { replaying: false })
  registry.register('job-1', throwing, { replaying: false })

  registry.publish('job-1', payload(1))
  registry.publish('job-1', payload(2))

  assert.deepEqual(writtenEvents(slow).map(event => event.sequence), [1])
  assert.deepEqual(writtenEvents(fast).map(event => event.sequence), [1, 2])
  assert.equal(throwing.destroyCalls, 1)
  assert.equal(throwing.listenerCount('drain'), 0)
  assert.equal(throwing.listenerCount('close'), 0)
  assert.equal(throwing.listenerCount('error'), 0)

  slow.emit('drain')
  assert.deepEqual(writtenEvents(slow).map(event => event.sequence), [1, 2])

  registry.shutdown()
})

test('subscriber event and byte caps deterministically evict only the slow subscriber', () => {
  const eventRegistry = createSseSubscriberRegistry({
    heartbeatMs: 0,
    maxQueuedEvents: 2,
    maxQueuedBytes: 1_000_000,
  })
  const eventSlow = new FakeResponse(() => false)
  const eventFast = new FakeResponse()
  eventRegistry.register('job-1', eventSlow, { replaying: false })
  eventRegistry.register('job-1', eventFast, { replaying: false })

  for (let sequence = 1; sequence <= 4; sequence += 1) {
    eventRegistry.publish('job-1', payload(sequence))
  }

  assert.equal(eventSlow.destroyCalls, 1)
  assert.deepEqual(writtenEvents(eventFast).map(event => event.sequence), [1, 2, 3, 4])
  assert.equal(eventRegistry.count('job-1'), 1)
  eventRegistry.shutdown()

  const byteRegistry = createSseSubscriberRegistry({
    heartbeatMs: 0,
    maxQueuedEvents: 10,
    maxQueuedBytes: 120,
  })
  const byteSlow = new FakeResponse(() => false)
  byteRegistry.register('job-1', byteSlow, { replaying: false })
  byteRegistry.publish('job-1', payload(1, 'accepted'))
  byteRegistry.publish('job-1', payload(2, 'x'.repeat(200)))

  assert.equal(byteSlow.destroyCalls, 1)
  assert.equal(byteRegistry.count('job-1'), 0)
  byteRegistry.shutdown()
})

test('heartbeat skips blocked subscribers, resumes after drain, and shutdown removes every listener', () => {
  const registry = createSseSubscriberRegistry({ heartbeatMs: 0 })
  const blocked = new FakeResponse((_chunk, writeNumber) => writeNumber !== 1)
  const writable = new FakeResponse()
  registry.register('job-1', blocked, { replaying: false })
  registry.register('job-1', writable, { replaying: false })

  registry.publish('job-1', payload(1))
  registry.pulseHeartbeat()
  assert.equal(blocked.writes.some(chunk => chunk === ': ping\n\n'), false)
  assert.equal(writable.writes.some(chunk => chunk === ': ping\n\n'), true)

  blocked.emit('drain')
  registry.pulseHeartbeat()
  assert.equal(blocked.writes.some(chunk => chunk === ': ping\n\n'), true)

  registry.shutdown()
  for (const response of [blocked, writable]) {
    assert.equal(response.endCalls, 1)
    assert.equal(response.listenerCount('drain'), 0)
    assert.equal(response.listenerCount('close'), 0)
    assert.equal(response.listenerCount('error'), 0)
  }
  assert.equal(registry.count(), 0)
})

test('replay includes an event that was enqueued but not yet persisted', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-pending-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const appendStarted = deferred()
  const releaseAppend = deferred()
  const finishQuery = deferred()
  let heldPendingAppend = false

  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineAppend: async (path, data) => {
      const event = JSON.parse(data)
      if (!heldPendingAppend && event.type === 'text' && event.text === 'pending') {
        heldPendingAppend = true
        appendStarted.resolve()
        await releaseAppend.promise
      }
      await appendFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('pending')
      await finishQuery.promise
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  t.after(async () => {
    releaseAppend.resolve()
    finishQuery.resolve()
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  await appendStarted.promise

  const response = new FakeResponse()
  assert.equal(await manager.streamJob(job.id, 0, response), true)
  const replayed = writtenEvents(response)
  assert.equal(replayed.filter(event => event.type === 'text' && event.text === 'pending').length, 1)

  releaseAppend.resolve()
  finishQuery.resolve()
  await waitFor(async () => (await manager.getJobState(job.id))?.status === 'completed')
})

test('terminal append failure keeps durable metadata active and replays the pending done without a gap', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-terminal-failure-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const terminalAppendAttempted = deferred()

  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    timelineAppend: async (path, data) => {
      const event = JSON.parse(data)
      if (event.type === 'done') {
        terminalAppendAttempted.resolve()
        throw new Error('simulated terminal append failure')
      }
      await appendFile(path, data, 'utf8')
    },
    claudeQuery: () => (async function* () {
      yield textDelta('persisted text')
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  await terminalAppendAttempted.promise
  await waitFor(() => !manager.listLiveJobIds().includes(job.id))

  const durableState = await manager.getJobState(job.id)
  assert.equal(durableState.status, 'running')
  const timelinePath = join(homeDir, 'timelines', `${job.id}.jsonl`)
  const durableEvents = (await readFile(timelinePath, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  assert.equal(durableEvents.some(event => event.type === 'done'), false)

  const response = new FakeResponse()
  assert.equal(await manager.streamJob(job.id, 0, response), false)
  const replayed = writtenEvents(response)
  const sequences = replayed.map(event => event.sequence)
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => index + 1),
  )
  assert.equal(replayed.filter(event => event.type === 'done').length, 1)
  assert.equal(replayed.at(-1)?.type, 'done')
  assert.ok(Number(durableState.lastSequence ?? 0) < Number(replayed.at(-1)?.sequence ?? 0))

  const upToDateResponse = new FakeResponse()
  assert.equal(
    await manager.streamJob(job.id, replayed.at(-1).sequence, upToDateResponse),
    false,
  )
  assert.deepEqual(writtenEvents(upToDateResponse), [])
})

test('replay buffers live and terminal events until drain, then emits each sequence exactly once', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-race-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  const releaseQuery = deferred()

  const manager = createChatJobManager({
    homeDir,
    heartbeatMs: 0,
    claudeQuery: () => (async function* () {
      yield textDelta('one')
      await releaseQuery.promise
      yield textDelta('two')
      yield { type: 'result', result: 'ok', total_cost_usd: 0, num_turns: 1 }
    })(),
  })
  t.after(async () => {
    releaseQuery.resolve()
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  const job = await manager.startJob({
    provider: 'claude',
    model: 'test',
    mode: 'bypassPermissions',
    workspaceDir,
    messages: [{ role: 'user', content: 'go' }],
  })
  const timelinePath = join(homeDir, 'timelines', `${job.id}.jsonl`)
  await waitFor(async () => (await readFile(timelinePath, 'utf8')).includes('"text":"one"'))

  let blockedData = false
  const response = new FakeResponse(chunk => {
    if (chunk.startsWith('data: ') && !blockedData) {
      blockedData = true
      return false
    }
    return true
  })
  const streamPromise = manager.streamJob(job.id, 0, response)
  await waitFor(() => writtenEvents(response).length === 1)

  releaseQuery.resolve()
  await waitFor(async () => (await manager.getJobState(job.id))?.status === 'completed')
  assert.deepEqual(writtenEvents(response).map(event => event.sequence), [1])

  response.emit('drain')
  assert.equal(await streamPromise, false)
  const events = writtenEvents(response)
  const sequences = events.map(event => event.sequence)
  assert.deepEqual(
    sequences,
    Array.from({ length: sequences.length }, (_, index) => index + 1),
  )
  assert.equal(new Set(sequences).size, sequences.length)
  assert.equal(events.filter(event => event.type === 'text' && event.text === 'one').length, 1)
  assert.equal(events.filter(event => event.type === 'text' && event.text === 'two').length, 1)
  assert.equal(events.filter(event => event.type === 'done').length, 1)
  assert.equal(events.at(-1)?.type, 'done')
  assert.equal(response.endCalls, 1)
})

test('completed timeline replay streams progressively under writable backpressure without truncation', async t => {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-sse-history-'))
  const jobsDir = join(homeDir, 'jobs')
  const timelinesDir = join(homeDir, 'timelines')
  await mkdir(jobsDir, { recursive: true })
  await mkdir(timelinesDir, { recursive: true })
  const jobId = 'history-job'
  const events = Array.from({ length: 50 }, (_, index) => ({
    jobId,
    sequence: index + 1,
    timestamp: index + 1,
    type: index === 49 ? 'done' : 'text',
    ...(index === 49 ? {} : { text: `line-${index + 1}` }),
  }))
  await writeFile(join(jobsDir, `${jobId}.json`), JSON.stringify({
    id: jobId,
    status: 'completed',
    lastSequence: 50,
  }), 'utf8')
  await writeFile(
    join(timelinesDir, `${jobId}.jsonl`),
    `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  )

  const manager = createChatJobManager({ homeDir, heartbeatMs: 0 })
  t.after(async () => {
    await manager.shutdown()
    await rm(homeDir, { recursive: true, force: true })
  })

  let blockedData = false
  const response = new FakeResponse(chunk => {
    if (chunk.startsWith('data: ') && !blockedData) {
      blockedData = true
      return false
    }
    return true
  })
  const streamPromise = manager.streamJob(jobId, 0, response)
  await waitFor(() => writtenEvents(response).length === 1)
  assert.deepEqual(writtenEvents(response).map(event => event.sequence), [1])

  response.emit('drain')
  assert.equal(await streamPromise, false)
  assert.deepEqual(writtenEvents(response).map(event => event.sequence), events.map(event => event.sequence))
})
