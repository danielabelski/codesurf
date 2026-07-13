import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HOST_PORT = 18477
const HOST = `http://127.0.0.1:${HOST_PORT}`
const HOST_TOKEN = 'web-host-route-test-token-which-is-long-enough'
const hostHeaders = { 'X-Codesurf-Host': HOST_TOKEN }

describe('web-host routes', () => {
  let child
  let home
  let runtimeConfigPath

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'codesurf-webhost-'))
    runtimeConfigPath = join(home, 'runtime-config.json')
    mkdirSync(join(home, 'daemon'), { recursive: true })
    // Minimal fake daemon pid so ensureDaemon can fail health and spawn real daemon —
    // for unit test we only need /health which doesn't require daemon.
    // Start web-host with isolated home; it will try to start real codesurfd.
    child = spawn(process.execPath, [resolve(root, 'scripts/web-host.mjs')], {
      cwd: root,
      env: {
        ...process.env,
        CODESURF_HOME: home,
        CODESURF_WEB_HOST_PORT: String(HOST_PORT),
        CODESURF_WEB_HOST_TOKEN: HOST_TOKEN,
        CODESURF_RUNTIME_CONFIG_PATH: runtimeConfigPath,
        CODESURF_APP_VERSION: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const start = Date.now()
    let lastErr
    while (Date.now() - start < 30_000) {
      try {
        const res = await fetch(`${HOST}/health`)
        if (res.ok) return
      } catch (err) {
        lastErr = err
      }
      await new Promise(r => setTimeout(r, 200))
    }
    const stderr = child.stderr?.read?.()?.toString?.() || ''
    throw new Error(`web-host failed to start: ${lastErr}\n${stderr}`)
  })

  after(async () => {
    if (child && !child.killed) {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      try { await once(child, 'exit') } catch { /* ignore */ }
    }
    try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('serves /health', async () => {
    const res = await fetch(`${HOST}/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.service, 'codesurf-web-host')
  })

  it('serves /host/health with capability info', async () => {
    const res = await fetch(`${HOST}/host/health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.host, 'codesurf-web-host')
    assert.ok(body.daemon)
    assert.equal('home' in body, false)
    assert.equal('port' in body, false)
  })

  it('requires the per-launch host token for stateful routes', async () => {
    const denied = await fetch(`${HOST}/host/config`)
    assert.equal(denied.status, 401)

    const allowed = await fetch(`${HOST}/host/config`, { headers: hostHeaders })
    assert.equal(allowed.status, 200)
    const body = await allowed.json()
    assert.equal(body.capabilities.workspace, true)
  })

  it('writes the Native runtime configuration with the bound host and token', () => {
    const runtime = JSON.parse(readFileSync(runtimeConfigPath, 'utf8'))
    assert.equal(runtime.hostBase, HOST)
    assert.equal(runtime.hostToken, HOST_TOKEN)
    assert.deepEqual(runtime.terminal, { endpoint: null, token: null })
  })

  it('allows only explicit browser origins', async () => {
    const denied = await fetch(`${HOST}/host/config`, {
      headers: { ...hostHeaders, Origin: 'https://attacker.example' },
    })
    assert.equal(denied.status, 403)

    const allowed = await fetch(`${HOST}/host/config`, {
      headers: { ...hostHeaders, Origin: 'http://127.0.0.1:5173' },
    })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5173')

    const preflight = await fetch(`${HOST}/host/config`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-codesurf-host',
      },
    })
    assert.equal(preflight.status, 204)
    assert.match(preflight.headers.get('access-control-allow-headers') || '', /X-Codesurf-Host/i)
  })

  it('round-trips settings', async () => {
    const payload = { theme: 'dark', testKey: 'web-host' }
    const put = await fetch(`${HOST}/host/settings`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(put.status, 200)
    const get = await fetch(`${HOST}/host/settings`, { headers: hostHeaders })
    const body = await get.json()
    assert.equal(body.theme, 'dark')
    assert.equal(body.testKey, 'web-host')
  })

  it('round-trips canvas state', async () => {
    const workspaceId = 'ws-test-1'
    const state = { tiles: [{ id: 't1', x: 0, y: 0 }], zoom: 1 }
    const put = await fetch(`${HOST}/host/canvas/save`, {
      method: 'POST',
      headers: { ...hostHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, state }),
    })
    assert.equal(put.status, 200)
    const get = await fetch(`${HOST}/host/canvas/load?workspaceId=${workspaceId}`, { headers: hostHeaders })
    const body = await get.json()
    assert.equal(body.zoom, 1)
    assert.equal(body.tiles[0].id, 't1')
  })

  it('does not expose arbitrary filesystem paths', async () => {
    const res = await fetch(`${HOST}/host/fs/readFile?path=${encodeURIComponent('/etc/passwd')}`, {
      headers: hostHeaders,
    })
    assert.equal(res.status, 403)
  })

  it('does not turn the daemon bearer into a generic browser proxy', async () => {
    const res = await fetch(`${HOST}/d/host/list`, { headers: hostHeaders })
    assert.equal(res.status, 404)
    const body = await res.json()
    assert.match(body.error, /not available to web clients/i)
  })
})
