import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  spawnManagedChild,
  waitFor,
} from './helpers/spawn-daemon.mjs'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const IGNORE_SIGTERM_FIXTURE = join(TEST_DIR, 'fixtures', 'ignore-sigterm.mjs')

test('managed child escalates SIGTERM to SIGKILL and settles every lifecycle listener', {
  skip: process.platform === 'win32',
}, async t => {
  const managed = spawnManagedChild({
    command: process.execPath,
    args: [IGNORE_SIGTERM_FIXTURE],
  })
  t.after(async () => {
    await managed.stop({
      termTimeoutMs: 50,
      killTimeoutMs: 2_000,
    })
  })

  await waitFor(
    () => managed.stdout.includes(`ready:${managed.child.pid}`),
    2_000,
    10,
  )

  const pid = managed.child.pid
  const result = await managed.stop({
    termTimeoutMs: 50,
    killTimeoutMs: 2_000,
  })

  assert.equal(result.escalated, true)
  assert.equal(result.signalCode, 'SIGKILL')
  assert.equal(managed.child.exitCode, null)
  assert.equal(managed.child.signalCode, 'SIGKILL')
  assert.equal(managed.child.listenerCount('error'), 0)
  assert.equal(managed.child.listenerCount('exit'), 0)
  assert.equal(managed.child.listenerCount('close'), 0)
  assert.equal(managed.child.stdout.listenerCount('data'), 0)
  assert.equal(managed.child.stderr.listenerCount('data'), 0)
  assert.equal(managed.child.stdout.readableEnded, true)
  assert.equal(managed.child.stderr.readableEnded, true)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

test('managed child settles spawn errors and removes lifecycle listeners', async () => {
  const managed = spawnManagedChild({
    command: join(TEST_DIR, 'fixtures', 'missing-executable'),
  })

  const result = await managed.waitForExit(2_000)

  assert.equal(result.spawnError?.code, 'ENOENT')
  assert.equal(managed.child.listenerCount('error'), 0)
  assert.equal(managed.child.listenerCount('exit'), 0)
  assert.equal(managed.child.listenerCount('close'), 0)
  assert.equal(managed.child.stdout.listenerCount('data'), 0)
  assert.equal(managed.child.stderr.listenerCount('data'), 0)
})
