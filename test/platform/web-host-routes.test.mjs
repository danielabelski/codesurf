import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const HOST_PORT = 18477
const HOST = `http://127.0.0.1:${HOST_PORT}`

describe('web-host routes', () => {
  let child
  let home

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'codesurf-webhost-'))
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

  after(() => {
    if (child && !child.killed) {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
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
  })

  it('round-trips settings', async () => {
    const payload = { theme: 'dark', testKey: 'web-host' }
    const put = await fetch(`${HOST}/host/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    assert.equal(put.status, 200)
    const get = await fetch(`${HOST}/host/settings`)
    const body = await get.json()
    assert.equal(body.theme, 'dark')
    assert.equal(body.testKey, 'web-host')
  })

  it('round-trips canvas state', async () => {
    const workspaceId = 'ws-test-1'
    const state = { tiles: [{ id: 't1', x: 0, y: 0 }], zoom: 1 }
    const put = await fetch(`${HOST}/host/canvas/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, state }),
    })
    assert.equal(put.status, 200)
    const get = await fetch(`${HOST}/host/canvas/load?workspaceId=${workspaceId}`)
    const body = await get.json()
    assert.equal(body.zoom, 1)
    assert.equal(body.tiles[0].id, 't1')
  })
})
