# CodeSurf Workspace — Generated Memory (2026-07-09)

## Overview

CodeSurf is an Electron desktop app — an infinite-canvas workspace where tiles (terminal, code editor, browser, kanban, chat) live on a 2D canvas. AI agents connect via MCP and collaborate with humans asynchronously. Internal config paths and some legacy variable names still use `contex` / `window.contex` / `~/.codesurf/` — do not rename these.

---

## Durable Facts

### Identity
- Product name: **CodeSurf** (never "contex" in user-facing copy; `contex` is legacy internal namespace only)
- Legacy internal namespace: `contex`, `window.contex`, `~/.codesurf/` — stable, do not rename
- Owner: Jason Kneen, Andover UK, Europe/London

### Codebase Anchors
- `src/renderer/src/App.tsx` — entire canvas engine, ~1944 LOC; be surgical; changes ripple widely
- `src/main/index.ts` — window management, IPC registration, app init
- `src/main/event-bus.ts` — in-memory pub/sub, wildcard patterns, ring-buffer (500 events/channel), no persistence
- `src/main/mcp-server.ts` — local HTTP MCP 2.0 server, random port; config at `~/.codesurf/mcp-server.json`
- `src/main/ipc/` — IPC handler modules, one file per feature domain
- `src/main/ipc/stream.ts` — NDJSON/SSE streaming for all chat providers
- `src/preload/index.ts` — context bridge (workspace, fs, canvas, terminal, chat, bus, mcp…)
- `src/renderer/src/components/` — tile components, all lazy-loaded via `React.lazy` + `Suspense`
- `src/renderer/src/hooks/` — `useDetectedAgents`, `useMCPServers`
- `src/shared/types.ts` — shared TypeScript types, `TileType` union

### Persistence (file-based, no cloud)
- Canvas state: `~/.codesurf/workspaces/{id}/canvas.json` — auto-saved, 500ms debounce
- Kanban tile state: `~/.codesurf/workspaces/{id}/tiles/{tileId}.json`
- MCP config: `~/.codesurf/mcp-server.json`

### Tech Stack
- Electron ^41.3.0, React 19.2.4, TypeScript 5.9.3
- Vite / electron-vite 7.3.1 / 5.0.0
- Tailwind CSS 4.0.0 (dark theme hardcoded: `#1e1e1e`, `#252525`, `#333`)
- xterm + node-pty (terminal), Monaco (code tiles)
- `@anthropic-ai/claude-agent-sdk` 0.2.79, `@opencode-ai/sdk` 1.2.27
- chokidar for filesystem watch
- `cluso-widget` optional local file dep (`file:../agentation-real`) — absence must not break build

### Chat Providers
| Provider | Integration |
|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` — session resumption, adaptive thinking |
| Codex | codex CLI subprocess |
| OpenCode | `@opencode-ai/sdk` HTTP server |

All providers stream via `src/main/ipc/stream.ts`.

### Build Commands
- `npm run dev` — electron-vite dev with hot reload
- `npm run build` — full build (main + preload + renderer)
- `npm run rebuild` — native rebuild for node-pty (required after dep changes)

### Style Conventions
- Dark theme only; no `prefers-color-scheme`; `body.dark` via bridge for extensions; solid hex only
- Tailwind + inline `React.CSSProperties`; no CSS-in-JS library
- Strict TypeScript; `any` avoided except legacy `chat.ts` sections
- 2-space indent, trailing commas, no semicolons
- No emoji anywhere — use SVG icons, CSS shapes, or text labels

---

## Known Hazards / Footguns

- **App.tsx size** — ~1944 LOC; be surgical
- **node-pty** — requires `npm run rebuild` after any dependency change
- **MCP port is random** — always read from `~/.codesurf/mcp-server.json`; never hardcode
- **Canvas undo** — holds full snapshots (max 50); don't push to undo stack in hot paths
- **tsc baseline is dirty** — ~145 pre-existing errors; measure regressions per-file, not by exit code
- **Electron binary footgun** — `npm install` can wipe electron dist binary; fix by extracting cached zip
- **Peer bridge tools not always ToolSearch-loadable** — `chat_send_message` and `chat_acknowledge` are declared in session context but ToolSearch may not surface their schemas; fallback is direct HTTP call to the local MCP server
- **Codex sandbox blocks `~/.cache/uv/`** — `uv` commands that touch `~/.cache/uv/sdists-v6/.git` fail with `Operation not permitted (os error 1)`; don't rely on uv in Codex tasks without verifying sandbox policy first

---

## Chip Chrome Rules (DO NOT BREAK)

| Component | Chrome |
|---|---|
| `ThinkingBlockView` | Full chip — background + border + shadow |
| `WorkingChipView` | Full chip — background + border + shadow |
| `ToolBlockView` | Full chip — canonical reference |
| `CollationSummaryChip` / group chips | Accent chip — coloured background/border, still bordered |

- `ThinkingBlockView` and `WorkingChipView` are independent — changing one must not touch the other
- Canvas overlap issues → check App.tsx `bringToFront`/`nextZIndex` first; do not add `position: relative` + `zIndex` to transcript rows
- `textTransform: uppercase` on spans containing `${n}s` renders as `NS` — remove or split the element
- Chip expand toggles → wrap in `React.startTransition`

---

## Active Subsystems

### Plugin / Extension Platform
- Rebuild in progress: `docs/plugins/00-architecture.md`; P0, P2, P3 landed; P1+ pending
- Extension SDK: bridge API, RPC flow, actions/context systems, chat integration
- Theming rule: never `prefers-color-scheme`; default light CSS; `body.dark` via bridge; solid hex only
- Sidebar/settings toggles: `hiddenFromSidebarExtIds` / `settingsPanelExtIds`, section type `ext:${id}`

### Chrome Data Sync
- Cookie decryption via macOS Keychain, AES-128-CBC; must inject before webview attachment

### Customisation Locations Panel
- Folder path lists with `$HOME`/`$WORKSPACE` vars replace import dialogs

### Zenbu Rearchitecture
- Analysis at `docs/zenbu-analysis/`

### Webview Paint Bridge
- 3-layer subsystem: `src/main/ipc/webview-paint.ts`, `src/renderer/src/lib/webviewPaint.ts`, `src/shared/webview-paint-bridge.ts`

### Pets Subsystem
- New files: `src/main/ipc/pets-path.ts`, `electrobun/bun/runtime-pets.ts`, companion tests
- In active expansion; not yet fully committed

### Activity Cap (PERF-01)
- `activity-cap.ts` has a companion test file; in-flight, nearing ready

### MCP Per-Tile Scoping (SEC-05)
- Status: DONE

---

## Peer Collaboration System

- Agent peer state managed via `mcp__codesurf__peer_set_state` / `peer_get_state` / `peer_send_message` / `peer_read_messages`
- On every session start: call `peer_set_state` (tile_id=$CARD_ID, status="idle") then `peer_get_state`
- Bridge tools `chat_send_message` / `chat_acknowledge` — use direct HTTP MCP call if ToolSearch fails
- Peer connectivity confirmed working at MCP HTTP level (2026-07-09)
- File conflict rule: never edit a file a linked peer lists in their `files` array; message first

---

## Harness / Runtime Notes

- **Local harness sandbox**: `LocalHostSandboxProvider` runs `@ai-sdk/harness` claude-code on localhost; spike proven; verdict: don't build adapters; status: dormant
- **Helmor evaluation**: concluded; shipped on `feature/helmor-harvest`; rest redundant

---

## OpenClaw / Automation Health (as of 2026-07-09)

| Gateway / Cron | Status |
|---|---|
| Lead gateway (`lead-c3f78d0c-…`) | HEARTBEAT_OK |
| MC gateway (`mc-gateway-894a3d5b-…`) | HEARTBEAT_FAILED — persistent ~145+ hours; assistant turns fail before producing content; needs root-cause |
| Urgent Email Alert cron | HEARTBEAT_OK |
| Tom Doerr Tweet Tracker cron | Degraded — Twitter/X blocking automated access to `x.com/search` even via Chrome profile; state at `/Users/jkneen/clawd/memory/tom-doerr-seen.json` |
| VibeClaw Article Generator cron | Running — 3-source verification requirement limits throughput when web search unavailable; DGX fallback active |
| VibeClaw Skills Scout cron | Running — successfully adding new skills/tools to explore page |
| Google Image Generation API | 403 — not available |
| OpenAI Image API (`gpt-image-1`) | billing_hard_limit_reached — do not attempt until billing resolved |
| DGX image endpoint | Down — fallback `image_generate` tool in use |

---

## Sibling Projects

- **grok-cli** — `~/Documents/GitHub/grok-cli`; model list must mirror `src/renderer/src/config/providers.ts` DEFAULT_MODELS; edit `src/core/extensions/builtin/codesurf-desktop-provider.ts` MODELS array; permission system blocked in daemon mode (needs CodeSurf Desktop UI)
- **Voxel Poser avatar** — canonical file: `~/Downloads/voxel-poser_20_patched.html` (~4500 LOC, Three.js, no build); backup at `voxel-poser_20_patched.BACKUP.html`; all capabilities verified: walk, run, jump, sit, crawl, crate-step-up, climb (both walls) + mantle + walk-on-top, grappling-hook abseil, LLM-only agent brain (`claude-sonnet-4-6`), procedural voxel textures, island-world sea, head-tracking off-axis parallax; serve via `python3 -m http.server 8765`; always cache-bust with `?v=N`; never `file://`

---

## Open Threads

- MC gateway persistent failure — root-cause diagnosis needed
- Google Cloud Image Generation API 403 — needs API enablement or provider switch
- OpenAI Image API billing blocked — resolve before retrying `gpt-image-1`
- DGX spark endpoint down — needs restart or substitution in article generator
- Tom Doerr Tweet Tracker — needs alternative to blocked `x.com/search` automation
- Pets subsystem — working tree, not yet committed
- PERF-01 activity-cap companion test — in-flight
- Plugin platform P1+ phases — not yet landed
- grok-cli permission system in daemon mode — needs UI in CodeSurf Desktop
- Voxel Poser: character swimming/sinking when walking into water — deferred
