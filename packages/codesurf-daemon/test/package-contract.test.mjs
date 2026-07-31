import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const DAEMON_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT_DIR = resolve(DAEMON_DIR, '../..')
const SDK_DEPENDENCIES = [
  '@anthropic-ai/claude-agent-sdk',
  '@openai/codex-sdk',
]

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function readJsonIfPresent(path) {
  try {
    return await readJson(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

test('daemon declares the Node 22 runtime floor required by its harness dependencies', async () => {
  const daemonPackage = await readJson(resolve(DAEMON_DIR, 'package.json'))
  const daemonLock = await readJson(resolve(DAEMON_DIR, 'package-lock.json'))

  assert.equal(daemonPackage.engines?.node, '>=22')
  assert.equal(daemonLock.packages?.['']?.engines?.node, daemonPackage.engines.node)

  for (const dependency of Object.keys(daemonPackage.dependencies).filter(name => name.startsWith('@ai-sdk/harness'))) {
    assert.match(
      daemonLock.packages?.[`node_modules/${dependency}`]?.engines?.node ?? '',
      /^>=22(?:\D|$)/,
      `${dependency} must retain its Node 22 floor`,
    )
  }
})

test('daemon dependency pins retain standalone self-authority and SDKs match the monorepo root when present', async () => {
  const rootLock = await readJsonIfPresent(resolve(ROOT_DIR, 'package-lock.json'))
  const daemonPackage = await readJson(resolve(DAEMON_DIR, 'package.json'))
  const daemonLock = await readJson(resolve(DAEMON_DIR, 'package-lock.json'))

  assert.deepEqual(
    daemonLock.packages?.['']?.dependencies,
    daemonPackage.dependencies,
    'the nested lock root must exactly mirror the standalone daemon manifest',
  )

  for (const [dependency, manifestVersion] of Object.entries(daemonPackage.dependencies ?? {})) {
    assert.match(manifestVersion ?? '', /^\d+\.\d+\.\d+$/, `${dependency} must be pinned exactly`)
    assert.equal(
      daemonLock.packages?.['']?.dependencies?.[dependency],
      manifestVersion,
      `${dependency} nested lock spec must match the daemon package`,
    )
    assert.equal(
      daemonLock.packages?.[`node_modules/${dependency}`]?.version,
      manifestVersion,
      `${dependency} nested resolution must match the standalone manifest`,
    )
  }

  for (const dependency of SDK_DEPENDENCIES) {
    const manifestVersion = daemonPackage.dependencies?.[dependency]
    if (!rootLock) continue
    const rootResolution = rootLock.packages?.[`node_modules/${dependency}`]?.version
    assert.ok(rootResolution, `${dependency} must have a root lock resolution`)
    assert.equal(
      manifestVersion,
      rootResolution,
      `${dependency} daemon dependency must pin the monorepo root resolution`,
    )
    assert.equal(
      daemonLock.packages?.[`node_modules/${dependency}`]?.version,
      rootResolution,
      `${dependency} nested resolution must match the root lock`,
    )
  }
})
