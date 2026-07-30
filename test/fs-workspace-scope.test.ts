import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  lstat,
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
import { promisify } from 'node:util'
import {
  assertPathAllowedForFs,
  cleanupCreatedCopyIfUnchanged,
  copyFileNoFollow,
  isPathUnderRoot,
  registerFsIPC,
  validateCanonicalFsPath,
  validateCanonicalFsPathDetails,
  validateFsPath,
  type FsIpcRegistrationDependencies,
  type FsPathScopeOptions,
} from '../src/main/ipc/fs.ts'
import { CODESURF_HOME } from '../src/main/paths.ts'

// `validateFsPath`'s `resolveHome()` falls back to `process.env.HOME` /
// `os.homedir()` outside of Electron, which is the case here.
const HOME = process.env.HOME || process.env.USERPROFILE || homedir()
const execFileAsync = promisify(execFile)

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

type CapturedIpcHandler = (event: unknown, ...args: unknown[]) => unknown

function captureFsHandlers(scope: FsPathScopeOptions): {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
} {
  const handlers = new Map<string, CapturedIpcHandler>()
  const ipcMain: NonNullable<FsIpcRegistrationDependencies['ipcMain']> = {
    handle(channel, listener) {
      handlers.set(channel, listener as unknown as CapturedIpcHandler)
    },
  }
  const shell: NonNullable<FsIpcRegistrationDependencies['shell']> = {
    showItemInFolder() {},
  }

  registerFsIPC({
    ipcMain,
    shell,
    validatePath: (filePath, intent, _workspaceId, operationOptions) => (
      validateCanonicalFsPathDetails(filePath, intent, {
        ...scope,
        ...operationOptions,
      })
    ),
  })

  return {
    async invoke(channel, ...args) {
      const handler = handlers.get(channel)
      assert.ok(handler, `Expected ${channel} to be registered`)
      return await handler({}, ...args)
    },
  }
}

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

  test('ignores an unavailable unrelated root but fails closed beneath it', async () => {
    const fixture = await createFsFixture()
    try {
      const validFile = join(fixture.workspace, 'valid.txt')
      const brokenRoot = join(fixture.root, 'broken-root')
      await writeFile(validFile, 'valid', 'utf8')
      await symlink(join(fixture.root, 'missing-root-target'), brokenRoot)

      const canonical = await validateCanonicalFsPath(validFile, 'read', {
        restrictToWorkspaceRoots: true,
        allowedRoots: [brokenRoot, fixture.workspace],
      })
      assert.equal(await readFile(canonical, 'utf8'), 'valid')

      await assert.rejects(
        validateCanonicalFsPath(join(brokenRoot, 'unavailable.txt'), 'read', {
          restrictToWorkspaceRoots: true,
          allowedRoots: [brokenRoot, fixture.workspace],
        }),
        /broken symbolic link|outside allowed workspace roots/,
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('a broken CODESURF_HOME does not disable another workspace or OpenCode reads', async () => {
    const fixture = await createFsFixture()
    try {
      const fakeHome = join(fixture.root, 'home')
      const validWorkspace = join(fixture.root, 'valid-workspace')
      const validFile = join(validWorkspace, 'valid.txt')
      const skillPath = join(fakeHome, '.config', 'opencode', 'skills', 'skill.md')
      const brokenCodesurfHome = join(fixture.root, 'broken-codesurf-home')
      await mkdir(dirname(skillPath), { recursive: true })
      await mkdir(validWorkspace)
      await writeFile(validFile, 'workspace', 'utf8')
      await writeFile(skillPath, 'skill', 'utf8')
      await symlink(join(fixture.root, 'missing-codesurf-home'), brokenCodesurfHome)

      const moduleUrl = new URL('../src/main/ipc/fs.ts', import.meta.url).href
      const script = `
        import { readFile } from 'node:fs/promises'
        import { validateCanonicalFsPath } from ${JSON.stringify(moduleUrl)}
        const workspacePath = await validateCanonicalFsPath(
          ${JSON.stringify(validFile)},
          'read',
          {
            restrictToWorkspaceRoots: true,
            allowedRoots: [${JSON.stringify(validWorkspace)}],
          },
        )
        const skillPath = await validateCanonicalFsPath(
          ${JSON.stringify(skillPath)},
          'read',
          {
            restrictToWorkspaceRoots: true,
            allowedRoots: [${JSON.stringify(brokenCodesurfHome)}],
            allowReadOnlyOpenCodeConfig: true,
          },
        )
        process.stdout.write(JSON.stringify([
          await readFile(workspacePath, 'utf8'),
          await readFile(skillPath, 'utf8'),
        ]))
      `
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '--eval', script],
        {
          env: {
            ...process.env,
            HOME: fakeHome,
            CODESURF_HOME: brokenCodesurfHome,
          },
        },
      )
      assert.deepEqual(JSON.parse(stdout), ['workspace', 'skill'])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('rejects an external-file symlink for read and write intents', async () => {
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

      const validatedRoot = await validateCanonicalFsPathDetails(
        configuredRoot,
        'directory',
        scopedTo(configuredRoot),
      )
      assert.equal(validatedRoot.operationPath, await realpath(fixture.workspace))
      assert.equal(validatedRoot.displayPath, configuredRoot)
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

describe('registered filesystem handlers', () => {
  test('use canonical paths for I/O while preserving a symlink workspace identity', async () => {
    const fixture = await createFsFixture()
    try {
      const configuredRoot = join(fixture.root, 'configured-workspace')
      const sourceRoot = join(fixture.root, 'import-source')
      const canonicalFile = join(fixture.workspace, 'notes.txt')
      const lexicalFile = join(configuredRoot, 'notes.txt')
      const importSource = join(sourceRoot, 'import.txt')
      await mkdir(sourceRoot)
      await writeFile(canonicalFile, 'before', 'utf8')
      await writeFile(importSource, 'imported', 'utf8')
      await symlink(fixture.workspace, configuredRoot)

      const { invoke } = captureFsHandlers({
        restrictToWorkspaceRoots: true,
        allowedRoots: [configuredRoot, sourceRoot],
      })

      await invoke('fs:writeFile', lexicalFile, 'after')
      assert.equal(await readFile(canonicalFile, 'utf8'), 'after')
      assert.equal(await invoke('fs:readFile', lexicalFile), 'after')

      const entries = await invoke('fs:readDir', configuredRoot) as Array<{
        name: string
        path: string
        isDir: boolean
        ext: string
      }>
      const notesEntry = entries.find(entry => entry.name === 'notes.txt')
      assert.ok(notesEntry)
      // FileExplorer stores and passes this path back into later handlers. It
      // must retain the configured root identity rather than switching to the
      // real target halfway through navigation.
      assert.equal(notesEntry.path, lexicalFile)
      assert.equal(await invoke('fs:readFile', notesEntry.path), 'after')

      const copyResult = await invoke(
        'fs:copyIntoDir',
        importSource,
        configuredRoot,
      ) as { path: string }
      assert.deepEqual(copyResult, {
        path: join(configuredRoot, 'import.txt'),
      })
      assert.equal(
        await readFile(join(fixture.workspace, 'import.txt'), 'utf8'),
        'imported',
      )
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('real handlers reject symlink escapes for read, write, list, and copy endpoints', async () => {
    const fixture = await createFsFixture()
    try {
      const sourceRoot = join(fixture.root, 'source')
      const deniedRoot = join(fixture.root, 'denied')
      const deniedFile = join(deniedRoot, 'secret.txt')
      const escapedFile = join(fixture.workspace, 'escaped-file.txt')
      const escapedSource = join(sourceRoot, 'escaped-source.txt')
      const escapedDirectory = join(fixture.workspace, 'escaped-directory')
      await Promise.all([mkdir(sourceRoot), mkdir(deniedRoot)])
      await writeFile(deniedFile, 'secret', 'utf8')
      await Promise.all([
        symlink(deniedFile, escapedFile),
        symlink(deniedFile, escapedSource),
        symlink(deniedRoot, escapedDirectory),
      ])

      const { invoke } = captureFsHandlers({
        restrictToWorkspaceRoots: true,
        allowedRoots: [fixture.workspace, sourceRoot],
      })

      await assert.rejects(
        invoke('fs:readFile', escapedFile),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        invoke('fs:writeFile', escapedFile, 'overwrite'),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        invoke('fs:readDir', escapedDirectory),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        invoke('fs:copyIntoDir', escapedSource, fixture.workspace),
        /outside allowed workspace roots|symbolic link/,
      )
      await assert.rejects(
        invoke('fs:copyIntoDir', join(sourceRoot, 'missing.txt'), escapedDirectory),
        /outside allowed workspace roots|symbolic link/,
      )
      assert.equal(await readFile(deniedFile, 'utf8'), 'secret')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })
})

describe('copy failure cleanup', () => {
  test('removes a partial destination after a mid-copy failure', async () => {
    const fixture = await createFsFixture()
    try {
      const sourcePath = join(fixture.workspace, 'large-source.bin')
      const destinationPath = join(fixture.workspace, 'partial-copy.bin')
      await writeFile(sourcePath, Buffer.alloc(128 * 1024, 0x61))

      await assert.rejects(
        copyFileNoFollow(sourcePath, destinationPath, {
          afterChunkCopied() {
            throw new Error('injected mid-copy failure')
          },
        }),
        /injected mid-copy failure/,
      )
      await assert.rejects(lstat(destinationPath), { code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('removes the inode created by a failed copy', async () => {
    const fixture = await createFsFixture()
    try {
      const destinationPath = join(fixture.workspace, 'partial-copy.txt')
      await writeFile(destinationPath, 'partial', 'utf8')
      const createdStats = await lstat(destinationPath)

      assert.equal(
        await cleanupCreatedCopyIfUnchanged(destinationPath, {
          dev: createdStats.dev,
          ino: createdStats.ino,
        }),
        true,
      )
      await assert.rejects(lstat(destinationPath), { code: 'ENOENT' })
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test('preserves replacement files and symlinks', async () => {
    const fixture = await createFsFixture()
    try {
      const destinationPath = join(fixture.workspace, 'partial-copy.txt')
      await writeFile(destinationPath, 'partial', 'utf8')
      const createdStats = await lstat(destinationPath)
      await rm(destinationPath)
      await writeFile(destinationPath, 'replacement', 'utf8')

      assert.equal(
        await cleanupCreatedCopyIfUnchanged(destinationPath, {
          dev: createdStats.dev,
          ino: createdStats.ino,
        }),
        false,
      )
      assert.equal(await readFile(destinationPath, 'utf8'), 'replacement')

      await rm(destinationPath)
      const symlinkTarget = join(fixture.workspace, 'symlink-target.txt')
      await writeFile(symlinkTarget, 'target', 'utf8')
      await symlink(symlinkTarget, destinationPath)

      assert.equal(
        await cleanupCreatedCopyIfUnchanged(destinationPath, {
          dev: createdStats.dev,
          ino: createdStats.ino,
        }),
        false,
      )
      assert.equal((await lstat(destinationPath)).isSymbolicLink(), true)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
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
