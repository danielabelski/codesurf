import { randomUUID } from 'node:crypto'
import { promises as fs, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RelayOperationContext } from './types'

export type RelayFileWrite = {
  path: string
  content: string
}

export type RelayAtomicWriteDependencies = {
  createId: () => string
  ensureDirectory: (path: string) => Promise<void>
  writeTemporaryFile: (path: string, content: string) => Promise<void>
  commitTemporaryFile: (temporaryPath: string, path: string) => void
  removeTemporaryFile: (temporaryPath: string) => void
}

const defaultDependencies: RelayAtomicWriteDependencies = {
  createId: randomUUID,
  ensureDirectory: async path => {
    await fs.mkdir(path, { recursive: true })
  },
  writeTemporaryFile: async (path, content) => {
    await fs.writeFile(path, content)
  },
  commitTemporaryFile: (temporaryPath, path) => {
    renameSync(temporaryPath, path)
  },
  removeTemporaryFile: temporaryPath => {
    rmSync(temporaryPath, { force: true })
  },
}

function assertActive(context?: RelayOperationContext): void {
  context?.assertActive()
}

async function awaitActive<T>(
  operation: () => Promise<T>,
  context?: RelayOperationContext,
): Promise<T> {
  assertActive(context)
  try {
    const result = await operation()
    assertActive(context)
    return result
  } catch (error) {
    assertActive(context)
    throw error
  }
}

export async function writeFilesAtomically(
  files: RelayFileWrite[],
  context?: RelayOperationContext,
  dependencies: RelayAtomicWriteDependencies = defaultDependencies,
): Promise<void> {
  assertActive(context)
  const staged: Array<{ path: string; temporaryPath: string }> = []
  try {
    for (const file of files) {
      await awaitActive(
        () => dependencies.ensureDirectory(dirname(file.path)),
        context,
      )
      const temporaryPath = join(
        dirname(file.path),
        `.${basename(file.path)}.${dependencies.createId()}.tmp`,
      )
      // Register the path before writing so even a partial failed write is
      // removed by the common cleanup path.
      staged.push({ path: file.path, temporaryPath })
      await awaitActive(
        () => dependencies.writeTemporaryFile(temporaryPath, file.content),
        context,
      )
    }

    // Commit is deliberately synchronous after the final lifecycle check.
    // Shutdown cannot interleave between that check and the atomic renames, so
    // a cancelled generation can leave only unobservable temporary files.
    assertActive(context)
    for (const file of staged) {
      dependencies.commitTemporaryFile(file.temporaryPath, file.path)
    }
  } catch (error) {
    for (const file of staged) {
      try {
        dependencies.removeTemporaryFile(file.temporaryPath)
      } catch {}
    }
    throw error
  }
}
