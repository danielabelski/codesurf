import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  assertPathAllowedForFs,
  isPathUnderRoot,
  validateFsPath,
} from '../src/main/ipc/fs.ts'
import { CONTEX_HOME } from '../src/main/paths.ts'

// `validateFsPath`'s `resolveHome()` falls back to `process.env.HOME` /
// `os.homedir()` outside of Electron, which is the case here.
const HOME = process.env.HOME || process.env.USERPROFILE || homedir()

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

  test('allows CONTEX_HOME when scoping is enabled', () => {
    assert.doesNotThrow(() => assertPathAllowedForFs(join(CONTEX_HOME, 'settings.json'), {
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

  test('denies all non-CONTEX_HOME paths when no roots are configured', () => {
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

  test('always allows CONTEX_HOME paths when scoping is on', () => {
    const resolved = validateFsPath(join(CONTEX_HOME, 'briefs/card.md'), {
      restrictToWorkspaceRoots: true,
      allowedRoots: ['/tmp/workspace'],
    })
    assert.equal(resolved, join(CONTEX_HOME, 'briefs/card.md'))
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