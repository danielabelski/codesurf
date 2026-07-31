import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DAEMON_DIR = resolve(ROOT_DIR, 'packages/codesurf-daemon')
const DAEMON_LOCK_ENTRY = 'packages/codesurf-daemon'
const HARNESS_PREFIX = '@ai-sdk/harness'
const BLOCKED_PI_HARNESS = '@ai-sdk/harness-pi'
const CLAUDE_SDK = '@anthropic-ai/claude-agent-sdk'
const SECURITY_LOCK_RESOLUTIONS = {
  'node_modules/ws': '8.21.1',
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

test('root and daemon manifests retain one Node and dependency authority', async () => {
  const [rootPackage, rootLock, daemonPackage, daemonLock] = await Promise.all([
    readJson(resolve(ROOT_DIR, 'package.json')),
    readJson(resolve(ROOT_DIR, 'package-lock.json')),
    readJson(resolve(DAEMON_DIR, 'package.json')),
    readJson(resolve(DAEMON_DIR, 'package-lock.json')),
  ])

  assert.equal(rootPackage.engines?.node, '>=22')
  assert.deepEqual(rootLock.packages?.['']?.engines, rootPackage.engines)
  assert.equal(daemonPackage.engines?.node, '>=22')

  assert.deepEqual(
    daemonLock.packages?.['']?.dependencies,
    daemonPackage.dependencies,
    'the daemon lock root must exactly mirror the daemon manifest dependencies',
  )
  assert.deepEqual(daemonLock.packages?.['']?.engines, daemonPackage.engines)

  const embeddedDaemon = rootLock.packages?.[DAEMON_LOCK_ENTRY]
  assert.ok(embeddedDaemon, 'the root lock must embed the local daemon package')
  assert.deepEqual(
    embeddedDaemon.dependencies,
    daemonPackage.dependencies,
    'the root lock embedded daemon dependencies must exactly mirror its manifest',
  )
  assert.deepEqual(embeddedDaemon.engines, daemonPackage.engines)

  assert.equal(rootPackage.dependencies?.[CLAUDE_SDK], daemonPackage.dependencies?.[CLAUDE_SDK])
  assert.match(
    daemonPackage.dependencies?.[CLAUDE_SDK] ?? '',
    /^\d+\.\d+\.\d+$/,
    'the shared Claude SDK authority must be an exact version',
  )

  for (const [dependency, version] of Object.entries(daemonPackage.dependencies ?? {})) {
    if (!dependency.startsWith(HARNESS_PREFIX)) continue
    assert.match(version, /^\d+\.\d+\.\d+$/, `${dependency} must use an exact stable version`)
    assert.equal(
      daemonLock.packages?.[`node_modules/${dependency}`]?.version,
      version,
      `${dependency} lock resolution must match its exact manifest version`,
    )
  }

  assert.equal(daemonPackage.dependencies?.[BLOCKED_PI_HARNESS], undefined)
  assert.equal(daemonLock.packages?.[`node_modules/${BLOCKED_PI_HARNESS}`], undefined)
  assert.equal(rootLock.packages?.[`node_modules/${BLOCKED_PI_HARNESS}`], undefined)

  for (const [path, expectedVersion] of Object.entries(SECURITY_LOCK_RESOLUTIONS)) {
    assert.equal(daemonLock.packages?.[path]?.version, expectedVersion, `${path} must retain its fixed daemon resolution`)
    assert.equal(
      rootLock.packages?.[path]?.version,
      expectedVersion,
      `${path} must retain the same fixed root resolution`,
    )
  }
})
