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
  const homeDir = await makeTestTempDir('codesurfd-memory-loader-')
  const pidPath = join(homeDir, 'daemon', 'pid.json')
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: homeDir,
      CODESURF_HOME: homeDir,
      CODESURF_DAEMON_PID_PATH: pidPath,
      CODESURF_APP_VERSION: 'memory-loader-test',
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

test('daemon memory loader returns layered AGENTS context, imports, buckets, and cloud-safe prompt selection', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'project-root')
  const nestedProjectDir = join(workspaceDir, 'packages', 'app')
  await mkdir(join(daemon.homeDir, '.codesurf', 'imports'), { recursive: true })
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  await mkdir(join(workspaceDir, 'rules'), { recursive: true })
  await mkdir(join(nestedProjectDir, '.codesurf'), { recursive: true })

  await writeFile(join(daemon.homeDir, '.codesurf', 'AGENTS.md'), 'User instruction layer', 'utf8')
  await writeFile(join(workspaceDir, 'AGENTS.md'), 'Workspace instruction layer\n@import ./rules/root-extra.md', 'utf8')
  await writeFile(join(workspaceDir, 'rules', 'root-extra.md'), 'Imported workspace rule', 'utf8')
  await writeFile(join(workspaceDir, '.codesurf', 'AGENTS.md'), 'Workspace local instruction layer', 'utf8')
  await writeFile(join(nestedProjectDir, 'AGENTS.md'), 'Nested workspace instruction layer', 'utf8')
  await writeFile(join(nestedProjectDir, '.codesurf', 'AGENTS.md'), 'Nested workspace local instruction layer', 'utf8')

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Memory Workspace',
      projectPath: workspaceDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request('/workspace/add-project-folder', {
    body: {
      workspaceId,
      folderPath: nestedProjectDir,
    },
  })
  assert.equal(response.status, 200)

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=local`)
  assert.equal(response.status, 200)
  assert.deepEqual(
    response.payload.sections.map(section => ({
      scope: section.scope,
      bucket: section.bucket,
      displayPath: section.displayPath,
      importedFrom: section.importedFrom ?? null,
      content: section.content,
    })),
    [
      { scope: 'user', bucket: 'local-only', displayPath: '~/.codesurf/AGENTS.md', importedFrom: null, content: 'User instruction layer' },
      { scope: 'workspace', bucket: 'remote-safe', displayPath: 'AGENTS.md', importedFrom: null, content: 'Workspace instruction layer' },
      { scope: 'workspace', bucket: 'remote-safe', displayPath: 'rules/root-extra.md', importedFrom: 'AGENTS.md', content: 'Imported workspace rule' },
      { scope: 'workspace-local', bucket: 'local-only', displayPath: '.codesurf/AGENTS.md', importedFrom: null, content: 'Workspace local instruction layer' },
      { scope: 'nested-workspace', bucket: 'remote-safe', displayPath: 'packages/app/AGENTS.md', importedFrom: null, content: 'Nested workspace instruction layer' },
      { scope: 'nested-workspace-local', bucket: 'local-only', displayPath: 'packages/app/.codesurf/AGENTS.md', importedFrom: null, content: 'Nested workspace local instruction layer' },
    ],
  )
  assert.deepEqual(response.payload.includedBuckets, ['local-only', 'remote-safe'])
  assert.match(response.payload.prompt, /User instruction layer[\s\S]*Workspace instruction layer[\s\S]*Imported workspace rule[\s\S]*Workspace local instruction layer[\s\S]*Nested workspace instruction layer[\s\S]*Nested workspace local instruction layer/)

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=cloud`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.payload.includedBuckets, ['remote-safe'])
  assert.match(response.payload.prompt, /Workspace instruction layer[\s\S]*Imported workspace rule[\s\S]*Nested workspace instruction layer/)
  assert.doesNotMatch(response.payload.prompt, /User instruction layer|Workspace local instruction layer|Nested workspace local instruction layer/)
})

test('daemon memory loader keeps imported local-only files out of cloud prompts and avoids self-import duplication', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'project-import-buckets')
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  await writeFile(
    join(workspaceDir, 'AGENTS.md'),
    'Workspace instruction layer\n@import ./.codesurf/local-extra.md\n@import ./AGENTS.md',
    'utf8',
  )
  await writeFile(join(workspaceDir, '.codesurf', 'local-extra.md'), 'Imported local-only rule\n@import ../AGENTS.md', 'utf8')

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Import Bucket Workspace',
      projectPath: workspaceDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=local`)
  assert.equal(response.status, 200)
  assert.deepEqual(
    response.payload.sections.map(section => ({
      scope: section.scope,
      bucket: section.bucket,
      displayPath: section.displayPath,
      importedFrom: section.importedFrom ?? null,
      content: section.content,
    })),
    [
      { scope: 'workspace', bucket: 'remote-safe', displayPath: 'AGENTS.md', importedFrom: null, content: 'Workspace instruction layer' },
      { scope: 'workspace-local', bucket: 'local-only', displayPath: '.codesurf/local-extra.md', importedFrom: 'AGENTS.md', content: 'Imported local-only rule' },
    ],
  )
  assert.match(response.payload.prompt, /Workspace instruction layer[\s\S]*Imported local-only rule/)

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=cloud`)
  assert.equal(response.status, 200)
  assert.match(response.payload.prompt, /Workspace instruction layer/)
  assert.doesNotMatch(response.payload.prompt, /Imported local-only rule/)
})

test('daemon memory loader rejects AGENTS imports that escape the workspace through symlinks', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'project-symlink-memory')
  const outsideDir = join(daemon.homeDir, 'outside-memory')
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(outsideDir, 'secret.md'), 'Nope', 'utf8')
  await symlink(outsideDir, join(workspaceDir, 'linked'))
  await writeFile(join(workspaceDir, 'AGENTS.md'), '@import ./linked/secret.md', 'utf8')

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Symlink Memory Workspace',
      projectPath: workspaceDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=local`)
  assert.equal(response.status, 500)
  assert.match(response.payload.error, /outside the workspace root|symlink/i)
})
