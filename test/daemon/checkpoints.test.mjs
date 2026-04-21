import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

async function makeTestTempDir(prefix) {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return await mkdtemp(join(TEST_TMP_ROOT, prefix))
}

async function startDaemon() {
  const homeDir = await makeTestTempDir('codesurfd-checkpoints-')
  const pidPath = join(homeDir, 'daemon', 'pid.json')
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: homeDir,
      CODESURF_HOME: homeDir,
      CODESURF_DAEMON_PID_PATH: pidPath,
      CODESURF_APP_VERSION: 'checkpoint-test',
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

test('daemon checkpoints reject symlink escapes outside workspace roots', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const projectDir = join(daemon.homeDir, 'project-symlink')
  const outsideDir = join(daemon.homeDir, 'outside-target')
  const outsideFile = join(outsideDir, 'secret.txt')
  const linkDir = join(projectDir, 'linked')

  await mkdir(projectDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  await writeFile(outsideFile, 'outside\n', 'utf8')
  await symlink(outsideDir, linkDir)

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Symlink Workspace',
      projectPath: projectDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-symlink',
      state: {
        provider: 'claude',
        model: 'sonnet',
        sessionId: 'claude-session-symlink',
        messages: [
          { role: 'user', content: 'Try the symlink path.' },
        ],
        executionTarget: 'local',
        jobId: null,
        jobSequence: 0,
        isStreaming: false,
      },
    },
  })
  assert.equal(response.status, 200)

  response = await daemon.request('/checkpoint/create', {
    body: {
      workspaceId,
      sessionEntryId: 'codesurf-runtime:chat-symlink',
      label: 'Symlink escape',
      files: [join(linkDir, 'secret.txt')],
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, false)
  assert.match(response.payload.error, /workspace/i)
})

test('daemon checkpoints create, list, and restore runtime session snapshots', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const projectDir = join(daemon.homeDir, 'project-alpha')
  const existingFile = join(projectDir, 'notes.txt')
  const newFile = join(projectDir, 'scratch.txt')
  await mkdir(projectDir, { recursive: true })
  await writeFile(existingFile, 'before checkpoint\n', 'utf8')

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Checkpoint Workspace',
      projectPath: projectDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id
  assert.ok(workspaceId)

  response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-123',
      state: {
        provider: 'claude',
        model: 'sonnet',
        sessionId: 'claude-session-123',
        messages: [
          { role: 'user', content: 'Please edit notes.txt safely.' },
          { role: 'assistant', content: 'I will checkpoint before editing.' },
        ],
        executionTarget: 'local',
        jobId: null,
        jobSequence: 0,
        isStreaming: false,
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)

  response = await daemon.request('/checkpoint/create', {
    body: {
      workspaceId,
      sessionEntryId: 'codesurf-runtime:chat-123',
      label: 'Before editing notes.txt',
      reason: 'tool:Write',
      files: [existingFile, newFile],
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.ok(response.payload.checkpoint?.id)
  assert.equal(response.payload.checkpoint.fileCount, 2)
  const checkpointId = response.payload.checkpoint.id

  response = await daemon.request('/checkpoint/list', {
    body: {
      workspaceId,
      sessionEntryId: 'codesurf-runtime:chat-123',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 1)
  assert.equal(response.payload[0].id, checkpointId)
  assert.equal(response.payload[0].fileCount, 2)
  assert.equal(response.payload[0].sessionEntryId, 'codesurf-runtime:chat-123')

  await writeFile(existingFile, 'after checkpoint\n', 'utf8')
  await writeFile(newFile, 'created after checkpoint\n', 'utf8')

  response = await daemon.request('/checkpoint/restore', {
    body: {
      workspaceId,
      checkpointId,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.filesRestored, 1)
  assert.equal(response.payload.filesDeleted, 1)

  assert.equal(await readFile(existingFile, 'utf8'), 'before checkpoint\n')
  assert.equal(existsSync(newFile), false)

  response = await daemon.request(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent('codesurf-runtime:chat-123')}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.checkpoints.count, 1)
  assert.equal(response.payload.checkpoints.latestCheckpointId, checkpointId)
  assert.equal(response.payload.checkpoints.lastRestoredCheckpointId, checkpointId)
  const restoredNotice = response.payload.messages.find(message => Array.isArray(message?.toolBlocks) && message.toolBlocks.some(block => block?.name === 'Checkpoint restored'))
  assert.ok(restoredNotice)

  response = await daemon.request('/session/runtime/upsert', {
    body: {
      workspaceId,
      cardId: 'chat-123',
      state: {
        provider: 'claude',
        model: 'sonnet',
        sessionId: 'claude-session-123',
        messages: [
          { role: 'user', content: 'Please edit notes.txt safely.' },
          { role: 'assistant', content: 'Checkpoint metadata should survive later upserts.' },
        ],
        executionTarget: 'local',
        jobId: null,
        jobSequence: 1,
        isStreaming: false,
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)

  response = await daemon.request(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent('codesurf-runtime:chat-123')}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.checkpoints.count, 1)
  assert.equal(response.payload.checkpoints.latestCheckpointId, checkpointId)
  assert.equal(response.payload.checkpoints.lastRestoredCheckpointId, checkpointId)

  response = await daemon.request(`/session/local/list?workspaceId=${encodeURIComponent(workspaceId)}`)
  assert.equal(response.status, 200)
  const restoredRuntimeEntry = response.payload.find(entry => entry.id === 'codesurf-runtime:chat-123')
  assert.ok(restoredRuntimeEntry)
  assert.equal(restoredRuntimeEntry.checkpointCount, 1)
})
