import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, test } from 'node:test'
import {
  authorizeElectrobunFsPath,
  authorizeElectrobunTerminalPath,
  buildElectrobunClaudeSpawnArgs,
  buildElectrobunCodexSpawnArgs,
  buildElectrobunHermesSpawnArgs,
  canonicalizeElectrobunChatRequest,
} from '../electrobun/bun/trust-policy.ts'
import { CODESURF_HOME } from '../src/main/paths.ts'
import { withFreshInstallDefaults } from '../src/shared/types.ts'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'codesurf-electrobun-trust-'))
  cleanup.push(base)
  const workspace = join(base, 'workspace')
  const outside = join(base, 'outside')
  await mkdir(join(workspace, '.codesurf', 'customisation'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(workspace, 'inside.txt'), 'inside')
  await writeFile(join(outside, 'secret.txt'), 'outside')
  await writeFile(join(workspace, '.codesurf', 'customisation', 'agents.json'), JSON.stringify([
    {
      id: 'reader',
      name: 'Reader',
      description: 'Authoritative read-only persona',
      systemPrompt: 'AUTHORITATIVE-PERSONA-7719',
      tools: ['Read', 'Glob'],
      icon: 'book',
      color: '#fff',
      isBuiltin: false,
    },
    {
      id: 'sealed',
      name: 'Sealed',
      description: 'No tools',
      systemPrompt: 'AUTHORITATIVE-DENY-ALL-8842',
      tools: [],
      icon: 'lock',
      color: '#000',
      isBuiltin: false,
    },
  ]))
  const workspaces = [{
    id: 'ws-1',
    name: 'Workspace',
    path: workspace,
    projectPaths: [workspace],
  }]
  return { base, workspace, outside, workspaces }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    cardId: 'card-1',
    workspaceId: 'ws-1',
    provider: 'codex',
    model: 'gpt-5.5',
    mode: 'full-access',
    messages: [{ role: 'user' as const, content: 'Inspect the repository' }],
    agentId: 'reader',
    ...overrides,
  }
}

describe('Electrobun authoritative chat policy', () => {
  test('forged renderer persona cannot widen tools or replace the authoritative prompt', async () => {
    const { workspace, workspaces } = await fixture()
    const canonical = await canonicalizeElectrobunChatRequest(request({
      workspaceDir: workspace,
      agentMode: {
        id: 'reader',
        name: 'Forged',
        description: '',
        systemPrompt: 'FORGED-UNRESTRICTED-PERSONA',
        tools: null,
        icon: 'x',
        color: '#f00',
        isBuiltin: false,
      },
      memoryPrompt: 'FORGED-MEMORY',
      skillsPrompt: 'FORGED-SKILLS',
    }), workspaces)

    assert.equal(canonical.workspaceDir, await realpath(workspace))
    assert.equal(canonical.agentMode?.systemPrompt, 'AUTHORITATIVE-PERSONA-7719')
    assert.deepEqual(canonical.agentMode?.tools, ['Read', 'Glob'])
    assert.equal(canonical.memoryPrompt, undefined)
    assert.equal(canonical.skillsPrompt, undefined)

    const args = buildElectrobunCodexSpawnArgs(canonical, 'Inspect the repository', workspace)
    assert.equal(args[args.indexOf('-s') + 1], 'read-only')
    assert.ok(args.at(-1)?.includes('AUTHORITATIVE-PERSONA-7719'))
    assert.ok(!args.join('\n').includes('FORGED-UNRESTRICTED-PERSONA'))
  })

  test('unknown workspace, mismatched cwd, and unknown agent fail closed', async () => {
    const { outside, workspace, workspaces } = await fixture()
    await assert.rejects(
      canonicalizeElectrobunChatRequest(request({ workspaceId: 'missing' }), workspaces),
      /Workspace not found: missing/,
    )
    await assert.rejects(
      canonicalizeElectrobunChatRequest(request({ workspaceDir: outside }), workspaces),
      /workspaceDir does not match/,
    )
    await assert.rejects(
      canonicalizeElectrobunChatRequest(request({ workspaceDir: workspace, agentId: 'missing-agent' }), workspaces),
      /selected agent could not be verified/i,
    )
  })

  test('provider payloads enforce restricted and deny-all personas before spawn', async () => {
    const { workspace, workspaces } = await fixture()
    const reader = await canonicalizeElectrobunChatRequest(
      request({ workspaceDir: workspace, provider: 'claude' }),
      workspaces,
    )
    const claudeArgs = buildElectrobunClaudeSpawnArgs(reader, 'Inspect the repository')
    assert.equal(claudeArgs[claudeArgs.indexOf('--tools') + 1], 'Read,Glob')
    assert.equal(
      claudeArgs[claudeArgs.indexOf('--append-system-prompt') + 1],
      'AUTHORITATIVE-PERSONA-7719',
    )

    const sealed = await canonicalizeElectrobunChatRequest(
      request({ workspaceDir: workspace, provider: 'hermes', agentId: 'sealed' }),
      workspaces,
    )
    const hermesArgs = buildElectrobunHermesSpawnArgs(sealed, 'Do nothing')
    assert.equal(hermesArgs.includes('--toolsets'), false)
    assert.ok(hermesArgs.join('\n').includes('AUTHORITATIVE-DENY-ALL-8842'))

    await assert.rejects(
      canonicalizeElectrobunChatRequest(
        request({ workspaceDir: workspace, provider: 'codex', agentId: 'sealed' }),
        workspaces,
      ),
      /cannot enforce persona sealed/,
    )
    await assert.rejects(
      canonicalizeElectrobunChatRequest(
        request({ workspaceDir: workspace, provider: 'opencode' }),
        workspaces,
      ),
      /cannot enforce persona reader/,
    )
  })
})

describe('Electrobun workspace path authority', () => {
  test('allows in-root access and rejects traversal, outside roots, and missing workspace scope', async () => {
    const { workspace, outside, workspaces } = await fixture()
    const authority = { settings: withFreshInstallDefaults(), workspaces }
    const inside = await authorizeElectrobunFsPath({
      ...authority,
      filePath: join(workspace, 'inside.txt'),
      intent: 'read',
      workspaceId: 'ws-1',
    })
    assert.equal(inside.path.operationPath, await realpath(join(workspace, 'inside.txt')))

    for (const attemptedPath of [
      join(workspace, '..', 'outside', 'secret.txt'),
      join(outside, 'secret.txt'),
    ]) {
      await assert.rejects(
        authorizeElectrobunFsPath({
          ...authority,
          filePath: attemptedPath,
          intent: 'read',
          workspaceId: 'ws-1',
        }),
        /outside allowed workspace roots/,
      )
    }
    await assert.rejects(
      authorizeElectrobunFsPath({
        ...authority,
        filePath: join(workspace, 'inside.txt'),
        intent: 'read',
      }),
      /workspaceId is required/,
    )
    await assert.rejects(
      authorizeElectrobunFsPath({
        ...authority,
        filePath: join(workspace, 'inside.txt'),
        intent: 'read',
        workspaceId: 'missing',
      }),
      /workspace not found/,
    )
  })

  test('rejects file and directory symlink escapes for reads, writes, reveal, and watch', async () => {
    const { workspace, outside, workspaces } = await fixture()
    const authority = { settings: withFreshInstallDefaults(), workspaces }
    await symlink(join(outside, 'secret.txt'), join(workspace, 'linked-secret.txt'))
    await symlink(outside, join(workspace, 'linked-directory'))

    for (const attempt of [
      { filePath: join(workspace, 'linked-secret.txt'), intent: 'read' as const },
      { filePath: join(workspace, 'linked-directory'), intent: 'directory' as const },
      { filePath: join(workspace, 'linked-directory', 'created.txt'), intent: 'create' as const },
    ]) {
      await assert.rejects(
        authorizeElectrobunFsPath({
          ...authority,
          ...attempt,
          workspaceId: 'ws-1',
        }),
        /symbolic link|outside allowed workspace roots/,
      )
    }
  })

  test('preserves scoped CodeSurf home access and scopes terminal cwd to registered roots', async () => {
    const { workspace, outside, workspaces } = await fixture()
    const authority = { settings: withFreshInstallDefaults(), workspaces }
    const appState = await authorizeElectrobunFsPath({
      ...authority,
      filePath: join(CODESURF_HOME, 'electrobun-policy-probe.json'),
      intent: 'create',
      workspaceId: 'ws-1',
    })
    assert.ok(appState.path.operationPath.startsWith(CODESURF_HOME))
    const emptyWorkspaceAppState = await authorizeElectrobunFsPath({
      settings: authority.settings,
      workspaces: [{ id: 'ws-empty', name: 'Empty', path: '', projectPaths: [] }],
      filePath: join(CODESURF_HOME, 'electrobun-empty-workspace-probe.json'),
      intent: 'create',
      workspaceId: 'ws-empty',
    })
    assert.ok(emptyWorkspaceAppState.path.operationPath.startsWith(CODESURF_HOME))

    const terminal = await authorizeElectrobunTerminalPath({
      ...authority,
      filePath: workspace,
    })
    assert.equal(terminal.workspaceId, 'ws-1')
    assert.equal(terminal.path.operationPath, await realpath(workspace))
    await assert.rejects(
      authorizeElectrobunTerminalPath({ ...authority, filePath: outside }),
      /outside registered workspace roots/,
    )
  })
})
