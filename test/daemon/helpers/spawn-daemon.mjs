import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DEFAULT_DAEMON_ENTRY = join(ROOT_DIR, 'bin', 'codesurfd.mjs')
const TEST_TMP_ROOT = join(ROOT_DIR, '.tmp', 'daemon-tests')
const DEFAULT_STARTUP_TIMEOUT_MS = 5_000
const DEFAULT_TERM_TIMEOUT_MS = 5_000
const DEFAULT_KILL_TIMEOUT_MS = 5_000
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024

function delay(ms) {
  return new Promise(resolveDelay => {
    setTimeout(resolveDelay, ms)
  })
}

async function withTimeout(promise, timeoutMs, description) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${description} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

function createOutputCollector(stream, maxBytes) {
  const chunks = []
  let bytes = 0
  let truncated = false

  const onData = chunk => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    const remaining = maxBytes - bytes
    if (remaining <= 0) {
      truncated = true
      return
    }
    if (buffer.length > remaining) {
      chunks.push(buffer.subarray(0, remaining))
      bytes += remaining
      truncated = true
      return
    }
    chunks.push(buffer)
    bytes += buffer.length
  }

  stream?.on('data', onData)
  return {
    cleanup() {
      stream?.off('data', onData)
    },
    read() {
      const output = Buffer.concat(chunks).toString('utf8')
      return truncated ? `${output}\n[output truncated at ${maxBytes} bytes]` : output
    },
  }
}

function processIsRunning(child, spawnError) {
  return !spawnError && child.exitCode === null && child.signalCode === null
}

export async function waitFor(check, timeoutMs = 5_000, intervalMs = 50) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = await check()
    if (value) return value
    await delay(intervalMs)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

export function spawnManagedChild({
  command,
  args = [],
  cwd = ROOT_DIR,
  env = process.env,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
}) {
  if (typeof command !== 'string' || !command) {
    throw new Error('managed child command is required')
  }

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutCollector = createOutputCollector(child.stdout, outputLimitBytes)
  const stderrCollector = createOutputCollector(child.stderr, outputLimitBytes)
  let spawnError = null
  let finalResult = null
  let stopPromise = null

  let resolveClosed
  const closed = new Promise(resolveClose => {
    resolveClosed = resolveClose
  })

  const onError = error => {
    spawnError = error
  }
  const onExit = () => {}
  const onClose = (exitCode, signalCode) => {
    child.off('error', onError)
    child.off('exit', onExit)
    child.off('close', onClose)
    stdoutCollector.cleanup()
    stderrCollector.cleanup()
    finalResult = {
      exitCode,
      signalCode,
      spawnError,
      stdout: stdoutCollector.read(),
      stderr: stderrCollector.read(),
    }
    resolveClosed(finalResult)
  }

  child.once('error', onError)
  child.once('exit', onExit)
  child.once('close', onClose)

  const stop = ({
    termTimeoutMs = DEFAULT_TERM_TIMEOUT_MS,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
  } = {}) => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      let escalated = false

      if (processIsRunning(child, spawnError)) {
        child.kill('SIGTERM')
      }

      try {
        const result = await withTimeout(closed, termTimeoutMs, 'managed child SIGTERM shutdown')
        return { ...result, escalated }
      } catch (termError) {
        if (processIsRunning(child, spawnError)) {
          escalated = true
          child.kill('SIGKILL')
        } else {
          child.stdout?.destroy()
          child.stderr?.destroy()
        }

        try {
          const result = await withTimeout(closed, killTimeoutMs, 'managed child final exit')
          return { ...result, escalated }
        } catch (killError) {
          throw new AggregateError(
            [termError, killError],
            `child process ${child.pid ?? 'unknown'} did not reach a final close`,
          )
        }
      }
    })()
    return stopPromise
  }

  return {
    child,
    closed,
    stop,
    waitForExit(timeoutMs = DEFAULT_KILL_TIMEOUT_MS) {
      return withTimeout(closed, timeoutMs, 'managed child exit')
    },
    get finalResult() {
      return finalResult
    },
    get spawnError() {
      return spawnError
    },
    get stdout() {
      return finalResult?.stdout ?? stdoutCollector.read()
    },
    get stderr() {
      return finalResult?.stderr ?? stderrCollector.read()
    },
  }
}
