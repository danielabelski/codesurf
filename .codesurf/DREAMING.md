# CodeSurf Workspace Memory — contex (collaborator-clone)

*Generated 2026-04-23. Workspace: `/Users/jkneen/clawd/collaborator-clone`. Branch: `feature/event-bus-mcp`.*

---

## Overview

CodeSurf is an Electron infinite-canvas workspace where AI agents and developers collaborate through canvas tiles. The repo lives at `~/clawd/collaborator-clone` (`github.com/jasonkneen/codesurf`). The primary active branch is `feature/event-bus-mcp`; a substantial set of staged and unstaged changes is in the working tree.

Static CLAUDE.md/AGENTS.md still say "contex" — that is legacy naming; the live product is CodeSurf.

---

## Durable Facts

**Identity**
- `package.json` name/productName: `codesurf` / `CodeSurf`
- Static CLAUDE.md/AGENTS.md still say "contex" — legacy naming

**Actual installed SDK version**
- `@anthropic-ai/claude-agent-sdk` is `0.2.118` in the running environment (static docs say `0.2.79` — outdated)
- `claude` CLI at `/Users/jkneen/.local/bin/claude`, version `2.1.118`
- `claude-sonnet-4-6` is confirmed valid from this machine
- SDK 0.2.118 requires `allowDangerouslySkipPermissions: true` for bypass permission mode; `permissionMode: 'bypassPermissions'` alone is insufficient in this version

**Persistence layout**
- Workspace canvas: `~/.contex/workspaces/{id}/canvas.json` (500 ms debounce auto-save)
- Kanban tile state: `~/.contex/workspaces/{id}/tiles/{tileId}.json`
- MCP server config: `~/.contex/mcp-server.json` (random port — never hardcode)
- Generated workspace memory: `<workspace>/.codesurf/DREAMING.md` ← this file

**Memory loader inclusion**
- `bin/memory-loader.mjs` resolves `.codesurf/DREAMING.md` at the project path and layers it into every chat run as local-only context (`displayPath: .codesurf/DREAMING.md`)

**Critical file warning**
- `src/renderer/src/App.tsx` is ~1700 LOC and owns all canvas 2D physics — changes ripple widely; edit surgically
- `node-pty` requires `npm run rebuild` after any native dependency change

---

## Active Subsystems

### Daemon (`bin/codesurfd.mjs`)
- HTTP daemon with routes for `/dreaming/status`, `/dreaming/runs`, `/dreaming/run`, `/dreaming/cancel`
- Owns dreaming lifecycle: `createDreamingManager` from `packages/codesurf-dreaming/src/index.mjs`
- Auto-dream sweep runs every 5 minutes; evaluates whether to trigger a dream run after new sessions accumulate (minimum 3 sessions, minimum 30-minute interval, 5-second debounce)
- Dream output written atomically to `.codesurf/DREAMING.md` in the workspace directory

### Dreaming Package (`packages/codesurf-dreaming`)
- Single source file: `packages/codesurf-dreaming/src/index.mjs`
- Provider: Claude (`claude-sonnet-4-6`) via `@anthropic-ai/claude-agent-sdk` `query()`
- Limits: max 6 sessions, 6 messages per session, 500 chars per message, 16 000 chars total memory, 8 000 chars existing dream budget, 4 000 chars per session block
- Writes atomically (temp file + rename) to avoid partial reads
- Auto-dreaming types in `src/shared/types.ts`: `AutoDreamSettings`, `DreamRunSummary`, `AutoDreamPolicySummary`, `DashboardDreamingSummary` (added commit `eef4ece`)
- UI surface: `MainStatusBar` chip via `mainStatusBarDreaming.ts`; `SettingsPanel` cadence controls

### Chat IPC (`src/main/ipc/chat.ts`) — dirty, modified
- **Recent fix (2026-04-23):** Claude stream replacement lifecycle guard — `intentionallyClosedQueries: WeakSet<Query>` + `isActiveQuery(cardId, query)` / `clearActiveQuery(cardId, query)` helpers; stale/superseded generators return silently and cannot emit failure into the new active stream or delete its query
- **Recent fix (2026-04-23):** stderr capture added to both live chat and detached daemon Claude jobs; `claudeStderr: string` accumulator passed as `stderr` callback; `sanitizeClaudeStderrText()` strips ANSI escapes and blank lines; `formatClaudeSdkError(error, stderrText)` formats real CLI output capped at 6 000 chars — failures no longer surface as bare `Claude Code process exited with code 1`
- Same helpers mirrored in `bin/chat-jobs.mjs` for detached daemon Claude jobs
- Three providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`: Claude SDK, Codex CLI subprocess, OpenCode HTTP server

### Chat Tile (`src/renderer/src/components/ChatTile.tsx`) — ~7 300+ LOC

- Transcript scroller is settled at `scrollbarGutter: 'stable both-edges'` (line ~5241) — multiple sessions oscillated between `stable` and `stable both-edges`; `both-edges` is the correct settled value for symmetric centering; do not change
- Shimmer bars (thin animated bar at bottom of live assistant messages and running tool chips) are present and intentional — multiple sessions removed then restored them; they must stay
- Live `Thinking for Ns` chip uses tabular numbers with reserved width to prevent per-tick horizontal reflow
- **Open bug — phantom liveness pulse on reload:** `ChatTile` restores `saved.isStreaming` directly on mount (line 3218: `if (typeof saved.isStreaming === 'boolean') setIsStreaming(saved.isStreaming)`). If a tile JSON was persisted with `isStreaming: true`, the 500 ms `StreamingLivenessIndicator` interval fires on every reload indefinitely. Root cause identified; no guard currently in place. Fix path: clear `isStreaming` to `false` on clean shutdown, or add a mount-time check that resets it when no active stream exists for the card.

### Session Title Generation (`src/main/ipc/session-title-generation.ts`) — untracked/new
- Multi-provider: prefers current session provider, falls back to OpenRouter free models, last resort `claude-haiku-4-5-20251001`
- OpenAI-compatible path supports `openai` and `openrouter` providers; OpenRouter free fallbacks: `deepseek/deepseek-chat-v3-0324:free`, `google/gemini-2.0-flash-exp:free`, `meta-llama/llama-3.1-8b-instruct:free`
- Title limits: `GENERATED_TITLE_MAX_CHARS = 64`, 3–4 words, 90 000-char transcript budget (head 32 + tail 96 messages)
- Companion renderer module: `src/renderer/src/components/sidebar/session-title-generation.ts`
- **Known prior bug (fixed):** Codex fallback was spawning inside the repo root, exposing `.mcp.json` (stale random MCP port). When the port was dead, Codex attempted to connect to a dead MCP server; failure or CLI startup banner leaked as title candidate text. Fix: isolate title generation subprocess from repo-local `.mcp.json`

### Session Openability (`src/renderer/src/components/sidebar/session-open.ts`) — untracked/new
- Pure logic: `getSessionOpenIntent(session, options)` → `{ kind: 'chat' | 'app' | 'file' | 'none' }`
- Determines how sidebar opens a session based on `canOpenInChat`, `canOpenInApp`, `filePath`, `messageCount`, `lastMessage`

### Extension System
- Manifest/registry/bridge/chat-surface host fully present
- Chat-surface tab strip in `ChatTile.tsx` and `chatSurfaceHostRpc.ts`
- Bundled extensions in `packages/` (e.g. `contex-relay`)
- `cluso-widget` is an optional local file dependency (`file:../agentation-real`) — may not exist

---

## Active Workflows / Capabilities

**Command CLI harvest** — Complete. Landed: daemon skill indexing, file-reference expansion, context bucket bundles, workspace instruction chips. No further harvest work expected.

**Solo harvest** — In-progress plan (`docs/plans/2026-04-22-codesurf-solo-harvest-plan.md`). Goal: pull runtime primitives, trust/review, summary/state persistence from Solo into CodeSurf core without copying Solo UI. Key seams already present (extension registry, bridge, chat-surface host, permissions, PTY).

**Nyx PTY + hooks lift** — Planned but not started (`docs/plans/2026-04-22-nyx-pty-hooks-lift-plan.md`). Recommendation: add a namespaced `agent-pty` IPC stack beside the current terminal IPC, not inside it. Do not replace tmux-backed terminal first. Port Nyx hooks as an optional reliability layer for Claude Code / Codex / Droid shells only.

**Daemon dreaming** — Fully wired. Package, daemon routes, IPC bridge (`src/main/ipc/dreaming.ts`), memory-loader inclusion, and auto-sweep all present. UI surfaces for dreaming runs were explicitly out of scope for the implementation burst.

**JSON/JSONL prettify in editor** — Requested by user on 2026-04-23; sessions crashed before the work happened (stream-lifecycle bug). Status after fix: not confirmed as implemented; treat as unimplemented until verified.

---

## Working Tree State (2026-04-23)

### Modified tracked files (uncommitted)
- `.mcp.json` — dirty; stale port risk if subprocesses launched from repo root read this
- `bin/chat-jobs.mjs` — Claude stderr capture patch
- `package.json` / `package-lock.json`
- `src/main/db/thread-indexer.ts`
- `src/main/ipc/canvas.ts`
- `src/main/ipc/chat.ts` — Claude stream lifecycle guard + stderr capture
- `src/main/session-sources.ts`
- `src/renderer/src/components/Sidebar.tsx`

### Untracked new files
- `src/main/ipc/session-title-generation.ts`
- `src/renderer/src/components/sidebar/session-open.ts`
- `src/renderer/src/components/sidebar/session-title-generation.ts`
- `test/session-openability.test.ts`
- `test/session-title-generation.test.ts`
- `docs/command-cli-harvest-status.md`
- `docs/plans/2026-04-21-command-code-harvest-next-bursts.md`
- `docs/plans/2026-04-22-codesurf-solo-harvest-plan.md`
- `docs/research/` (directory)

---

## Open Threads

- **ChatTile phantom liveness pulse on reload** — `isStreaming` restored from disk at mount (line 3218) with no guard; tiles saved with `isStreaming: true` pulse indefinitely on reload. Needs fix before calling chat tile stable.
- **JSON/JSONL prettify in Monaco editor** — User asked, sessions crashed before work happened. Likely unimplemented; confirm before claiming done.
- **Nyx `agent-pty` stack** — Only a plan exists; no code written yet. Start by creating a namespaced `agent-pty` IPC module, not modifying `terminal.ts`.
- **Solo harvest execution** — Plan written, not yet executed. Key next seams: runtime primitive types in `src/shared/types.ts`, trust/review in `src/main/permissions.ts`, summary persistence in `src/main/storage/`.
- **Session title generation tests** — `test/session-title-generation.test.ts` is untracked; verify tests pass before considering this feature done.
- **Session openability tests** — `test/session-openability.test.ts` is untracked; same status.
- **`src/main/ipc/chat.ts` dirty state** — Stream-replacement guard + stderr capture both present; confirm coherence and stage before committing.
- **`.mcp.json` in repo root** — Should be gitignored or templated; current state dirty with live port.
- **Daemon dreaming renderer UI** — Explicitly deferred; `mainStatusBarDreaming.ts` surface present but background dashboard unification not complete.
- **Vite chunking warnings** — `PanelLayout.tsx` and `MediaTile.tsx` emit pre-existing chunk-size warnings; non-blocking.
- **AGENTS.md SDK version** — Documents 0.2.79; installed is 0.2.118; update when convenient.

---

## Gotchas and Non-Obvious Rules

- MCP server port is random at startup — always read `~/.contex/mcp-server.json`; never hardcode
- `node-pty` requires native rebuild after any dependency changes: `npm run rebuild`
- Canvas undo holds full state snapshots (max 50) — do not push to undo stack in hot render/event paths
- `App.tsx` is ~1700 LOC — all 2D canvas physics lives here; changes ripple widely
- `@opencode-ai/sdk` is ESM-only; loaded via dynamic `import()` inside a try/catch; failure expected in CJS environments
- `isStreaming` must not be saved as `true` in tile persistence — currently no mount-time guard exists (line 3218)
- Title sanitizer must strip Codex CLI startup/crash banner text from candidates — prior bug where operational output leaked into titles
- `allowDangerouslySkipPermissions: true` required in SDK 0.2.118+ for bypass permission mode; `permissionMode: 'bypassPermissions'` alone is not enough
