import { promises as fs, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  writeFilesAtomically,
  type RelayAtomicWriteDependencies,
} from './atomicFileWrites'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => (
    fs.rm(path, { recursive: true, force: true })
  )))
})

describe('writeFilesAtomically', () => {
  it('does not begin filesystem work for an inactive operation', async () => {
    const dependencies: RelayAtomicWriteDependencies = {
      createId: vi.fn(() => 'unused'),
      ensureDirectory: vi.fn(async () => {}),
      writeTemporaryFile: vi.fn(async () => {}),
      commitTemporaryFile: vi.fn(),
      removeTemporaryFile: vi.fn(),
    }
    const cancellation = new Error('inactive generation')

    await expect(writeFilesAtomically(
      [{ path: '/unused/state.json', content: '{}' }],
      {
        assertActive() {
          throw cancellation
        },
      },
      dependencies,
    )).rejects.toBe(cancellation)

    expect(dependencies.createId).not.toHaveBeenCalled()
    expect(dependencies.ensureDirectory).not.toHaveBeenCalled()
    expect(dependencies.writeTemporaryFile).not.toHaveBeenCalled()
    expect(dependencies.commitTemporaryFile).not.toHaveBeenCalled()
    expect(dependencies.removeTemporaryFile).not.toHaveBeenCalled()
  })

  it('removes a partially written temp file before surfacing write failure', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'codesurf-relay-atomic-'))
    temporaryRoots.push(root)
    const target = join(root, 'nested', 'state.json')
    const failure = new Error('injected partial write failure')
    const dependencies: RelayAtomicWriteDependencies = {
      createId: () => 'partial',
      ensureDirectory: async path => {
        await fs.mkdir(path, { recursive: true })
      },
      writeTemporaryFile: async (path, content) => {
        await fs.writeFile(path, content.slice(0, 1))
        throw failure
      },
      commitTemporaryFile: vi.fn(),
      removeTemporaryFile: path => {
        rmSync(path, { force: true })
      },
    }

    await expect(writeFilesAtomically(
      [{ path: target, content: '{"ready":true}' }],
      undefined,
      dependencies,
    )).rejects.toBe(failure)

    expect(dependencies.commitTemporaryFile).not.toHaveBeenCalled()
    expect(await fs.readdir(join(root, 'nested'))).toEqual([])
    await expect(fs.access(target)).rejects.toThrow()
  })

  it('does not commit a staged file after its lifecycle becomes inactive', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'codesurf-relay-cancel-'))
    temporaryRoots.push(root)
    const target = join(root, 'state.json')
    const cancellation = new Error('generation stopped')
    let active = true
    const dependencies: RelayAtomicWriteDependencies = {
      createId: () => 'cancelled',
      ensureDirectory: async path => {
        await fs.mkdir(path, { recursive: true })
      },
      writeTemporaryFile: async (path, content) => {
        await fs.writeFile(path, content)
        active = false
      },
      commitTemporaryFile: vi.fn(),
      removeTemporaryFile: path => {
        rmSync(path, { force: true })
      },
    }

    await expect(writeFilesAtomically(
      [{ path: target, content: '{"ready":true}' }],
      {
        assertActive() {
          if (!active) throw cancellation
        },
      },
      dependencies,
    )).rejects.toBe(cancellation)

    expect(dependencies.commitTemporaryFile).not.toHaveBeenCalled()
    expect(await fs.readdir(root)).toEqual([])
    await expect(fs.access(target)).rejects.toThrow()
  })

  it('rolls every destination back when the second commit rename fails', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'codesurf-relay-rollback-'))
    temporaryRoots.push(root)
    const first = join(root, 'first.md')
    const second = join(root, 'second.md')
    await fs.writeFile(first, 'first-before')
    await fs.writeFile(second, 'second-before')
    const failure = new Error('injected second rename failure')
    let commitCount = 0
    const dependencies: RelayAtomicWriteDependencies = {
      createId: (() => {
        let id = 0
        return () => `rollback-${++id}`
      })(),
      ensureDirectory: async path => {
        await fs.mkdir(path, { recursive: true })
      },
      writeTemporaryFile: async (path, content) => {
        await fs.writeFile(path, content)
      },
      commitTemporaryFile: (temporaryPath, path) => {
        commitCount += 1
        if (commitCount === 2) throw failure
        renameSync(temporaryPath, path)
      },
      removeTemporaryFile: path => {
        rmSync(path, { force: true })
      },
    }

    await expect(writeFilesAtomically([
      { path: first, content: 'first-after' },
      { path: second, content: 'second-after' },
    ], undefined, dependencies)).rejects.toBe(failure)

    expect(await fs.readFile(first, 'utf8')).toBe('first-before')
    expect(await fs.readFile(second, 'utf8')).toBe('second-before')
    expect((await fs.readdir(root)).sort()).toEqual(['first.md', 'second.md'])
  })
})
