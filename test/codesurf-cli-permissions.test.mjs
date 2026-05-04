import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT_DIR = process.cwd()
const CLI = join(ROOT_DIR, 'bin', 'codesurf.cjs')

async function runCodesurf(args, options) {
  const result = await execFileAsync(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      HOME: options.homeDir,
      CODESURF_HOME: join(options.homeDir, '.codesurf'),
    },
    encoding: 'utf8',
  })
  return result.stdout.trim()
}

test('codesurf permissions CLI writes the same persisted grant shape used by chat', async t => {
  const homeDir = await mkdtemp(join(ROOT_DIR, '.tmp', 'codesurf-cli-permissions-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const allowOutput = await runCodesurf([
    'permissions',
    'allow',
    'claude',
    'Write',
    '--scope',
    'today',
    '--json',
  ], { homeDir, cwd: workspaceDir })
  const allowResult = JSON.parse(allowOutput)

  assert.equal(allowResult.grant.provider, 'claude')
  assert.equal(allowResult.grant.toolName, 'Write')
  assert.equal(allowResult.grant.action, 'allow')
  assert.equal(allowResult.grant.scope, 'today')
  assert.equal(allowResult.grant.workspaceDir, resolve(workspaceDir))
  assert.match(allowResult.grant.expiresAt, /^\d{4}-\d{2}-\d{2}T/)

  const denyOutput = await runCodesurf([
    'permissions',
    'deny',
    'claude',
    'Write',
    '--json',
  ], { homeDir, cwd: workspaceDir })
  const denyResult = JSON.parse(denyOutput)

  assert.equal(denyResult.grants.length, 1)
  assert.equal(denyResult.grant.action, 'deny')
  assert.equal(denyResult.grant.scope, 'never')
  assert.equal(denyResult.grant.workspaceDir, resolve(workspaceDir))

  const store = JSON.parse(await readFile(join(homeDir, '.codesurf', 'permissions.json'), 'utf8'))
  assert.equal(store.version, 1)
  assert.deepEqual(store.grants, denyResult.grants)

  const listOutput = await runCodesurf(['permissions', 'list', '--json'], { homeDir, cwd: workspaceDir })
  const listResult = JSON.parse(listOutput)
  assert.equal(listResult.path, join(homeDir, '.codesurf', 'permissions.json'))
  assert.equal(listResult.grants[0].id, denyResult.grant.id)

  await runCodesurf(['permissions', 'clear', denyResult.grant.id], { homeDir, cwd: workspaceDir })
  const cleared = JSON.parse(await runCodesurf(['permissions', 'list', '--json'], { homeDir, cwd: workspaceDir }))
  assert.deepEqual(cleared.grants, [])
})

test('codesurf permissions CLI can write global grants for all workspaces', async t => {
  const homeDir = await mkdtemp(join(ROOT_DIR, '.tmp', 'codesurf-cli-permissions-global-'))
  const workspaceDir = join(homeDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })
  t.after(async () => {
    await rm(homeDir, { recursive: true, force: true })
  })

  const output = await runCodesurf([
    'permissions',
    'allow',
    'claude',
    'Write',
    '--global',
    '--json',
  ], { homeDir, cwd: workspaceDir })
  const result = JSON.parse(output)

  assert.equal(result.grant.provider, 'claude')
  assert.equal(result.grant.toolName, 'Write')
  assert.equal(result.grant.action, 'allow')
  assert.equal(result.grant.scope, 'forever')
  assert.equal(result.grant.workspaceDir, null)

  const store = JSON.parse(await readFile(join(homeDir, '.codesurf', 'permissions.json'), 'utf8'))
  assert.deepEqual(store.grants, result.grants)
  assert.equal(store.grants[0].workspaceDir, null)
})
