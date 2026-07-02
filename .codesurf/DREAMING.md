# CodeSurf Workspace — Generated Memory

Last updated: 2026-07-02

---

## Overview

CodeSurf (internal legacy name: contex) is an Electron desktop app — an infinite-canvas workspace where tiles (terminal, code editor, browser, kanban, chat, pets) live on a 2D canvas. AI agents connect via a local HTTP MCP 2.0 server. Current active branch: `main`.

---

## Durable Facts

### Repository state (as of 2026-07-02)
- Current branch: `main`
- Latest commit: `16f2e00` — "Fix chat-send git stall, stream error loss, codex backpressure, settings re-parse; refresh docs + pets facade parity"
- All eleven plans (001–011) tracked in `plans/README.md`
- Only dirty file: `bun.lock` (modified, not committed; `package-lock.json` targets electron 41.3, `bun.lock` targets 41.7 — disagree)

### Recently landed (since last memory)
- `f861473` — Flag-gated canvas perf optimisations: imperative pan, drag RAF coalescing, tile culling, zoom LOD (off by default, gated behind feature flag)
- `16f2e00` — Chat-send: fixed git stall on send, stream error loss, codex backpressure, settings re-parse; pets facade parity; docs refresh

### Plan status
| Plan | Title | Status |
|------|-------|--------|
| 001–004 | Security/guard fixes (broker deactivate, manifest path traversal, workspace scope, channel validation) | DONE |
| 005 | Unit tests for `isPowerActivationPermitted` | **TODO** — unblocked |
| 006 | Quick cleanups (tile-type normalisation, test glob, LiveKit creds) | **TODO** — unblocked |
| 007–011 | Runtime fixes + security (Codex abort, PTY exit, Pets, MCP token scope, fs denylist) | DONE |

---

## Active Subsystems

### Canvas engine
- All 2D physics (pan/zoom, drag, resize, snap, groups, undo/redo) in `src/renderer/src/App.tsx` (~1944 LOC)
- Undo: full-state snapshots, max 50 — never push to undo stack in hot paths
- New flag-gated path: imperative pan + RAF-coalesced drag + culling + zoom LOD (all off by default)

### Chat / streaming
- Providers: Claude (`@anthropic-ai/claude-agent-sdk`), Codex (CLI subprocess), OpenCode (`@opencode-ai/sdk`)
- All stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`
- Recent fix (`16f2e00`): codex backpressure resolved; git stall on send fixed; stream error loss closed

### Harness (daemon-side, desktop UI pending)
- `packages/codesurf-daemon/bin/harness-runtime.mjs` — `LocalHostSandboxProvider` + `createHarnessRunner`
- Supports providers: claude, codex (auth-broken locally — codex config deprecation warnings), pi (`@ai-sdk/harness-pi`)
- Worktree isolation: agent edits happen in a throwaway git worktree → applied to live workspace on success; non-git falls back to live
- Gitignored-file recovery: agent-created ignored files are enumerated and applied (capped at 500)
- Tool approval loop wired via existing daemon `awaitToolPermissionAnswer` mechanism
- Opt-in: `settings.harness.enabled` in `~/.codesurf/settings.json` OR `CODESURF_HARNESS=1` env; desktop never sends `useHarness:true` — dormant in production
- **CAUTION:** `node_modules/@codesurf/daemon` must be a symlink to `packages/codesurf-daemon/` — `npm install` may overwrite it with a stale copy (re-symlink after every install)
- Desktop `useHarness` toggle: not yet built

### MCP server
- Random port at startup; config at `~/.contex/mcp-server.json` — never hardcode port
- 34 tools exposed; results propagate to canvas/kanban via event bus
- SEC-05 open: per-tile token guards wired but dormant — callers never send tile tokens; fix = pass `tileId` into `buildContexHttpMcpServerEntry`

### Cron agents (status as of 2026-07-02)
| Cron | Status | Notes |
|------|--------|-------|
| Urgent Email Alert | **OK** | HEARTBEAT_OK at 10:01 UTC |
| Tom Doerr Tweet Tracker | **Blocked** | X.com login wall; Chrome agent profile not authenticated |
| VibeClaw Skills Scout | **Failing** | Assistant turn fails before content (repeated) |
| VibeClaw Wallpaper Generator | **Failing** | Assistant turn fails before content (repeated) |
| VibeClaw Article Generator | **Failing** | Assistant turn fails before content (repeated) |
| OpenClaw Lead heartbeat | **OK** | Gateway OK, heartbeat passing |
| OpenClaw MC Gateway heartbeat | **Unstable** | Turn failures + partial recovery; localhost:8000 connection refused |
| Codex gpt-5.5 image session | **Completed** | Generated 8 ship-material PNGs via `gpt-image-2`; script at `generate_ship_mats.py` |

---

## Open Threads

- **Plans 005 & 006** — only remaining unexecuted plans; both unblocked and independent
- **SEC-05** — MCP per-tile token guards dormant; fix is `tileId` propagation into MCP server entry builder
- **Harness desktop UI** — daemon fully built and tested; desktop toggle not wired; re-symlink `node_modules/@codesurf/daemon` after every `npm install`
- **VibeClaw crons** — three cron agents failing before content; root cause unknown (not an X.com auth issue — separate from the tweet tracker); needs investigation
- **bun.lock drift** — only uncommitted file on `main`; electron version mismatch between lock files
- **gpt-5.5 in providers.ts** — Codex sessions are using it; verify it appears in `src/renderer/src/config/providers.ts` DEFAULT_MODELS
- **Large session loading** — `session-index.mjs` trims transcripts over 2 MB (`MAX_SESSION_LISTING_JSON_BYTES`); 13 MB+ sessions show only a sliver in the desktop conversation list

---

## Hard-Won Rules

- `App.tsx` is ~1944 LOC — be surgical; changes ripple widely
- `node-pty` requires native rebuild after dep changes (`npm run rebuild`)
- MCP server port is random — always read from config, never hardcode
- Canvas undo holds full snapshots — never push in hot paths
- `cluso-widget` is an optional `file:` dep (`file:../agentation-real`) — may not exist
- `ThinkingBlockView` and `WorkingChipView` are independent components — changing chrome on one must not touch the other (caused three regressions)
- Canvas overlap issues → check `App.tsx` z-index (`bringToFront`, `nextZIndex`) first; do not add `position: relative` + `zIndex` to transcript rows
- `textTransform: uppercase` on spans containing `${n}s` renders as `NS` — use separate elements or remove transform
- Chip expand: use `React.startTransition`; collation system is already lazy
- Extension tiles: never use `prefers-color-scheme`; default to light CSS; apply `body.dark` via bridge; use solid hex not rgba opacity
- Never surface `pi`/`earendil` to users — `src/main/chat/pi-runtime.ts`/`csagent` is a separate internal provider, not the harness `@ai-sdk/harness-pi`
