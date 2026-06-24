# CodeSurf Workspace — Generated Memory

_Last consolidated: 2026-06-24_

## Overview

CodeSurf is an Electron desktop app providing an infinite-canvas workspace where AI agents and developers collaborate. Tiles (terminal, code editor, browser, kanban, chat) live on a 2D canvas; agents connect via a local MCP server. The product name is **CodeSurf** — "contex" is the legacy internal identifier still present in paths (`~/.contex/`, `window.contex`) but must not appear in user-facing copy.

Root: `/Users/jkneen/clawd/collaborator-clone`
Active branch: `feature/event-bus-mcp`

---

## Durable Architecture Facts

- **App.tsx** owns the entire canvas engine (pan/zoom, drag, resize, snapping, groups, undo/redo). Be surgical — changes ripple widely.
- **Undo** snapshots full state (max 50). Never push to undo stack in hot paths.
- **Tiles** are `React.lazy` + `Suspense` — every tile component is lazy-loaded.
- **Event bus** (`src/main/event-bus.ts`) — main-process in-memory pub/sub, wildcard subscriptions, 500-event ring-buffer per channel. Not persisted.
- **MCP server** (`src/main/mcp-server.ts`) — starts on a random port; config at `~/.contex/mcp-server.json`. Never hardcode the port. `.mcp.json` in the repo root records the current session URL/token; expect it to change on every daemon restart.
- **Persistence** — file-based only, no cloud:
  - `~/.contex/workspaces/{id}/canvas.json` (auto-saved, 500 ms debounce)
  - `~/.contex/workspaces/{id}/tiles/{tileId}.json` (kanban state)
  - `~/.contex/workspaces/{id}/chats/{tileId}.json` (chat history, per-tile)
- **Streaming** — all chat providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.
- **node-pty** requires `npm run rebuild` after any native dependency change.
- **cluso-widget** is an optional local file dep (`file:../agentation-real`) — may not exist in all environments; do not assume it is present.
- **tsc baseline is dirty** — ~145 pre-existing errors. Measure regressions per-file, not by exit code. Type sweep is actively reducing `any` escapes.
- **Electron binary footgun** — `npm install` can wipe the Electron dist binary; fix by extracting the cached zip manually.
- **Node version** — `.nvmrc` pins Node 22.18.0. Node 24 is explicitly blocked (guard added to build scripts). Use `nvm use` before builds.

### Chat Providers

| Provider | Integration |
|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` (session resumption, adaptive thinking) — sends **only latest user message**; SDK tracks history |
| Codex | `codex` CLI subprocess — sends **full message history** (stateless API) |
| OpenClaw | Direct Claude API via IPC — sends **full message history** (stateless) |

### ChatProviderContext models (as of 2026-06-24)

- **claude**: claude-opus-4-5, claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4, claude-sonnet-4
- **codex**: gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o, gpt-4o-mini, o4-mini, o3, o3-mini, o1, o1-mini (gpt-5.5 observed in live sessions; not yet in config list)
- **openclaw**: openclaw-claude-opus-4-5, openclaw-claude-sonnet-4-5, openclaw-claude-haiku-4-5, openclaw-gpt-4.1, openclaw-gpt-4o, openclaw-gpt-4o-mini

### IPC Convention

`{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `terminal:write`, `bus:publish`

Chat IPC additions: `chat:load`, `chat:save`, `chat:list`

---

## Canvas Interaction Model

- **Tile dragging**: limited to mousedown on `.tile-title-bar` class only
- **Double-click on canvas background** → opens `CanvasTilePicker` modal (fixed-position, viewport-centred)
- **Sidebar "+" button** → same `CanvasTilePicker` modal, centred on viewport
- **Right-click on canvas background** → `CanvasContextMenu` at click position
  - Add Tile → opens `CanvasTilePicker` at right-click position
  - Clear Canvas → `window.confirm()` then clears in-memory + persisted state (`canvas.save([])`)
  - Zoom to Fit — fits all tiles into viewport
  - Reset Zoom — sets zoom to 1.0
- **Active streaming tile** → animated glow/border effect via `activeTiles` Set in App.tsx; driven by `tile:stream:start` / `tile:stream:end` bus events published from ChatTile

---

## Component Inventory

### Key tile components

| Component | Path | Notes |
|---|---|---|
| `CanvasTilePicker` | `src/renderer/src/components/CanvasTilePicker.tsx` | Fixed modal overlay for tile creation; closes on backdrop click or Escape |
| `CanvasContextMenu` | `src/renderer/src/components/CanvasContextMenu.tsx` | Right-click canvas menu with SVG icons |
| `AgentsTile` | `src/renderer/src/components/AgentsTile.tsx` | Polls `window.contex.mcp.listServers()` every 3 s; shows agent cards with status, URL, tool count |
| `ChatHistoryTile` | `src/renderer/src/components/ChatHistoryTile.tsx` | Lists saved chats (preview + date, most recent first); Resume opens new chat tile seeded with history + sessionId |
| `VoxelPoserTile` | `src/renderer/src/components/VoxelPoserTile.tsx` | iframe → `https://voxel-poser-nine.vercel.app/` |
| `ChatProviderContext` | `src/renderer/src/context/ChatProviderContext.tsx` | Global provider/model state; wraps App; per-tile local override supported |

### TileType additions

`agents`, `chat_history`, `voxel_poser` added to `src/shared/types.ts` TileType union. All tile types accessible via double-click canvas picker and sidebar "+" button.

---

## Component Extraction Sweep (COMMITTED — as of 2026-06-24)

All extractions below are landed in git. The Sidebar.tsx sweep is ongoing.

### `Sidebar.tsx` → `src/renderer/src/components/sidebar/`

| Extracted | File |
|---|---|
| `SidebarTextDialog` | `sidebar/SidebarTextDialog.tsx` |
| `SessionSidebarRow` | `sidebar/SessionSidebarRow.tsx` |
| `SidebarSearchPalette` | `sidebar/SidebarSearchPalette.tsx` |
| `SidebarTopItem` | `sidebar/SidebarTopItem.tsx` |
| `SessionSidebarIndicator` + helpers | `sidebar/session-indicators.tsx` |
| `SidebarFooter` | `sidebar/SidebarFooter.tsx` |

Supporting modules in `sidebar/`: `footerExtensions.ts`, `path-utils.ts`, `session-actions.ts`, `session-filters.ts`, `session-open.ts`, `session-ordering.ts`, `session-title-generation.ts`, `types.ts`, `ui.tsx`, `utils.tsx`

Sidebar.tsx trajectory: 2598 → 2425 → 2205 → 2005 → **~1860 LOC** (sweep ongoing). Always check `sidebar/` subdirectory before adding logic to Sidebar.tsx.

### `BrowserTile.tsx` → `src/renderer/src/components/browser/`

| Extracted | File |
|---|---|
| Webview manager subsystem | `browser/webviewManager.ts` |
| `ToolbarButton` | `browser/ToolbarButton.tsx` |

BrowserTile.tsx trajectory: 2177 → 1475 → **~1411 LOC**.

### `SettingsPanel` → `src/renderer/src/components/SettingsPanel/`

All seven sections extracted: `DaemonSection`, `ProvidersSection`, `McpSection`, `ExtensionsSection`, `PermissionsSection`, `GeneralSection`, `ChatSection`. SettingsPanel.tsx is **~940 LOC — under 1000 target, DONE**.

---

## Sidebar Architecture (Current State)

Layout top → bottom:

1. CodeSurf logo + "CodeSurf" text
2. Icon-only nav (Canvas, Agents, Files, Settings, Extensions) with tooltips
3. Workspace switcher (shows current workspace name; expands to list; "+ New Workspace" uses `window.prompt()` + `workspace.create()` + `workspace.open()`)
4. Collapsible agents section (robot icon header; shows MCP server cards from `listServers()`)
5. "+" new tile button (opens `CanvasTilePicker` at viewport centre)

---

## ChatTile Architecture (Current State)

### Toolbar
- Standard dark-themed `<select>` elements for provider and model
- Global/local override: global mode shows provider + model inline (no pill); local mode shows "local ×" pill to revert
- Provider/model list sourced from `ChatProviderContext`; model list filtered to selected provider
- Clear/reset button

### Transcript
- System messages (`role === 'system'`) filtered at both state-update level and render time
- User messages: right-aligned blue bubble (`#0a84ff`), white text
- AI messages: left-aligned, robot icon avatar, `#ccc` text
- Timestamps (HH:MM) on every message; copy button on hover
- Markdown code blocks rendered with `highlight.js` (AI messages only)
- Regenerate button below last AI response
- 800 px max-width, centred

### Input bar
- Auto-expanding textarea (resets on send); max-height 200 px
- Enter → send; Shift+Enter → new line
- Action row: attach file (paperclip), image upload, MCP toggle, voice (microphone), send — all inline SVG icons

### Streaming
- Placeholder assistant bubble added immediately on send with `streaming: true`
- Tokens appended in real time via `chat:token` IPC events
- Typing indicator (three animated dots) while streaming and content is empty
- On `chat:done`, placeholder finalised

### Persistence
- Chat history saved per-tile to `~/.contex/workspaces/<id>/chats/<tileId>.json`
- Loaded on mount; saved on every message change
- `conversationId` for Claude stored in `useRef` — not sent in IPC payload; SDK tracks internally

---

## Claude Provider — Blank-Turn Hardening (UNCOMMITTED)

Both `src/main/chat/providers/claude.ts` and `packages/codesurf-daemon/bin/chat-jobs.mjs` have matching fixes pending commit:

- `sawAssistantOutput` boolean; set on any `text_delta`, `thinking_delta`, `input_json_delta`, `tool_use`, `tool_progress`, `tool_use_summary`, or fallback `result.result` text
- `streamedTextByIndex` Map (`${streamTurn}:${index}` key) tracks streamed content per turn/block; assembled `assistant` message only emits tail text not already streamed — prevents duplication
- `assistantText` string accumulates all emitted text across the turn
- If Claude finishes with `sawAssistantOutput === false` and no result text → explicit `error` event emitted instead of blank turn; message: "Claude finished without assistant output… Please resend the message."
- Same guard fires if stream ends before `emittedDone`
- Test coverage: `test/daemon/chat-jobs-loop-hardening.test.mjs`

---

## Collab Protocol — Directory Bootstrap Fix (UNCOMMITTED)

`src/main/ipc/collab.ts` — fixed ENOENT crash on first open where `collab:ensureDir` / `collab:watchMessages` attempted to create `~/.contex/<tileId>/context` before the parent tile root existed. Fix: validate and create tile root first, then create `context` + mailbox folders in one pass. Verified via `npm run build:main`. Change is uncommitted.

---

## KanbanTile AI Integration

Compact prompt bar at top. On submit:
- Serialises current board state (columns + cards) as JSON
- Sends to Claude with system prompt instructing JSON patch response
- Supported ops: `add_card`, `move_card`, `update_card`, `delete_card`, `add_column`, `rename_column`, `delete_column`
- Response parsed and ops applied to local board state; loading indicator; errors surfaced inline

---

## Chat Chip Chrome Map — Do Not Break

| Component | Chrome |
|---|---|
| `ThinkingBlockView` (individual transcript entry) | Full chip — background + border + shadow |
| `WorkingChipView` (live WORKING indicator) | Full chip — background + border + shadow |
| `ToolBlockView` (individual tool chip) | Full chip — canonical reference |
| `CollationSummaryChip` / group chips | Accent chip — coloured background/border, still bordered |

- `ThinkingBlockView` and `WorkingChipView` are independent components. Do not couple their styling.
- Canvas overlap issues → check `App.tsx` z-index (`bringToFront`, `nextZIndex`) first. Do not add `position: relative` + `zIndex` to transcript rows to fix canvas stacking.
- `textTransform: uppercase` destroys unit strings (`${n}s` → `NS`). Remove from any span containing number+unit, or render as separate elements.
- Chip expand toggles must use `React.startTransition`.

---

## Extensions

- Bundled extensions live in `bundled-extensions/`.
- LiveKit Rooms loads from `bundled-extensions/livekit-rooms/`.
- Extension tile theming rule: **never** use `prefers-color-scheme`; default to light CSS; apply `body.dark` class via bridge; use solid hex colours, not `rgba` opacity.

---

## Distribution

### Platform packages
- `npm run dist:mac` — macOS dmg + zip
- `npm run dist:windows` — NSIS installer + portable exe
- `npm run dist:linux` — AppImage + deb

### npm/npx package (changes UNCOMMITTED)
- `npm run dist:npm` — alias added to `package.json` for `npm run build:npm`; runs `scripts/build-npm-package.mjs`
- On first run the launcher downloads Electron into `~/.codesurf/electron` and reuses the cached runtime thereafter
- **codesurf-daemon is now bundled in the npm package** — `.npmignore` updated (`!packages/codesurf-daemon/**`) and `build-npm-package.mjs` has a `copyDaemonPackage()` step; these `.npmignore`, `build-npm-package.mjs`, and `package.json` changes are uncommitted

---

## packages/codesurf-daemon

Sub-package at `packages/codesurf-daemon/` with its own `node_modules/`:

- `bin/chat-jobs.mjs` — job manager (Claude + Codex + Omnigent + OpenClaw runners); blank-turn hardening pending commit
- `bin/omnigent-provider.mjs` — Omnigent model provider: `decodeOmnigentModelId`, `extractOmnigentSessionId`, `mapOmnigentStreamEvent`, `omnigentAuthHeaders`, `omnigentEndpointUrl`, `parseOmnigentSseChunk`
- `bin/agent-mode-tools.mjs`, `bin/agent-mode-resolver.mjs`, `bin/codex-sdk-provider.mjs` — agent mode / tool allowlist resolution
- `bin/` also contains: `checkpoints.mjs`, `context-buckets.mjs`, `instruction-context.mjs`, `memory-loader.mjs`, `project-context.mjs`, `session-index.mjs`, `skills-index.mjs`
- `src/` — `manager.ts`, `paths.ts`
- `vendor/dreaming.mjs` — dreaming memory consolidator

Other packages: `contex-chat-bridge`, `contex-relay`, `codesurf-plugin`

---

## Type Safety Sweep (fully committed as of 2026-06-24)

All `any` elimination work is now landed in git:

- Bus subscribe callbacks typed throughout — eliminated `any` in peer-context (`useChatTilePeerContext.ts`) and kanban listeners (`KanbanTile.tsx`)
- SDK parsing paths (array callbacks) converted to typed shapes across: `src/main/agents/agent-cli-contracts.ts`, `src/main/chat/providers/openclaw.ts`, `src/main/extensions/registry.ts`, `src/main/mcp/tools/context.ts`, `src/main/relay/provider-executor.ts`, `src/main/session-sources/opencode.ts`, `src/main/session-sources/pi-agent.ts`, `src/main/session-sources/tool-blocks.ts`, `src/renderer/src/components/chat/chatTileUtils.ts`
- IPC handler validation hardened (`handleTyped.ts`)
- Main logger added (`src/main/ipc/`); ad-hoc `console.log` calls replaced
- MCP and event-bus calls hardened via `broadcastToRenderer`
- Session-sources decomposed and orchestrator wired

tsc baseline (~145 errors) reflects pre-existing issues only; the type sweep has not introduced new regressions.

---

## Memory / Listener Leak Fixes (committed)

- ChatTile: more aggressive compaction — fewer live messages, lower char caps, truncation for tool/thinking/content-block payloads, auto-flatten of older finished messages
- `src/main/ipc/bus.ts`, `terminal.ts`, `fs.ts`: one tracked cleanup listener per sender instead of stacking `destroyed` handlers on repeated subscribe/create/watch calls (was causing `MaxListenersExceededWarning`)

---

## OpenClaw Heartbeat

- OpenClaw runs periodic heartbeat polls against board tasks; `lead-*` agent IDs respond with gateway OK and no-op when no tasks are pending
- `mc-gateway-*` variant has logged `connection refused` in recent sessions — likely a daemon restart or port change; treat as transient unless persistent
- Urgent email alert cron script (`~/clawd/scripts/email-alert-check.sh`) runs on schedule; recent execution returned HEARTBEAT_OK (no errors)

---

## Open Threads

- **Sidebar.tsx still shrinking** — extraction sweep ongoing; ~1860 LOC remaining; always check `sidebar/` subdirectory before adding logic to the root file
- **BrowserTile.tsx** — at ~1411 LOC after two extractions; further decomposition possible
- **Blank-turn hardening** — changes in `src/main/chat/providers/claude.ts`, `packages/codesurf-daemon/bin/chat-jobs.mjs`, and `test/daemon/chat-jobs-loop-hardening.test.mjs` are uncommitted; commit and verify end-to-end in both ChatTile and daemon job flows
- **Collab protocol bootstrap fix** — `src/main/ipc/collab.ts` change is uncommitted; commit pending
- **npm package + codesurf-daemon bundling** — `.npmignore`, `build-npm-package.mjs`, `package.json` (`dist:npm` alias) changes are uncommitted; needs commit + publish verification
- **Omnigent provider** — recently landed; integration test coverage may be thin
- **gpt-5.5 in Codex** — appeared in live session chat history as `codex (gpt-5.5)`; confirm whether it should be added to `ChatProviderContext` model list
- **OpenClaw mc-gateway** — `connection refused` errors observed in recent heartbeat sessions; verify daemon port config if failures persist
