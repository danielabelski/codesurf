import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

test('daemon chat-context mirrors exactly match their TypeScript sources', () => {
  const result = spawnSync(process.execPath, ['scripts/build-chat-context-mirrors.mjs', '--check'], {
    cwd: rootDir,
    encoding: 'utf8',
  })

  assert.equal(result.status, 0, result.stderr || result.stdout)
})
