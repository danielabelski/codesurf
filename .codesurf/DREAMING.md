# CodeSurf Workspace — Generated Memory (2026-07-09)

## Overview

CodeSurf is an Electron desktop app — an infinite-canvas workspace where tiles (terminal, code editor, browser, kanban, chat) live on a 2D canvas. AI agents connect via MCP and collaborate with humans asynchronously. Internal config paths and legacy variable names still use `contex` / `window.contex` / `~/.codesurf/` — do not rename these.

A multi-target migration is actively in flight: the renderer is now shared across Electron, a browser PWA, and a Native (electrobun/Bun WebView) shell. As of 2026-07-09 the Native migration is an uncommitted working-tree change on `main`, and the local checkout is ~44 commits behind `origin/main`.

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
- `scripts/web-host.mjs` — `codesurfd` daemon; web and Native targets talk to this instead of Electron IPC
- `docs/multi-target.md` — multi-target architecture reference (Electron / web / Native)

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
| Codex | codex CLI subprocess; models seen in active use: gpt-5.5, gpt-5.6, gpt-5.6-terra, gpt-5.6-sol |
| OpenCode | `@opencode-ai/sdk` HTTP server |

All providers stream via `src/main/ipc/stream.ts`.

### Build Commands (current multi-target set)
- `npm run dev` — Electron full product, hot reload (default)
- `npm run web:dev` — browser UI + web-host + codesurfd (Agensis-style web)
- `npm run web:preview` — serve production web build (PWA installable)
- `npm run web:pwa` — web:dev with service worker enabled for install testing
- `npm run desktop:dev` — Native SDK WebView shell + same web stack
- `npm run build` — full Electron build (main + preload + renderer)
- `npm run build:web` — renderer-only → dist/ (browser + Native + PWA assets)
- `npm run desktop:build` — package Native shell
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
- **Native migration is WIP/uncommitted** — the local checkout is on `main`, ~44 commits behind `origin/main`; review working-tree changes separately from HEAD when auditing
- **Terminal transport for web/Native mode** — requires a CORS proxy hosted externally; the Electron path and web path diverge at the transport layer; trace via `scripts/web-host.mjs` + the proxy boundary before assuming IPC parity
- **Peer bridge tools not always ToolSearch-loadable** — `chat_send_message` and `chat_acknowledge` may not surface via ToolSearch; fallback is direct HTTP call to the local MCP server
- **Codex sandbox blocks `~/.cache/uv/`** — `uv` commands touching `~/.cache/uv/sdists-v6/.git` fail with `Operation not permitted`; don't rely on uv in Codex tasks without verifying sandbox policy first

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

### Multi-Target Architecture (In Flight)
- Renderer is shared across Electron, browser PWA, and Native (electrobun/Bun WebView) shell
- Web/Native targets communicate with `codesurfd` (`scripts/web-host.mjs`) instead of Electron IPC
- Terminal tile for web/browser mode requires a remotely hosted CORS proxy — in active development
- Architecture reference: `docs/multi-target.md`
- **Status as of 2026-07-09:** uncommitted working-tree change on `main`; full code review sessions active

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
- Files: `src/main/ipc/pets-path.ts`, `electrobun/bun/runtime-pets.ts`, companion tests; in active expansion

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

## Image / Asset Generation Status (2026-07-09)

| Source | Status |
|---|---|
| OpenAI `gpt-image-1` | billing_hard_limit_reached — do not attempt |
| Google Image Generation API | 403 — unavailable |
| DGX image endpoint | Down — fallback `image_generate` tool in use |
| Gemini image generator (`~/.claude/skills/threejs-image-generator/scripts/generate_image.py`) | Working — confirmed via `uv run` |

- `assets/duck-codex.png` generated 2026-07-09 via Gemini script, 3.95 MB

---

## OpenClaw / Automation Health (as of 2026-07-09)

| Gateway / Cron | Status |
|---|---|
| Lead gateway (`lead-c3f78d0c-…`) | HEARTBEAT_OK |
| MC gateway (`mc-gateway-894a3d5b-…`) | HEARTBEAT_FAILED — persistent ~145+ hours; assistant turns fail before producing content; needs root-cause |
| Urgent Email Alert cron | HEARTBEAT_OK |
| Tom Doerr Tweet Tracker cron | Degraded — Twitter/X blocking automated access to `x.com/search` via Chrome profile; state at `/Users/jkneen/clawd/memory/tom-doerr-seen.json` |
| VibeClaw Article Generator cron | Running — 3-source verification limits throughput when web search unavailable; DGX fallback active |
| VibeClaw Skills Scout cron | Running — successfully adding new skills/tools to explore page |

---

## Sibling Projects

- **grok-cli** — `~/Documents/GitHub/grok-cli`; model list must mirror `src/renderer/src/config/providers.ts` DEFAULT_MODELS; edit `src/core/extensions/builtin/codesurf-desktop-provider.ts` MODELS array; permission system blocked in daemon mode — needs UI in CodeSurf Desktop

---

## Voxel Poser Avatar (Side Project)

File: `~/Downloads/voxel-poser_20_patched.html` — single canonical version (~4500 LOC, Three.js, no build)

**Verified capabilities (all passing):** walk, run, jump, sit, crawl, crate-step-up, climb (both walls) + mantle + walk-on-top, grappling-hook abseil

**Key architecture facts:**
- Pose targets in global `T` (voxel units × V=0.07 → world); `locoStep()` = LOCO state machine; `actStep()`/`CLIPS` = keyframe action clips
- Clips END HELD — `endAct()` resets `ACT.kind` but leaves `T`; idle path does not yank a held low pose to standing; WASD from a held pose re-engages LOCO naturally
- `solvePose` clamps `CEFF.y` — currently set to `220*V`; raise again if taller walls are added
- LLM-only agent (`INSTINCTS[]` + `buildSys()` + `llmDecide`); no fallback brain; active model: `claude-sonnet-4-6`

**Verify loop:** serve via `python3 -m http.server 8765` in `~/Downloads`; open `http://localhost:8765/voxel-poser_20_patched.html?v=N` in claude-in-chrome (NOT file://, NOT headless); bump `?v=N` after every edit (hard browser cache); rAF throttles when tab not foreground — drive deterministic checks from JS with `actStep(1/120)` loop

**Two-renderer gotcha:** EYE PiP uses a second WebGLRenderer; `onBeforeCompile` compiles once per context; use a shared uniform object (`const uT={value:0}; sh.uniforms.uTime = uT`) so both contexts animate

**Carry/capture:** `carryPose()` is additive and MUST be restored via `carryPoseRestore()` after `solvePose` or the character drifts; gizmo-hide for screenshots: set `.visible=false` AFTER `present()` (present re-shows stalks), before `render()`
