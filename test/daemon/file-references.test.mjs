import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { expandFileReferences } from '../../bin/file-references.mjs'

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

async function makeWorkspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-file-refs-'))
  const workspaceDir = join(root, 'workspace')
  const srcDir = join(workspaceDir, 'src')
  const outsideDir = join(root, 'outside')
  await mkdir(srcDir, { recursive: true })
  await mkdir(outsideDir, { recursive: true })
  await writeFile(join(srcDir, 'app.ts'), 'export const value = 42\n', 'utf8')
  await writeFile(join(workspaceDir, 'README.md'), '# Workspace\n', 'utf8')
  await writeFile(join(outsideDir, 'secret.txt'), 'do not leak\n', 'utf8')
  return {
    root,
    workspaceDir,
    outsideDir,
  }
}

async function startDaemon() {
  const homeDir = await makeTestTempDir('codesurfd-file-refs-')
  const pidPath = join(homeDir, 'daemon', 'pid.json')
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: homeDir,
      CODESURF_HOME: homeDir,
      CODESURF_DAEMON_PID_PATH: pidPath,
      CODESURF_APP_VERSION: 'file-reference-test',
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

test('expandFileReferences expands workspace-relative @path tokens and strips absolute attachment paths for cloud prompts', async t => {
  const fixture = await makeWorkspaceFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const result = await expandFileReferences({
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'cloud',
    message: [
      'Please review @src/app.ts and the attached README.',
      '',
      'Attached file paths:',
      join(fixture.workspaceDir, 'README.md'),
    ].join('\n'),
  })

  assert.equal(result.changed, true)
  assert.equal(result.references.length, 2)
  assert.deepEqual(
    result.references.map(reference => ({
      source: reference.source,
      displayPath: reference.displayPath,
      truncated: reference.truncated,
    })),
    [
      { source: '@src/app.ts', displayPath: 'src/app.ts', truncated: false },
      { source: 'attachment', displayPath: 'README.md', truncated: false },
    ],
  )
  assert.match(result.message, /Please review @src\/app\.ts and the attached README\./)
  assert.match(result.message, /Referenced workspace files/i)
  assert.match(result.message, /src\/app\.ts/)
  assert.match(result.message, /README\.md/)
  assert.match(result.message, /export const value = 42/)
  assert.match(result.message, /# Workspace/)
  assert.doesNotMatch(result.message, /Attached file paths:/)
  assert.doesNotMatch(result.message, new RegExp(fixture.workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('expandFileReferences rejects symlink escapes outside the workspace root', async t => {
  const fixture = await makeWorkspaceFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await mkdir(join(fixture.workspaceDir, 'linked'), { recursive: true })
  await symlink(join(fixture.outsideDir, 'secret.txt'), join(fixture.workspaceDir, 'linked', 'secret.txt'))

  await assert.rejects(
    expandFileReferences({
      workspaceDir: fixture.workspaceDir,
      executionTarget: 'local',
      message: 'Read @linked/secret.txt',
    }),
    /outside the workspace root|symlink/i,
  )
})

test('daemon file-reference expansion route resolves workspaceId and returns cloud-safe display paths', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const projectDir = join(daemon.homeDir, 'project-file-refs')
  await mkdir(join(projectDir, 'src'), { recursive: true })
  await writeFile(join(projectDir, 'src', 'feature.ts'), 'export function feature() { return true }\n', 'utf8')

  const workspaceResponse = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'File Reference Workspace',
      projectPath: projectDir,
    },
  })
  assert.equal(workspaceResponse.status, 200)

  const response = await daemon.request('/file-references/expand', {
    body: {
      workspaceId: workspaceResponse.payload.id,
      executionTarget: 'cloud',
      message: 'Check @src/feature.ts',
    },
  })

  assert.equal(response.status, 200)
  assert.equal(response.payload.changed, true)
  assert.deepEqual(
    response.payload.references.map(reference => reference.displayPath),
    ['src/feature.ts'],
  )
  assert.match(response.payload.message, /src\/feature\.ts/)
  assert.match(response.payload.message, /feature\(\)/)
  assert.doesNotMatch(response.payload.message, new RegExp(projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
