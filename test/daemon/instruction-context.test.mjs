import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildInstructionPrompt, loadInstructionContext } from '../../bin/instruction-context.mjs'

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-instruction-context-'))
  const homeDir = join(root, 'home')
  const workspaceDir = join(root, 'workspace')
  await mkdir(join(homeDir, '.codesurf'), { recursive: true })
  await mkdir(join(workspaceDir, '.codesurf'), { recursive: true })
  return { root, homeDir, workspaceDir }
}

test('daemon local execution loads layered user and workspace instruction files in precedence order', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await writeFile(join(fixture.homeDir, '.codesurf', 'AGENTS.md'), 'User instruction layer', 'utf8')
  await writeFile(join(fixture.workspaceDir, 'AGENTS.md'), 'Workspace instruction layer', 'utf8')
  await writeFile(join(fixture.workspaceDir, '.codesurf', 'AGENTS.md'), 'Workspace local instruction layer', 'utf8')

  const context = await loadInstructionContext({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })

  assert.deepEqual(
    context.sections.map(section => ({ scope: section.scope, displayPath: section.displayPath, content: section.content })),
    [
      { scope: 'user', displayPath: '~/.codesurf/AGENTS.md', content: 'User instruction layer' },
      { scope: 'workspace', displayPath: 'AGENTS.md', content: 'Workspace instruction layer' },
      { scope: 'workspace-local', displayPath: '.codesurf/AGENTS.md', content: 'Workspace local instruction layer' },
    ],
  )

  const prompt = buildInstructionPrompt(context)
  assert.match(prompt, /User instruction layer[\s\S]*Workspace instruction layer[\s\S]*Workspace local instruction layer/)
  assert.match(prompt, /later sections override earlier ones/i)
})

test('daemon cloud execution excludes host home instructions but keeps workspace instructions', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await writeFile(join(fixture.homeDir, '.codesurf', 'AGENTS.md'), 'User instruction layer', 'utf8')
  await writeFile(join(fixture.workspaceDir, 'AGENTS.md'), 'Workspace instruction layer', 'utf8')

  const context = await loadInstructionContext({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'cloud',
  })

  assert.deepEqual(
    context.sections.map(section => ({ scope: section.scope, displayPath: section.displayPath, content: section.content })),
    [
      { scope: 'workspace', displayPath: 'AGENTS.md', content: 'Workspace instruction layer' },
    ],
  )

  const prompt = buildInstructionPrompt(context)
  assert.match(prompt, /Workspace instruction layer/)
  assert.doesNotMatch(prompt, /User instruction layer/)
})

test('instruction prompt is omitted when no non-empty instruction files exist', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await writeFile(join(fixture.workspaceDir, 'AGENTS.md'), '   \n\n', 'utf8')

  const context = await loadInstructionContext({
    homeDir: fixture.homeDir,
    workspaceDir: fixture.workspaceDir,
    executionTarget: 'local',
  })

  assert.deepEqual(context.sections, [])
  assert.equal(buildInstructionPrompt(context), undefined)
})

test('workspace instruction files must not follow symlinks outside the workspace root', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const escapedPath = join(fixture.root, 'escaped-secret.txt')
  await writeFile(escapedPath, 'Do not leak this file', 'utf8')
  await symlink(escapedPath, join(fixture.workspaceDir, 'AGENTS.md'))

  await assert.rejects(
    loadInstructionContext({
      homeDir: fixture.homeDir,
      workspaceDir: fixture.workspaceDir,
      executionTarget: 'local',
    }),
    /outside the workspace root|symlink/i,
  )
})

test('workspace instruction files must not escape through symlinked parent directories', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const escapedDir = join(fixture.root, 'escaped-dir')
  await mkdir(escapedDir, { recursive: true })
  await writeFile(join(escapedDir, 'AGENTS.md'), 'Leaked through parent symlink', 'utf8')
  await rm(join(fixture.workspaceDir, '.codesurf'), { recursive: true, force: true })
  await symlink(escapedDir, join(fixture.workspaceDir, '.codesurf'))

  await assert.rejects(
    loadInstructionContext({
      homeDir: fixture.homeDir,
      workspaceDir: fixture.workspaceDir,
      executionTarget: 'local',
    }),
    /outside the workspace root|symlink/i,
  )
})

test('unexpected instruction file read errors are surfaced instead of silently ignored', async t => {
  const fixture = await makeFixture()
  t.after(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  await mkdir(join(fixture.workspaceDir, '.codesurf', 'AGENTS.md'), { recursive: true })

  await assert.rejects(
    loadInstructionContext({
      homeDir: fixture.homeDir,
      workspaceDir: fixture.workspaceDir,
      executionTarget: 'local',
    }),
    /AGENTS\.md|EISDIR/i,
  )
})
