import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expandFileReferences } from '../../bin/file-references.mjs'
import { spawnDaemon } from './helpers/spawn-daemon.mjs'

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
  return await spawnDaemon({
    homePrefix: 'codesurfd-file-refs-',
    appVersion: 'file-reference-test',
  })
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

test('expandFileReferences ignores stale attachment paths without failing the turn', async t => {
  const fixture = await makeWorkspaceFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const missingAttachment = join(fixture.root, 'TemporaryItems', 'missing-screenshot.png')
  const result = await expandFileReferences({
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
    message: [
      'Please answer normally.',
      '',
      'Attached file paths:',
      missingAttachment,
    ].join('\n'),
  })

  assert.equal(result.changed, true)
  assert.deepEqual(result.references, [])
  assert.equal(result.message, 'Please answer normally.')
  assert.doesNotMatch(result.message, /Attached file paths:/)
  assert.doesNotMatch(result.message, /missing-screenshot\.png/)
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

test('expandFileReferences leaves npm-style @mentions as literal text instead of erroring', async () => {
  const fixture = await makeWorkspaceFixture()
  try {
    const message = 'install @ai-sdk/harness@canary and @scope/pkg then read @src/app.ts'
    // The regression: this used to throw "File reference ... was not found in the workspace".
    const result = await expandFileReferences({ workspaceDir: fixture.workspaceDir, message })
    // npm specs survive as literal text...
    assert.match(result.message, /@ai-sdk\/harness@canary/)
    assert.match(result.message, /@scope\/pkg/)
    // ...and are not treated as references...
    assert.equal(result.references.some(r => String(r.source).includes('ai-sdk') || String(r.source).includes('scope/pkg')), false)
    // ...while a real workspace file is still expanded.
    assert.ok(result.references.some(r => String(r.displayPath).includes('app.ts')))
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('expandFileReferences does not throw on a bare unresolved @mention', async () => {
  const fixture = await makeWorkspaceFixture()
  try {
    const result = await expandFileReferences({
      workspaceDir: fixture.workspaceDir,
      message: 'ping @octocat/hello-world about the build',
    })
    assert.match(result.message, /@octocat\/hello-world/)
    assert.equal(result.references.length, 0)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})
