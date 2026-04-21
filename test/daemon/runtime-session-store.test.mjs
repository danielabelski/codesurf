import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const DAEMON_ENTRY = join(ROOT_DIR, 'bin', 'codesurfd.mjs')
const TEST_TMP_ROOT = join(ROOT_DIR, '.tmp', 'daemon-tests')

async function waitFor(check, timeoutMs = 5_000, intervalMs = 50) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function makeTestTempDir(prefix) {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return await mkdtemp(join(TEST_TMP_ROOT, prefix))
}

async function startDaemon() {
  const homeDir = await makeTestTempDir('codesurfd-runtime-session-')
  const pidPath = join(homeDir, 'daemon', 'pid.json')
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: homeDir,
      CODESURF_HOME: homeDir,
      CODESURF_DAEMON_PID_PATH: pidPath,
      CODESURF_APP_VERSION: 'runtime-session-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr += String(chunk)
  })

  const pidInfo = await waitFor(async () => {
    if (!existsSync(pidPath)) return null
    return await readJson(pidPath)
  })

  const request = async (path, { body, method } = {}) => {
    const response = await fetch(`http://127.0.0.1:${pidInfo.port}${path}`, {
      method: method ?? (body == null ? 'GET' : 'POST'),
      headers: {
        Authorization: `Bearer ${pidInfo.token}`,
        ...(body == null ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body == null ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const payload = text.trim() ? JSON.parse(text) : null
    return { status: response.status, payload }
  }

  const stop = async () => {
    if (!child.killed) child.kill('SIGTERM')
    await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 5_000, 50).catch(() => null)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(homeDir, { recursive: true, force: true })
    if (stderr.trim()) {
      assert.fail(`daemon stderr was not empty:\n${stderr}`)
    }
  }

  return { homeDir, request, stop }
}

test('daemon runtime session store upserts, lists, reads, and deletes local chat sessions', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceId = 'ws-runtime'
  const workspaceDir = join(daemon.homeDir, 'workspaces', workspaceId)
  await mkdir(join(workspaceDir, '.contex'), { recursive: true })
  await writeFile(join(daemon.homeDir, 'workspaces.json'), JSON.stringify({
    workspaces: [{ id: workspaceId, name: 'Runtime', path: workspaceDir }],
    activeWorkspaceId: workspaceId,
  }, null, 2))

  const state = {
    provider: 'claude',
    model: 'sonnet',
    sessionId: 'claude-session-123',
    messages: [
      { role: 'user', content: 'Build a daemon-owned session store.' },
      { role: 'assistant', content: 'Sure — I can do that.' },
    ],
    executionTarget: 'local',
    jobId: null,
    jobSequence: 0,
    isStreaming: false,
  }

  let response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-123',
      state,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)

  response = await daemon.request(`/session/local/list?workspaceId=${encodeURIComponent(workspaceId)}`)
  assert.equal(response.status, 200)
  const runtimeEntry = response.payload.find(entry => entry.id === 'codesurf-runtime:chat-123')
  assert.ok(runtimeEntry)
  assert.equal(runtimeEntry.provider, 'claude')
  assert.equal(runtimeEntry.model, 'sonnet')
  assert.equal(runtimeEntry.sessionId, 'claude-session-123')
  assert.equal(runtimeEntry.messageCount, 2)
  assert.match(runtimeEntry.lastMessage, /sure/i)

  response = await daemon.request(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent('codesurf-runtime:chat-123')}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.provider, 'claude')
  assert.equal(response.payload.model, 'sonnet')
  assert.equal(response.payload.sessionId, 'claude-session-123')
  assert.equal(response.payload.messages.length, 2)

  response = await daemon.request('/session/local/delete', {
    body: {
      workspaceId,
      sessionEntryId: 'codesurf-runtime:chat-123',
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, { ok: true })
  assert.equal(existsSync(join(workspaceDir, '.contex', 'runtime-session-chat-123.json')), false)
  assert.equal(existsSync(join(workspaceDir, '.contex', 'deleted', 'runtime-session-chat-123.json')), true)
})
