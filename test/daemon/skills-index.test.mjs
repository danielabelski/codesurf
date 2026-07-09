import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { chmodSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSkillSelectionPrompt, createSkillsIndex } from '../../bin/skills-index.mjs'

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

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function makeTestTempDir(prefix) {
  await mkdir(TEST_TMP_ROOT, { recursive: true })
  return await mkdtemp(join(TEST_TMP_ROOT, prefix))
}

function execPython(script, args, input = '') {
  const bins = ['python3', 'python']
  let lastError = null
  for (const bin of bins) {
    try {
      execFileSync(bin, ['-c', script, ...args], {
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('No python interpreter available')
}

function createSkillArchive(zipPath, topFolder, skillMd) {
  execPython(
    [
      'import sys, zipfile',
      'zip_path = sys.argv[1]',
      'top_folder = sys.argv[2]',
      'skill_md = sys.stdin.read()',
      'with zipfile.ZipFile(zip_path, "w") as zf:',
      '    zf.writestr(f"{top_folder}/SKILL.md", skill_md)',
      '    zf.writestr(f"{top_folder}/notes.txt", "archive note\\n")',
    ].join('\n'),
    [zipPath, topFolder],
    skillMd,
  )
}

async function startDaemon() {
  const homeDir = await makeTestTempDir('codesurfd-skills-index-')
  const pidPath = join(homeDir, 'daemon', 'pid.json')
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOME: homeDir,
      CODESURF_HOME: homeDir,
      CODESURF_DAEMON_PID_PATH: pidPath,
      CODESURF_APP_VERSION: 'skills-index-test',
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

test('buildSkillSelectionPrompt summarizes selected workspace, global, and command entries', () => {
  const result = buildSkillSelectionPrompt({
    skills: [
      {
        id: 'workspace:lint-fix',
        name: 'lint-fix',
        description: 'Fix lint failures before commit.',
        scope: 'workspace',
        kind: 'skill',
        displayPath: '.codesurf/skills/lint-fix/SKILL.md',
      },
      {
        id: 'global:release-notes',
        name: 'release-notes',
        description: 'Write concise release notes.',
        scope: 'global',
        kind: 'skill',
        displayPath: '~/.codesurf/skills/release-notes/SKILL.md',
      },
      {
        id: 'command:/compact',
        name: '/compact',
        description: 'Compact conversation.',
        scope: 'command',
        kind: 'command',
        displayPath: 'builtin:/compact',
      },
    ],
    selection: {
      enabledIds: ['workspace:lint-fix', 'command:/compact', 'missing-skill', 'global:release-notes'],
      disabledIds: [],
    },
  })

  assert.deepEqual(result.unresolvedIds, ['missing-skill'])
  assert.equal(result.summary, 'Included 3 skills: lint-fix, /compact, release-notes')
  assert.match(result.prompt, /^## Included Skills/m)
  assert.match(result.prompt, /@lint-fix \[workspace\] — Fix lint failures before commit\./)
  assert.match(result.prompt, /@\/compact \[command\] — Compact conversation\./)
  assert.match(result.prompt, /@release-notes \[global\] — Write concise release notes\./)
})

test('daemon skills list/get/install merge global and workspace roots with inspectable selection summaries', async t => {
  const daemon = await startDaemon()
  t.after(async () => {
    await daemon.stop()
  })

  const workspaceDir = join(daemon.homeDir, 'project-skills')
  const globalSkillDir = join(daemon.homeDir, 'skills', 'global-helper')
  const workspaceSkillDir = join(workspaceDir, '.codesurf', 'skills', 'workspace-helper')
  const compatCommandDir = join(workspaceDir, '.claude', 'commands')
  const customSkillsFile = join(workspaceDir, '.codesurf', 'customisation', 'skills.json')
  const tileSkillsFile = join(workspaceDir, '.codesurf', 'chat-skills', 'skills.json')

  const globalSkillMdPath = join(globalSkillDir, 'SKILL.md')
  const workspaceSkillMdPath = join(workspaceSkillDir, 'SKILL.md')
  const compatCommandPath = join(compatCommandDir, 'review.md')

  const globalSkillMd = [
    '---',
    'name: Global Helper',
    'description: Shared repo helper.',
    '---',
    'Use this for shared checks.',
    '',
  ].join('\n')
  const workspaceSkillMd = [
    '---',
    'name: Workspace Helper',
    'description: Workspace-specific workflow.',
    '---',
    'Use this for workspace-only steps.',
    '',
  ].join('\n')
  const compatCommandMd = [
    '---',
    'name: review',
    'description: Review the current branch.',
    '---',
    'Run a branch review checklist.',
    '',
  ].join('\n')

  await mkdir(globalSkillDir, { recursive: true })
  await mkdir(workspaceSkillDir, { recursive: true })
  await mkdir(compatCommandDir, { recursive: true })
  await writeFile(globalSkillMdPath, globalSkillMd, 'utf8')
  await writeFile(workspaceSkillMdPath, workspaceSkillMd, 'utf8')
  await writeFile(compatCommandPath, compatCommandMd, 'utf8')
  await writeJson(customSkillsFile, [
    {
      id: 'custom:workspace-playbook',
      name: 'Workspace Playbook',
      description: 'Saved workspace playbook.',
      content: 'Document local release steps.',
    },
  ])
  await writeJson(tileSkillsFile, {
    enabled: [
      `discovered-${globalSkillMdPath}`,
      `discovered-${workspaceSkillMdPath}`,
      `discovered-${compatCommandPath}`,
      'custom:workspace-playbook',
      'command:/compact',
    ],
    disabled: ['command:/help'],
  })

  let response = await daemon.request('/workspace/create-with-path', {
    body: {
      name: 'Skill Workspace',
      projectPath: workspaceDir,
    },
  })
  assert.equal(response.status, 200)
  const workspaceId = response.payload.id

  response = await daemon.request(`/skills/list?workspaceId=${encodeURIComponent(workspaceId)}&cardId=chat-skills`)
  assert.equal(response.status, 200)
  assert.ok(Array.isArray(response.payload.roots))
  assert.ok(Array.isArray(response.payload.skills))
  assert.ok(response.payload.roots.some(root => root.path === join(daemon.homeDir, 'skills') && root.scope === 'global'))
  assert.ok(response.payload.roots.some(root => root.path === join(workspaceDir, '.codesurf', 'skills') && root.scope === 'workspace'))
  assert.ok(response.payload.roots.some(root => root.path === join(workspaceDir, '.claude', 'commands') && root.kind === 'claude-commands'))
  assert.ok(response.payload.skills.every(skill => !Object.prototype.hasOwnProperty.call(skill, 'content')))
  assert.ok(response.payload.skills.some(skill => skill.name === 'Global Helper'))
  assert.ok(response.payload.skills.some(skill => skill.name === 'Workspace Helper'))
  assert.ok(response.payload.skills.some(skill => skill.name === 'Workspace Playbook'))
  assert.ok(response.payload.skills.some(skill => skill.id === 'command:/compact'))
  assert.equal(response.payload.selection.summary, 'Included 5 skills: Global Helper, Workspace Helper, review, Workspace Playbook +1 more')
  assert.match(response.payload.selection.prompt, /## Included Skills/)
  assert.match(response.payload.selection.prompt, /@Global Helper \[global\] — Shared repo helper\./)
  assert.match(response.payload.selection.prompt, /@Workspace Helper \[workspace\] — Workspace-specific workflow\./)
  assert.match(response.payload.selection.prompt, /@review \[workspace\] — Review the current branch\./)
  assert.match(response.payload.selection.prompt, /@Workspace Playbook \[workspace\] — Saved workspace playbook\./)
  assert.match(response.payload.selection.prompt, /@\/compact \[command\] — Compact conversation/)

  response = await daemon.request(`/skills/get?workspaceId=${encodeURIComponent(workspaceId)}&skillId=${encodeURIComponent(`discovered-${workspaceSkillMdPath}`)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.name, 'Workspace Helper')
  assert.equal(response.payload.content, workspaceSkillMd)
  assert.equal(response.payload.scope, 'workspace')

  const archivePath = join(daemon.homeDir, 'archive-helper.skill')
  const archiveSkillMd = [
    '---',
    'name: Archive Helper',
    'description: Installed from archive.',
    '---',
    'Use this after install.',
    '',
  ].join('\n')
  createSkillArchive(archivePath, 'archive-helper', archiveSkillMd)

  response = await daemon.request('/skills/install', {
    body: {
      workspaceId,
      scope: 'workspace',
      zipPath: archivePath,
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.payload.ok, true)
  assert.equal(response.payload.skill.name, 'Archive Helper')
  assert.equal(response.payload.installedPath, join(workspaceDir, '.codesurf', 'skills', 'archive-helper'))

  response = await daemon.request(`/skills/get?workspaceId=${encodeURIComponent(workspaceId)}&skillId=${encodeURIComponent(`discovered-${join(workspaceDir, '.codesurf', 'skills', 'archive-helper', 'SKILL.md')}`)}`)
  assert.equal(response.status, 200)
  assert.equal(response.payload.content, archiveSkillMd)
})

test('listSkills skips unreadable custom skill directories without failing', async () => {
  const homeDir = await makeTestTempDir('skills-index-unreadable-')
  const workspaceDir = join(homeDir, 'project')
  const blockedDir = join(workspaceDir, 'codesurf', 'skills')
  const goodSkillDir = join(workspaceDir, '.codesurf', 'skills', 'good-skill')
  const locationsFile = join(workspaceDir, '.codesurf', 'customisation', 'locations-skills.json')

  await mkdir(blockedDir, { recursive: true })
  await writeFile(join(blockedDir, 'SKILL.md'), '---\nname: Blocked Skill\ndescription: hidden\n---\n', 'utf8')
  await mkdir(goodSkillDir, { recursive: true })
  await writeFile(join(goodSkillDir, 'SKILL.md'), '---\nname: Good Skill\ndescription: Works\n---\n', 'utf8')
  await writeJson(locationsFile, '$WORKSPACE/codesurf/skills')

  try {
    chmodSync(blockedDir, 0o000)
  } catch {
    // Some platforms disallow chmod 000; ENOTDIR coverage below still guards scan failures.
  }

  const index = createSkillsIndex({ homeDir, userHomeDir: homeDir })
  const result = await index.listSkills({ workspaceDir })

  assert.ok(result.skills.some(skill => skill.name === 'Good Skill'))
  assert.ok(result.skills.some(skill => skill.name === '/compact'))
  if (result.skippedLocations.length > 0) {
    assert.ok(result.skippedLocations.some(entry => entry.path.includes('codesurf/skills')))
  }
})

test('listSkills treats a skill location file path as unreadable and continues', async () => {
  const homeDir = await makeTestTempDir('skills-index-enotdir-')
  const workspaceDir = join(homeDir, 'project')
  const blockedFile = join(workspaceDir, 'codesurf', 'skills')
  const locationsFile = join(workspaceDir, '.codesurf', 'customisation', 'locations-skills.json')

  await mkdir(join(workspaceDir, 'codesurf'), { recursive: true })
  await writeFile(blockedFile, 'not a directory\n', 'utf8')
  await writeJson(locationsFile, '$WORKSPACE/codesurf/skills')

  const index = createSkillsIndex({ homeDir, userHomeDir: homeDir })
  const result = await index.listSkills({ workspaceDir })

  assert.ok(Array.isArray(result.skills))
  assert.equal(result.skippedLocations.length, 1)
  assert.equal(result.skippedLocations[0]?.code, 'ENOTDIR')
  assert.ok(result.skills.some(skill => skill.name === '/compact'))
})
