# CodeSurf — Generated Memory (2026-08-01)

## Overview

Electron infinite-canvas workspace, three deployment targets (Electron / Browser PWA / Native Zig WebView) sharing one React renderer. Product name is CodeSurf; legacy `window.contex` identifiers and `~/.codesurf/` paths are preserved as-is — do not rename them. The 2026-07-30 full code review has been integrated into `main` from `review/full-remediation-2026-07-31`.

The merge preserves the hardened provider, relay, MCP workspace-scope, Electrobun lifecycle, daemon, filesystem, extension, context, and browser changes. Plan 015 remains IN PROGRESS until the exact final commit passes the detached clean-checkout gate; integration-worktree green results are not sufficient.

---

## Durable Architecture Facts

### Source layout

- `src/main/` — Electron main process: IPC handlers, MCP server, event bus, extensions, chat providers, session-sources, security, OWL runtime, secrets, usage, generation, privacy, storage
- `src/preload/index.ts` — Context bridge (exposed as `window.contex` — legacy identifier, do NOT rename)
- `src/renderer/src/` — Shared React SPA across all targets
  - `App.tsx` — orchestration shell; canvas composition delegated to focused hooks
  - `components/` — tile components (lazy-loaded via `React.lazy` + `Suspense`); subdirs: `canvas/`, `chat/`, `sidebar/`, `settings/`, `tile-chrome/`, `browser/`, `codesurf-ui/`, `ai-elements/`
  - `hooks/` — 70+ focused hooks; canvas family (`useAppCanvas*`, `useCanvas*`), chat family (`useChatTile*`), sidebar, sessions, discovery
- `shared/types.ts` — Shared TypeScript types (TileType union, etc.)
- `packages/` — `codesurf-daemon`, `codesurf-chat-bridge`, `codesurf-plugin`, `codesurf-relay`, `codesurf-terminal-gateway`
- `desktop/` — Native Zig WebView thin shell
- `scripts/web-host.mjs` — fixed-port host API for browser/Native targets

### Key patterns

- **Canvas engine** — App.tsx is the orchestration shell; pan/zoom, drag, resize, snapping, groups, undo/redo, context menus, and connection locks live in `hooks/useAppCanvasInteraction.ts` and related focused hooks. World coords = screen coords adjusted for zoom + pan. Group movement recurses through nested groups. Undo snapshots full state (max 50). Perf flags are flag-gated — see `docs/perf-flags.md`. App.tsx is still a large surface — be surgical and prefer focused hooks; changes ripple widely.
- **Tiles** — lazy-loaded with `React.lazy` + `Suspense`. Canvas tile chrome in `components/tile-chrome/`.
- **Event bus** — Main-process pub/sub (`src/main/event-bus.ts`). Wildcard subscriptions (`tile:*`, `*`). Ring-buffer per channel (500 events). No persistence.
- **MCP server** — Random port. Config at `~/.codesurf/mcp-server.json`. 34 tools. Never hardcode the port — always read from config.
- **Persistence** — File-based, no cloud sync: `~/.codesurf/workspaces/{id}/canvas.json` (500ms debounce), `~/.codesurf/workspaces/{id}/tiles/{tileId}.json` (kanban).
- **CODESURF_HOME** — Env var overrides `~/.codesurf/` base path. All tests that write there must set it to a temp dir.
- **IPC naming** — `{feature}:{action}`.

### Build commands

| Command | Purpose |
|---|---|
| `npm run dev` | Electron full product (hot reload) — default |
| `npm run web:dev` | Browser UI + web-host + codesurfd |
| `npm run web:preview` | Serve production web build (PWA installable) |
| `npm run web:pwa` | web:dev with service worker for install testing |
| `npm run desktop:dev` | Native WebView shell + web stack |
| `npm run build` | Electron build (main + preload + renderer) |
| `npm run build:web` | Renderer-only → dist/ |
| `npm run desktop:build` | Package Native shell |
| `npm run rebuild` | Native rebuild (node-pty) — required after native dep changes |

### Chat providers

Claude · Codex · OpenCode · Hermes · CSAgent · OpenClaw · Pi-Agent — all streaming via NDJSON/SSE parsed in `src/main/ipc/stream.ts`. Providers live in `src/main/chat/providers/`. Session sources live in `src/main/session-sources/`.

### Daemon

`packages/codesurf-daemon/bin/codesurfd.mjs`. Pid at `~/.codesurf/daemon/pid.json`. HTTP+SSE protocol: `POST /chat/job/start`, `GET /chat/job/events?jobId`, `POST /chat/job/cancel`, `GET /health`. Desktop owns the daemon — grok-cli does not spawn it.

---

## Security Hardening (shipped bc2d0a9, 2026-07-17)

All shipped — bridge confinement, `chat:loadSessionHistory` restriction, Codicons path traversal fix, SVG CSP, `event.origin` validation, kanban shell-injection fix, React hook ordering fix, `mcp-auth.test.ts` isolation.

---

## Extension System

Broker framework at `src/main/extensions/broker/` exists but direct `require()` is still default. Phase 1 migration is unstarted (XL).

---

## Modularization State

App.tsx → `useAppCanvas*` hooks; Sidebar → `components/sidebar/`; ChatTile → `useChatTile*` hooks; TileChrome → `components/tile-chrome/`; Settings → `components/settings/`; session-sources → `src/main/session-sources/`; Dreaming subsystem → `src/main/ipc/dreaming.ts` + `src/renderer/src/components/mainStatusBarDreaming.ts` (status tones: `active | pending | ready | disabled | failed | idle`).

---

## Chat Chip Chrome Rules (DO NOT BREAK)

| Component | Chrome |
|---|---|
| `ThinkingBlockView` (individual thinking block in transcript) | Full chip — background + border + shadow |
| `WorkingChipView` (live WORKING indicator) | Full chip — background + border + shadow |
| `ToolBlockView` (individual tool chip) | Full chip — canonical reference |
| `CollationSummaryChip` / group chips | Accent chip — coloured background/border, still bordered |

- `ThinkingBlockView` and `WorkingChipView` are **independent** — never touch one when fixing the other.
- Canvas z-index bugs → fix in App.tsx (`bringToFront`, `nextZIndex`), never in transcript row CSS.
- `textTransform: uppercase` on number+unit spans breaks rendering — remove transform or split elements.
- Chip expand toggles use `React.startTransition`.

---

## Infinitty / titerm

**Infinitty** is the agentic terminal tile in CodeSurf. **titerm** (`~/Documents/GitHub/titerm`) is a separate Swift + Metal macOS terminal emulator — the native backend Infinitty fronts. Not part of the CodeSurf repo.

**Active usage (2026-07-28):** Infinitty tile is in active use with Codex agents (gpt-5.6-terra, gpt-5.6). The Infinitty system prompt (`you ARE the terminal`) is working; agents call `infinitty_*` tools. Observed: `/status` is not available inside the Infinitty Claude subprocess environment.

**Pane system** committed at `2757cf9` in titerm. Confirmed working: synchronous zoom topology restore, non-cumulative traffic-light rebasing, animation restart guard in `PaneChrome.swift:349`.

**Agent Notch** embedded as commit `3587ad8` ("Embed Agent Notch activity UI") in titerm. Includes Claude/Codex session discovery, animations, session panel, subagent grouping, 8 bundled pet sprites, 5 tests. No runtime dependency on the sibling repo.

**Notch click routing** — design audited, not yet implemented. Priority: (1) focus owning `TerminalSession`; (2) resume in new terminal; (3) recover via PetChat. "Agent Notch" user-facing label also needs removal.

**Outstanding titerm code-review findings** (unmerged, 2026-07-21):
- `TerminalTabStrip.swift:538` — tabs can shrink below 190 pt minimum
- `PaneChrome.swift:67` — resize while maximized counts hidden panes' stale widths
- `App.swift:1513` — maximize stores absolute divider coords; stale on restore after window resize
- `App.swift:1037/1215/1524` — split-created terminals skip shared-surface rendering
- `App.swift:1937` — SwiftPM flattens logos; `subdirectory: "Logos"` lookup fails
- `App.swift:1964` — new panes after tint selection stay default blue
- `TerminalTabStrip.swift:375–395` — tint on button, not sibling icon view
- `TerminalTabStrip.swift:472–524` — sibling icons don't reserve title space

---

## Hermes Agent Codex Fix (2026-07-20)

`hermes-agent/agent-core-rs/src/external.rs:586` — replaced removed `-a never` with `-c approval_policy="never"`, added stderr capture. Binary at `/usr/local/bin/hermes-rs` updated.

---

## grok-cli Integration

Separate repo at `~/Documents/GitHub/grok-cli`. Model IDs must stay in sync with `src/renderer/src/config/providers.ts` DEFAULT_MODELS. Edit `src/core/extensions/builtin/codesurf-desktop-provider.ts` MODELS array when provider list changes; update `src/core/extensions/codesurf-desktop-provider.test.ts` fixtures if default model changes. **Open blocker:** daemon-mode permission grants have no UI — every tool call requires explicit grant but Desktop has no dialog to surface it back to the daemon-connected CLI.

---

## Electron Target Uncertainty (2026-07-28)

Session evidence from 2026-07-28 shows uncertainty about whether a `native-floating-webview` worktree change was truly reverted. User stated "we changed this back yesterday" but no Electron restoration commit was found on `main` by forensic session review. The `native-floating-webview` worktree may still be present. **Verify branch/worktree state before assuming Electron is the current main target.**

---

## Side Projects (active, not CodeSurf core)

- **agensis / visual-editor** (`~/Documents/GitHub/agensis`) — pluggable in-page visual editor package. Features: double-click-to-edit-in-place, live preview isolated to changed area, multi-page content selector. Tests: 11/11 interaction, 87/87 standalone. Root CI now covers standalone package suite. Route-based SPA targets are a known gap (only `.html` file discovery, no config API for app routes).
- **Claude-for-speed** (`~/Documents/GitHub/Claude-for-speed`) — browser drift/racing game. Visual improvements (Blender-style textures, post-processing, shadows, wet reflections) shipped. `npm run test:drift` (8 chassis) and `npm run capture` suites pass.
- **scrape/carve** (`~/Documents/GitHub/scrape/carve`) — browser game with modal/keyboard UX. Functional defects fixed (keyboard nav behind settings dialog, focus trap, landscape crash overlap). No automated test suite exists.

---

## Open Threads

- **Electron vs native-floating-webview** — verify current state of `main` branch and any remaining worktree; unclear if restoration is committed
- Extension broker Phase 1 migration — unstarted (XL)
- grok-cli permission UI — no dialog path from daemon into Desktop
- titerm: eight code-review findings above need a clean fix commit
- titerm: notch click routing not yet implemented; "Agent Notch" label needs removal
- tsc baseline is dirty (~145 pre-existing errors) — measure regressions per-file, not by exit code
- `cluso-widget` optional local dep (`file:../agentation-real`) may not exist in all environments
- agensis visual-editor: SPA/route-based page discovery not yet implemented
