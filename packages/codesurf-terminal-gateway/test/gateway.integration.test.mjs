import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import WebSocket from 'ws'

import { GatewayConfigError, createGatewayConfig, createTerminalGateway } from '../src/index.js'

class FakeTerminal {
  constructor() {
    this.writes = []
    this.resizes = []
    this.dataListeners = new Set()
    this.exitListeners = new Set()
    this.killed = false
  }

  onData(listener) {
    this.dataListeners.add(listener)
    return { dispose: () => this.dataListeners.delete(listener) }
  }

  onExit(listener) {
    this.exitListeners.add(listener)
    return { dispose: () => this.exitListeners.delete(listener) }
  }

  write(data) {
    this.writes.push(data)
  }

  resize(cols, rows) {
    this.resizes.push([cols, rows])
  }

  kill() {
    if (this.killed) return
    this.killed = true
    for (const listener of this.exitListeners) listener({ exitCode: 0, signal: 1 })
  }

  emitData(data) {
    for (const listener of this.dataListeners) listener(data)
  }
}

function waitForMessage(socket) {
  return once(socket, 'message').then(([payload]) => JSON.parse(String(payload)))
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for terminal state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function startGateway(root, { limits: limitOverrides = {} } = {}) {
  const terminals = []
  const gateway = createTerminalGateway({
    config: {
      bindHost: '127.0.0.1',
      port: 0,
      allowedOrigins: ['https://app.example.test'],
      tenants: [{
        id: 'acme',
        bearerToken: 'test-bearer-token',
        roots: [root],
        workspaces: { demo: root },
      }],
      limits: {
        bodyBytes: 8 * 1024,
        messageBytes: 8 * 1024,
        outputBacklogBytes: 16 * 1024,
        sessionTtlMs: 60_000,
        attachTtlMs: 10_000,
        ...limitOverrides,
      },
    },
    adapter: {
      async spawn() {
        const terminal = new FakeTerminal()
        terminals.push(terminal)
        return terminal
      },
    },
  })
  const endpoint = await gateway.listen()
  return { gateway, endpoint, terminals }
}

function sessionRequest(endpoint, { token = 'test-bearer-token', origin = 'https://app.example.test', body, suffix = '' } = {}) {
  return fetch(`${endpoint}/v1/terminal/sessions${suffix}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(origin ? { origin } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body ?? { workspaceId: 'demo', cwd: '.', cols: 100, rows: 30 }),
  })
}

test('authenticated client creates, attaches, writes to, resizes, and closes a terminal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-terminal-gateway-'))
  const { gateway, endpoint, terminals } = await startGateway(root)
  t.after(async () => {
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  })

  const response = await sessionRequest(endpoint)

  assert.equal(response.status, 201)
  const created = await response.json()
  assert.match(created.sessionId, /^[0-9a-f-]{36}$/)
  assert.match(created.attachToken, /^[A-Za-z0-9_-]{32,}$/)
  assert.match(created.websocketUrl, /^ws:\/\/127\.0\.0\.1:\d+\/v1\/terminal\/attach$/)

  const socket = new WebSocket(created.websocketUrl, { origin: 'https://app.example.test' })
  await once(socket, 'open')
  socket.send(JSON.stringify({
    type: 'attach',
    attachToken: created.attachToken,
  }))
  assert.deepEqual(await waitForMessage(socket), {
    type: 'ready',
    sessionId: created.sessionId,
    cols: 100,
    rows: 30,
  })

  terminals[0].emitData('hello from pty')
  assert.deepEqual(await waitForMessage(socket), { type: 'data', data: 'hello from pty' })

  socket.send(JSON.stringify({ type: 'write', data: 'pwd\r' }))
  socket.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
  await waitFor(() => terminals[0].writes.length === 1 && terminals[0].resizes.length === 1)
  assert.deepEqual(terminals[0].writes, ['pwd\r'])
  assert.deepEqual(terminals[0].resizes, [[120, 40]])

  socket.send(JSON.stringify({ type: 'close' }))
  assert.deepEqual(await waitForMessage(socket), {
    type: 'exit',
    exitCode: 0,
    signal: 1,
  })
  await once(socket, 'close')
})

test('rejects missing origins, invalid bearers, query credentials, and cwd values outside the tenant root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-terminal-gateway-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'codesurf-terminal-gateway-outside-'))
  const { gateway, endpoint, terminals } = await startGateway(root)
  t.after(async () => {
    await gateway.close()
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  const preflight = await fetch(`${endpoint}/v1/terminal/sessions`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://app.example.test',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type',
    },
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example.test')

  assert.equal((await sessionRequest(endpoint, { origin: null })).status, 403)
  assert.equal((await sessionRequest(endpoint, { token: 'not-the-tenant-token' })).status, 401)
  assert.equal((await sessionRequest(endpoint, { suffix: '?attachToken=never-here' })).status, 404)
  assert.equal((await sessionRequest(endpoint, {
    body: { workspaceId: 'demo', cwd: outside, cols: 100, rows: 30 },
  })).status, 403)
  assert.equal((await sessionRequest(endpoint, {
    body: { workspaceId: 'dynamic-ui-workspace', cwd: root, cols: 100, rows: 30 },
  })).status, 201)
  assert.equal(terminals.length, 0)
})

test('an attach token is consumed once and cannot attach a second websocket', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-terminal-gateway-once-'))
  const { gateway, endpoint } = await startGateway(root)
  t.after(async () => {
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  })

  const created = await (await sessionRequest(endpoint)).json()
  const invalid = new WebSocket(created.websocketUrl, { origin: 'https://app.example.test' })
  await once(invalid, 'open')
  invalid.send(JSON.stringify({ type: 'attach', attachToken: created.attachToken, sessionId: created.sessionId }))
  assert.deepEqual(await waitForMessage(invalid), {
    type: 'error',
    code: 'protocol_error',
    message: 'the first websocket message must be attach with attachToken',
  })
  await once(invalid, 'close')

  const first = new WebSocket(created.websocketUrl, { origin: 'https://app.example.test' })
  await once(first, 'open')
  first.send(JSON.stringify({ type: 'attach', attachToken: created.attachToken }))
  assert.equal((await waitForMessage(first)).type, 'ready')

  const second = new WebSocket(created.websocketUrl, { origin: 'https://app.example.test' })
  await once(second, 'open')
  second.send(JSON.stringify({ type: 'attach', attachToken: created.attachToken }))
  assert.deepEqual(await waitForMessage(second), {
    type: 'error',
    code: 'invalid_attach',
    message: 'terminal session is unavailable',
  })
  await once(second, 'close')

  first.send(JSON.stringify({ type: 'close' }))
  await waitForMessage(first)
  await once(first, 'close')
})

test('the local adapter runs a real node-pty process and emits ready, data, then exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-terminal-gateway-local-'))
  const gateway = createTerminalGateway({
    config: {
      bindHost: '127.0.0.1',
      port: 0,
      allowedOrigins: ['https://app.example.test'],
      tenants: [{ id: 'acme', bearerToken: 'test-bearer-token', roots: [root], workspaces: { demo: root } }],
      adapter: { type: 'local', shell: '/bin/sh', shellArgs: ['-c', 'printf local-pty-ok'] },
    },
  })
  const endpoint = await gateway.listen()
  t.after(async () => {
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  })

  const created = await (await sessionRequest(endpoint)).json()
  const socket = new WebSocket(created.websocketUrl, { origin: 'https://app.example.test' })
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'attach', attachToken: created.attachToken }))
  const events = [await waitForMessage(socket), await waitForMessage(socket), await waitForMessage(socket)]
  assert.equal(events[0].type, 'ready')
  assert.deepEqual(events[1], { type: 'data', data: 'local-pty-ok' })
  assert.equal(events[2].type, 'exit')
  assert.equal(events[2].exitCode, 0)
  await once(socket, 'close')
})

test('native aliases require tenant roots and publish a 0600 runtime endpoint/token atomically', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-terminal-gateway-runtime-'))
  const runtimeConfigPath = join(root, 'runtime', 'terminal-gateway.json')
  const env = {
    CODESURF_TERMINAL_GATEWAY_BIND: '127.0.0.1',
    CODESURF_TERMINAL_GATEWAY_PORT: '0',
    CODESURF_TERMINAL_TOKEN: 'native-test-bearer-token',
    CODESURF_TERMINAL_RUNTIME_CONFIG_PATH: runtimeConfigPath,
    CODESURF_TERMINAL_ALLOWED_ORIGINS: 'zero://app',
    CODESURF_TERMINAL_TENANTS_JSON: JSON.stringify({ native: { roots: [root], workspaces: { repo: root } } }),
  }
  const config = createGatewayConfig(env)
  assert.equal(config.bindHost, '127.0.0.1')
  assert.equal(config.port, 0)
  assert.equal(config.tenants[0].id, 'native')
  assert.equal(config.tenants[0].bearerToken, 'native-test-bearer-token')
  assert.throws(() => createGatewayConfig({
    ...env,
    CODESURF_TERMINAL_TENANTS_JSON: JSON.stringify({ native: { roots: [root], bearerToken: 'different-tenant-bearer-token' } }),
  }), GatewayConfigError)
  assert.throws(() => createGatewayConfig({
    ...env,
    CODESURF_TERMINAL_GATEWAY_PORT: '8787not-a-port',
  }), GatewayConfigError)

  const gateway = createTerminalGateway({
    config,
    adapter: { async spawn() { return new FakeTerminal() } },
  })
  const endpoint = await gateway.listen()
  t.after(async () => {
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  })

  assert.deepEqual(JSON.parse(await readFile(runtimeConfigPath, 'utf8')), {
    endpoint,
    token: 'native-test-bearer-token',
  })
  assert.equal((await stat(runtimeConfigPath)).mode & 0o777, 0o600)
  await gateway.close()
  await assert.rejects(stat(runtimeConfigPath), { code: 'ENOENT' })
})

test('Docker adapter is fail-closed until explicitly enabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-terminal-gateway-docker-'))
  try {
    const base = {
      CODESURF_TERMINAL_TOKEN: 'docker-test-bearer-token',
      CODESURF_TERMINAL_ALLOWED_ORIGINS: 'https://app.example.test',
      CODESURF_TERMINAL_TENANTS_JSON: JSON.stringify({ acme: { roots: [root] } }),
      CODESURF_TERMINAL_ADAPTER: 'docker',
      CODESURF_TERMINAL_DOCKER_IMAGE: 'codesurf-terminal-sandbox:test',
    }
    assert.throws(() => createGatewayConfig(base), GatewayConfigError)
    const enabled = createGatewayConfig({ ...base, CODESURF_TERMINAL_ENABLE_DOCKER: '1' })
    assert.equal(enabled.adapter.type, 'docker')
    assert.equal(enabled.adapter.docker.image, 'codesurf-terminal-sandbox:test')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unattached sessions expire and release their server state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-terminal-gateway-expiry-'))
  const { gateway, endpoint } = await startGateway(root, { limits: { attachTtlMs: 25 } })
  t.after(async () => {
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  })

  await sessionRequest(endpoint)
  await waitFor(() => gateway.getSnapshot().sessions === 0)
})

test('output backpressure terminates a PTY instead of buffering unbounded data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-terminal-gateway-backpressure-'))
  const { gateway, endpoint, terminals } = await startGateway(root, {
    limits: { messageBytes: 1_024, outputBacklogBytes: 1_024 },
  })
  t.after(async () => {
    await gateway.close()
    await rm(root, { recursive: true, force: true })
  })

  const created = await (await sessionRequest(endpoint)).json()
  const socket = new WebSocket(created.websocketUrl, { origin: 'https://app.example.test' })
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'attach', attachToken: created.attachToken }))
  assert.equal((await waitForMessage(socket)).type, 'ready')
  terminals[0].emitData('x'.repeat(2_048))
  assert.equal((await waitForMessage(socket)).type, 'exit')
  await once(socket, 'close')
  assert.equal(gateway.getSnapshot().sessions, 0)
})
