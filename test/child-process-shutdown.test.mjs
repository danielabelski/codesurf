import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { stopTestChild, trackTestChild } from './helpers/child-process-shutdown.mjs'

async function spawnFixture(setup = '') {
  const child = spawn(process.execPath, [
    '-e',
    `${setup}; process.stdout.write('ready\\n'); setInterval(() => {}, 1000)`,
  ], {
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  trackTestChild(child)
  await once(child.stdout, 'data')
  return child
}

async function forceCleanup(child) {
  await stopTestChild(child, { graceMs: 50, killMs: 1_000 })
}

function assertDrained(child) {
  assert.equal(child.stdin.destroyed, true)
  assert.equal(child.stdout.destroyed, true)
  assert.equal(child.listenerCount('close'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    throw error
  }
}

async function waitForProcessGone(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`process ${pid} remained alive after process-group shutdown`)
    }
    await delay(10)
  }
}

test('stopTestChild awaits graceful SIGTERM exit', { timeout: 5_000 }, async (t) => {
  const child = await spawnFixture()
  child.stdout.on('data', () => {})
  t.after(() => {
    return forceCleanup(child)
  })

  const result = await stopTestChild(child, { graceMs: 1_000, killMs: 1_000 })

  assert.equal(result.escalated, false)
  assert.equal(result.signal, 'SIGTERM')
  assert.notEqual(child.signalCode, null)
  assertDrained(child)
})

test('stopTestChild escalates a SIGTERM-resistant child and awaits SIGKILL', {
  timeout: 5_000,
  skip: process.platform === 'win32' ? 'Windows does not support catchable SIGTERM child semantics' : false,
}, async (t) => {
  const child = await spawnFixture("process.on('SIGTERM', () => {})")
  t.after(() => {
    return forceCleanup(child)
  })

  const result = await stopTestChild(child, { graceMs: 100, killMs: 1_000 })

  assert.equal(result.escalated, true)
  assert.equal(result.signal, 'SIGKILL')
  assert.notEqual(child.signalCode, null)
  assertDrained(child)
})

test('stopTestChild kills a detached POSIX child group without orphaning descendants', {
  timeout: 5_000,
  skip: process.platform === 'win32' ? 'POSIX process groups are unavailable on Windows' : false,
}, async (t) => {
  const grandchildSource = [
    "process.on('SIGTERM', () => {})",
    "process.stdout.write('ready\\n')",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const leaderSource = [
    "const { spawn } = require('node:child_process')",
    "process.on('SIGTERM', () => {})",
    `const worker = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildSource)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
    "worker.stdout.once('data', () => process.stdout.write(String(worker.pid) + '\\n'))",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const leader = spawn(process.execPath, ['-e', leaderSource], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  })
  trackTestChild(leader)
  const [pidChunk] = await once(leader.stdout, 'data')
  const grandchildPid = Number.parseInt(String(pidChunk).trim(), 10)
  assert.equal(Number.isSafeInteger(grandchildPid), true)
  t.after(() => {
    return stopTestChild(leader, {
      graceMs: 50,
      killMs: 1_000,
      killProcessGroup: true,
    })
  })

  const result = await stopTestChild(leader, {
    graceMs: 100,
    killMs: 1_000,
    killProcessGroup: true,
  })

  assert.equal(result.escalated, true)
  await waitForProcessGone(grandchildPid)
  assertDrained(leader)
})
