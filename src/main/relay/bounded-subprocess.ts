import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'

export const RELAY_SUBPROCESS_STDOUT_MAX_BYTES = 8 * 1024 * 1024
export const RELAY_SUBPROCESS_STDERR_MAX_BYTES = 1024 * 1024
export const RELAY_SUBPROCESS_TERM_GRACE_MS = 1_000
export const RELAY_SUBPROCESS_KILL_WAIT_MS = 1_000

export type BoundedSubprocessFailureReason =
  | 'spawn'
  | 'abort'
  | 'timeout'
  | 'stdout-limit'
  | 'stderr-limit'
  | 'termination'

export class BoundedSubprocessError extends Error {
  readonly reason: BoundedSubprocessFailureReason
  readonly command: string
  readonly pid: number | null
  readonly stdout: string
  readonly stderr: string

  constructor(options: {
    reason: BoundedSubprocessFailureReason
    message: string
    command: string
    pid: number | null
    stdout: string
    stderr: string
    cause?: unknown
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BoundedSubprocessError'
    this.reason = options.reason
    this.command = options.command
    this.pid = options.pid
    this.stdout = options.stdout
    this.stderr = options.stderr
  }
}

export type BoundedSubprocessResult = {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
  pid: number
}

export type RunBoundedSubprocessOptions = {
  command: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  label?: string
  timeoutMs: number
  stdoutMaxBytes?: number
  stderrMaxBytes?: number
  termGraceMs?: number
  killWaitMs?: number
  windowsHide?: boolean
  signal?: AbortSignal
}

type CloseResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, delayMs)
  })
}

function waitForClose(closePromise: Promise<CloseResult>, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (closed: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(closed)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    void closePromise.then(() => finish(true))
  })
}

function isPosixProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForPosixProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isPosixProcessGroupAlive(pid)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await wait(Math.min(15, remaining))
  }
  return true
}

function signalPosixProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid
  if (pid) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // The group may already be gone or group signalling may be unavailable.
    }
  }
  try {
    proc.kill(signal)
  } catch {
    // The direct child already exited.
  }
}

async function forceKillWindowsProcessTree(proc: ChildProcess, waitMs: number): Promise<void> {
  const pid = proc.pid
  if (!pid) {
    try { proc.kill('SIGKILL') } catch {}
    return
  }

  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      try { killer.kill('SIGKILL') } catch {}
      finish()
    }, waitMs)
    killer.once('error', finish)
    killer.once('close', finish)
  })

  try { proc.kill('SIGKILL') } catch {}
}

async function terminateProcessTree(options: {
  proc: ChildProcess
  closePromise: Promise<CloseResult>
  termGraceMs: number
  killWaitMs: number
}): Promise<boolean> {
  const { proc, closePromise, termGraceMs, killWaitMs } = options
  const pid = proc.pid

  if (!pid) {
    return await waitForClose(closePromise, killWaitMs)
  }

  if (process.platform === 'win32') {
    await forceKillWindowsProcessTree(proc, killWaitMs)
    return await waitForClose(closePromise, killWaitMs)
  }

  signalPosixProcessGroup(proc, 'SIGTERM')
  await waitForClose(closePromise, termGraceMs)

  if (isPosixProcessGroupAlive(pid) || proc.exitCode === null) {
    signalPosixProcessGroup(proc, 'SIGKILL')
  }

  const [childClosed, groupExited] = await Promise.all([
    waitForClose(closePromise, killWaitMs),
    waitForPosixProcessGroupExit(pid, killWaitMs),
  ])
  return childClosed && groupExited
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
  return resolved
}

/**
 * Run a CLI child with bounded output and process-tree termination.
 *
 * POSIX children lead a dedicated process group. Timeout/output failures signal
 * the entire group with TERM, wait a bounded grace period, then escalate to
 * KILL. Windows uses taskkill /T /F so grandchildren are included.
 */
export async function runBoundedSubprocess(
  options: RunBoundedSubprocessOptions,
): Promise<BoundedSubprocessResult> {
  const stdoutMaxBytes = positiveLimit(
    options.stdoutMaxBytes,
    RELAY_SUBPROCESS_STDOUT_MAX_BYTES,
    'stdoutMaxBytes',
  )
  const stderrMaxBytes = positiveLimit(
    options.stderrMaxBytes,
    RELAY_SUBPROCESS_STDERR_MAX_BYTES,
    'stderrMaxBytes',
  )
  const termGraceMs = positiveLimit(
    options.termGraceMs,
    RELAY_SUBPROCESS_TERM_GRACE_MS,
    'termGraceMs',
  )
  const killWaitMs = positiveLimit(
    options.killWaitMs,
    RELAY_SUBPROCESS_KILL_WAIT_MS,
    'killWaitMs',
  )
  const timeoutMs = positiveLimit(options.timeoutMs, 0, 'timeoutMs')
  const label = options.label?.trim() || options.command
  if (options.signal?.aborted) {
    throw new BoundedSubprocessError({
      reason: 'abort',
      message: `${label} turn was cancelled before launch`,
      command: options.command,
      pid: null,
      stdout: '',
      stderr: '',
      cause: options.signal.reason,
    })
  }

  const spawnOptions: SpawnOptions = {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: options.windowsHide ?? true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.env ? { env: options.env } : {}),
  }
  const proc = spawn(options.command, [...(options.args ?? [])], spawnOptions)
  const pid = proc.pid ?? null
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let collectionStopped = false
  let failure: {
    reason: BoundedSubprocessFailureReason
    message: string
    cause?: unknown
  } | null = null

  let resolveClose!: (result: CloseResult) => void
  const closePromise = new Promise<CloseResult>(resolve => {
    resolveClose = resolve
  })

  const capturedStdout = (): string => Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8')
  const capturedStderr = (): string => Buffer.concat(stderrChunks, stderrBytes).toString('utf8')

  const stopCollecting = (): void => {
    if (collectionStopped) return
    collectionStopped = true
    proc.stdout?.off('data', onStdout)
    proc.stderr?.off('data', onStderr)
    proc.stdout?.destroy()
    proc.stderr?.destroy()
  }

  let startFailure!: (
    reason: BoundedSubprocessFailureReason,
    message: string,
    cause?: unknown,
  ) => void

  const collect = (
    streamName: 'stdout' | 'stderr',
    rawChunk: Buffer | string,
  ): void => {
    if (collectionStopped || failure) return
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk)
    const currentBytes = streamName === 'stdout' ? stdoutBytes : stderrBytes
    const maxBytes = streamName === 'stdout' ? stdoutMaxBytes : stderrMaxBytes
    if (currentBytes + chunk.byteLength > maxBytes) {
      startFailure(
        streamName === 'stdout' ? 'stdout-limit' : 'stderr-limit',
        `${label} ${streamName} exceeded ${maxBytes} byte limit`,
      )
      return
    }
    if (streamName === 'stdout') {
      stdoutChunks.push(chunk)
      stdoutBytes += chunk.byteLength
    } else {
      stderrChunks.push(chunk)
      stderrBytes += chunk.byteLength
    }
  }

  const onStdout = (chunk: Buffer | string): void => collect('stdout', chunk)
  const onStderr = (chunk: Buffer | string): void => collect('stderr', chunk)
  proc.stdout?.on('data', onStdout)
  proc.stderr?.on('data', onStderr)

  proc.once('close', (code, signal) => {
    resolveClose({ code, signal })
  })

  const timeoutHandle = setTimeout(() => {
    startFailure('timeout', `${label} turn timed out after ${timeoutMs}ms`)
  }, timeoutMs)

  let resolveOutcome!: (result: BoundedSubprocessResult) => void
  let rejectOutcome!: (error: Error) => void
  let outcomeSettled = false
  const outcome = new Promise<BoundedSubprocessResult>((resolve, reject) => {
    resolveOutcome = resolve
    rejectOutcome = reject
  })

  const cleanupOutcome = (): void => {
    clearTimeout(timeoutHandle)
    options.signal?.removeEventListener('abort', onAbort)
  }

  const rejectFailure = (reason: BoundedSubprocessFailureReason, message: string, cause?: unknown): void => {
    if (outcomeSettled) return
    outcomeSettled = true
    cleanupOutcome()
    rejectOutcome(new BoundedSubprocessError({
      reason,
      message,
      command: options.command,
      pid,
      stdout: capturedStdout(),
      stderr: capturedStderr(),
      cause,
    }))
  }

  startFailure = (reason, message, cause) => {
    if (failure || outcomeSettled) return
    failure = { reason, message, cause }
    clearTimeout(timeoutHandle)
    stopCollecting()
    void (async () => {
      const confirmedClosed = await terminateProcessTree({
        proc,
        closePromise,
        termGraceMs,
        killWaitMs,
      })
      const finalReason = confirmedClosed ? reason : 'termination'
      const finalMessage = confirmedClosed
        ? message
        : `${message}; process exit could not be confirmed after forced termination`
      rejectFailure(finalReason, finalMessage, cause)
    })()
  }

  const onAbort = (): void => {
    startFailure(
      'abort',
      `${label} turn was cancelled`,
      options.signal?.reason,
    )
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  proc.once('error', error => {
    startFailure('spawn', `${label} failed to start: ${error.message}`, error)
  })

  void closePromise.then(result => {
    cleanupOutcome()
    if (failure || outcomeSettled) return
    outcomeSettled = true
    resolveOutcome({
      stdout: capturedStdout(),
      stderr: capturedStderr(),
      code: result.code,
      signal: result.signal,
      pid: pid ?? 0,
    })
  })

  return await outcome
}
