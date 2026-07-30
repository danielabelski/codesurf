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

test('daemon SDK dependency pins and lock resolutions follow the root lock authority', async () => {
  const rootLock = await readJson(resolve(ROOT_DIR, 'package-lock.json'))
  const daemonPackage = await readJson(resolve(DAEMON_DIR, 'package.json'))
  const daemonLock = await readJson(resolve(DAEMON_DIR, 'package-lock.json'))

  for (const dependency of SDK_DEPENDENCIES) {
    const rootResolution = rootLock.packages?.[`node_modules/${dependency}`]?.version
    assert.ok(rootResolution, `${dependency} must have a root lock resolution`)
    assert.equal(
      daemonPackage.dependencies?.[dependency],
      rootResolution,
      `${dependency} daemon dependency must pin the root lock resolution`,
    )
    assert.equal(
      daemonLock.packages?.['']?.dependencies?.[dependency],
      daemonPackage.dependencies?.[dependency],
      `${dependency} nested lock spec must match the daemon package`,
    )
    assert.equal(
      daemonLock.packages?.[`node_modules/${dependency}`]?.version,
      rootLock.packages?.[`node_modules/${dependency}`]?.version,
      `${dependency} nested resolution must match the root lock`,
    )
  }
})
