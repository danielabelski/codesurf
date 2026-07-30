import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, test } from 'node:test'
import {
  assertPathAllowedForFs,
  isPathUnderRoot,
  validateCanonicalFsPath,
  validateFsPath,
} from '../src/main/ipc/fs.ts'
import { CODESURF_HOME } from '../src/main/paths.ts'

// `validateFsPath`'s `resolveHome()` falls back to `process.env.HOME` /
// `os.homedir()` outside of Electron, which is the case here.
const HOME = process.env.HOME || process.env.USERPROFILE || homedir()

async function createFsFixture(): Promise<{
  root: string
  workspace: string
  outside: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'codesurf-fs-scope-'))
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  await Promise.all([
    mkdir(workspace),
    mkdir(outside),
  ])
  return { root, workspace, outside }
}

const scopedTo = (workspace: string) => ({
  restrictToWorkspaceRoots: true,
  allowedRoots: [workspace],
})

describe('isPathUnderRoot', () => {
  test('matches exact root path', () => {
    assert.equal(isPathUnderRoot('/tmp/workspace', '/tmp/workspace'), true)
  })

  test('matches nested file under root', () => {
    assert.equal(isPathUnderRoot('/tmp/workspace/src/app.ts', '/tmp/workspace'), true)
  })

  test('rejects sibling paths that share a prefix', () => {
    assert.equal(isPathUnderRoot('/tmp/workspace-other/file.ts', '/tmp/workspace'), false)
  })

  test('rejects paths outside root', () => {
    assert.equal(isPathUnderRoot('/etc/passwd', '/tmp/workspace'), false)
  })
})

describe('validateCanonicalFsPath operation-aware authorization', () => {
  test('allows read, write, and create below a real workspace root', async () => {
    const fixture = await createFsFixture()
    try {
      const filePath = join(fixture.workspace, 'allowed.txt')
      await writeFile(filePath, 'before', 'utf8')

      const readPath = await validateCanonicalFsPath(filePath, 'read', scopedTo(fixture.workspace))
      assert.equal(await readFile(readPath, 'utf8'), 'before')

      const writePath = await validateCanonicalFsPath(filePath, 'write', scopedTo(fixture.workspace))
      await writeFile(writePath, 'after', 'utf8')
      assert.equal(await readFile(filePath, 'utf8'), 'after')

      const newFilePath = join(fixture.workspace, 'created.txt')
      const createPath = await validateCanonicalFsPath(
        newFilePath,
        'create',
        scopedTo(fixture.workspace),
      )
      await writeFile(createPath, 'created', 'utf8')
      assert.equal(await readFile(newFilePath, 'utf8'), 'created')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects an external-file symlink for read, write, stat, and reveal intents', async () => {
    const fixture = await createFsFixture()
    try {
      const externalFile = join(fixture.outside, 'secret.txt')
      const linkedFile = join(fixture.workspace, 'linked-secret.txt')
      await writeFile(externalFile, 'secret', 'utf8')
      await symlink(externalFile, linkedFile)

      for (const intent of ['read', 'write'] as const) {
        await assert.rejects(
          validateCanonicalFsPath(linkedFile, intent, scopedTo(fixture.workspace)),
          /outside allowed workspace roots|symbolic link/,
        )
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects a final file symlink even when its target stays in the workspace', async () => {
    const fixture = await createFsFixture()
    try {
      const targetFile = join(fixture.workspace, 'target.txt')
      const linkedFile = join(fixture.workspace, 'linked.txt')
      await writeFile(targetFile, 'inside', 'utf8')
      await symlink(targetFile, linkedFile)

      for (const intent of ['read', 'write'] as const) {
        await assert.rejects(
          validateCanonicalFsPath(linkedFile, intent, scopedTo(fixture.workspace)),
          /symbolic link/,
        )
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects an external-directory symlink for list, create, delete, and copy destination intents', async () => {
    const fixture = await createFsFixture()
    try {
      const linkedDirectory = join(fixture.workspace, 'linked-directory')
      await symlink(fixture.outside, linkedDirectory)

      await assert.rejects(
        validateCanonicalFsPath(linkedDirectory, 'directory', scopedTo(fixture.workspace)),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        validateCanonicalFsPath(
          join(linkedDirectory, 'created.txt'),
          'create',
          scopedTo(fixture.workspace),
        ),
        /outside allowed workspace roots/,
      )
      await assert.rejects(
        validateCanonicalFsPath(linkedDirectory, 'write', scopedTo(fixture.workspace)),
        /outside allowed workspace roots|symbolic link/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects a final directory symlink even when its target stays in the workspace', async () => {
    const fixture = await createFsFixture()
    try {
      const targetDirectory = join(fixture.workspace, 'target-directory')
      const linkedDirectory = join(fixture.workspace, 'linked-directory')
      await mkdir(targetDirectory)
      await symlink(targetDirectory, linkedDirectory)

      for (const intent of ['directory', 'write'] as const) {
        await assert.rejects(
          validateCanonicalFsPath(linkedDirectory, intent, scopedTo(fixture.workspace)),
          /symbolic link/,
        )
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects a symlink to a sensitive home path with workspace scoping disabled', {
    concurrency: false,
  }, async () => {
    const fixture = await createFsFixture()
    const originalHome = process.env.HOME
    try {
      const fakeHome = join(fixture.root, 'home')
      const sshDir = join(fakeHome, '.ssh')
      await mkdir(sshDir, { recursive: true })
      const secretPath = join(sshDir, 'id_test')
      await writeFile(secretPath, 'secret', 'utf8')
      const linkedSecret = join(fixture.workspace, 'linked-sensitive')
      await symlink(secretPath, linkedSecret)
      process.env.HOME = fakeHome

      await assert.rejects(
        validateCanonicalFsPath(linkedSecret, 'read'),
        /sensitive directory/,
      )
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects a missing target below a symlinked parent', async () => {
    const fixture = await createFsFixture()
    try {
      const linkedDirectory = join(fixture.workspace, 'linked-parent')
      await symlink(fixture.outside, linkedDirectory)

      await assert.rejects(
        validateCanonicalFsPath(
          join(linkedDirectory, 'new.txt'),
          'create',
          scopedTo(fixture.workspace),
        ),
        /outside allowed workspace roots/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('canonicalizes a configured workspace root that is itself a symlink', async () => {
    const fixture = await createFsFixture()
    try {
      const configuredRoot = join(fixture.root, 'configured-root')
      const filePath = join(configuredRoot, 'inside.txt')
      await writeFile(join(fixture.workspace, 'inside.txt'), 'inside', 'utf8')
      await symlink(fixture.workspace, configuredRoot)

      const canonical = await validateCanonicalFsPath(filePath, 'read', scopedTo(configuredRoot))
      assert.equal(canonical, await realpath(join(fixture.workspace, 'inside.txt')))

      const canonicalRoot = await validateCanonicalFsPath(
        configuredRoot,
        'directory',
        scopedTo(configuredRoot),
      )
      assert.equal(canonicalRoot, await realpath(fixture.workspace))
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('validates rename and copy endpoints independently', async () => {
    const fixture = await createFsFixture()
    try {
      const externalFile = join(fixture.outside, 'source.txt')
      const escapedSource = join(fixture.workspace, 'escaped-source.txt')
      const escapedDestination = join(fixture.workspace, 'escaped-destination')
      await writeFile(externalFile, 'outside', 'utf8')
      await symlink(externalFile, escapedSource)
      await symlink(fixture.outside, escapedDestination)

      await assert.rejects(
        validateCanonicalFsPath(escapedSource, 'read', scopedTo(fixture.workspace)),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        validateCanonicalFsPath(
          join(escapedDestination, 'copied.txt'),
          'create',
          scopedTo(fixture.workspace),
        ),
        /outside allowed workspace roots/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('keeps the OpenCode carve-out read-only', {
    concurrency: false,
  }, async () => {
    const fixture = await createFsFixture()
    const originalHome = process.env.HOME
    try {
      const fakeHome = join(fixture.root, 'home')
      const skillPath = join(fakeHome, '.config', 'opencode', 'skills', 'skill.md')
      await mkdir(dirname(skillPath), { recursive: true })
      await writeFile(skillPath, 'skill', 'utf8')
      process.env.HOME = fakeHome

      const readPath = await validateCanonicalFsPath(skillPath, 'read', {
        restrictToWorkspaceRoots: true,
        allowedRoots: [],
        allowReadOnlyOpenCodeConfig: true,
      })
      assert.equal(await readFile(readPath, 'utf8'), 'skill')

      await assert.rejects(
        validateCanonicalFsPath(skillPath, 'write', {
          restrictToWorkspaceRoots: true,
          allowedRoots: [],
          allowReadOnlyOpenCodeConfig: true,
        }),
        /sensitive directory/,
      )
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('keeps CODESURF_HOME available with no workspace roots', async () => {
    const statePath = join(
      CODESURF_HOME,
      `plan-013-${process.pid}`,
      'state.json',
    )
    const canonical = await validateCanonicalFsPath(statePath, 'create', {
      restrictToWorkspaceRoots: true,
      allowedRoots: [],
    })

    const canonicalCodesurfHome = await realpath(CODESURF_HOME).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return join(await realpath(dirname(CODESURF_HOME)), basename(CODESURF_HOME))
    })
    assert.equal(
      canonical,
      join(canonicalCodesurfHome, `plan-013-${process.pid}`, 'state.json'),
    )
  })
})

describe('assertPathAllowedForFs', () => {
  test('no-op when workspace scoping is disabled', () => {
    assert.doesNotThrow(() => assertPathAllowedForFs('/etc/passwd'))
    assert.doesNotThrow(() => assertPathAllowedForFs('/etc/passwd', { restrictToWorkspaceRoots: false }))
  })

  test('allows paths under configured workspace roots', () => {
    assert.doesNotThrow(() => assertPathAllowedForFs('/tmp/workspace/src/foo.ts', {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    }))
  })

  test('allows CODESURF_HOME when scoping is enabled', () => {
    assert.doesNotThrow(() => assertPathAllowedForFs(join(CODESURF_HOME, 'settings.json'), {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    }))
  })

  test('denies paths outside workspace roots when scoping is enabled', () => {
    assert.throws(
      () => assertPathAllowedForFs('/etc/passwd', {
        restrictToWorkspaceRoots: true,
        allowedRoots: ['/tmp/workspace'],
      }),
      /outside allowed workspace roots/,
    )
  })

  test('denies all non-CODESURF_HOME paths when no roots are configured', () => {
    assert.throws(
      () => assertPathAllowedForFs('/tmp/workspace/file.ts', {
        restrictToWorkspaceRoots: true,
        allowedRoots: [],
      }),
      /no workspace project folders configured/i,
    )
  })
})

describe('validateFsPath workspace scoping', () => {
  test('allows arbitrary paths when scoping is off', () => {
    const resolved = validateFsPath('/tmp/outside-home/file.txt')
    assert.equal(resolved, join('/tmp/outside-home/file.txt'))
  })

  test('allows workspace paths when scoping is on', () => {
    const resolved = validateFsPath('/tmp/workspace/readme.md', {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    })
    assert.equal(resolved, join('/tmp/workspace/readme.md'))
  })

  test('always allows CODESURF_HOME paths when scoping is on', () => {
    const resolved = validateFsPath(join(CODESURF_HOME, 'briefs/card.md'), {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    })
    assert.equal(resolved, join(CODESURF_HOME, 'briefs/card.md'))
  })

  test('rejects paths outside workspace roots when scoping is on', () => {
    assert.throws(
      () => validateFsPath('/etc/passwd', {
        restrictToWorkspaceRoots: true,
        allowedRoots: ['/tmp/workspace'],
      }),
      /outside allowed workspace roots/,
    )
  })
})

describe('validateFsPath sensitive-dir denylist (shared with file-protocol-auth)', () => {
  test('rejects ~/.git-credentials', () => {
    assert.throws(
      () => validateFsPath(join(HOME, '.git-credentials')),
      /sensitive directory/,
    )
  })

  test('rejects ~/.npmrc', () => {
    assert.throws(
      () => validateFsPath(join(HOME, '.npmrc')),
      /sensitive directory/,
    )
  })

  test('rejects ~/.kube/config', () => {
    assert.throws(
      () => validateFsPath(join(HOME, '.kube', 'config')),
      /sensitive directory/,
    )
  })

  test('allows ~/.config/opencode/skills/x.md with allowReadOnlyOpenCodeConfig', () => {
    const resolved = validateFsPath(join(HOME, '.config', 'opencode', 'skills', 'x.md'), {
      allowReadOnlyOpenCodeConfig: true,
    })
    assert.equal(resolved, join(HOME, '.config', 'opencode', 'skills', 'x.md'))
  })

  test('rejects ~/.config/other/x (as before)', () => {
    assert.throws(
      () => validateFsPath(join(HOME, '.config', 'other', 'x'), {
        allowReadOnlyOpenCodeConfig: true,
      }),
      /sensitive directory/,
    )
  })

  test('still allows a workspace-root path', () => {
    const resolved = validateFsPath('/tmp/workspace/readme.md', {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    })
    assert.equal(resolved, join('/tmp/workspace/readme.md'))
  })
})
