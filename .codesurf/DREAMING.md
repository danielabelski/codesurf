CodeSurf — Generated Memory (2026-07-15)

## Overview

CodeSurf is an Electron desktop app providing an infinite-canvas workspace where tiles (terminal, code editor, browser, kanban, chat) live on a 2D canvas. AI agents connect via MCP and collaborate with humans asynchronously. Multi-target architecture is live: one React renderer shared across Electron (full), browser PWA, and a Native Zig WebView shell. Reference: `docs/multi-target.md`.

CodeSurf is actively used as an agent orchestration platform — Canvas Codex tiles run as specialised subagents in external projects. This is expected behaviour, not changes to this repo.

---

## Durable Facts

### Identity

- Product name: **CodeSurf** — never "contex" in user-facing copy
- Legacy internal namespace (`window.contex`, `~/.codesurf/`) remains stable — do not rename
- Package `contex-relay` was renamed to `codesurf-relay` in commit `ba94e3a` — update any remaining references

### Codebase Anchors

| Area | Path |
|---|---|
| Electron main entry | `src/main/index.ts` |
| Event bus | `src/main/event-bus.ts` |
| MCP server (34 tools) | `src/main/mcp-server.ts` |
| IPC handlers (41 files) | `src/main/ipc/` |
| Canvas engine (~1944 LOC) | `src/renderer/src/App.tsx` |
| Tile components (lazy) | `src/renderer/src/components/` |
| Shared types | `src/shared/types.ts` |
| Stream parser | `src/main/ipc/stream.ts` |
| Agent room store | `src/main/agent-room/` (`index.ts`, `store.ts`, `types.ts`) |
| Webview paint bridge | `src/shared/webview-paint-bridge.ts` |
| Platform detect + transport | `src/renderer/src/platform/terminalTransport.ts` |
| Platform layer | `src/renderer/src/platform/` (detect, daemonBridge, hostConfig, nativeRuntimeConfig, pickFolder, pwa) |
| Terminal gateway package | `packages/codesurf-terminal-gateway/` |
| Daemon package | `packages/codesurf-daemon/` |
| Plugin package | `packages/codesurf-plugin/` |
| Relay package | `packages/codesurf-relay/` |
| Chat bridge package | `packages/codesurf-chat-bridge/` |
| Native Zig launcher | `desktop/src/sidecar_launcher.zig` |
| Native runner/main | `desktop/src/runner.zig`, `desktop/src/main.zig` |
| Web host | `scripts/web-host.mjs` |
| Web dev loop | `scripts/web-dev.mjs` |
| Desktop dev loop | `scripts/desktop-dev.mjs` |
| Hosted gateway | `scripts/hosted-gateway.mjs` |
| Web preview | `scripts/web-preview.mjs` |
| Desktop sidecar packager | `scripts/desktop-sidecar.mjs` |

### Persistence Locations

- `~/.codesurf/workspaces/{id}/canvas.json` — auto-saved, 500 ms debounce
- `~/.codesurf/workspaces/{id}/tiles/{tileId}.json` — kanban tile state
- `~/.codesurf/mcp-server.json` — MCP server config (random port — always read from file, never hardcode)

### Build Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Electron (hot reload) — full product |
| `npm run web:dev` | Browser UI + web-host `:4177` + terminal gateway `:4178` |
| `npm run web:preview` | Serve production web build (PWA installable) |
| `npm run web:pwa` | web:dev with service worker for install testing |
| `npm run desktop:dev` | Native SDK WebView shell + web stack |
| `npm run build` | Electron build (main + preload + renderer) |
| `npm run build:web` | Renderer only → `dist/` |
| `npm run desktop:build` | `build:web` + Native package |
| `npm run rebuild` | Native rebuild for node-pty |

### Commit History (as of 2026-07-15)

No new commits since 2026-07-14. HEAD remains at `7c688cb` (Add terminal gateway and Native loopback sidecar).

- `7c688cb` — Add terminal gateway and Native loopback sidecar
- `52921bd` — Upgrade to native zero
- `ba94e3a` — Major collaboration updates (agent-room store, webview-paint bridge, activity cap, `codesurf-relay` rename, peer-state expansion, 15+ new tests)
- `16f2e00` — Fix chat-send git stall, stream error loss, codex backpressure, settings re-parse
- `f861473` — Flag-gated canvas perf optimisations
- `8397448` / `8ba3119` — Security branches merged (shared-sensitive-denylist, mcp-tile-token-scope)

### Working Tree (2026-07-15)

Modified: `.claude/codesurf.md`, `.codesurf/DREAMING.md`, `.codesurf/tile-1783794405365/peers.md`, `.codesurf/tile-1783794514942/peers.md`.
Untracked: `.codesurf/tile-1783949414422/`, `.codesurf/tile-1784011665126/` (idle tiles, no tasks assigned).

---

## Active Capabilities

### Terminal Gateway (`packages/codesurf-terminal-gateway/`)

Committed `7c688cb`. Authenticated WebSocket terminal broker; local PTY and Docker sandbox adapters; single-use attach tokens; backpressure limits; 0600 runtime config output. Fixes TerminalTile P0 on web/Native targets. Integration tests in `test/platform/terminal-transport.test.mjs` and `packages/codesurf-terminal-gateway/test/`.

### Native Zero (`desktop/`)

Committed `52921bd`. Boot screen present. Known issue: white screen on cold start — root cause is `std.process.run` being synchronous; fix requires a persistent async controller path. Build/dev from `~/clawd/github/native` via `zig build dev`.

### Multi-target Data Flow

- Electron → IPC → main → codesurfd
- Browser/Native → HTTP `:4177` (web-host) → codesurfd
- Terminal sessions → gateway `:4178` (WebSocket, attach tokens)
- Platform detection: `__CODESURF_PLATFORM__` marker takes precedence over `window.electron`; daemon-backed facades must not be mistaken for Electron preload
- `src/renderer/src/platform/nativeRuntimeConfig.ts` — reads 0600 sidecar config, sanitises loopback-only values before renderer exposure

### Agent Room (`src/main/agent-room/`)

Added in `ba94e3a`. In-memory store for multi-agent room membership, peer state, and message routing within a canvas session. Exposed via MCP tools and preload. Tests: `test/agent-room.test.ts`.

Active room observed: `457be8cf-26fc-48b5-8049-4298e6e3a8ea` with two linked tiles (`tile-1783794405365` terminal, `tile-1783794514942` chat). MCP servers at `:53312` (contex) and `:64713` (codesurf) confirmed live on 2026-07-14.

### Activity Cap (`src/main/activity-cap.ts`)

Added in `ba94e3a`. Rate-limits agent activity bursts. Tests: `test/activity-cap.test.ts`.

### Webview Paint Bridge (`src/shared/webview-paint-bridge.ts`)

Added in `ba94e3a`. Allows tiles to paint into a shared webview surface; `src/renderer/src/lib/webviewPaint.ts` and `src/main/ipc/webview-paint.ts` wire it end-to-end. Tests: `test/webview-paint.test.ts`.

### Canvas Perf Flags

4 flags ON by default: imperative pan, drag RAF coalescing, culling, zoom LOD. Master off-switch: `CODESURF_PERF_ALL=0`. Reference: `docs/perf-flags.md`. Culling tests: `test/canvas-culling.test.ts`.

### Security — Landed

- `security/shared-sensitive-denylist` — unified sensitive path denylist in `src/main/security/sensitivePaths.ts`
- `security/mcp-tile-token-scope` — MCP tokens scoped per tile; tile scope guards extend to peer state tools; tests: `test/mcp-tile-config.test.ts`

### Chat Chip Chrome Map — Do Not Break

| Component | Chrome |
|---|---|
| `ThinkingBlockView` | Full chip — background + border + shadow |
| `WorkingChipView` | Full chip — background + border + shadow |
| `ToolBlockView` | Full chip — canonical reference |
| `CollationSummaryChip` / group chips | Accent chip — coloured background/border |

- `ThinkingBlockView` and `WorkingChipView` are independent — never edit both in one change
- Canvas overlap issues → check App.tsx `bringToFront`/`nextZIndex` before touching transcript CSS
- `textTransform: uppercase` on spans containing number+unit strings destroys the unit suffix
- Chip expansion: use `React.startTransition` on all expand toggles

### IPC Surface — 41 handlers

Notable additions/areas: `dreaming.ts`, `owl.ts`, `spokify.ts`, `transcribe.ts`, `tts.ts`, `execution.ts`, `jobs.ts`, `agents.ts`, `collab.ts`, `secrets-ipc.ts`, `tile-context.ts`, `webview-paint.ts`, `terminal-exit.ts`, `pets.ts`, `pets-id.ts`, `pets-path.ts`, `activity.ts`, `permissions.ts`.

### Agent Room Protocol (Canvas agents)

On session start: `room_status` → `peer_set_state` → `room_consume`. File conflict rule enforced via `room_post`. All tools prefixed `mcp__codesurf__*`. Full protocol documented in `.claude/codesurf.md`.

---

## External Projects — Canvas Codex Activity

### Electron Test Suite Repair (CodeSurf itself, 2026-07-14)

Codex session (`gpt-5.6-terra`) repaired the Electron test harness:

- Fixed stale pnpm workspace install and Electron runtime payload
- Fixed test-mode macOS shutdown so Electron tests exit cleanly
- Fixed slash-command ranking: exact built-in `/status` now wins over fuzzy-matched skills
- `pnpm build` passes; desktop typecheck passes; Electron smoke passes
- Core Electron lane: **108/111** passed; slash fix resolved two additional failures
- One remaining failure: abort/rename edge case — not yet addressed

### titerm (`/Users/jkneen/Documents/GitHub/titerm`)

Swift terminal emulator package. NOT a git worktree (no `.git`). Multiple Codex sessions (`gpt-5.6-sol`) conducted static code reviews and appended findings to `/Users/jkneen/Documents/GitHub/titerm/review.md` under a `CODEX REVIEW` section. Verdict: **BLOCK**.

Key findings written to `review.md`:

- **P0** — No byte/token cap on agent-visible responses; `screen`/`history`/`last-output`/`last-command` returned verbatim; history only has a line-count clamp (`Sources/titerm/ControlServer.swift:124–127`); responses can exceed model context limits
- **P0** — Post-fork libc deadlock: app starts renderer and control-server threads before `forkpty`, then child calls non-async-signal-safe libc routines (`setenv`/`unsetenv`/`getenv`) before `exec` (`Sources/CPty/cpty.c:16`); fix: precompute args/env or use `posix_spawn`
- **P1** — `last-output` loses output on the completion-marker row (same-row output returns `""`); OSC 133 markers use exclusive line range at `Sources/titerm/Terminal.swift:1162`; affects `printf foo` with no newline
- **P1** — No test suite exists; `Package.swift` defines only production targets; `Terminal.swift` (1,188 LOC) is unprotected
- **Medium** — `Terminal.swift` exceeds 800-line change ceiling; mixes grid/scrollback state, sync, resizing, UTF-8/VT parsing, ESC/CSI/OSC dispatch, semantic markers, and agent-facing extraction — split recommended
- Source files were changing concurrently during review (another agent landing cross-file changes across `Config`, `Theme`, `Terminal`, `Shaders`, `Renderer`)
- Debug and release builds pass; Swift 6 mode fails on concurrency errors; `swift test` fails (no tests)
- Three reproducible correctness defects confirmed via harness: `last-output` returns `""` for same-row output; overwriting second half of `界` leaves `界a`; invalid UTF-8 surrogate advances state but extracts as invisible text

### Autoflow

Active Canvas Codex sessions (`gpt-5.4`, `gpt-5.6-sol`). Stack: TypeScript ESM, Vite + React 19, Bun backend, Jotai, Clerk auth, Tailwind, Radix UI, XYFlow, AI SDK + OpenAI, Vitest (jsdom), ESLint. Key fix: chat ran full canvas workflow for simple conversational messages — fix routes ordinary replies to direct model stream; workflow only for action requests.

### VSCode Extension Harness (`~/clawd/runext`, branch `main-test-1`)

- Wave 0 complete; commit `42e313f`
- API grades: 68 native, 56 emulated, 16 containers, 281 stubs; 125 demanded stubs pending
- Wave 1 next: 50 `workspace`, `env`, `extensions`, `l10n` APIs
- Open audit findings: (1) generated report embeds absolute paths; (2) `audit-vscode-api.mjs` copies SHA from config constant rather than hashing the boundary file; (3) support-evidence enforcement accepts any non-empty label

### Other External Projects (resolved)

- **Vercel Sandbox coding loop** — 400 error fixed by wiring `VERCEL_TOKEN`/`VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` through to `Sandbox.getOrCreate`
- **flows/agent-media** — unified backend hydration and runtime key storage; 64/64 tests passing
- **Games Launcher** — 15 games, all browser-tested; production builds pass
- **Docker Sandbox (Fractal)** — `sbx` symlink fixed; `sbx diagnose` passes 8/8 checks

---

## Voxel Poser Avatar (Separate Side Project)

Single-file procedural voxel humanoid animator at `~/Downloads/voxel-poser_20_patched.html` (~4500 LOC, Three.js, no build). Not part of CodeSurf repo. Last active: 2026-06-20.

Key facts:

- `_patched.html` is the canonical live file — merged LLM-only agent + bevel-everything + texture patches
- Serve via `python3 -m http.server 8765` in `~/Downloads`; open `http://localhost:8765/voxel-poser_20_patched.html?v=N` — never `file://`; always add `?v=N` cache-bust after each edit
- rAF throttles when tab is not foreground — verify clip logic deterministically via JS: set `ACT.kind`/`ACT.t`/`ACT.anchor`, loop `actStep(1/120)`, then `dangleStep(1/120)`
- LLM agent is the ONLY mind; no fallback brain; API 401/400 errors surface loudly; model: `claude-sonnet-4-6`
- `CEFF.y` clamped to `220*V` (was 72 — caused body-tear on tall walls)
- Two-renderer shader gotcha: use a shared uniform object (`const uT={value:0}`) for `onBeforeCompile` materials rendered by both main and EYE PiP WebGLRenderers
- Capabilities verified: walk, run, jump, sit, crawl, climb (two walls) + mantle + walk-on-top, grappling-hook abseil, crate step-up, voxel sea + foam, island world, head-tracked parallax window-frame view, procedural clothing + prop textures, LLM-driven agent with eyes-view capture

---

## Open Threads

- **Native cold-start white screen** — synchronous `std.process.run` in Zig main; needs persistent async controller path
- **Electron test suite: 1 remaining failure** — abort/rename edge case not yet addressed
- **titerm P0/P1 findings** — post-fork libc deadlock, token cap, `last-output` row bug, zero tests; review written to `/Users/jkneen/Documents/GitHub/titerm/review.md`; source had concurrent changes during review — re-verify findings against settled code before fixing
- **runext Wave 1** — 50 VS Code API stubs (`workspace`, `env`, `extensions`, `l10n`) pending; 3 open audit findings
- **tsc baseline dirty** — ~145 pre-existing errors; measure regressions per-file, not by exit code
- **`cluso-widget`** — optional local file dep (`file:../agentation-real`); may not exist in all environments
- **node-pty** — requires `npm run rebuild` after any native dependency change
- **MCP server port** — always read from `~/.codesurf/mcp-server.json`; never hardcode
- **New idle tiles** — `tile-1783949414422` and `tile-1784011665126` spawned, no tasks assigned; untracked in git
