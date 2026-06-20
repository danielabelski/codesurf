import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('broker host replaces owned extension IPC handlers before re-registering', () => {
  const source = readFileSync(`${process.cwd()}/src/main/extensions/broker/host.ts`, 'utf8')

  assert.match(source, /const expectedPrefix = `ext:\$\{extId\}:`/)
  assert.match(source, /if \(this\.ipcChannels\.includes\(fullChannel\)\) \{\s*ipcMain\.removeHandler\(fullChannel\)/s)
  assert.match(source, /this\.ipcChannels = this\.ipcChannels\.filter\(channel => channel !== fullChannel\)/)
  assert.match(source, /this\.ipcChannels\.push\(fullChannel\)/)
})

test('extension IPC loading coalesces in-flight scans for the same workspace', () => {
  const source = readFileSync(`${process.cwd()}/src/main/ipc/extensions.ts`, 'utf8')

  assert.match(source, /let inFlightLoad: \{ workspacePath: string \| null; promise: Promise<void> \} \| null = null/)
  assert.match(source, /inFlightLoad && inFlightLoad\.workspacePath === targetWorkspacePath/)
  assert.match(source, /await inFlightLoad\.promise/)
  assert.match(source, /inFlightLoad = \{ workspacePath: targetWorkspacePath, promise: loadPromise \}/)
})

test('extension registry serializes rescans to avoid overlapping deactivate\/activate cycles', () => {
  const source = readFileSync(`${process.cwd()}/src/main/extensions/registry.ts`, 'utf8')

  assert.match(source, /private rescanQueue: Promise<void> = Promise\.resolve\(\)/)
  assert.match(source, /this\.rescanQueue = this\.rescanQueue\.then\(run, run\)/)
  assert.match(source, /return this\.rescanQueue/)
})