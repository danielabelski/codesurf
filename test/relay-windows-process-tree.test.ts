import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  runWindowsTaskkill,
  type WindowsTaskkillProcess,
} from '../src/main/relay/bounded-subprocess.ts'

function closingTaskkill(
  code: number | null,
  signal: NodeJS.Signals | null = null,
): WindowsTaskkillProcess {
  return {
    onError() {},
    onClose(listener) {
      queueMicrotask(() => listener(code, signal))
    },
    kill() {},
  }
}

describe('Windows relay process-tree termination contract', () => {
  test('accepts taskkill /T only when it exits successfully', async () => {
    const result = await runWindowsTaskkill(123, 100, {
      spawnTaskkill: () => closingTaskkill(0),
    })

    assert.deepEqual(result, {
      confirmed: true,
      outcome: 'success',
      detail: 'taskkill /T exited successfully',
    })
  })

  test('fails closed when taskkill cannot be spawned', async () => {
    const result = await runWindowsTaskkill(123, 100, {
      spawnTaskkill: () => {
        throw new Error('ENOENT')
      },
    })

    assert.equal(result.confirmed, false)
    assert.equal(result.outcome, 'spawn-error')
    assert.match(result.detail, /ENOENT/)
  })

  test('fails closed on a non-zero taskkill exit', async () => {
    const result = await runWindowsTaskkill(123, 100, {
      spawnTaskkill: () => closingTaskkill(5),
    })

    assert.equal(result.confirmed, false)
    assert.equal(result.outcome, 'nonzero-exit')
    assert.match(result.detail, /code 5/)
  })

  test('fails closed when taskkill itself times out', async () => {
    let killCalls = 0
    const result = await runWindowsTaskkill(123, 10, {
      spawnTaskkill: () => ({
        onError() {},
        onClose() {},
        kill() {
          killCalls += 1
        },
      }),
    })

    assert.equal(result.confirmed, false)
    assert.equal(result.outcome, 'timeout')
    assert.equal(killCalls, 1)
  })

  test('allows an explicit descendant-death verifier to confirm fallback', async () => {
    const result = await runWindowsTaskkill(123, 100, {
      spawnTaskkill: () => closingTaskkill(1),
      verifyProcessTreeExited: async pid => pid === 123,
    })

    assert.equal(result.confirmed, true)
    assert.equal(result.outcome, 'verified')
    assert.match(result.detail, /independently verified dead/)
  })
})
