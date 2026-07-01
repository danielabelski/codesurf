// Pure helper for PTY-exit cleanup — deliberately electron-free so it can be
// unit tested without pulling in `electron`, `node-pty`, etc. (terminal.ts
// requires `electron` at module load time, which breaks under `node --test`.)
import type { BusEvent } from '../../shared/event-bus-types.ts'

/** Minimal listener shape terminal.ts's `WebContents` satisfies. */
export interface ExitListener {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

/** Minimal session shape terminal.ts's `TerminalSession` satisfies. */
export interface ExitableSession {
  pty: unknown
  listeners: Set<ExitListener>
}

export interface TerminalBufferEntry {
  data: string
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface HandlePtyExitDeps<TSession extends ExitableSession> {
  terminals: Map<string, TSession>
  terminalBuffers: Map<string, TerminalBufferEntry>
  publish: (event: Omit<BusEvent, 'id' | 'timestamp'>) => unknown
}

/**
 * Clean up an app-side terminal session after its PTY process exits.
 *
 * `ptyRef` must be the exact `pty` object the exit event fired for — if the
 * session in `terminals` has since been replaced (e.g. `terminal:create`
 * respawned it before this exit event was processed), this is a no-op so a
 * live session is never torn down by a stale exit from its predecessor.
 */
export function handlePtyExit<TSession extends ExitableSession>(
  tileId: string,
  exitCode: number,
  ptyRef: unknown,
  deps: HandlePtyExitDeps<TSession>
): void {
  const current = deps.terminals.get(tileId)
  if (!current || current.pty !== ptyRef) return // superseded by a newer session

  for (const listener of [...current.listeners]) {
    try {
      if (!listener.isDestroyed()) listener.send(`terminal:exit:${tileId}`, exitCode)
    } catch { /* listener gone */ }
  }

  const buf = deps.terminalBuffers.get(tileId)
  if (buf?.timer) clearTimeout(buf.timer)
  deps.terminalBuffers.delete(tileId)
  deps.terminals.delete(tileId)

  deps.publish({
    channel: `tile:${tileId}`,
    type: 'system',
    source: `terminal:${tileId}`,
    payload: { action: 'exited', exitCode }
  })
}
