import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDaemonManager } from '../../packages/codesurf-daemon/src/manager.ts'

async function makeManagerFixture(options = {}) {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-daemon-manager-'))
  const daemonDir = join(homeDir, 'daemon')
  const daemonScriptPath = join(homeDir, 'codesurfd.mjs')
  const pidPath = join(daemonDir, 'pid.json')
  await mkdir(daemonDir, { recursive: true })
  await writeFile(daemonScriptPath, '// manager test fixture\n', 'utf8')

  const events = []
  const alivePids = new Set()
  let nextPid = 42_200

  async function writePidInfo(info) {
    await writeFile(pidPath, `${JSON.stringify(info)}\n`, 'utf8')
    alivePids.add(info.pid)
  }

  if (options.existingVersion !== undefined) {
    await writePidInfo({
      pid: 42_100,
      port: 4100,
      token: 'existing-token',
      startedAt: new Date(0).toISOString(),
      protocolVersion: 1,
      appVersion: options.existingVersion,
    })
  }

  const runtime = {
    fetch: async (url) => {
      const port = Number(new URL(String(url)).port)
      const pid = port === 4100 ? 42_100 : nextPid
      events.push(`health:${pid}`)
      return new Response(JSON.stringify({ ok: alivePids.has(pid) }), {
        status: alivePids.has(pid) ? 200 : 503,
        headers: { 'Content-Type': 'application/json' },
      })
    },
    kill: (pid, signal = 0) => {
      if (signal === 0) {
        if (alivePids.has(pid)) return true
        const error = new Error(`No process ${pid}`)
        error.code = 'ESRCH'
        throw error
      }
      events.push(`${signal}:${pid}`)
      alivePids.delete(Math.abs(pid))
      return true
    },
    spawn: () => {
      nextPid += 1
      events.push(`spawn:${nextPid}`)
      const child = new EventEmitter()
      child.pid = nextPid
      child.unref = () => {}
      void writePidInfo({
        pid: nextPid,
        port: nextPid,
        token: `token-${nextPid}`,
        startedAt: new Date(nextPid).toISOString(),
        protocolVersion: 1,
        appVersion: '2.0.0',
      })
      return child
    },
    waitForChildStartupGrace: async () => {},
  }

  const manager = createDaemonManager({
    homeDir,
    getAppVersion: () => '2.0.0',
    resolveDaemonScriptPath: () => daemonScriptPath,
    healthTimeoutMs: 1_000,
  }, runtime)

  return {
    events,
    homeDir,
    manager,
    cleanup: () => rm(homeDir, { recursive: true, force: true }),
  }
}

test('manager reuses a healthy same-version daemon', async t => {
  const fixture = await makeManagerFixture({ existingVersion: '2.0.0' })
  t.after(fixture.cleanup)

  const info = await fixture.manager.ensureDaemonRunning()

  assert.equal(info.pid, 42_100)
  assert.equal(fixture.events.some(event => event.startsWith('spawn:')), false)
  assert.equal(fixture.events.some(event => event.startsWith('SIGTERM:')), false)
})

test('manager retains compatibility with a healthy legacy daemon without an app version', async t => {
  const fixture = await makeManagerFixture({ existingVersion: null })
  t.after(fixture.cleanup)

  const info = await fixture.manager.ensureDaemonRunning()

  assert.equal(info.pid, 42_100)
  assert.equal(fixture.events.some(event => event.startsWith('spawn:')), false)
})

test('manager stops a healthy mismatched daemon before spawning its replacement', async t => {
  const fixture = await makeManagerFixture({ existingVersion: '1.0.0' })
  t.after(fixture.cleanup)

  const info = await fixture.manager.ensureDaemonRunning()

  assert.equal(info.appVersion, '2.0.0')
  assert.equal(fixture.events.filter(event => event.startsWith('SIGTERM:')).length, 1)
  assert.equal(fixture.events.filter(event => event.startsWith('spawn:')).length, 1)
  assert.ok(
    fixture.events.findIndex(event => event === 'SIGTERM:42100')
      < fixture.events.findIndex(event => event.startsWith('spawn:')),
  )
})

test('concurrent version-drift checks share one replacement startup', async t => {
  const fixture = await makeManagerFixture({ existingVersion: '1.0.0' })
  t.after(fixture.cleanup)

  const [first, second] = await Promise.all([
    fixture.manager.ensureDaemonRunning(),
    fixture.manager.ensureDaemonRunning(),
  ])

  assert.equal(first.pid, second.pid)
  assert.equal(fixture.events.filter(event => event.startsWith('SIGTERM:')).length, 1)
  assert.equal(fixture.events.filter(event => event.startsWith('spawn:')).length, 1)
})
