import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

async function startDaemon(options = {}) {
  const homeDir = await makeTestTempDir('codesurfd-test-')
  const pidPath = join(homeDir, 'daemon', 'pid.json')
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: homeDir,
      CODESURF_HOME: homeDir,
      CODESURF_DAEMON_PID_PATH: pidPath,
      CODESURF_APP_VERSION: 'test-suite',
      ...(options.env ?? {}),
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

  const request = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${pidInfo.port}${path}`, {
      method: options.method ?? (options.body == null ? 'GET' : 'POST'),
      headers: {
        Authorization: `Bearer ${pidInfo.token}`,
        ...(options.body == null ? {} : { 'Content-Type': 'application/json' }),
      },
      body: options.body == null ? undefined : JSON.stringify(options.body),
    })
    const text = await response.text()
    const payload = text.trim() ? JSON.parse(text) : null
    return { status: response.status, payload }
  }

  const requestText = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${pidInfo.port}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${pidInfo.token}`,
        ...(options.headers ?? {}),
      },
    })
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
    }
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

  return { child, homeDir, pidInfo, request, requestText, stop }
}

test('daemon health endpoint requires auth and returns metadata', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const unauth = await fetch(`http://127.0.0.1:${daemon.pidInfo.port}/health`)
  assert.equal(unauth.status, 401)

  const { status, payload } = await daemon.request('/health')
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.equal(payload.protocolVersion, 1)
  assert.equal(payload.appVersion, 'test-suite')
})

test('daemon dashboard serves html and query-token auth works', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const unauth = await fetch(`http://127.0.0.1:${daemon.pidInfo.port}/dashboard`)
  assert.equal(unauth.status, 401)

  const queryAuth = await fetch(
    `http://127.0.0.1:${daemon.pidInfo.port}/dashboard?token=${encodeURIComponent(daemon.pidInfo.token)}`,
  )
  assert.equal(queryAuth.status, 200)
  const html = await queryAuth.text()
  assert.match(queryAuth.headers.get('content-type') ?? '', /text\/html/)
  assert.match(html, /CodeSurf Daemon Jobs/)
  assert.match(html, /\/dashboard\/api\/jobs/)
})

test('daemon manages workspace and project lifecycle through persisted json state', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const folderA = join(daemon.homeDir, 'repos', 'alpha')
  const folderB = join(daemon.homeDir, 'repos', 'beta')

  let response = await daemon.request('/workspace/create-from-folder', {
    body: { folderPath: folderA },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.name, 'alpha')
  assert.equal(response.payload.path, folderA)
  assert.deepEqual(response.payload.projectPaths, [folderA])

  response = await daemon.request('/workspace/projects')
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 1)
  assert.equal(response.payload[0].name, 'alpha')
  assert.equal(response.payload[0].path, folderA)

  response = await daemon.request('/workspace/add-project-folder', {
    body: {
      workspaceId: (await daemon.request('/workspace/active')).payload.id,
      folderPath: folderB,
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.projectPaths, [folderA, folderB])

  response = await daemon.request('/workspace/projects')
  assert.equal(response.payload.length, 2)
  assert.deepEqual(response.payload.map(project => project.name), ['alpha', 'beta'])

  response = await daemon.request('/workspace/remove-project-folder', {
    body: {
      workspaceId: (await daemon.request('/workspace/active')).payload.id,
      folderPath: folderA,
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.projectPaths, [folderB])
  assert.equal(response.payload.path, folderB)

  const workspacesDoc = await readJson(join(daemon.homeDir, 'workspaces', 'workspaces.json'))
  const projectsDoc = await readJson(join(daemon.homeDir, 'projects', 'projects.json'))
  assert.equal(workspacesDoc.workspaces.length, 1)
  assert.equal(projectsDoc.projects.length, 1)
  assert.equal(projectsDoc.projects[0].path, folderB)
})

test('daemon creates, switches, and deletes workspaces while maintaining the active workspace', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const alpha = await daemon.request('/workspace/create', { body: { name: 'Alpha' } })
  const beta = await daemon.request('/workspace/create-with-path', {
    body: { name: 'Beta', projectPath: join(daemon.homeDir, 'repos', 'beta') },
  })

  assert.equal(alpha.status, 200)
  assert.equal(beta.status, 200)
  assert.equal(beta.payload.name, 'Beta')
  assert.equal(beta.payload.projectPaths.length, 1)

  let active = await daemon.request('/workspace/active')
  assert.equal(active.status, 200)
  assert.equal(active.payload.id, beta.payload.id)

  let switched = await daemon.request('/workspace/set-active', { body: { id: alpha.payload.id } })
  assert.equal(switched.status, 200)
  assert.deepEqual(switched.payload, { ok: true })

  active = await daemon.request('/workspace/active')
  assert.equal(active.payload.id, alpha.payload.id)

  const listed = await daemon.request('/workspace/list')
  assert.equal(listed.status, 200)
  assert.equal(listed.payload.length, 2)

  const deleted = await daemon.request(`/workspace/${encodeURIComponent(alpha.payload.id)}`, {
    method: 'DELETE',
  })
  assert.equal(deleted.status, 200)
  assert.deepEqual(deleted.payload, { ok: true })

  active = await daemon.request('/workspace/active')
  assert.equal(active.payload.id, beta.payload.id)
})

test('daemon manages agent kanban board state in ~/.codesurf storage', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  let response = await daemon.request('/agent-kanban/board?workspacePath=/tmp/project-alpha')
  assert.equal(response.status, 200)
  assert.equal(response.payload.columns.length, 4)
  assert.equal(response.payload.columns[0].id, 'backlog')

  response = await daemon.request('/agent-kanban/task/create', {
    body: {
      workspacePath: '/tmp/project-alpha',
      prompt: 'Implement daemon-backed kanban task persistence',
      agentId: 'codex',
      baseRef: 'main',
      columnId: 'backlog',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.task.agentId, 'codex')
  const taskId = response.payload.task.id

  response = await daemon.request('/agent-kanban/dependency/add', {
    body: {
      workspacePath: '/tmp/project-alpha',
      fromTaskId: taskId,
      toTaskId: taskId,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, false)

  response = await daemon.request('/agent-kanban/task/move', {
    body: {
      workspacePath: '/tmp/project-alpha',
      taskId,
      columnId: 'in_progress',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.toColumnId, 'in_progress')

  response = await daemon.request('/agent-kanban/summary?workspacePath=/tmp/project-alpha')
  assert.equal(response.status, 200)
  assert.equal(response.payload.counts.active, 1)
  assert.equal(response.payload.counts.total, 1)

  const boardFile = join(daemon.homeDir, 'agent-kanban', '_tmp_project-alpha.json')
  const boardDoc = await readJson(boardFile)
  assert.equal(boardDoc.columns[1].cards.length, 1)
  assert.equal(boardDoc.columns[1].cards[0].id, taskId)
})

test('daemon lists, reads, and deletes local session state while maintaining summary files', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceId = 'ws-test'
  const tileId = 'alpha'
  const contexDir = join(daemon.homeDir, 'workspaces', workspaceId, '.contex')
  const tileStateFile = join(contexDir, `tile-state-${tileId}.json`)
  const summaryFile = join(contexDir, `tile-session-${tileId}.json`)
  const state = {
    sessionId: 'sess-1',
    provider: 'codex',
    model: 'gpt-5.4',
    messages: [
      { role: 'user', content: 'first message' },
      { role: 'assistant', content: 'latest assistant reply' },
    ],
  }

  await writeJson(tileStateFile, state)

  let response = await daemon.request(`/session/local/list?workspaceId=${workspaceId}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 1)
  assert.equal(response.payload[0].id, `codesurf-tile:tile-state-${tileId}.json`)
  assert.equal(response.payload[0].provider, 'codex')
  assert.equal(response.payload[0].model, 'gpt-5.4')
  assert.equal(response.payload[0].messageCount, 2)
  assert.equal(response.payload[0].lastMessage, 'latest assistant reply')
  assert.equal(response.payload[0].title, 'latest assistant reply')

  const summaryStat = await stat(summaryFile)
  assert.ok(summaryStat.isFile())

  response = await daemon.request(`/session/local/state?workspaceId=${workspaceId}&sessionEntryId=${encodeURIComponent(`codesurf-tile:tile-state-${tileId}.json`)}`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, state)

  response = await daemon.request('/session/local/delete', {
    body: {
      workspaceId,
      sessionEntryId: `codesurf-tile:tile-state-${tileId}.json`,
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, { ok: true })
  assert.equal(existsSync(tileStateFile), false)
  assert.equal(existsSync(summaryFile), false)
  assert.equal(existsSync(join(contexDir, 'deleted', `tile-state-${tileId}.json`)), true)
})

test('daemon settings routes round-trip settings and raw json', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  let response = await daemon.request('/settings')
  assert.equal(response.status, 200)
  assert.equal(typeof response.payload, 'object')

  response = await daemon.request('/settings', {
    body: {
      settings: {
        appearance: 'light',
        linkOpenMode: 'browser-block',
        execution: {
          mode: 'specific-host',
          hostId: 'macmini',
        },
      },
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.appearance, 'light')
  assert.equal(response.payload.linkOpenMode, 'browser-block')
  assert.equal(response.payload.execution.mode, 'specific-host')
  assert.equal(response.payload.execution.hostId, 'macmini')

  response = await daemon.request('/settings/raw')
  assert.equal(response.status, 200)
  assert.match(response.payload.path, /settings\.json$/)
  assert.match(response.payload.content, /"appearance": "light"/)
  assert.match(response.payload.content, /"mode": "specific-host"/)

  response = await daemon.request('/settings/raw', {
    body: {
      json: JSON.stringify({ someFlag: true, nested: { value: 2 } }),
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.settings.someFlag, true)
  assert.equal(response.payload.settings.nested.value, 2)

  response = await daemon.request('/settings/raw', {
    body: { json: '[]' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, false)
  assert.match(response.payload.error, /Root must be a JSON object/)
})

test('daemon persists execution hosts separately from settings and preserves built-in hosts', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  let response = await daemon.request('/host/list')
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.map(host => host.id), ['local-runtime', 'local-daemon'])

  response = await daemon.request('/host/upsert', {
    body: {
      host: {
        id: 'macmini',
        type: 'remote-daemon',
        label: 'Mac Mini',
        url: 'https://daemon.example.com',
        authToken: 'secret-token',
        enabled: true,
      },
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.map(host => host.id), ['local-runtime', 'local-daemon', 'macmini'])

  let hostsDoc = await readJson(join(daemon.homeDir, 'hosts', 'hosts.json'))
  assert.equal(hostsDoc.hosts.length, 3)
  assert.equal(hostsDoc.hosts[2].label, 'Mac Mini')
  assert.equal(hostsDoc.hosts[2].url, 'https://daemon.example.com')

  response = await daemon.request('/host/upsert', {
    body: {
      host: {
        id: 'macmini',
        type: 'remote-daemon',
        label: 'Mac Mini Updated',
        url: 'https://daemon-2.example.com',
        enabled: false,
      },
    },
  })
  assert.equal(response.status, 200)
  const updated = response.payload.find(host => host.id === 'macmini')
  assert.equal(updated.label, 'Mac Mini Updated')
  assert.equal(updated.enabled, false)
  assert.equal(updated.url, 'https://daemon-2.example.com')

  response = await daemon.request('/host/local-runtime', { method: 'DELETE' })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /cannot be deleted/i)

  response = await daemon.request('/host/macmini', { method: 'DELETE' })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.deepEqual(response.payload.hosts.map(host => host.id), ['local-runtime', 'local-daemon'])

  hostsDoc = await readJson(join(daemon.homeDir, 'hosts', 'hosts.json'))
  assert.deepEqual(hostsDoc.hosts.map(host => host.id), ['local-runtime', 'local-daemon'])
})

test('daemon migrates legacy config.json into split workspace, project, and settings files', async t => {
  const homeDir = await makeTestTempDir('codesurfd-legacy-')
  const legacyConfigPath = join(homeDir, 'config.json')
  await writeJson(legacyConfigPath, {
    settings: {
      themeMode: 'dark',
      openLinksIn: 'external',
    },
    activeWorkspaceIndex: 0,
    workspaces: [
      {
        id: 'legacy-ws-1',
        name: 'Legacy Workspace',
        projectPaths: [
          join(homeDir, 'repos', 'one'),
          join(homeDir, 'repos', 'two'),
        ],
      },
    ],
  })

  const pidPath = join(homeDir, 'daemon', 'pid.json')
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: homeDir,
      CODESURF_HOME: homeDir,
      CODESURF_DAEMON_PID_PATH: pidPath,
      CODESURF_APP_VERSION: 'test-suite',
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

  t.after(async () => {
    if (!child.killed) child.kill('SIGTERM')
    await waitFor(async () => child.exitCode !== null || child.signalCode !== null, 5_000, 50).catch(() => null)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(homeDir, { recursive: true, force: true })
    if (stderr.trim()) {
      assert.fail(`daemon stderr was not empty:\n${stderr}`)
    }
  })

  const response = await fetch(`http://127.0.0.1:${pidInfo.port}/workspace/projects`, {
    headers: { Authorization: `Bearer ${pidInfo.token}` },
  })
  assert.equal(response.status, 200)
  const projects = await response.json()
  assert.equal(projects.length, 2)
  assert.deepEqual(projects.map(project => project.name), ['one', 'two'])

  const workspacesDoc = await readJson(join(homeDir, 'workspaces', 'workspaces.json'))
  const projectsDoc = await readJson(join(homeDir, 'projects', 'projects.json'))
  const settingsDoc = await readJson(join(homeDir, 'settings.json'))
  const hostsDoc = await readJson(join(homeDir, 'hosts', 'hosts.json'))
  assert.equal(workspacesDoc.activeWorkspaceId, 'legacy-ws-1')
  assert.equal(workspacesDoc.workspaces.length, 1)
  assert.equal(projectsDoc.projects.length, 2)
  assert.equal(settingsDoc.settings.themeMode, 'dark')
  assert.equal(settingsDoc.settings.openLinksIn, 'external')
  assert.deepEqual(hostsDoc.hosts.map(host => host.id), ['local-runtime', 'local-daemon'])
})

test('daemon chat jobs persist detached background mode in job metadata', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const response = await daemon.request('/chat/job/start', {
    body: {
      request: {
        cardId: 'chat-1',
        provider: 'unsupported-provider',
        model: 'test-model',
        runMode: 'background',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'Do this in the background' },
        ],
      },
    },
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.runMode, 'background')
  assert.equal(response.payload.status, 'running')

  const completed = await waitFor(async () => {
    const current = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(response.payload.id)}`)
    return current.payload?.status === 'failed' ? current.payload : null
  }, 5_000, 50)

  assert.equal(completed.runMode, 'background')
  assert.match(String(completed.error ?? ''), /only implemented for Claude and Codex/i)
})

test('daemon lists external CodeSurf sessions and invalidates the external-session cache route', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspacePath = join(daemon.homeDir, 'repos', 'gamma')
  const projectSessionPath = join(workspacePath, '.codesurf', 'sessions', 'project-chat.json')
  const userSessionPath = join(daemon.homeDir, 'sessions', 'user-chat.json')

  await writeJson(projectSessionPath, {
    sessionId: 'project-session',
    provider: 'claude',
    model: 'sonnet',
    messages: [
      { role: 'assistant', content: 'project level session' },
    ],
  })
  await writeJson(userSessionPath, {
    sessionId: 'user-session',
    provider: 'codex',
    model: 'gpt-5.4',
    title: 'User Chat',
    messages: [
      { role: 'assistant', content: 'user level session' },
    ],
  })

  let response = await daemon.request(`/session/external/list?workspacePath=${encodeURIComponent(workspacePath)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 2)
  const byId = new Map(response.payload.map(entry => [entry.sessionId, entry]))
  assert.equal(byId.get('project-session').scope, 'project')
  assert.equal(byId.get('project-session').projectPath, workspacePath)
  assert.equal(byId.get('user-session').scope, 'user')
  assert.equal(byId.get('user-session').title, 'User Chat')

  response = await daemon.request(`/session/external/state?workspacePath=${encodeURIComponent(workspacePath)}&sessionEntryId=${encodeURIComponent(byId.get('project-session').id)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.provider, 'claude')
  assert.equal(response.payload.model, 'sonnet')
  assert.equal(response.payload.sessionId, 'project-session')
  assert.equal(response.payload.messages.length, 1)
  assert.equal(response.payload.messages[0].content, 'project level session')

  response = await daemon.request('/session/external/invalidate', {
    body: { workspacePath },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, { ok: true })

  response = await daemon.request(`/session/external/list?workspacePath=${encodeURIComponent(workspacePath)}&force=1`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.length, 2)

  response = await daemon.request('/session/external/delete', {
    body: {
      workspacePath,
      sessionEntryId: byId.get('project-session').id,
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload, { ok: true })
  assert.equal(existsSync(projectSessionPath), false)
  assert.equal(existsSync(join(workspacePath, '.codesurf', 'sessions', 'deleted', 'project-chat.json')), true)
})

test('daemon validates local session route inputs', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  let response = await daemon.request('/session/local/list')
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /workspaceId is required/)

  response = await daemon.request('/session/local/delete', {
    body: { workspaceId: 'ws-only' },
  })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /workspaceId and sessionEntryId are required/)

  response = await daemon.request('/session/local/delete', {
    body: {
      workspaceId: 'ws-only',
      sessionEntryId: 'codesurf-tile:tile-state-missing.json',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, false)
  assert.match(response.payload.error, /Session file missing/)
})

test('daemon validates chat job route inputs', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  let response = await daemon.request('/chat/job/start', {
    body: {},
  })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /request is required/)

  response = await daemon.request('/chat/job/state')
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /jobId is required/)

  response = await daemon.request('/chat/job/cancel', {
    body: {},
  })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /jobId is required/)

  response = await daemon.request('/chat/job/state?jobId=missing-job')
  assert.equal(response.status, 404)
  assert.match(response.payload.error, /Job not found/)
})

test('daemon runs a persisted chat job timeline and replays events for completed jobs', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        provider: 'unsupported-provider',
        model: 'test-model',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'test daemon execution' },
        ],
      },
    },
  })
  assert.equal(start.status, 200)
  assert.equal(typeof start.payload.id, 'string')
  assert.equal(start.payload.taskLabel, 'test daemon execution')
  const jobId = start.payload.id

  const state = await waitFor(async () => {
    const next = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    return next.payload?.status === 'running' ? null : next
  })

  assert.equal(state.status, 200)
  assert.equal(state.payload.id, jobId)
  assert.equal(state.payload.status, 'failed')
  assert.equal(state.payload.lastSequence, 2)
  assert.match(state.payload.error, /only implemented for Claude and Codex/i)

  const timelineResponse = await fetch(`http://127.0.0.1:${daemon.pidInfo.port}/chat/job/events?jobId=${encodeURIComponent(jobId)}&since=0`, {
    headers: {
      Authorization: `Bearer ${daemon.pidInfo.token}`,
    },
  })
  assert.equal(timelineResponse.status, 200)
  const rawTimeline = await timelineResponse.text()
  const replayedEvents = rawTimeline
    .split(/\n\n+/)
    .map(chunk => chunk
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line))

  assert.equal(replayedEvents.length, 2)
  assert.equal(replayedEvents[0].jobId, jobId)
  assert.equal(replayedEvents[0].sequence, 1)
  assert.equal(replayedEvents[0].type, 'error')
  assert.match(replayedEvents[0].error, /only implemented for Claude and Codex/i)
  assert.equal(replayedEvents[1].jobId, jobId)
  assert.equal(replayedEvents[1].sequence, 2)
  assert.equal(replayedEvents[1].type, 'done')

  const timelineFile = join(daemon.homeDir, 'timelines', `${jobId}.jsonl`)
  const metadataFile = join(daemon.homeDir, 'jobs', `${jobId}.json`)
  assert.equal(existsSync(timelineFile), true)
  assert.equal(existsSync(metadataFile), true)
})

test('daemon codex jobs ignore benign stderr and still complete successfully', async t => {
  const fakeBinDir = await makeTestTempDir('codesurfd-fake-bin-')
  const fakeCodexPath = join(fakeBinDir, 'codex')
  await writeFile(fakeCodexPath, `#!/bin/sh
printf '%s\n' '{"type":"thread.started","thread_id":"thread-test"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"TEST OK"}}'
printf '%s\n' 'Reading additional input from stdin...' >&2
exit 0
`, 'utf8')
  await chmod(fakeCodexPath, 0o755)

  const daemon = await startDaemon({
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    },
  })

  t.after(async () => {
    await daemon.stop()
    await rm(fakeBinDir, { recursive: true, force: true })
  })

  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        provider: 'codex',
        model: 'gpt-5.4',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'test daemon execution' },
        ],
      },
    },
  })

  assert.equal(start.status, 200)
  const jobId = start.payload.id
  assert.equal(start.payload.taskLabel, 'test daemon execution')

  const state = await waitFor(async () => {
    const next = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    return next.payload?.status === 'running' ? null : next
  })

  assert.equal(state.status, 200)
  assert.equal(state.payload.status, 'completed')
  assert.equal(state.payload.error, null)
  assert.equal(state.payload.sessionId, 'thread-test')

  const timelineFile = join(daemon.homeDir, 'timelines', `${jobId}.jsonl`)
  const rawTimeline = await readFile(timelineFile, 'utf8')
  assert.match(rawTimeline, /"type":"session"/)
  assert.match(rawTimeline, /"type":"text","text":"TEST OK"/)
  assert.match(rawTimeline, /"type":"done"/)
  assert.doesNotMatch(rawTimeline, /Reading additional input from stdin/)
})

test('daemon dashboard job endpoints return recorded jobs and timelines', async t => {
  const fakeBinDir = await makeTestTempDir('codesurfd-dashboard-bin-')
  const fakeCodexPath = join(fakeBinDir, 'codex')
  await writeFile(fakeCodexPath, `#!/bin/sh
printf '%s\n' '{"type":"thread.started","thread_id":"thread-dashboard"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"DASHBOARD OK"}}'
exit 0
`, 'utf8')
  await chmod(fakeCodexPath, 0o755)

  const daemon = await startDaemon({
    env: {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    },
  })

  t.after(async () => {
    await daemon.stop()
    await rm(fakeBinDir, { recursive: true, force: true })
  })

  const start = await daemon.request('/chat/job/start', {
    body: {
      request: {
        provider: 'codex',
        model: 'gpt-5.4',
        workspaceDir: daemon.homeDir,
        messages: [
          { role: 'user', content: 'dashboard inspection test' },
        ],
      },
    },
  })

  assert.equal(start.status, 200)
  const jobId = start.payload.id
  assert.equal(start.payload.taskLabel, 'dashboard inspection test')

  await waitFor(async () => {
    const state = await daemon.request(`/chat/job/state?jobId=${encodeURIComponent(jobId)}`)
    return state.payload?.status === 'completed' ? state : null
  })

  const jobsResponse = await daemon.request('/dashboard/api/jobs')
  assert.equal(jobsResponse.status, 200)
  assert.equal(Array.isArray(jobsResponse.payload.jobs), true)
  assert.equal(jobsResponse.payload.summary.total > 0, true)
  assert.equal(jobsResponse.payload.daemon.appVersion, 'test-suite')
  assert.equal(jobsResponse.payload.jobs.some(job => job.id === jobId), true)
  assert.equal(
    jobsResponse.payload.jobs.some(job => job.id === jobId && job.taskLabel === 'dashboard inspection test'),
    true,
  )

  const detailResponse = await daemon.request(`/dashboard/api/job?jobId=${encodeURIComponent(jobId)}`)
  assert.equal(detailResponse.status, 200)
  assert.equal(detailResponse.payload.job.id, jobId)
  assert.equal(detailResponse.payload.job.taskLabel, 'dashboard inspection test')
  assert.equal(detailResponse.payload.job.status, 'completed')
  assert.equal(Array.isArray(detailResponse.payload.timeline), true)
  assert.equal(detailResponse.payload.timeline.some(event => event.type === 'text' && event.text === 'DASHBOARD OK'), true)

  const htmlResponse = await daemon.requestText('/dashboard')
  assert.equal(htmlResponse.status, 200)
  assert.match(htmlResponse.body, /CodeSurf Daemon Jobs/)
  assert.match(htmlResponse.body, /refreshAll\(\)/)
})
