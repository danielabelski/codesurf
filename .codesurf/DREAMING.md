# CodeSurf Workspace — Generated Memory

_Last consolidated: 2026-06-25_

## Overview

CodeSurf is an Electron desktop app providing an infinite-canvas workspace where AI agents and developers collaborate. Tiles (terminal, code editor, browser, kanban, chat) live on a 2D canvas; agents connect via a local MCP server. Product name is **CodeSurf** — "contex" is the legacy internal identifier still present in paths (`~/.contex/`, `window.contex`) but must not appear in user-facing copy.

Root: `/Users/jkneen/clawd/collaborator-clone`
Active branch: `feature/event-bus-mcp`

---

## Durable Architecture Facts

- **App.tsx** owns the entire canvas engine (pan/zoom, drag, resize, snapping, groups, undo/redo). Currently ~1941 LOC — changes ripple widely; be surgical.
- **Undo** snapshots full state (max 50). Never push to undo stack in hot paths.
- **Tiles** are `React.lazy` + `Suspense` — every tile component is lazy-loaded.
- **Event bus** (`src/main/event-bus.ts`) — main-process in-memory pub/sub, wildcard subscriptions, 500-event ring-buffer per channel. Not persisted.
- **MCP server** (`src/main/mcp-server.ts`) — starts on a random port; config at `~/.contex/mcp-server.json`. Never hardcode the port. `.mcp.json` in the repo root records the current session URL/token; changes on every daemon restart.
- **Persistence** — file-based only, no cloud:
  - `~/.contex/workspaces/{id}/canvas.json` (auto-saved, 500 ms debounce)
  - `~/.contex/workspaces/{id}/tiles/{tileId}.json` (kanban state)
  - `~/.contex/workspaces/{id}/chats/{tileId}.json` (chat history, per-tile)
- **Streaming** — all chat providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.
- **node-pty** requires `npm run rebuild` after any native dependency change.
- **cluso-widget** is an optional local file dep (`file:../agentation-real`) — may not exist in all environments; do not assume it is present.
- **tsc baseline is dirty** — ~145 pre-existing errors. Measure regressions per-file, not by exit code. Active type safety sweep removing `any` escapes.
- **Electron binary footgun** — `npm install` can wipe the Electron dist binary; fix by extracting the cached zip manually.
- **Node version** — `.nvmrc` pins Node 22.18.0. Node 24 is explicitly blocked (guard in build scripts). Use `nvm use` before builds.
- **Main logger** added — use it in new main-process code; do not add ad-hoc `console.log`.
- **`broadcastToRenderer`** utility — use for main→renderer IPC broadcasts; replaces direct `webContents.send`.

### Chat Providers

| Provider | Integration | History model |
|---|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` (session resumption, adaptive thinking) | SDK tracks history; send only latest user message |
| Codex | `codex` CLI subprocess | Stateless API; send full message history. `OPTIONS` must precede `resume` subcommand on multi-turn resume (polly/daemon-resume-argfix merged) |
| OpenClaw | Direct Claude API via IPC | Stateless; send full message history |

### ChatProviderContext Models (as of 2026-06-24)

- **claude**: claude-opus-4-5, claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4, claude-sonnet-4
- **codex**: gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o, gpt-4o-mini, o4-mini, o3, o3-mini, o1, o1-mini (gpt-5.5 observed in live sessions; not yet in config list)
- **openclaw**: openclaw-claude-opus-4-5, openclaw-claude-sonnet-4-5, openclaw-claude-haiku-4-5, openclaw-gpt-4.1, openclaw-gpt-4o, openclaw-gpt-4o-mini

### IPC Convention

`{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `terminal:write`, `bus:publish`

Chat IPC additions: `chat:load`, `chat:save`, `chat:list`

### IPC Module Inventory (src/main/ipc/)

`activity.ts`, `agents.ts`, `appearance.ts`, `bus.ts`, `canvas.ts`, `chat.ts`, `chromeSync.ts`, `collab.ts`, `dreaming.ts`, `execution.ts`, `extensions.ts`, `fs.ts`, `git.ts`, `handleTyped.ts`, `image.ts`, `jobs.ts`, `localProxy.ts`, `mcp-config.ts`, `owl.ts`, `permissions.ts`, `pets.ts`, `relay.ts`, `secrets-ipc.ts`, `session-title-generation.ts`, `skills.ts`, `spokify.ts`, `stream.ts`, `system.ts`, `terminal-helpers.ts`, `terminal.ts`, `tile-context.ts`, `transcribe.ts`, `tts.ts`, `ui.ts`, `updater.ts`, `window.ts`, `workspace.ts`

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

## Component Size Tracking (post-extraction, 2026-06-25)

| File | LOC | Notes |
|---|---|---|
| `src/renderer/src/App.tsx` | ~1941 | Canvas engine — surgical edits only |
| `src/renderer/src/components/Sidebar.tsx` | ~1870 | Extraction ongoing; was 2598 |
| `src/renderer/src/components/BrowserTile.tsx` | ~1411 | Was 2177; webviewManager + ToolbarButton extracted |
| `src/renderer/src/components/SettingsPanel.tsx` | ~953 | Under 1000 — extraction complete |

---

## Component Extraction Sweep (COMMITTED — as of 2026-06-25)

### `Sidebar.tsx` → `src/renderer/src/components/sidebar/`

Extracted: `SidebarTextDialog`, `SessionSidebarRow`, `SidebarSearchPalette`, `SidebarTopItem`, `SessionSidebarIndicator` + helpers, `SidebarFooter`

Supporting modules: `footerExtensions.ts`, `path-utils.ts`, `session-actions.ts`, `session-filters.ts`, `session-open.ts`, `session-ordering.ts`, `session-title-generation.ts`, `types.ts`, `ui.tsx`, `utils.tsx`

Sidebar.tsx: 2598 → 2425 → 2205 → 2005 → **~1870 LOC** (sweep ongoing). Always check `sidebar/` before adding logic to Sidebar.tsx.

### `BrowserTile.tsx` → `src/renderer/src/components/browser/`

Extracted: `browser/webviewManager.ts`, `browser/ToolbarButton.tsx`. Trajectory: 2177 → 1475 → **~1411 LOC**.

### `SettingsPanel` → `src/renderer/src/components/settings/`

Sections extracted: `ChromeSyncSection`, `DaemonSection`, `DisplaySettingsEditor`, `ExtensionsSection`, `FontTokenEditor`, `GeneralSection`, `McpSection`, `PermissionsSection`, `ProvidersSection`, `VoiceSettingsEditor`, `controls.tsx`. SettingsPanel.tsx at **~953 LOC — under 1000 target, complete**.

### Canvas subdir — `src/renderer/src/components/canvas/`

Extracted: `CanvasGroupFrames`, `CanvasTileItem`, `groupResizeHandles`

### Chat subdir — `src/renderer/src/components/chat/`

Contains: `AskUserQuestionForm`, `BlockNoteAffordance`, `ChatComposer`, `ChatComposerControls`, `ChatComposerMenus`, `ChatTileComposer`, `ChatTileLatestChangeDrawer`, `ChatTileQueuedTurnsDrawer`, `ChatTileTranscriptColumn`, `ChatTileTranscriptMessages`, `ChatTileViews`, `checkpointToolActions`, `DiffView`, `dreamToolActions`, `insightSegments`, `largeContent`, `messageNormalization`, `PlanCard`, `PlanChip`, `PlanPane`, `ToolBlockView`, `toolChipCollation`, `chatStyles`, `chatTileContexts`, `chatTileLayout`, `chatTileTypes`, `chatTileUtils`

---

## Key Tile Components

| Component | Path | Notes |
|---|---|---|
| `CanvasTilePicker` | `src/renderer/src/components/CanvasTilePicker.tsx` | Fixed modal overlay; closes on backdrop click or Escape |
| `CanvasContextMenu` | `src/renderer/src/components/CanvasContextMenu.tsx` | Right-click canvas menu with SVG icons |
| `AgentsTile` | `src/renderer/src/components/AgentsTile.tsx` | Polls `window.contex.mcp.listServers()` every 3 s |
| `ChatHistoryTile` | `src/renderer/src/components/ChatHistoryTile.tsx` | Lists saved chats; Resume seeds new chat tile with history + sessionId |
| `VoxelPoserTile` | `src/renderer/src/components/VoxelPoserTile.tsx` | iframe → `https://voxel-poser-nine.vercel.app/` |
| `ChatProviderContext` | `src/renderer/src/context/ChatProviderContext.tsx` | Global provider/model state; per-tile local override supported |
| `PetOverlay` | `src/renderer/src/components/PetOverlay.tsx` | Floating animated pet mascot; spritesheet animation via CSS background-position; draggable |
| `PetPicker` | `src/renderer/src/components/PetPicker.tsx` | Pet selection gallery; left scrollable list, right live animated preview |

TileType additions: `agents`, `chat_history`, `voxel_poser` in `src/shared/types.ts`.

---

## Pet Subsystem

Core committed at `77e3c7d` ("Add Pet UI and types; bundle daemon"). Five files have **uncommitted** modifications beyond HEAD: `src/main/ipc/pets.ts`, `src/preload/index.ts`, `src/renderer/src/components/PetOverlay.tsx`, `src/renderer/src/components/PetPicker.tsx`, `src/renderer/src/env.d.ts`.

### Uncommitted changes (2026-06-25)

- **`pets:spritesheetData` IPC handler** — returns full spritesheet as base64 data URL. Replaces `contex-file://` custom protocol entirely; eliminates path-encoding issues.
- **`pets:thumbnailData` IPC handler** — returns thumbnail as base64 data URL.
- **Preload bridge** — `window.electron.pets.spritesheetData(slug)` and `window.electron.pets.thumbnailData(slug)` wired in `src/preload/index.ts`.
- **`PetOverlay` refactor** — `manifest` state replaced by `spritesheetUrl` (base64 string); `getManifest` IPC call and `contex-file://` references removed.
- **`PetPicker` redesign** — left scrollable list + right live-animating `PetPreview`; `contex-file://` removed; `spritesheetUrl` added to `PetEntry`.
- **`loadPetManifest` suffix fix** — handles suffixed IDs (`originalId__dirName`) produced when same pet id appears in multiple scan dirs.
- **`sharp` require fix** — `ensureThumbnail` uses `require('sharp')` not dynamic `import('sharp')`. Main process is CommonJS; bundler chunked dynamic import in a way that failed to resolve sharp's default export at runtime. Error logging added on failure.

### Bundle format

Compatible with codex-rs / grok-cli / hermes / cursorbuddy:

    <pet-id>/
      pet.json          { id, displayName, description, spritesheetPath }
      spritesheet.webp  1536×1872, 8 cols × 9 rows of 192×208 cells

### Scan dirs (first-hit wins)

1. `~/.codesurf/pets` — primary; installs go here
2. `~/.codex/pets` — codex overlay
3. `~/.hermes/pets` — hermes overlay

### Key files

- `src/main/ipc/pets.ts` — IPC handlers: discover, install, select, remove, spritesheetData, thumbnailData
- `src/shared/pet-types.ts` — ATLAS geometry constants, `AnimationRow` union, `ROW_INDEX`, `FRAME_DURATIONS`, `PetManifest`
- `src/renderer/src/components/PetOverlay.tsx` — spritesheet player (base64 data URL), drag logic, animation row FSM
- `src/renderer/src/components/PetPicker.tsx` — selection gallery with animated preview
- Wired into `AppOverlays.tsx` and `CommandPalette.tsx`

### Animation rows

`idle | runningRight | runningLeft | waving | jumping | failed | waiting | running | review`

Row transitions are event-driven via the event bus: `running` on active chat/agent turn, `idle` while waiting, `failed` transient on tool failure, `waving` on session start/turn completion (2 s then settles to idle).

Spritesheet delivered as base64 data URL via `pets:spritesheetData` IPC. `requestAnimationFrame` cycles `background-position` through frames at per-row cadence from `FRAME_DURATIONS`. Default position: bottom-right, 16 px inset, above status bar (~36 px from bottom).

---

## Chat Chip Chrome Map — Do Not Break

| Component | Chrome |
|---|---|
| `ThinkingBlockView` (individual transcript entry) | Full chip — background + border + shadow |
| `WorkingChipView` (live WORKING indicator) | Full chip — background + border + shadow |
| `ToolBlockView` (individual tool chip) | Full chip — canonical reference |
| `CollationSummaryChip` / group chips | Accent chip — coloured background/border, still bordered |

- `ThinkingBlockView` and `WorkingChipView` are **independent**. Do not couple their styling.
- Canvas overlap issues → check `App.tsx` z-index (`bringToFront`, `nextZIndex`) first. Do not add `position: relative` + `zIndex` to transcript rows to fix canvas stacking.
- `textTransform: uppercase` destroys unit strings (`${n}s` → `NS`). Remove from any span containing number+unit, or render as separate elements.
- Chip expand toggles must use `React.startTransition`.

---

## ChatTile Architecture

### Transcript

- System messages (`role === 'system'`) filtered at both state-update and render time
- User messages: right-aligned blue bubble (`#0a84ff`), white text
- AI messages: left-aligned, robot icon avatar, `#ccc` text
- Timestamps (HH:MM) on every message; copy button on hover
- Markdown code blocks rendered with `highlight.js` (AI messages only)
- 800 px max-width, centred

### Input bar

- Auto-expanding textarea (resets on send); max-height 200 px
- Enter → send; Shift+Enter → new line
- Action row: attach file, image upload, MCP toggle, voice, send — all inline SVG icons

### Streaming

- Placeholder assistant bubble added immediately on send with `streaming: true`
- Tokens appended via `chat:token` IPC events
- Typing indicator (three animated dots) while streaming and content is empty
- On `chat:done`, placeholder finalised

### Persistence

- Chat history saved per-tile to `~/.contex/workspaces/<id>/chats/<tileId>.json`
- Loaded on mount; saved on every message change
- `conversationId` for Claude stored in `useRef` — not sent in IPC payload; SDK tracks internally

---

## Claude Provider — Blank-Turn Hardening (COMMITTED)

Both `src/main/chat/providers/claude.ts` and `packages/codesurf-daemon/bin/chat-jobs.mjs`:

- `sawAssistantOutput` boolean; set on `text_delta`, `thinking_delta`, `input_json_delta`, `tool_use`, `tool_progress`, `tool_use_summary`, or fallback `result.result` text
- `streamedTextByIndex` Map tracks streamed content per turn/block; prevents duplication on assembled `assistant` message
- If Claude finishes with `sawAssistantOutput === false` and no result text → explicit `error` event emitted: "Claude finished without assistant output… Please resend the message."
- Test coverage: `test/daemon/chat-jobs-loop-hardening.test.mjs`

---

## packages/codesurf-daemon

Sub-package at `packages/codesurf-daemon/` with its own `node_modules/`:

- `bin/chat-jobs.mjs` — job manager (Claude + Codex + Omnigent + OpenClaw runners); blank-turn hardening committed
- `bin/omnigent-provider.mjs` — Omnigent model provider: `decodeOmnigentModelId`, `extractOmnigentSessionId`, `mapOmnigentStreamEvent`, `omnigentAuthHeaders`, `omnigentEndpointUrl`, `parseOmnigentSseChunk`
- `bin/agent-mode-tools.mjs`, `bin/agent-mode-resolver.mjs`, `bin/codex-sdk-provider.mjs` — agent mode / tool allowlist resolution
- `bin/` also contains: `checkpoints.mjs`, `context-buckets.mjs`, `instruction-context.mjs`, `memory-loader.mjs`, `project-context.mjs`, `session-index.mjs`, `skills-index.mjs`
- `vendor/dreaming.mjs` — dreaming memory consolidator

Other packages: `contex-chat-bridge`, `contex-relay`, `codesurf-plugin`

---

## Distribution

- `npm run dist:mac` — macOS dmg + zip
- `npm run dist:windows` — NSIS installer + portable exe
- `npm run dist:linux` — AppImage + deb
- `npm run dist:npm` — runs `scripts/build-npm-package.mjs`; launcher downloads Electron into `~/.codesurf/electron` and reuses cached runtime. codesurf-daemon is bundled (`.npmignore` updated; `copyDaemonPackage()` step added).

---

## Type Safety Sweep (COMMITTED as of 2026-06-24)

- Bus subscribe callbacks typed throughout — peer-context (`useChatTilePeerContext.ts`) and kanban listeners (`KanbanTile.tsx`)
- SDK parsing paths (array callbacks) typed across: `agents/agent-cli-contracts.ts`, `chat/providers/openclaw.ts`, `extensions/registry.ts`, `mcp/tools/context.ts`, `relay/provider-executor.ts`, `session-sources/*.ts`, `components/chat/chatTileUtils.ts`
- `src/shared/settings-runtime.ts` — new shared module for runtime settings types
- IPC handler validation hardened (`handleTyped.ts`)
- Session-sources decomposed and orchestrator wired

tsc baseline (~145 errors) reflects pre-existing issues only; no new regressions introduced.

---

## Memory / Listener Leak Fixes (COMMITTED)

- ChatTile: more aggressive compaction — lower char caps, truncation for tool/thinking/content-block payloads, auto-flatten older finished messages
- `src/main/ipc/bus.ts`, `terminal.ts`, `fs.ts`: one tracked cleanup listener per sender; was stacking `destroyed` handlers on repeated subscribe/create/watch calls causing `MaxListenersExceededWarning`

---

## KanbanTile AI Integration

- Compact prompt bar at top
- On submit: serialises board state as JSON; sends to Claude with system prompt instructing JSON patch response
- Supported ops: `add_card`, `move_card`, `update_card`, `delete_card`, `add_column`, `rename_column`, `delete_column`
- Response parsed and ops applied to local board state

---

## Extensions

- Bundled extensions: `bundled-extensions/`; LiveKit Rooms at `bundled-extensions/livekit-rooms/`
- Extension tile theming rule: **never** use `prefers-color-scheme`; default light CSS; apply `body.dark` via bridge; use solid hex, not `rgba` opacity

---

## Active Cron Agents (OpenClaw-hosted)

| Name | Status |
|---|---|
| VibeClaw Skills Scout | Running — scans skills.sh + GitHub for new MCP tools; reports to VibeClaw explore page |
| Urgent Email Alert | Running — executes `~/clawd/scripts/email-alert-check.sh`; reports HEARTBEAT_OK or script errors only |
| Tom Doerr Tweet Tracker | Blocked — X.com requires login; no cached auth session; state file at `~/clawd/memory/tom-doerr-seen.json` |
| VibeClaw Wallpaper Generator | Blocked — DGX at `192.168.4.104:8003` unreachable; generation server must be running |
| VibeClaw Article Generator | Blocked — web search returning 403 (Gemini API); zero articles published when fewer than 3 independent sources verifiable |
| OpenClaw Lead/MC-Gateway heartbeat | Running — HEARTBEAT_OK when gateway alive; mc-gateway had intermittent failed turns, likely a port/restart issue |

---

## Open Threads

- **Pet uncommitted changes** — five files (`src/main/ipc/pets.ts`, `src/preload/index.ts`, `PetOverlay.tsx`, `PetPicker.tsx`, `src/renderer/src/env.d.ts`) are self-consistent and ready to commit. Smoke-test that `require('sharp')` resolves in the built Electron app before committing.
- **Sidebar.tsx still ~1870 LOC** — extraction ongoing; further components can be pulled into `sidebar/`
- **BrowserTile.tsx at ~1411 LOC** — further decomposition possible
- **gpt-5.5 in Codex** — observed in live session history; confirm whether to add to `ChatProviderContext` model list
- **OpenClaw mc-gateway** — intermittent failed assistant turns in recent heartbeat sessions; verify daemon port config if failures persist
- **X.com auth for tweet tracker** — needs authenticated Chrome session or alternative endpoint
- **DGX wallpaper server** — `192.168.4.104:8003` unreachable; VibeClaw wallpaper cron dead until service restarted
- **grok-cli model sync** — when new models added, also update `~/Documents/GitHub/grok-cli/src/core/extensions/builtin/codesurf-desktop-provider.ts` MODELS array to mirror `src/renderer/src/config/providers.ts`
