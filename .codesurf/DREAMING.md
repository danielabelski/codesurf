# CodeSurf — Generated Dream Memory

*Generated: 2026-06-20*

---

## Overview

CodeSurf (formerly "contex" — the internal name persists in paths: `~/.contex/`, `window.contex`) is an Electron desktop app providing an infinite 2D canvas where tiles (terminal, code editor, browser, kanban, chat) live side-by-side. AI agents connect over MCP and interact with canvas/kanban state asynchronously alongside humans.

---

## Durable Facts

**Project identity**
- Public product name: **CodeSurf**; internal/legacy namespace: `contex` (don't rename paths)
- Root: `/Users/jkneen/clawd/collaborator-clone`
- Active branch: `feature/event-bus-mcp`; `src/main/ipc/chat.ts` is untracked
- TSC baseline is dirty (~145 pre-existing errors); measure regressions per-file, not by exit code
- `npm install` can wipe the Electron dist binary — re-extract from cache if "Electron uninstall" crash appears

**Runtime topology**
- Electron main process + React renderer (electron-vite); renderer bundle stays on `ai@6`
- Daemon (`packages/codesurf-daemon/`, raw Node ESM `codesurfd.mjs`) is a SEPARATE child process — singleton per `~/.codesurf` (pid.json)
- `node_modules/@codesurf/daemon` must be a **symlink → packages/codesurf-daemon**; `npm install` at the root may overwrite it with the stale `file:` copy — re-symlink after any root install
- MCP server starts on a random port; config at `~/.contex/mcp-server.json` — always read from file, never hardcode
- Canvas state auto-saved (500 ms debounce) to `~/.contex/workspaces/{id}/canvas.json`

**Persistence**
- File-based only, no cloud sync
- Workspace canvas: `~/.contex/workspaces/{id}/canvas.json`
- Kanban tile state: `~/.contex/workspaces/{id}/tiles/{tileId}.json`
- MCP config: `~/.contex/mcp-server.json`
- Agent sessions: `~/.codesurf/agent-sessions`
- Pi agent sessions: `~/.pi/agent/sessions`
- Tom Doerr tweet dedup state: `/Users/jkneen/clawd/memory/tom-doerr-seen.json`

**Canvas engine gotchas**
- `App.tsx` is ~1700 LOC — surgical edits only; changes ripple widely
- Undo snapshots full state (max 50) — don't push to undo stack in hot paths
- Tiles are `React.lazy` + `Suspense`; node-pty requires `npm run rebuild` after dep changes

---

## Active Subsystems

**Chat tile UI (recent changes)**
- THOUGHT chips: 3+ consecutive thought chips collapse into a single `N×THOUGHT` grouped chip; clicking expands back to individual chips; reuses existing grouped tool-chip style
  - Files: `src/renderer/src/components/chat/toolChipCollation.ts`, `src/renderer/src/components/chat/ToolBlockView.tsx`, `src/renderer/src/components/chat/ChatTileTranscriptMessages.tsx`
- Agent name removed from transcript header — it is already shown in the prompt area; do not re-add it to the transcript
- Chip border style: outer 0.5px dark border + 0.5px light border (both applied); inner dark border variant was dropped in the A/B test

**Session sidebar / session sources**
- Pi/csagent sessions now scanned from both `~/.codesurf/agent-sessions` and `~/.pi/agent/sessions`
- Pi session parsing strips the injected CodeSurf prompt convention from displayed user prompts
- `csagent` added as a session source type in `src/shared/session-types.ts`
- Sidebar renders Pi Agent label/icon for these sessions
  - Files: `src/main/session-sources.ts`, `src/shared/session-types.ts`, `src/renderer/src/components/sidebar/utils.tsx`

**Harness runtime** (daemon-side, opt-in)
- Enabled via `settings.harness.enabled` in `~/.codesurf/settings.json` OR `CODESURF_HARNESS=1`
- 101 daemon tests green
- Worktree isolation: per-job dir under `<daemonHome>/harness/sessions/<provider>-<jobId>`; git worktree snapshot + apply back to live workspace on success; failed turns discard cleanly
- Supported providers: `claude`, `codex`, `pi` (`@ai-sdk/harness-pi`)
- Known v1 gap: pre-existing gitignored files (`.env`, `node_modules`) are not materialized in the worktree — agent can't read/update them
- Codex harness: wired but blocked by deprecated config warnings in `~/.codex/config.toml` (`[features].codex_hooks` → `[features].hooks`) — user must update their codex config
- Per-tool interactive approval works via daemon's existing `awaitToolPermissionAnswer` flow; 100-round guard in place
- Desktop never sends `useHarness:true` via UI — the opt-in path is daemon-side only for now
- Bootstrap cached at `/tmp/harness/claude-code` (one-time ~442 MB cost)

**Extension broker / plugin platform**
- Architecture doc: `docs/plugins/00-architecture.md`
- P0–P9 phases landed; bundled plugins migrated to `@codesurf/ui`
- Broker child `createCtxProxy()` uses fire-and-forget `call('ipc', 'handle', ...)` — unhandled rejections surface as `UnhandledPromiseRejectionWarning` when main rejects duplicate channel registration
- **In-progress fix** (`fix-omniagent-extension-halt`): coalesces concurrent extension loads, serializes registry rescans, makes broker-child IPC capability calls catch/log rather than throw, makes broker host re-registration idempotent for `ext:<id>:` channels; new test `test/extension-loading-hardening.test.ts` (untracked); `npm run build` passes, targeted tests updated — not yet committed
- Affected files (staged, uncommitted): `src/main/extensions/broker/child-entry.ts`, `src/main/extensions/broker/host.ts`, `src/main/extensions/registry.ts`, `src/main/ipc/extensions.ts`, `src/main/ipc/fs.ts`, `test/agent-cli-contracts.test.ts`, `test/broker-ctx-proxy.test.ts`
- `agent-kanban` re-migration to `@codesurf/ui`: still pending

**Omnigent provider**
- Daemon runner landed: commit `816fef8`; desktop wiring commit `6807973`
- "Unsupported provider: omnigent" error = stale daemon symlink — re-symlink `node_modules/@codesurf/daemon` and restart daemon
- Evidence files in `.plans/evidence/port-desktop-omnigent-*` document the wiring work (untracked)

**Chat providers**
- Claude: `@anthropic-ai/claude-agent-sdk` 0.2.79 (session resumption, adaptive thinking)
- Codex: codex CLI subprocess; requires `--ignore-user-config` flag to avoid stale MCP transport hangs; codex exec OPTIONS must come before `resume` subcommand on multi-turn resume (fix: `ef90b90`)
- OpenCode: `@opencode-ai/sdk` 1.2.27 HTTP server; known issue — OpenCode exits with code 1 on some sessions (observed with grok-4.20-multi-agent-0309); no root cause identified yet
- Omnigent: wired (`6807973`); see stale-symlink note above
- Pi/csagent: resolves `@ai-sdk/harness-pi` 0.73.1 dynamically; batch events on `message_end`
- All providers stream NDJSON/SSE via `src/main/ipc/stream.ts`
- Session isolation hardened (`6c389a4`): isolates provider sessions, hardens daemon routing
- Daemon chat continuity fix merged: branch `polly/daemon-resume-argfix` (`bf2608f`)

**OpenClaw cron jobs (as of 2026-06-20)**
- `Urgent Email Alert`: HEARTBEAT_OK (10:15 UTC, script `bash /Users/jkneen/clawd/scripts/email-alert-check.sh`)
- `Tom Doerr Tweet Tracker`: blocked — Twitter login wall prevents web_fetch and browser tool navigation; browser tool with `profile="chrome"` is the confirmed correct path; snapshot step still unverified; dedup state at `/Users/jkneen/clawd/memory/tom-doerr-seen.json`
- `VibeClaw Skills Scout`: completed (10:03 UTC) — 8 new items added
- `VibeClaw Wallpaper Generator`: partial assistant turn failures — some turns failed before producing content, others succeeded
- `VibeClaw Article Generator`: 0 articles published — web_fetch blocked (Verge fragment only, Reuters blocked), web search returned permission error; cannot cross-verify to 3 sources as required by cron rules
- `Smart Summary + Highlights`: completed (prior run 16:00 UTC) — daily briefing

**OpenClaw sessions**
- `main` (openclaw/main): heartbeat + crons running normally
- Lead agent `Ava` (board `c3f78d0c-abf3-45d5-898e-27cd1d95c0d1`): HEARTBEAT_OK
- MC Gateway `894a3d5b-7faa-4c0a-a40f-69fbdee7b78d`: **all assistant turns failing** — "connection refused"; every heartbeat produces `[assistant turn failed before producing content]`; root cause unknown
- `hello` (codex/gpt-5.5): Slack MCP OAuth expired — `Bearer resource_metadata` 401; needs re-auth
- `checking` (omnigent/omnigent:default): "Unsupported provider" — stale daemon symlink; re-symlink + restart to fix
- Two `claude session` (claude/claude-fable-5): no messages sent yet

**World-of-claudecraft** (read-only parallel extraction, 2026-06-20)
- Multiple parallel codex sessions analyzed multiplayer architecture at `/Users/jkneen/Documents/GitHub/world-of-claudecraft`
- Focus: authoritative simulation loop, tick rate, data model, protocol/message types, REST vs WebSocket, realm/server process model, database boundaries, deterministic shared sim reuse
- Gameplay content is declarative, merged via `src/sim/data.ts:55`: `ITEMS`, `MOBS`, `NPCS`, `QUESTS`, `CAMPS`, `GROUND_OBJECTS`, `ZONES`, `DUNGEONS`
- No persistent exploration/fog-of-war state — computed from current position + static `ZoneDef`/POI data
- XP currently only awarded for kills and quest turn-ins; PRD lists exploration/discovery/gathering as desired sources (not yet implemented)
- Key env knobs (code-only, not in `.env.example`): `GITHUB_REPO`, `GITHUB_TOKEN`, `WEB_ORIGINS`, `REQUIRE_WEB_LOGIN`, `MAX_WS_PER_IP_*`, `ANTIBOT_ENFORCE`, `CHAT_FILTER_HARD_LIST`, `CHAT_FILTER_HARD_FILE`
- Production URL: `https://worldofclaudecraft.com`; admin at `admin.worldofclaudecraft.com` (proxied; not a security boundary)
- No files edited; all sessions were read-only research

---

## Open Threads

- **Extension halt fix** (`fix-omniagent-extension-halt`): implementation complete, `npm run build` passes, tests updated — **not yet committed**; plan at `.plans/fix-omniagent-extension-halt.md`; new test file `test/extension-loading-hardening.test.ts` also untracked
- **MC Gateway OpenClaw agent** (`894a3d5b…`): all assistant turns failing with "connection refused" — root cause unknown; investigate process/port binding
- **Slack MCP OAuth expired**: `hello` session (codex/gpt-5.5) hit a `Bearer` auth challenge — Slack MCP needs re-auth
- **Tom Doerr tracker**: Twitter blocks both web_fetch and browser navigation; browser + Chrome profile is the correct path — verify snapshot step works on next successful navigation
- **VibeClaw Wallpaper Generator**: intermittent assistant turn failures — may need model/tool diagnosis
- **VibeClaw Article Generator**: fetch blocking (Verge/Reuters) and web search permission error prevent 3-source verification; investigate web search MCP permissions in OpenClaw
- **Omnigent "Unsupported provider"**: stale daemon symlink — re-symlink and restart daemon
- **OpenCode exit code 1**: `hello` session (opencode/grok-4.20-multi-agent-0309) failed immediately with no output; root cause unknown
- **agent-kanban migration** to `@codesurf/ui`: pending
- **Hosted marketplace catalog**: product decision deferred
- **Harness v1 — gitignored files gap**: pre-existing `.env`/`node_modules` not visible to agent in worktree; documented as acceptable v1 tradeoff
- **Harness codex adapter**: wired but non-functional until user fixes `~/.codex/config.toml` (`[features].codex_hooks` → `[features].hooks`)
- **Large session loading**: sessions over 2 MB trimmed by `session-index.mjs` (`MAX_SESSION_LISTING_JSON_BYTES = 2MB`); fix = raise cap or smarter head+tail trim
- **Branch `feature/event-bus-mcp`**: `src/main/ipc/chat.ts` remains untracked

---

## Key File Landmarks

| Path | Purpose |
|---|---|
| `src/renderer/src/App.tsx` | Canvas engine (~1700 LOC) — pan/zoom, drag, undo, groups |
| `src/main/event-bus.ts` | In-process pub/sub, wildcard + ring buffer (500 events) |
| `src/main/mcp-server.ts` | Local HTTP MCP 2.0 server (random port, 17 tools) |
| `src/main/ipc/stream.ts` | NDJSON/SSE streaming for all chat providers |
| `src/main/ipc/chat.ts` | Chat IPC handlers (untracked) |
| `src/main/session-sources.ts` | Session scanning — now includes Pi paths |
| `src/shared/session-types.ts` | Session source type definitions — `csagent` added |
| `src/renderer/src/components/sidebar/utils.tsx` | Sidebar session label/icon rendering |
| `src/renderer/src/components/chat/toolChipCollation.ts` | Chip grouping logic — THOUGHT chip collation |
| `src/renderer/src/components/chat/ToolBlockView.tsx` | Tool/thought chip rendering |
| `src/renderer/src/components/chat/ChatTileTranscriptMessages.tsx` | Transcript message layout — agent name removed from header |
| `src/main/extensions/broker/child-entry.ts` | Broker child process — fire-and-forget IPC proxy (active fix) |
| `src/main/extensions/broker/host.ts` | Broker host — IPC handler registration in main process (active fix) |
| `src/main/extensions/registry.ts` | Extension registry — rescan / activate / deactivate (active fix) |
| `src/main/ipc/extensions.ts` | Extension IPC surface — ensureLoaded, concurrency lock (active fix) |
| `test/extension-loading-hardening.test.ts` | New test for extension load coalescing (untracked) |
| `packages/codesurf-daemon/bin/harness-runtime.mjs` | LocalHostSandboxProvider + harness job runner |
| `packages/codesurf-daemon/bin/harness-worktree.mjs` | Worktree snapshot + apply logic |
| `packages/codesurf-daemon/bin/harness-settings.mjs` | `isHarnessEnabled()` — reads settings + env |
| `docs/plugins/00-architecture.md` | Plugin platform architecture |
| `.plans/fix-omniagent-extension-halt.md` | Active plan for extension halt fix |
| `~/.codesurf/settings.json` | `settings.harness.enabled` to opt into harness |
| `~/.contex/mcp-server.json` | MCP server config (random port written here on start) |
