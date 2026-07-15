CodeSurf — Generated Memory (2026-07-15)

## Overview

CodeSurf is an Electron desktop app providing an infinite-canvas workspace where tiles (terminal, code editor, browser, kanban, chat) live on a 2D canvas. AI agents connect via MCP and collaborate with humans asynchronously. Multi-target architecture is live: one React renderer shared across Electron (full), browser PWA, and a Native Zig WebView shell. Reference: `docs/multi-target.md`.

The codebase is in an active large-scale **modularization phase** — monolithic components (App.tsx, ChatTile.tsx, ToolBlockView.tsx, useCanvasEngine.ts, Sidebar.tsx, TileChrome.tsx, themePresets.ts) are being split into focused modules with stable re-export surfaces and test coverage added for each split. This is the dominant pattern in recent commits; continue it rather than fighting it.

CodeSurf is also actively used as an agent orchestration platform — Canvas Codex tiles run as specialised subagents in external projects. Expected behaviour.

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
| IPC handlers (41+ files) | `src/main/ipc/` |
| Canvas engine shell (trimmed) | `src/renderer/src/App.tsx` |
| Canvas engine math | `src/renderer/src/hooks/canvasEngineMath.ts` |
| Canvas pointer handlers | `src/renderer/src/hooks/useCanvasPointerHandlers.ts` |
| Canvas context menus | `src/renderer/src/hooks/useCanvasContextMenus.ts` |
| Canvas connection lock | `src/renderer/src/hooks/useCanvasConnectionLock.ts` |
| Canvas engine orchestrator | `src/renderer/src/hooks/useCanvasEngine.ts` (re-exports above) |
| Canvas derived state hook | `src/renderer/src/hooks/useAppCanvasDerivedState.ts` (untracked, in-progress) |
| Canvas visibility lib | `src/renderer/src/lib/canvasVisibility.ts` (untracked, in-progress) |
| Canvas history equality | `src/renderer/src/hooks/canvasHistory.ts` |
| Shell chrome hook | `src/renderer/src/hooks/useAppShellChrome.ts` |
| Shell layout metrics | `src/renderer/src/hooks/useShellLayoutMetrics.ts` |
| Tile components (lazy) | `src/renderer/src/components/` |
| Sidebar shell | `src/renderer/src/components/Sidebar.tsx` (re-export surface) |
| Sidebar controller | `src/renderer/src/components/sidebar/useSidebarController.tsx` |
| TileChrome shell | `src/renderer/src/components/TileChrome.tsx` (re-export surface) |
| TileChrome drawer panels | `src/renderer/src/components/tile-chrome/DrawerPanels.tsx` |
| TileChrome drawer activity | `src/renderer/src/components/tile-chrome/drawerActivity.ts` |
| TileChrome resize handle | `src/renderer/src/components/tile-chrome/ResizeHandle.tsx` |
| TileChrome labels/types | `src/renderer/src/components/tile-chrome/labels.ts`, `types.ts` |
| ChatTile shell (trimmed) | `src/renderer/src/components/ChatTile.tsx` |
| Chat stream hub | `src/renderer/src/components/chat/chatStreamHub.ts` |
| Chat messages store | `src/renderer/src/components/chat/chatMessagesStore.ts` |
| Thinking clock | `src/renderer/src/components/chat/thinkingClock.ts` |
| Transcript window | `src/renderer/src/components/chat/transcriptWindow.ts` |
| ToolBlockView shell | `src/renderer/src/components/chat/ToolBlockView.tsx` (re-export surface) |
| ToolBlockView core | `src/renderer/src/components/chat/ToolBlockViewCore.tsx` |
| Thinking/Working chips | `src/renderer/src/components/chat/ThinkingWorkingChips.tsx` |
| Tool group chips | `src/renderer/src/components/chat/ToolGroupChips.tsx` |
| Tool input view | `src/renderer/src/components/chat/ToolInputView.tsx` |
| Chat send path hook | `src/renderer/src/hooks/useChatTileSendPath.ts` |
| Chat session core hook | `src/renderer/src/hooks/useChatTileSessionCore.ts` |
| Chat shell model hook | `src/renderer/src/hooks/useChatTileShellModel.ts` |
| Chat agent modes hook | `src/renderer/src/hooks/useChatTileAgentModes.ts` |
| Runtime checkpoints | `src/main/chat/runtime-checkpoints.ts` |
| Theme presets (entry) | `src/renderer/src/themePresets.ts` (re-exports from catalogs) |
| Theme presets core | `src/renderer/src/themePresetsCore.ts` |
| Theme presets dark | `src/renderer/src/themePresetsDark.ts` |
| Theme presets light | `src/renderer/src/themePresetsLight.ts` |
| Shared types | `src/shared/types.ts` |
| Stream parser | `src/main/ipc/stream.ts` |
| Agent room store | `src/main/agent-room/` (`index.ts`, `store.ts`, `types.ts`) |
| Activity cap | `src/main/activity-cap.ts` |
| Webview paint bridge | `src/shared/webview-paint-bridge.ts` |
| Platform layer | `src/renderer/src/platform/` (detect, daemonBridge, hostConfig, nativeRuntimeConfig, pickFolder, pwa) |
| Terminal transport | `src/renderer/src/platform/terminalTransport.ts` |
| Terminal gateway package | `packages/codesurf-terminal-gateway/` |
| Daemon package | `packages/codesurf-daemon/` |
| Plugin package | `packages/codesurf-plugin/` |
| Relay package | `packages/codesurf-relay/` |
| Chat bridge package | `packages/codesurf-chat-bridge/` |
| Native Zig launcher | `desktop/src/sidecar_launcher.zig` |
| Web host | `scripts/web-host.mjs` |

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
| `npm run desktop:dev` | Native SDK WebView shell + web stack |
| `npm run build` | Electron build (main + preload + renderer) |
| `npm run build:web` | Renderer only → `dist/` |
| `npm run rebuild` | Native rebuild for node-pty |

### Commit History (as of 2026-07-15)

HEAD: `8ec42e1` (Split theme presets into core catalogs)

- `8ec42e1` — Split theme presets into core catalogs (`themePresetsCore`, `themePresetsDark`, `themePresetsLight`)
- `beb6536` — Refactor chat shell orchestration (ChatTile split; chatStreamHub, chatMessagesStore, thinkingClock, transcriptWindow; new hooks; structural canvas history equality; 7+ new tests)
- `d4bcebb` — Split Sidebar and TileChrome into modules
- `f33578e` — Modularize chat chips and canvas engine hooks (ToolBlockView split; useCanvasEngine split; runtime-checkpoints)
- `ef9046e` / `8f441e1` — Merge polly daemon-host-binding and claude-resume-transcript-guard
- `7c688cb` — Add terminal gateway and Native loopback sidecar
- `52921bd` — Upgrade to native zero
- `ba94e3a` — Major collaboration updates (agent-room, webview-paint bridge, activity cap, codesurf-relay rename)

### Working Tree (2026-07-15, post-8ec42e1)

Modified: `src/renderer/src/App.tsx` — extracting `panelTileIds`, `tileByIdMap`, `expandedCanvasMembership` into `useAppCanvasDerivedState` hook.

Untracked (in-progress): `src/renderer/src/hooks/useAppCanvasDerivedState.ts`, `src/renderer/src/lib/canvasVisibility.ts`, `test/app-canvas-derived-state.test.ts`, `test/theme-presets-split.test.ts`.

---

## Active Capabilities

### Modularization Pattern (Active)

Shell files become thin re-export surfaces; logic moves to sibling directories; tests added for new modules. When touching a component, check if it has already been split — the shell may be very short with logic in a subfolder.

### Chat Shell Architecture (post-beb6536)

ChatTile substantially slimmed. Key new seams: `chatStreamHub.ts` (global stream multiplexer), `chatMessagesStore.ts` (per-tile message state), `thinkingClock.ts`, `transcriptWindow.ts`, `useChatTileShellModel.ts`, `useChatTileSendPath.ts`, `useChatTileSessionCore.ts`, `useChatTileAgentModes.ts`.

### Chat Chip Chrome Map — Do Not Break

| Component | Chrome |
|---|---|
| `ThinkingBlockView` | Full chip — background + border + shadow |
| `WorkingChipView` | Full chip — background + border + shadow |
| `ToolBlockViewCore` | Full chip — canonical reference |
| `CollationSummaryChip` / group chips | Accent chip — coloured background/border |

- `ThinkingBlockView` and `WorkingChipView` are independent — never edit both in one change; both now live in `ThinkingWorkingChips.tsx`
- Canvas overlap issues → check App.tsx `bringToFront`/`nextZIndex` before touching transcript CSS
- `textTransform: uppercase` on spans containing number+unit strings destroys the unit suffix
- Chip expansion: use `React.startTransition` on all expand toggles
- `ToolBlockView.tsx` is a re-export surface only; real logic is in `ToolBlockViewCore.tsx`

### Terminal Gateway / Multi-target / Agent Room / Security / Canvas Perf

All landed and stable — see previous memory entries; no changes to these subsystems in latest commits.

---

## Open Threads

- **App.tsx canvas derived state extraction** — `useAppCanvasDerivedState` + `canvasVisibility.ts` untracked; App.tsx modified; needs commit
- **theme-presets-split test** — `test/theme-presets-split.test.ts` untracked; needs commit alongside `8ec42e1`
- **Native cold-start white screen** — synchronous `std.process.run`; needs persistent async controller path
- **Electron test: 1 remaining failure** — abort/rename edge case
- **titerm P0/P1** — post-fork libc deadlock, token cap, `last-output` row bug, zero tests; re-verify before fixing
- **Lazar TUI** — fabrication/grounding kernel changes staged; TUI is a separate repo and must be committed independently
- **runext Wave 1** — 50 VS Code API stubs pending; 3 open audit findings
- **tsc baseline dirty** — ~145 pre-existing errors; measure regressions per-file, not by exit code
- **`cluso-widget`** — optional local dep (`file:../agentation-real`); may not exist in all environments
- **node-pty** — requires `npm run rebuild` after any native dependency change
