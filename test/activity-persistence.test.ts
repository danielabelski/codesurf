import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActivityRecord } from '../src/shared/activity-types.ts'
import {
  ActivityPersistenceError,
  activityStorePath,
  createFileActivityPersistence,
} from '../src/main/activity-persistence.ts'
import { ACTIVITY_DOCUMENT_VERSION } from '../src/main/activity-validation.ts'

const NOW = Date.now()

function record(workspaceId = 'workspace-1'): ActivityRecord {
  return {
    id: 'activity-1',
    tileId: 'tile-1',
    workspaceId,
    type: 'task',
    status: 'running',
    title: 'Review',
    createdAt: NOW - 100,
    updatedAt: NOW,
  }
}

async function fixture(): Promise<{ homeDir: string, cleanup: () => Promise<void> }> {
  const homeDir = await mkdtemp(join(tmpdir(), 'codesurf-activity-storage-'))
  return {
    homeDir,
    cleanup: () => rm(homeDir, { recursive: true, force: true }),
  }
}

describe('file activity persistence', () => {
  test('rejects traversal before resolving an activity path', () => {
    assert.throws(() => activityStorePath('/tmp/codesurf-test', '../escape'))
    assert.throws(() => activityStorePath('/tmp/codesurf-test', 'nested/workspace'))
  })

  test('returns an empty store only when the file does not exist', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const persistence = createFileActivityPersistence({ homeDir })
      assert.deepEqual(await persistence.load('workspace-1'), {
        records: [],
        needsRewrite: false,
      })

      const filePath = activityStorePath(homeDir, 'workspace-1')
      await mkdir(filePath, { recursive: true })
      await assert.rejects(
        persistence.load('workspace-1'),
        (error: unknown) => error instanceof ActivityPersistenceError && error.code === 'not_a_file',
      )
    } finally {
      await cleanup()
    }
  })

  test('loads legacy arrays but requires a rewrite', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify([record()]))
      const persistence = createFileActivityPersistence({ homeDir })
      assert.deepEqual(await persistence.load('workspace-1'), {
        records: [record()],
        needsRewrite: true,
      })
    } finally {
      await cleanup()
    }
  })

  test('writes a versioned document atomically with restrictive permissions', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const persistence = createFileActivityPersistence({ homeDir })
      await persistence.save('workspace-1', [record()])

      const filePath = activityStorePath(homeDir, 'workspace-1')
      const raw = await readFile(filePath, 'utf8')
      assert.deepEqual(JSON.parse(raw), {
        version: ACTIVITY_DOCUMENT_VERSION,
        records: [record()],
      })
      assert.equal((await stat(filePath)).mode & 0o777, 0o600)
      assert.equal((await stat(dirname(filePath))).mode & 0o777, 0o700)
      assert.deepEqual(
        (await readdir(dirname(filePath))).filter(name => name.endsWith('.tmp')),
        [],
      )

      await chmod(filePath, 0o666)
      await persistence.save('workspace-1', [record()])
      assert.equal((await stat(filePath)).mode & 0o777, 0o600)
    } finally {
      await cleanup()
    }
  })

  test('preserves corrupt, future, and oversized files without rewriting them', async () => {
    const cases: Array<{ name: string, raw: string, maxFileBytes?: number }> = [
      { name: 'corrupt', raw: '{not json' },
      {
        name: 'future',
        raw: JSON.stringify({ version: ACTIVITY_DOCUMENT_VERSION + 1, records: [] }),
      },
      { name: 'oversized', raw: 'x'.repeat(128), maxFileBytes: 64 },
    ]

    for (const testCase of cases) {
      const { homeDir, cleanup } = await fixture()
      try {
        const filePath = activityStorePath(homeDir, testCase.name)
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, testCase.raw)
        const persistence = createFileActivityPersistence({
          homeDir,
          ...(testCase.maxFileBytes === undefined ? {} : { maxFileBytes: testCase.maxFileBytes }),
        })
        await assert.rejects(persistence.load(testCase.name), ActivityPersistenceError)
        assert.equal(await readFile(filePath, 'utf8'), testCase.raw)
      } finally {
        await cleanup()
      }
    }
  })

  test('rejects records from another workspace before touching the destination', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const persistence = createFileActivityPersistence({ homeDir })
      await assert.rejects(persistence.save('workspace-1', [record('workspace-2')]))
      await assert.rejects(stat(activityStorePath(homeDir, 'workspace-1')), { code: 'ENOENT' })
    } finally {
      await cleanup()
    }
  })

  test('rejects a symbolic-link activity file without reading its target', async () => {
    const { homeDir, cleanup } = await fixture()
    const externalDir = await mkdtemp(join(tmpdir(), 'codesurf-activity-external-'))
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      const externalPath = join(externalDir, 'outside.json')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(externalPath, JSON.stringify({
        version: ACTIVITY_DOCUMENT_VERSION,
        records: [record()],
      }))
      await symlink(externalPath, filePath)

      const persistence = createFileActivityPersistence({ homeDir })
      await assert.rejects(
        persistence.load('workspace-1'),
        (error: unknown) => error instanceof ActivityPersistenceError && error.code === 'unsafe_path',
      )
    } finally {
      await Promise.all([
        cleanup(),
        rm(externalDir, { recursive: true, force: true }),
      ])
    }
  })

  test('rejects a symbolic-link workspace directory', async () => {
    const { homeDir, cleanup } = await fixture()
    const externalDir = await mkdtemp(join(tmpdir(), 'codesurf-activity-external-workspace-'))
    try {
      const workspacesDir = join(homeDir, 'workspaces')
      await mkdir(workspacesDir, { recursive: true })
      await mkdir(join(externalDir, '.codesurf'), { recursive: true })
      await writeFile(join(externalDir, '.codesurf', 'activity.json'), JSON.stringify({
        version: ACTIVITY_DOCUMENT_VERSION,
        records: [record()],
      }))
      await symlink(externalDir, join(workspacesDir, 'workspace-1'))

      const persistence = createFileActivityPersistence({ homeDir })
      await assert.rejects(
        persistence.load('workspace-1'),
        (error: unknown) => error instanceof ActivityPersistenceError && error.code === 'unsafe_path',
      )
    } finally {
      await Promise.all([
        cleanup(),
        rm(externalDir, { recursive: true, force: true }),
      ])
    }
  })

  test('rejects deterministic replacement after opening a retained handle', async () => {
    const { homeDir, cleanup } = await fixture()
    try {
      const filePath = activityStorePath(homeDir, 'workspace-1')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, JSON.stringify({
        version: ACTIVITY_DOCUMENT_VERSION,
        records: [record()],
      }))

      let replaced = false
      const persistence = createFileActivityPersistence({
        homeDir,
        readHooks: {
          async afterOpen(path) {
            const displaced = `${path}.displaced`
            await rename(path, displaced)
            await writeFile(path, JSON.stringify({
              version: ACTIVITY_DOCUMENT_VERSION,
              records: [],
            }))
            replaced = true
          },
        },
      })
      await assert.rejects(
        persistence.load('workspace-1'),
        (error: unknown) => error instanceof ActivityPersistenceError && error.code === 'path_changed',
      )
      assert.equal(replaced, true)
    } finally {
      await cleanup()
    }
  })

  test('save rejects symbolic-link files and ancestors without changing external targets', async () => {
    const cases = ['file', 'workspace', 'activity-dir'] as const
    for (const kind of cases) {
      const { homeDir, cleanup } = await fixture()
      const externalDir = await mkdtemp(join(tmpdir(), 'codesurf-activity-write-external-'))
      try {
        const filePath = activityStorePath(homeDir, 'workspace-1')
        const externalPath = join(externalDir, 'outside.json')
        const original = 'external-content-must-survive'
        await writeFile(externalPath, original)

        if (kind === 'file') {
          await mkdir(dirname(filePath), { recursive: true })
          await symlink(externalPath, filePath)
        } else if (kind === 'workspace') {
          await mkdir(join(homeDir, 'workspaces'), { recursive: true })
          await symlink(externalDir, join(homeDir, 'workspaces', 'workspace-1'))
        } else {
          await mkdir(join(homeDir, 'workspaces', 'workspace-1'), { recursive: true })
          await symlink(externalDir, dirname(filePath))
        }

        const persistence = createFileActivityPersistence({ homeDir })
        await assert.rejects(
          persistence.save('workspace-1', [record()]),
          (error: unknown) => error instanceof ActivityPersistenceError && error.code === 'unsafe_path',
        )
        assert.equal(await readFile(externalPath, 'utf8'), original)
        assert.deepEqual(
          (await readdir(externalDir)).sort(),
          ['outside.json'],
        )
      } finally {
        await Promise.all([
          cleanup(),
          rm(externalDir, { recursive: true, force: true }),
        ])
      }
    }
  })
})
