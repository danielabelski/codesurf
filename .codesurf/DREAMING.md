# CodeSurf — Generated Memory (2026-08-01)

## Overview

Electron infinite-canvas workspace, three deployment targets (Electron / Browser PWA / Native Zig WebView) sharing one React renderer. Product name is CodeSurf; legacy `window.contex` identifiers and `~/.codesurf/` paths are preserved as-is — do not rename them.

The `review/full-remediation-2026-07-31` branch merged at `2209e0f` and is fully integrated into `main`. `df804d9` ("Document review merge handoff state") is the current HEAD. Plan 015 is COMPLETE — all provider, relay, MCP workspace-scope, Electrobun lifecycle, daemon, filesystem, extension, context, and browser changes are shipped.

---

## Durable Architecture Facts

### Source layout

- `src/main/` — Electron main process: IPC handlers, MCP server, event bus, extensions, chat providers, session-sources, security, OWL runtime, secrets, usage, generation, privacy, storage, activity, relay, agent-room
- `src/preload/index.ts` — Context bridge (exposed as `window.contex` — legacy identifier, do NOT rename)
- `src/renderer/src/` — Shared React SPA across all targets
  - `App.tsx` — orchestration shell; canvas composition delegated to focused hooks
  - `components/` — tile components (lazy-loaded via `React.lazy` + `Suspense`); notable subdirs: `canvas/`, `chat/`, `sidebar/`, `settings/`, `tile-chrome/`, `browser/`, `codesurf-ui/`, `ai-elements/`
  - `hooks/` — 70+ focused hooks; canvas family (`useAppCanvas*`, `useCanvas*`), chat family (`useChatTile*`), sidebar, sessions, discovery
- `shared/types.ts` — Shared TypeScript types (TileType union, etc.)
- `packages/` — `codesurf-daemon`, `codesurf-chat-bridge`, `codesurf-plugin`, `codesurf-relay`, `codesurf-terminal-gateway`
- `desktop/` — Native Zig WebView thin shell
- `scripts/web-host.mjs` — fixed-port host API for browser/Native targets

### Key patterns

- **Canvas engine** — App.tsx is the orchestration shell; pan/zoom, drag, resize, snapping, groups, undo/redo, context menus, and connection locks live in `hooks/useAppCanvasInteraction.ts` and related focused hooks. World coords = screen coords adjusted for zoom + pan. Group movement recurses through nested groups. Undo snapshots full state (max 50). Perf flags are flag-gated — see `docs/perf-flags.md`. App.tsx is a large surface — be surgical and prefer focused hooks; changes ripple widely.
- **Tiles** — lazy-loaded with `React.lazy` + `Suspense`. Canvas tile chrome in `components/tile-chrome/`.
- **Event bus** — Main-process pub/sub (`src/main/event-bus.ts`). Wildcard subscriptions (`tile:*`, `*`). Ring-buffer per channel (500 events). No persistence.
- **MCP server** — Random port. Config at `~/.codesurf/mcp-server.json`. 34 tools. Never hardcode the port — always read from config.
- **Persistence** — File-based, no cloud sync:
  - `~/.codesurf/workspaces/{storageId}/.codesurf/canvas-state.json`
  - `~/.codesurf/workspaces/{storageId}/.codesurf/tile-state-{tileId}.json`
  - `~/.codesurf/workspaces/{storageId}/.codesurf/kanban-{tileId}.json`
  - `<project>/.codesurf/{tileId}/` — project-backed collaboration protocol state
  - `~/.codesurf/mcp-server.json` — MCP server config
- **CODESURF_HOME** — Env var overrides `~/.codesurf/` base path. All tests that write there must set it to a temp dir.
- **IPC naming** — `{feature}:{action}`.
- **Relay system** — `src/main/relay/` (bounded-subprocess, canvasProjection, ipc-validation, provider-cancellation, provider-executor, registration, service, workspaceRelayService). Separate from event bus.
- **Agent room** — `src/main/agent-room/` — room protocol for peer state coordination; see `.claude/codesurf.md` for agent room tools.
- **Dreaming subsystem** — `src/main/ipc/dreaming.ts` + `src/renderer/src/components/mainStatusBarDreaming.ts`. Status tones: `active | pending | ready | disabled | failed | idle`.

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

Multi-target details: `docs/multi-target.md`.

### Chat providers

Claude · Codex · OpenCode · Hermes · CSAgent · OpenClaw · Pi-Agent — all streaming via NDJSON/SSE parsed in `src/main/ipc/stream.ts`. Providers live in `src/main/chat/providers/`. Session sources live in `src/main/session-sources/`.

### Daemon

`packages/codesurf-daemon/bin/codesurfd.mjs`. Pid at `~/.codesurf/daemon/pid.json`. HTTP+SSE protocol: `POST /chat/job/start`, `GET /chat/job/events?jobId`, `POST /chat/job/cancel`, `GET /health`. Desktop owns the daemon — grok-cli does not spawn it.

---

## Security Hardening (shipped bc2d0a9, 2026-07-17)

All shipped — bridge confinement, `chat:loadSessionHistory` restriction, Codicons path traversal fix, SVG CSP, `event.origin` validation, kanban shell-injection fix, React hook ordering fix, `mcp-auth.test.ts` isolation.

---

## TypeScript Baseline

tsc baseline is dirty (~145 pre-existing errors). Gauge regressions per-file, not by exit code. The `tsgo -p tsconfig.tsgo.json --noEmit` variant exits 0 after removing the stale `TerminalUnavailableError` import. Use `tsgo` for focused checks rather than `tsc` on the full project.

---

## Extension System

Broker framework at `src/main/extensions/broker/` exists but direct `require()` is still default. Phase 1 migration is unstarted (XL).

---

## Modularization State

App.tsx → `useAppCanvas*` hooks; Sidebar → `components/sidebar/`; ChatTile → `useChatTile*` hooks; TileChrome → `components/tile-chrome/`; Settings → `components/settings/`; session-sources → `src/main/session-sources/`.

Notable renderer components (not exhaustive):

- `PlanCard.tsx`, `PlanChip.tsx`, `PlanPane.tsx` — in-chat plan rendering
- `DiffView.tsx` — diff display
- `PetOverlay.tsx`, `PetPicker.tsx` — pet/avatar features
- `ActivityFeed.tsx` — activity feed tile
- `AgentSetup.tsx` — agent configuration UI
- `LayoutBuilder.tsx` — layout builder tile
- `SkillInstallModal.tsx` — skill installation flow
- `MiniChatWindow.tsx` — floating mini chat surface
- `ChatTileWebview.tsx`, `chatSurfaceHostRpc.ts` — webview-hosted chat surfaces

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

## Collaborator / Sharing Features (Audit 2026-08-01)

These components implement the shared/read-only workspace model and have known issues as of the 2026-08-01 Codex audit:

- **FloatingWindowShell.tsx** — floating window chrome for shared workspace views
  - `:950` — non-owner/shared chat bodies are wrapped in `pointer-events-none`, blocking read-only transcript interaction (bug)
  - `:860-863` — `Duplicate` window action is a no-op; stub not wired (bug)
- **Read-only chat** — omits thread/subthread props and pagination; collaborators cannot open threads or load older history (gap)
- **Resource polling** — operation detail remains stale during polling (gap)
- `src/main/ipc/collab.ts` — collaborator IPC handler

### Deployment (Fly + Netlify)

- Fly is the primary API backend; Netlify is a CDN/preview layer
- Netlify parity is partial — only Nostr preview and workspace-resource mirrors exist; unified join/redeem, join-link management, controllers, and most Nostr routes are Fly-only
- A Netlify forwarding seam exists (separate from the public `netlify.toml` proxy) — check its failure behavior and route coverage before adding a duplicate join implementation
- Live deployment status as of 2026-08-01: `status.md` says uncommitted/not deployed; hosted Nostr preview returns 404
- Deploy Fly server routes first, then address Netlify parity

---

## Infinitty / titerm

**Infinitty** is the agentic terminal tile in CodeSurf. **titerm** (`~/Documents/GitHub/titerm`) is a separate Swift + Metal macOS terminal emulator — the native backend Infinitty fronts. Not part of this repo.

### feature/agent-channels — SHIPPED (2026-07-31)

- Four commits: `ea04bb1` through `13d8a28` on branch `feature/agent-channels`
- 512 tests, 5 skipped, 0 failures
- Installed at `/Applications/Infinitty.app`; previous version backed up to `~/.Trash/Infinitty-before-agent-channels-20260731-231934.app`
- Change-size note: 2,076 lines over four commits (above 800-line guidance); commit boundaries are directionally correct but `ea04bb1` (559 lines) and `6c87111` (693 lines) each mix concerns

### Agent room comms — open improvement thread

The current implementation has a per-turn model latency problem: agents must call tool APIs each turn to discover room context. Specifically:

- Terminal process detection renames panes but does not register generic CLIs as room participants
- MCP bootstrap registers but returns static instructions; room context depends on per-turn tool selection
- Automatic provider inference covers only 7 providers; lacks a provider-neutral wrapper
- Messages posted by one peer are visible to others only after their next explicit context/event call
- No process-level MCP JSON-RPC, wrapper, or hook mechanism exists yet

User direction: wrap the CLI process (e.g. claude, codex) or use hooks — do not rely on per-turn tool selection. Must work for any CLI, not just known providers.

### Agent Notch

Embedded at commit `3587ad8` in titerm. Includes Claude/Codex session discovery, animations, session panel, subagent grouping, 8 bundled pet sprites, 5 tests. No runtime dependency on CodeSurf repo.

- Notch click routing — design audited, not yet implemented. Priority: (1) focus owning `TerminalSession`; (2) resume in new terminal; (3) recover via PetChat
- "Agent Notch" user-facing label needs removal

### Outstanding titerm code-review findings (unmerged, 2026-07-21)

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

Separate repo at `~/Documents/GitHub/grok-cli`. Model IDs must stay in sync with `src/renderer/src/config/providers.ts` DEFAULT_MODELS. Edit `src/core/extensions/builtin/codesurf-desktop-provider.ts` MODELS array when provider list changes. **Open blocker:** daemon-mode permission grants have no UI — every tool call requires explicit grant but Desktop has no dialog to surface it back to the daemon-connected CLI.

---

## Side Projects (active, not CodeSurf core)

- **agensis / visual-editor** (`~/Documents/GitHub/agensis`) — pluggable in-page visual editor. Tests: 11/11 interaction, 87/87 standalone. Known gap: route-based SPA targets (only `.html` file discovery; no config API for app routes).
- **Claude-for-speed** (`~/Documents/GitHub/Claude-for-speed`) — browser drift/racing game. Visual improvements shipped. `npm run test:drift` and `npm run capture` suites pass.
- **scrape/carve** (`~/Documents/GitHub/scrape/carve`) — browser game; functional defects fixed. No automated test suite.

---

## Open Threads

- **Collaborator sharing bugs** — `FloatingWindowShell.tsx` `pointer-events-none` (`:950`), Duplicate no-op (`:860-863`), read-only chat missing thread/pagination, stale resource polling — all unaddressed as of 2026-08-01
- **Netlify/Fly deployment** — Nostr preview 404, most Fly routes missing Netlify parity, no confirmed live deploy
- **titerm: agent-channels CLI wrapping** — replace per-turn tool-selection with process-level wrapper or hook; must be provider-neutral
- **titerm: 8 code-review findings** — listed above, clean fix commit pending
- **titerm: notch click routing** — not yet implemented; "Agent Notch" label pending removal
- **Extension broker Phase 1 migration** — unstarted (XL)
- **grok-cli permission UI** — no dialog path from daemon into Desktop
- **tsc baseline dirty** (~145 pre-existing errors) — measure regressions per-file only
- **`cluso-widget`** — optional local dep (`file:../agentation-real`); may not exist in all environments
- **`bun.lock`** — untracked file in working tree (not yet gitignored or committed)
- **`.claude/codesurf.md`** — modified in working tree (uncommitted change)
