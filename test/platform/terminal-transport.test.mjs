import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const transport = await import(pathToFileURL(resolve(root, 'src/renderer/src/platform/terminalTransport.ts')).href)
const hostConfig = await import(pathToFileURL(resolve(root, 'src/renderer/src/platform/hostConfig.ts')).href)
const daemonBridge = await import(pathToFileURL(resolve(root, 'src/renderer/src/platform/daemonBridge.ts')).href)

class FakeWebSocket {
  static instances = []

  constructor(url) {
    this.url = url
    this.sent = []
    this.closed = false
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }

  send(raw) {
    const message = JSON.parse(raw)
    this.sent.push(message)
    if (message.type === 'attach') {
      queueMicrotask(() => this.emit({ type: 'ready', buffer: 'boot\r\n' }))
    }
  }

  close() {
    this.closed = true
    queueMicrotask(() => this.onclose?.())
  }

  emit(message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
}

function makeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({
      sessionId: 'session-1',
      attachToken: 'attach-token',
      websocketUrl: 'wss://sandbox.example.test/terminal/socket',
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

describe('terminal transport', () => {
  test('prefers an injected endpoint, never puts credentials in the URL, and relays the protocol', async () => {
    FakeWebSocket.instances.length = 0
    const calls = []
    const client = new transport.TerminalTransport({
      endpoint: 'https://gateway.example.test/',
      token: 'injected-bearer-token',
      fetchImpl: makeFetch(calls),
      webSocketConstructor: FakeWebSocket,
      readyTimeoutMs: 1_000,
    })

    const created = await client.create('tile-a', {
      cwd: '/workspace/demo',
      workspaceId: 'workspace-a',
      cols: 901,
      rows: 901,
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://gateway.example.test/v1/terminal/sessions')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.credentials, 'same-origin')
    assert.equal(calls[0].init.headers.Authorization, 'Bearer injected-bearer-token')
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      cwd: '/workspace/demo',
      workspaceId: 'workspace-a',
      cols: 500,
      rows: 300,
    })
    assert.equal(created.buffer, 'boot\r\n')
    assert.equal(created.cols, 500)
    assert.equal(created.rows, 300)

    const socket = FakeWebSocket.instances[0]
    assert.equal(socket.url, 'wss://sandbox.example.test/terminal/socket')
    assert.doesNotMatch(socket.url, /injected-bearer-token|attach-token/)
    assert.deepEqual(socket.sent[0], { type: 'attach', attachToken: 'attach-token' })

    const output = []
    const exits = []
    client.onData('tile-a', data => output.push(data))
    client.onExit('tile-a', code => exits.push(code))
    socket.emit({ type: 'data', data: 'echo ready\r\n' })
    await client.write('tile-a', 'echo ready\r')
    await client.resize('tile-a', 220, 60)
    socket.emit({ type: 'exit', exitCode: 0 })

    assert.deepEqual(output, ['echo ready\r\n'])
    assert.deepEqual(exits, [0])
    assert.deepEqual(socket.sent.slice(1), [
      { type: 'write', data: 'echo ready\r' },
      { type: 'resize', cols: 220, rows: 60 },
    ])
  })

  test('sends an explicit close frame and leaves same-origin cookie auth available', async () => {
    FakeWebSocket.instances.length = 0
    const calls = []
    const client = new transport.TerminalTransport({
      endpoint: 'https://gateway.example.test',
      token: 'runtime-token',
      fetchImpl: makeFetch(calls),
      webSocketConstructor: FakeWebSocket,
    })
    await client.create('tile-close', { cwd: '/workspace/demo', workspaceId: 'workspace-a' })
    await client.close('tile-close')
    assert.deepEqual(FakeWebSocket.instances[0].sent.at(-1), { type: 'close' })

    const cookieAuthCalls = []
    const cookieAuthenticated = new transport.TerminalTransport({
      endpoint: 'https://gateway.example.test',
      token: null,
      fetchImpl: makeFetch(cookieAuthCalls),
      webSocketConstructor: FakeWebSocket,
    })
    assert.equal(cookieAuthenticated.isAvailable(), true)
    await cookieAuthenticated.create('tile-cookie-auth', { cwd: '/workspace/demo', workspaceId: 'workspace-a' })
    assert.equal(cookieAuthCalls[0].init.headers.Authorization, undefined)
  })

  test('keeps endpoint and host resolution precedence explicit', () => {
    assert.equal(
      transport.resolveTerminalEndpoint({
        injectedEndpoint: 'https://injected.example/',
        envEndpoint: 'https://env.example/',
        hostBase: 'https://host.example/',
      }),
      'https://injected.example/',
    )
    assert.equal(
      transport.resolveTerminalEndpoint({ envEndpoint: 'https://env.example/', hostBase: 'https://host.example/' }),
      'https://env.example/',
    )
    assert.equal(transport.terminalSessionsUrl('https://gateway.example/v1/terminal/sessions'), 'https://gateway.example/v1/terminal/sessions')
    assert.equal(transport.terminalSessionsUrl('ws://127.0.0.1:4178'), 'http://127.0.0.1:4178/v1/terminal/sessions')
    assert.equal(
      hostConfig.resolveHostBase({ locationOrigin: 'https://codesurf.example.test', locationPort: '443' }),
      '',
    )
    assert.equal(
      hostConfig.resolveHostBase({ locationOrigin: 'zero://app', locationPort: '' }),
      'http://127.0.0.1:4177',
    )
    assert.equal(
      hostConfig.resolveHostToken({ injectedToken: 'native-token' }),
      'native-token',
    )
  })

  test('relays bounded daemon SSE job events through the Electron-compatible stream API', async () => {
    const priorWindow = globalThis.window
    const priorFetch = globalThis.fetch
    const calls = []
    const encoder = new TextEncoder()
    globalThis.window = {
      __CODESURF_HOST__: 'https://bridge.example.test',
      __CODESURF_HOST_TOKEN__: 'host-capability-token',
      location: { origin: 'https://bridge.example.test', protocol: 'https:', port: '' },
    }
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/d/chat/job/start')) {
        return new Response(JSON.stringify({ id: 'job-1' }), { status: 200 })
      }
      if (String(url).includes('/d/chat/job/events?')) {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"jobId":"job-1","sequence":1,"type":"text","text":"hello"}\n\n'))
            controller.enqueue(encoder.encode('data: {"jobId":"job-1","sequence":2,"type":"done"}\n\n'))
            controller.close()
          },
        })
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
      }
      throw new Error(`unexpected fetch ${url}`)
    }

    try {
      const api = daemonBridge.createDaemonBackedElectronApi()
      const events = []
      const unsubscribe = api.stream.onChunk(event => events.push(event))
      const result = await api.chat.send({ cardId: 'card-1', runMode: 'foreground' })
      await new Promise(resolve => setTimeout(resolve, 0))
      unsubscribe()

      assert.deepEqual(result, { ok: true, jobId: 'job-1', detached: false })
      assert.deepEqual(events.map(event => ({ cardId: event.cardId, jobId: event.jobId, type: event.type, text: event.text })), [
        { cardId: 'card-1', jobId: 'job-1', type: 'text', text: 'hello' },
        { cardId: 'card-1', jobId: 'job-1', type: 'done', text: undefined },
      ])
      assert.equal(calls[0].init.headers.get('X-Codesurf-Host'), 'host-capability-token')
      assert.equal(calls[1].init.headers.get('X-Codesurf-Host'), 'host-capability-token')
      assert.equal(calls[1].init.credentials, 'same-origin')
    } finally {
      if (priorWindow === undefined) delete globalThis.window
      else globalThis.window = priorWindow
      globalThis.fetch = priorFetch
    }
  })
})
