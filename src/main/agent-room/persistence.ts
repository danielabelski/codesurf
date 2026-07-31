import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface AgentRoomFileHandle {
  writeFile(contents: string, options?: { encoding?: BufferEncoding }): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface AgentRoomFileStat {
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface AgentRoomFileIO {
  mkdir(path: string, options: { recursive: boolean, mode: number }): Promise<void>
  lstat(path: string): Promise<AgentRoomFileStat>
  realpath(path: string): Promise<string>
  open(path: string, flags: string, mode?: number): Promise<AgentRoomFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
  rmdir(path: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
}

export const nodeAgentRoomFileIO: AgentRoomFileIO = {
  mkdir: async (path, options) => {
    await fs.mkdir(path, options)
  },
  lstat: path => fs.lstat(path),
  realpath: path => fs.realpath(path),
  open: (path, flags, mode) => fs.open(path, flags, mode),
  rename: (from, to) => fs.rename(from, to),
  unlink: path => fs.unlink(path),
  rmdir: path => fs.rmdir(path),
  chmod: (path, mode) => fs.chmod(path, mode),
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function assertInsideRoot(root: string, path: string): string {
  const target = resolve(path)
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Agent-room persistence path escapes its owned root')
  }
  return target
}

export interface AgentRoomFileAdapter {
  writeFileAtomic(path: string, contents: string): Promise<void>
  removeOwnedFile(path: string, options?: { pruneEmptyParent?: boolean }): Promise<void>
}

export class NodeAgentRoomFileAdapter implements AgentRoomFileAdapter {
  readonly root: string
  readonly io: AgentRoomFileIO

  constructor(root: string, io: AgentRoomFileIO = nodeAgentRoomFileIO) {
    this.root = resolve(root)
    this.io = io
  }

  private async readStat(path: string): Promise<AgentRoomFileStat | null> {
    try {
      return await this.io.lstat(path)
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  private assertSafeStat(path: string, stat: AgentRoomFileStat, expected: 'directory' | 'file'): void {
    if (stat.isSymbolicLink()) {
      throw new Error(`Agent-room persistence refuses symbolic link: ${path}`)
    }
    if (expected === 'directory' && !stat.isDirectory()) {
      throw new Error(`Agent-room persistence expected directory: ${path}`)
    }
    if (expected === 'file' && !stat.isFile()) {
      throw new Error(`Agent-room persistence expected file: ${path}`)
    }
  }

  private async ensureSafeDirectory(targetDirectory: string): Promise<void> {
    const directory = assertInsideRoot(this.root, targetDirectory)
    await this.io.mkdir(this.root, { recursive: true, mode: 0o700 })
    const rootStat = await this.io.lstat(this.root)
    this.assertSafeStat(this.root, rootStat, 'directory')

    const rel = relative(this.root, directory)
    let current = this.root
    for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
      current = join(current, segment)
      let stat = await this.readStat(current)
      if (!stat) {
        await this.io.mkdir(current, { recursive: false, mode: 0o700 })
        stat = await this.io.lstat(current)
      }
      this.assertSafeStat(current, stat, 'directory')
    }

    const [realRoot, realDirectory] = await Promise.all([
      this.io.realpath(this.root),
      this.io.realpath(directory),
    ])
    assertInsideRoot(realRoot, realDirectory)
  }

  private async validateExistingSafeDirectory(targetDirectory: string): Promise<boolean> {
    const directory = assertInsideRoot(this.root, targetDirectory)
    const rootStat = await this.readStat(this.root)
    if (!rootStat) return false
    this.assertSafeStat(this.root, rootStat, 'directory')

    const rel = relative(this.root, directory)
    let current = this.root
    for (const segment of rel.split(/[\\/]+/).filter(Boolean)) {
      current = join(current, segment)
      const stat = await this.readStat(current)
      if (!stat) return false
      this.assertSafeStat(current, stat, 'directory')
    }

    const [realRoot, realDirectory] = await Promise.all([
      this.io.realpath(this.root),
      this.io.realpath(directory),
    ])
    assertInsideRoot(realRoot, realDirectory)
    return true
  }

  private async assertSafeTarget(path: string): Promise<void> {
    const target = assertInsideRoot(this.root, path)
    const stat = await this.readStat(target)
    if (stat) this.assertSafeStat(target, stat, 'file')
  }

  private async syncDirectory(path: string): Promise<void> {
    let handle: AgentRoomFileHandle | null = null
    try {
      handle = await this.io.open(path, 'r')
      await handle.sync()
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    const target = assertInsideRoot(this.root, path)
    const directory = dirname(target)
    await this.ensureSafeDirectory(directory)
    await this.assertSafeTarget(target)

    const tempPath = join(
      directory,
      `.${basename(target)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
    )
    let handle: AgentRoomFileHandle | null = null
    try {
      handle = await this.io.open(tempPath, 'wx', 0o600)
      await handle.writeFile(contents, { encoding: 'utf8' })
      await handle.sync()
      await handle.close()
      handle = null

      // Re-check after the asynchronous write to narrow the directory-swap race.
      await this.ensureSafeDirectory(directory)
      await this.assertSafeTarget(target)
      await this.io.rename(tempPath, target)
      await this.io.chmod(target, 0o600)
      await this.syncDirectory(directory)
    } catch (error) {
      await handle?.close().catch(() => {})
      await this.io.unlink(tempPath).catch(() => {})
      throw error
    }
  }

  async removeOwnedFile(
    path: string,
    options: { pruneEmptyParent?: boolean } = {},
  ): Promise<void> {
    const target = assertInsideRoot(this.root, path)
    const directory = dirname(target)
    if (!await this.validateExistingSafeDirectory(directory)) return
    // Node does not expose openat/unlinkat here, so a same-user directory swap can
    // still race this final check. CODESURF_HOME remains the user-owned trust anchor.
    const targetStat = await this.readStat(target)
    if (!targetStat) return
    this.assertSafeStat(target, targetStat, 'file')
    await this.io.unlink(target)
    await this.syncDirectory(directory)

    if (options.pruneEmptyParent) {
      let current = directory
      while (current !== this.root) {
        try {
          await this.io.rmdir(current)
          await this.syncDirectory(dirname(current))
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code
          if (code === 'ENOENT') {
            current = dirname(current)
            continue
          }
          if (code === 'ENOTEMPTY' || code === 'EEXIST') break
          throw error
        }
        current = dirname(current)
      }
    }
  }
}

export interface AgentRoomRetryScheduler {
  schedule(task: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
}

const defaultRetryScheduler: AgentRoomRetryScheduler = {
  schedule(task, delayMs) {
    const timer = setTimeout(task, delayMs)
    timer.unref?.()
    return timer
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

type PersistenceOperation =
  | { revision: number, kind: 'write', contents: string }
  | { revision: number, kind: 'delete', pruneEmptyParent: boolean }

interface PersistencePathState {
  nextRevision: number
  appliedRevision: number
  latest: PersistenceOperation | null
  running: Promise<void> | null
  retryHandle: unknown
  failures: number
  lastError: Error | null
}

export class AgentRoomPersistenceQueue {
  private readonly adapter: AgentRoomFileAdapter
  private readonly retryScheduler: AgentRoomRetryScheduler
  private readonly states = new Map<string, PersistencePathState>()
  private disposed = false

  constructor(
    adapter: AgentRoomFileAdapter,
    options: { retryScheduler?: AgentRoomRetryScheduler } = {},
  ) {
    this.adapter = adapter
    this.retryScheduler = options.retryScheduler ?? defaultRetryScheduler
  }

  writeJson(path: string, value: unknown): void {
    const contents = `${JSON.stringify(value, null, 2)}\n`
    this.writeText(path, contents)
  }

  writeText(path: string, contents: string): void {
    this.schedule(path, revision => ({ revision, kind: 'write', contents }))
  }

  removeFile(path: string, options: { pruneEmptyParent?: boolean } = {}): void {
    this.schedule(path, revision => ({
      revision,
      kind: 'delete',
      pruneEmptyParent: options.pruneEmptyParent === true,
    }))
  }

  private schedule(
    path: string,
    createOperation: (revision: number) => PersistenceOperation,
  ): void {
    if (this.disposed) throw new Error('Agent-room persistence queue is disposed')
    const normalizedPath = resolve(path)
    const state = this.states.get(normalizedPath) ?? {
      nextRevision: 0,
      appliedRevision: 0,
      latest: null,
      running: null,
      retryHandle: null,
      failures: 0,
      lastError: null,
    }
    state.nextRevision += 1
    state.latest = createOperation(state.nextRevision)
    state.lastError = null
    if (state.retryHandle !== null) {
      this.retryScheduler.cancel(state.retryHandle)
      state.retryHandle = null
    }
    this.states.set(normalizedPath, state)
    this.startDrain(normalizedPath, state)
  }

  private startDrain(path: string, state: PersistencePathState): void {
    if (state.running || !state.latest || state.appliedRevision >= state.latest.revision) return
    const running = this.drain(path, state)
    state.running = running
    void running.finally(() => {
      if (state.running === running) state.running = null
      if (
        state.latest
        && state.appliedRevision < state.latest.revision
        && state.retryHandle === null
      ) {
        this.startDrain(path, state)
        return
      }
      if (
        state.latest
        && state.appliedRevision >= state.latest.revision
        && state.retryHandle === null
      ) {
        this.states.delete(path)
      }
    })
  }

  private async drain(path: string, state: PersistencePathState): Promise<void> {
    while (state.latest && state.appliedRevision < state.latest.revision) {
      const operation = state.latest
      try {
        if (operation.kind === 'write') {
          await this.adapter.writeFileAtomic(path, operation.contents)
        } else {
          await this.adapter.removeOwnedFile(path, {
            pruneEmptyParent: operation.pruneEmptyParent,
          })
        }
        state.appliedRevision = operation.revision
        state.failures = 0
        state.lastError = null
      } catch (error) {
        state.failures += 1
        state.lastError = error instanceof Error ? error : new Error(String(error))
        this.scheduleRetry(path, state)
        return
      }
    }
  }

  private scheduleRetry(path: string, state: PersistencePathState): void {
    if (state.retryHandle !== null || this.disposed) return
    const delayMs = Math.min(1000, 50 * (2 ** Math.min(state.failures - 1, 5)))
    state.retryHandle = this.retryScheduler.schedule(() => {
      state.retryHandle = null
      this.startDrain(path, state)
    }, delayMs)
  }

  private cancelRetry(state: PersistencePathState): void {
    if (state.retryHandle === null) return
    this.retryScheduler.cancel(state.retryHandle)
    state.retryHandle = null
  }

  async flush(): Promise<void> {
    const errors: Error[] = []
    while (true) {
      const entries = [...this.states.entries()]
      if (entries.length === 0) break
      let madeProgress = false

      for (const [path, state] of entries) {
        this.cancelRetry(state)
        if (state.running) await state.running
        this.cancelRetry(state)
        if (state.latest && state.appliedRevision < state.latest.revision) {
          const priorApplied = state.appliedRevision
          state.lastError = null
          this.startDrain(path, state)
          if (state.running) await state.running
          madeProgress ||= state.appliedRevision > priorApplied
          if (state.latest && state.appliedRevision < state.latest.revision && state.lastError) {
            errors.push(state.lastError)
          }
        }
        if (state.latest && state.appliedRevision >= state.latest.revision) {
          this.states.delete(path)
        }
      }

      if (errors.length > 0 || (!madeProgress && this.states.size > 0)) break
    }

    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'Agent-room persistence flush failed')
  }

  getStats(): { pendingPaths: number } {
    return { pendingPaths: this.states.size }
  }

  async dispose(): Promise<void> {
    await this.flush()
    this.disposed = true
    for (const state of this.states.values()) this.cancelRetry(state)
    this.states.clear()
  }
}
