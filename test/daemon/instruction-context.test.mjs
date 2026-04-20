import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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
