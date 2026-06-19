import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCodexExecArgs } from '../bin/chat-jobs.mjs'

test('buildCodexExecArgs places exec-level options before resume', () => {
  const args = buildCodexExecArgs({
    provider: 'codex',
    model: 'o3',
    mode: 'default',
    sessionId: 'session-1',
    messages: [{ role: 'user', content: 'continue' }],
  }, '/tmp/workspace')

  assert.deepEqual(args.slice(0, 12), [
    'exec',
    '--json',
    '--model',
    'o3',
    '--skip-git-repo-check',
    '-C',
    '/tmp/workspace',
    '-s',
    'workspace-write',
    '-c',
    'approval_policy=on-request',
    'resume',
  ])
  assert.equal(args[12], 'session-1')
  assert.match(args.at(-1), /continue/)
})

test('buildCodexExecArgs keeps fresh turns on codex exec without resume', () => {
  const args = buildCodexExecArgs({
    provider: 'codex',
    model: 'o3',
    mode: 'default',
    messages: [{ role: 'user', content: 'start' }],
  }, '/tmp/workspace')

  assert.equal(args[0], 'exec')
  assert.equal(args.includes('resume'), false)
  assert.equal(args.at(-1).includes('start'), true)
})
