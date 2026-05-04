# @codesurf/daemon

The CodeSurf local HTTP daemon (`codesurfd`) and its process supervisor.

This package is consumed by:

- **collaborator-clone** (Electron desktop app) — adapter at `src/main/daemon/manager.ts`
- **grok-cli / codesurf TUI** — adapter at `src/daemon/manager.ts`

Both clients spawn / supervise the same daemon binary and talk to it over an
authenticated localhost HTTP socket. State lives under `~/.codesurf/`.

## Layout

```
bin/
  codesurfd.mjs         # the HTTP server entrypoint
  chat-jobs.mjs         # chat job manager (uses @anthropic-ai/claude-agent-sdk)
  checkpoints.mjs       # file-snapshot store
  memory-loader.mjs     # memory / context bucket loader
  skills-index.mjs      # skill discovery & install
  file-references.mjs   # @-mention expansion
  session-index.mjs     # external session indexer
  context-buckets.mjs   # context bucket policy
  project-context.mjs   # project context policy
  instruction-context.mjs
vendor/
  dreaming.mjs          # autonomous research runner (was @codesurf/dreaming)
src/
  manager.ts            # createDaemonManager(config) — Electron-free supervisor
  client.ts             # createDaemonClient({getInfo}) — typed REST client
  paths.ts              # CODESURF_HOME constant
  index.ts              # re-exports
```

## Usage (host adapter)

```ts
import { createDaemonManager } from '@codesurf/daemon/manager'
import { createDaemonClient } from '@codesurf/daemon/client'
import { CODESURF_HOME } from '@codesurf/daemon/paths'

const manager = createDaemonManager({
  homeDir: CODESURF_HOME,
  getAppVersion: () => '1.2.3',
  resolveDaemonScriptPath: () => /* path to bin/codesurfd.mjs */,
})

const daemonClient = createDaemonClient({
  ensureRunning: manager.ensureDaemonRunning,
  getStatus: manager.getDaemonStatus,
  invalidate: manager.invalidateDaemonCache,
})

await daemonClient.listWorkspaces()
```
