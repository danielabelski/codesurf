# CodeSurf Workspace — Generated Memory

## Overview

CodeSurf (formerly "Contex" internally) is an Electron desktop app: an infinite 2D canvas workspace where tiles (terminal, code editor, browser, kanban, chat) host AI agents and human collaborators. Project root: `/Users/jkneen/clawd/collaborator-clone`. Public name is **CodeSurf**; `window.contex`, `~/.contex/`, `contex-relay` are legacy internal identifiers still in code — never surfaced to users.

---

## Durable Facts

### Identity & Naming
- Product name: **CodeSurf** (not Contex, not contex)
- Legacy identifiers still in code: `window.contex`, `~/.contex/`, `contex-relay`
- User: Jason Kneen, Europe/London, jason@bouncingfish.com

### Repo Structure
- Root is NOT an npm workspace; `packages/codesurf-daemon` is a `file:` dependency
- **Critical symlink:** `node_modules/@codesurf/daemon` must point to `packages/codesurf-daemon` (live source); `npm install` can overwrite with a stale copy — re-symlink after any root install
- Daemon singleton tracked via `~/.codesurf/pid.json`; launched from `bin/codesurfd.mjs`
- `packages/codesurf-daemon/node_modules` is gitignored; prod packaging must ship it

### Tech Stack (pinned)
- Electron 40.8.2 / React 19.2.4 / TypeScript 5.9.3 / electron-vite / Tailwind CSS 4
- xterm + node-pty (terminal); Monaco (code tiles); chokidar (fs watch)
- `@anthropic-ai/claude-agent-sdk` 0.2.79; `@opencode-ai/sdk` 1.2.27
- Daemon: raw-Node ESM, separate child process, never bundled with renderer

### Canvas Engine
- All 2D physics (pan/zoom, drag, resize, snap, groups, undo/redo) in `src/renderer/src/App.tsx` (~1700 LOC) — be surgical
- Undo holds full snapshots (max 50); never push to undo stack in hot paths
- Tiles lazy-loaded via `React.lazy` + `Suspense`

### Persistence
- `~/.contex/workspaces/{id}/canvas.json` — auto-saved, 500ms debounce
- `~/.contex/workspaces/{id}/tiles/{tileId}.json` — kanban state
- `~/.contex/mcp-server.json` — MCP config (random port — always read from file)
- `~/.codesurf/settings.json` — daemon settings (harness, omnigent, etc.)

### Style Rules
- No emoji — SVG icons, CSS shapes, or text labels only
- Extension tiles: never `prefers-color-scheme`; default light CSS; apply `body.dark` via bridge; solid hex not rgba opacity
- Dark theme hardcoded: `#1e1e1e`, `#252525`, `#333`
- Tailwind + inline `React.CSSProperties`; strict TS; 2-space indent, trailing commas, no semicolons
- Images: `sips -s format png <input> --out /tmp/<name>.png` before reading (macOS HEIC-in-PNG trap)

### TypeScript Baseline
- ~145 pre-existing tsc errors — measure regressions per-file, not by exit code
- Use `npm run build` as the primary regression gate (electron-vite, ~26-39s)

### Native Rebuild
- node-pty requires `npm run rebuild` after any dependency change
- Electron binary footgun: `npm install` can wipe Electron's dist binary — re-extract from npm cache zip if it crashes on launch

---

## Active Subsystems & Capabilities

### Chat Providers (`BuiltinProvider` union)
`'claude' | 'codex' | 'opencode' | 'openclaw' | 'hermes' | 'omnigent' | 'csagent'`

| Provider | Integration | Notes |
|---|---|---|
| claude | `@anthropic-ai/claude-agent-sdk` | Session resumption, adaptive thinking; OAuth via `~/.claude.json` |
| codex | codex CLI subprocess | Auth via `~/.codex/auth.json`; use `--ignore-user-config` flag to avoid stale MCP transport hangs from `~/.codex/config.toml` |
| opencode | `@opencode-ai/sdk` HTTP server | |
| openclaw | OpenClaw agent gateway | Heartbeat-polled sessions |
| hermes | HTTP provider | Needs `ANTHROPIC_TOKEN` or `ANTHROPIC_API_KEY` in env; separate desktop app at `/Users/jkneen/.hermes/hermes-agent/apps/desktop` |
| omnigent | SSE wire (`/v1/sessions`, `/v1/agents`), default `http://127.0.0.1:6767` | `omnigent:<encoded-agent-id>` model ID; `omni` CLI; `enabled` defaults true |
| csagent | Pi-based internal agent; UI label "Pi" | Never surface "csagent" internals; resolves `@mariozechner/pi-coding-agent` 0.73.1 from `~/.pi/npm` or global roots |

All providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.

### Daemon Chat Dispatcher (`packages/codesurf-daemon/bin/chat-jobs.mjs`)
- Routes by `request.provider`; per-provider helper modules (`codex-sdk-provider.mjs`, `omnigent-provider.mjs`)
- Harness opt-in: `request.useHarness === true`, `CODESURF_HARNESS=1`, or `settings.harness.enabled` in `~/.codesurf/settings.json`

### Harness Runtime (`bin/harness-runtime.mjs`)
- Proven end-to-end: `@ai-sdk/harness@1.0.0-canary.9` + `ai@7-canary` isolated in daemon's own `node_modules`
- Root stays on `ai@6` — no bundler conflict by design
- Three adapters: `claude` (via `harness-claude-code`), `codex` (wired, blocked by env), `pi` (Vercel's `@ai-sdk/harness-pi`, proven)
- Per-session isolated workdir: `<daemonHome>/harness/sessions/<provider>-<jobId>`
- Workspace binding: git worktree snapshot → agent works in worktree → changes synced back on success; non-git falls back to live workspace
- Gitignored files created by the agent are recovered and applied (cap: 500 files)
- Bootstrap cached at `/tmp/harness/claude-code` (442M, harnessId-keyed, one-time cost)
- Tool approval: harness `tool-approval-request` parts wired to `awaitToolPermissionAnswer` → `tool_permission_request` event → desktop prompt
- **101/101 daemon tests verified green** (as of 2026-06-15 after harness branch merges)
- Pre-existing gitignored files (`.env`, `node_modules`) are NOT visible to agent in worktree — known v1 limitation
- Enable: `settings.harness.enabled` in `~/.codesurf/settings.json` or `CODESURF_HARNESS=1`

### Omnigent Provider
- PR #18 merged to main (commit `6807973`, 2026-06-15)
- Wire: `POST /v1/sessions` → create; `GET /v1/sessions/{id}/stream` → SSE; `POST /v1/sessions/{id}/events` → push; `GET /v1/agents` → discovery
- Settings: `settings.omnigent.{enabled,baseUrl,apiKey,agentId,autoStart}` in `~/.codesurf/settings.json`
- "Unsupported provider: omnigent" at runtime = stale daemon; fix: re-symlink `node_modules/@codesurf/daemon → packages/codesurf-daemon` and restart

### Plugin Platform
- In-progress rebuild of extension system; spec at `docs/plugins/00-architecture.md`
- `packages/codesurf-plugin/` — stable author contract (`definePlugin`, `CodesurfBridge`)
- `@codesurf/ui` control kit at `src/renderer/src/components/codesurf-ui/index.tsx`
- **Landed (build-verified):** P0–P9 phases complete including foundations, capability gate, Command Palette (⌘⇧P), Plugin Store, MCP-UI host, Pi/csagent runtime, layout presets (guillotine), `@codesurf/plugin` SDK, marketplace install-from-file, onboarding overlay + auto-update wiring
- All 10 bundled plugins migrated to `@codesurf/ui` kit (324 bespoke CSS lines removed); `agent-kanban` still needs re-migration
- `cluso-widget` is optional local dep (`file:../agentation-real`) — may not exist in all environments
- **Remaining:** hosted remote marketplace catalog (product decision); deeper P5 Pi tool bridge / permission gating; runtime smoke test via `npm run dev` still the confidence gap for Pi streaming, slash interception, mcp-ui mount

### IPC Convention
`{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `terminal:write`, `bus:publish`

### Event Bus
- Main-process pub/sub, wildcard subscriptions (`tile:*`, `*`), ring-buffer 500 events/channel, no persistence

### Pi / csagent Runtime
- Resolves `@mariozechner/pi-coding-agent` 0.73.1 dynamically from `~/.pi/npm` or nvm/pnpm roots
- Events emitted as batch on `message_end`, NOT per-token — translator reads `message_end.message.content` array; do not assume streaming
- Sessions at `~/.codesurf/agent-sessions`; auth shared with pi CLI (`~/.pi/agent/auth.json`)
- 52 auth-configured models available via `ModelRegistry.getAvailable()`
- `new.jsonl` collision fixed: uses `SessionManager.create()` + `findSessionFile()` for history continuity

### Codex Provider (daemon)
- `buildCodexExecArgs` in `chat-jobs.mjs` was fixed: exec-level flags (`--json`, `--model`, `-C`, sandbox flags) must come BEFORE `resume <sessionId>` — clap parser requires this ordering
- Fix committed (uncommitted diff on `packages/codesurf-daemon/bin/chat-jobs.mjs` as of 2026-06-17); test at `packages/codesurf-daemon/test/codex-exec-args.test.mjs` (untracked)
- Use `--ignore-user-config` flag when spawning codex CLI — prevents `~/.codex/config.toml` MCP servers from causing transport errors/hangs
- Codex has its own `~/.codex/hooks.json` permission layer separate from harness tool approval

---

## Known Bugs (Investigated, Not Yet Fixed)

### Claude turns:0 / cost:0 — Cross-provider session-id contamination
- **Root cause:** `findLatestDaemonSessionIdForCard` in `grok-cli/src/daemon/session-repair.ts:107-112` selects the most-recent job for a card by `cardId + workspaceDir` only — **does not filter by provider**
- If the last job was codex, its UUID v7 thread id is passed as `resume:` to the Claude SDK
- Claude SDK is handed a foreign id with no transcript on disk → returns `num_turns:0`, `total_cost_usd:0`, zero assistant content
- Diagnosis: UUID v7 = codex/omnigent; UUID v4 = Claude session. `019ecd2c-…` (v7) caused the failure; `c92228fd-…` (v4) worked
- **Fix needed in: `grok-cli/src/daemon/session-repair.ts:107-112`** — add `job.provider === targetProvider` to the `find` predicate
- See `docs/claude-daemon-turns0-findings.md` for full evidence trail

### Claude context loss on resume — Total amnesia on session-id miss
- **Root cause:** `runClaudeJob` (`chat-jobs.mjs:1222,1383`) sends only the last user message and discards the full `messages` array, relying entirely on `resume` for history continuity
- If session id is absent on any turn → total context loss, not just last exchange
- `this.sessionId` resets on: API-key rotation (`agent.ts:589`), conversation switch (`agent.ts:888`), process restart, consumer error
- Recovery path has two defects: `findLatestDaemonSessionIdForCard` has no provider filter (see above); a missing transcript silently returns no history
- **Fix needed in: grok-cli** (multiple files); see `docs/claude-extension-resume-findings.md` for precise drop points

---

## OpenClaw / Cron Agent Status (as of 2026-06-19)

| Agent | Status | Notes |
|---|---|---|
| Lead agent "Ava" | Healthy — HEARTBEAT_OK | Board `c3f78d0c-abf3-45d5-898e-27cd1d95c0d1`, agent ID `9f5f3df9-2ed7-4efe-9d97-2114fe460a35`; gateway confirmed working 2026-06-19 |
| mc-gateway `894a3d5b-7faa-4c0a-a40f-69fbdee7b78d` | **DOWN** — connection refused | All turns failing; persistent across multiple poll cycles 2026-06-18 and 2026-06-19 |
| Cron: Tom Doerr Tweet Tracker | **FAILING** — X.com fully blocked | State: `/Users/jkneen/clawd/memory/tom-doerr-seen.json`; X.com shows login wall in browser AND blocks direct HTTP fetch; both scraping paths exhausted |
| Cron: VibeClaw Skills Scout | **WORKING** (2026-06-19) | Successfully added 5 items: GLM-5.2, VibeThinker-3B, FastContext-1.0-4B-SFT, Nemotron 3.5 ASR, North-Mini-Code; uses npm as fallback when web search blocked |
| Cron: VibeClaw Article Generator | **PARTIALLY WORKING** (2026-06-19) | Runs and fetches content; web search broken in cron context; fell back to official source fetches; could not achieve 3-source verification threshold — published nothing (correct per its own rules) |
| Cron: VibeClaw Wallpaper Generator | **FAILING** — DGX offline | DGX at `192.168.4.104:8003` unreachable on 2026-06-19; all 3 generation attempts failed |

**Updated pattern:** The 2026-06-18 "systemic startup crash" affecting most cron sessions appears resolved — Skills Scout and Article Generator ran successfully on 2026-06-19. Tom Doerr Tracker and Wallpaper Generator failures are caused by independent external blockers (X.com auth wall; DGX offline), not an OpenClaw infrastructure issue.

**VibeClaw Article Generator behaviour:** Web search is consistently broken in the cron execution context. The agent correctly refuses to publish when it cannot reach 3 independent sources. Official company blogs (OpenAI, Anthropic) are reachable via direct fetch and serve as source-1.

---

## Recent Branch / Commit Activity

- **main** — current branch; PR #18 (omnigent provider) merged at commit `6807973` (2026-06-15)
- **Uncommitted changes on main (as of 2026-06-17):**
  - `packages/codesurf-daemon/bin/chat-jobs.mjs` — codex exec arg ordering fix
  - `.grok/settings.json`, `.mcp.json` — modified
  - `.polly/registry.json` — deleted
  - **Untracked:** `.codesurf/` dir, `docs/claude-daemon-turns0-findings.md`, `docs/claude-extension-resume-findings.md`, `packages/codesurf-daemon/test/codex-exec-args.test.mjs`
- **feature/event-bus-mcp** — universal event bus, MCP upgrade, chat tile, bus bridges (precursor branch, not current)
- **Persona / CLI chain** — PRs #13–#17 merged: persona-model binding, cx0 chat CLI, persona-souls, cli-mcp-noise suppression, skill-model lock

---

## Open Threads

- **mc-gateway process down** — session `894a3d5b-…` consistently connection refused across 2026-06-18 and 2026-06-19; gateway process needs restart or re-provision
- **Tom Doerr Tweet Tracker** — X.com browser session logged out AND direct HTTP fetch blocked; needs Nitter instance, official API, or RSS feed approach
- **VibeClaw Article Generator web search** — web search is broken in the cron execution context; agent correctly self-silences without 3 sources; root cause of broken web search not yet diagnosed
- **DGX server offline** — `192.168.4.104:8003` unreachable; VibeClaw wallpaper generation blocked
- **Codex exec args fix** — diff exists in `chat-jobs.mjs` + test at `packages/codesurf-daemon/test/codex-exec-args.test.mjs`; both untracked/uncommitted — needs committing
- **Claude turns:0 bug** — fix is in grok-cli (`session-repair.ts`), not this repo; add provider filter to `findLatestDaemonSessionIdForCard`
- **Claude context loss** — multiple drop points in grok-cli; see `docs/claude-extension-resume-findings.md`; `runClaudeJob` architecture (last-message-only + resume-only) is the structural amplifier
- **Pi runtime smoke test** — streaming, slash interception, mcp-ui mount need `npm run dev` live verification (Electron requires display)
- **Codex harness** — wired but blocked by `~/.codex/config.toml` deprecation warnings; update config (`[features].hooks` not `[features].codex_hooks`)
- **agent-kanban plugin** — not migrated to `@codesurf/ui` kit during P8 pass; needs dedicated re-migration
- **Pre-existing gitignored files in worktree** — `.env`, `node_modules` not materialized for harness agent; documented v1 limitation
- **Large session loading** — `session-index.mjs` trims transcripts over 2MB; fix: raise `MAX_SESSION_LISTING_JSON_BYTES` or smarter head+tail trim
- **Hosted marketplace catalog** — install primitive + capability gate exist; remote registry source URL/trust model is a product decision pending
- **Capability gate re-consent UI** — plugins updated with new capabilities don't trigger re-consent; deferred

---

## Key Gotchas

- `npm install` at repo root can overwrite the `@codesurf/daemon` symlink — always re-symlink: `ln -sfn ../../packages/codesurf-daemon node_modules/@codesurf/daemon`
- MCP server port is random — always read from `~/.contex/mcp-server.json`, never hardcode
- Pi agent emits events in batch on `message_end`, not per-token — translator must handle both shapes on any version bump
- App.tsx is ~1700 LOC; canvas engine changes ripple widely — be surgical
- node-pty requires `npm run rebuild` after dependency changes
- `codex` CLI: use `--ignore-user-config` to skip `~/.codex/config.toml` MCP servers (avoids hangs from auth-required servers like slack/stripe)
- OAuth auth (claude/pi) relies on inherited real `$HOME` — overriding HOME breaks auth in harness sessions
- Claude session ids are UUID v4; codex/omnigent thread ids are UUID v7 — a v7 id passed as `resume` to Claude SDK silently returns 0 turns
- VibeClaw Skills Scout falls back to npm registry when web search is blocked — this works; don't treat npm-only runs as degraded
