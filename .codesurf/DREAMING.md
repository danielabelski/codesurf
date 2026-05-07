The `.codesurf/DREAMING.md` file has been updated. Here is the full replacement content:

---

# Workspace Memory — contex (collaborator-clone)

Generated: 2026-05-07. Supplements CLAUDE.md/AGENTS.md — does not replace them.

---

## Overview

**contex** is an Electron desktop app — infinite canvas workspace for AI agents and humans. Also branded **CodeSurf**. Active branch: `main-latest`. HEAD: `2a5e985` ("Merge branch 'main-latest'"). Working tree has 2 unstaged files (`src/main/ipc/canvas.ts`, `src/renderer/src/App.tsx`). The branch referenced in CLAUDE.md/AGENTS.md (`feature/event-bus-mcp`) is long merged; ignore it.

---

## Architectural NorthStar

"The desktop is dumb as shit. The daemon is smart." — all intelligence belongs in `grok-cli` at `~/Documents/GitHub/grok-cli/`. Desktop is a rendering shell; code-index, agent memory, and model intelligence live in grok-cli, not this repo. Session title generation now queries the daemon (`daemonClient.listExternalSessions()`) before falling back to local SQLite — signals growing daemon-first data ownership.

---

## Monorepo Layout

- `src/` — Electron host app (main + preload + renderer)
- `packages/codesurf-daemon` — CodeSurf daemon binary
- `packages/codesurf-dreaming` — Dreaming agent package
- `packages/contex-chat-bridge` — Chat bridge package
- `packages/contex-relay` — Relay layer
- `apps/chat-app` — Standalone React chat UI (scaffolded; integration depth with main harness unknown)

---

## Durable Facts

**Stack:** Electron 40.8.2, React 19.2.4, TypeScript 5.9.3, electron-vite 5.0.0, Tailwind CSS 4.0.0, xterm+node-pty, Monaco, `@anthropic-ai/claude-agent-sdk` 0.2.79, `@opencode-ai/sdk` 1.2.27. All chat providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.

**IPC:** `{feature}:{action}` convention; handlers in `src/main/ipc/`; context bridge in `src/preload/index.ts`. Use `window.electron.invoke()` — not `window.electron.ipcRenderer.invoke()`.

**MCP:** Agent-facing MCP server on random port — always read from `~/.contex/mcp-server.json`. Claude Code/Codex contex MCP port is session-local — read from `.mcp.json`, never hardcode.

**Persistence:** canvas.json (500ms debounce), kanban tile JSON, `~/.codesurf/sessions/` (chat threads), `~/.codesurf/builder/{tileId}.json` (builder history), `~/.contex/mcp-server.json`, SQLite DB in `src/main/db/`.

**Style:** Dark theme hardcoded. Tailwind + inline `React.CSSProperties`. 2-space indent, trailing commas, no semicolons. No `prefers-color-scheme`; dark mode via `body.dark` bridge.

**Typecheck:** `npm run typecheck:go` has pre-existing repo-wide TS errors. Use `npm run build:renderer` as the practical compile check for UI work.

---

## Recently Landed (committed)

| Commit | Summary |
|--------|---------|
| `2a5e985` | Merge branch 'main-latest' — 18 files, 914 insertions: App.tsx, ChatTile, LayoutBuilder, PanelLayout, SettingsPanel, Sidebar, TileChrome, SidebarFooter, ChatComposer, streamdown-utils, Toggle, index.css, theme.ts, types.ts |
| `61e2e92` | UI spacing: workspace tab heights, chat transcript scrollbar gutter, user bubble margins, compact tab theme-aware sizing, SidebarTopItem vertical rhythm |
| `b3dadfe` | ChatTile tool parsing helpers, `extractChipsFromMessage` tool-only support; workspace tab active/inactive bottom gaps split; sidebar hover overlay (absolute positioning) |
| `fd23f34` | External-agent markup parsing; toolbar pill sizing; sidebar right-rail offset 4→2; CSS table exclusion from border→shadow rule |
| `82f6c77` | Refactor UI: edge shadows & light-mode visuals (15 files) |
| `67f17be` | Throttle thread scans; SWR and dedupe sessions |
| `9cbb578` | Persist builder history and chat-surface state |

---

## Active Subsystems

**Edge Shadow System** — `getEdgeShadow(theme, tone)` and `stackEdgeShadow()` in `theme.ts`; CSS vars `--cs-edge-shadow-*` on `#root`; global CSS rule in `index.css` replaces hairline borders with `box-shadow` on rounded/pill elements; tables excluded (`:not(table)`); `SidebarFooter` glass resting state, 28×28 icon-only.

**Light-Mode Theming** — LayoutBuilder computes `leafSurface`, `leafEdge`, `dividerHandle` from `theme.mode`; leaf tiles use `borderRadius: 2` and edge shadow. Multiple components received light-mode passes in `2a5e985` merge.

**Chat Tile / Composer** — Composer fill uses `composerBackground`; `ChatComposerCard` applies `stackEdgeShadow()`; unfenced-diff blocks as `<pre>`; chat-md tables flat. Large content: `largeContent.ts`, `GuardedChatMarkdown`, `LargeTextBlock`, `RawDiffBlock`. Streaming: 50ms flush; deferred normalization; 2000ms/500ms persist debounce. Chat transcript uses `scrollbarGutter: 'stable'`.

**External Agent Markup** — `splitExternalAgentMarkup`, `getExternalAgentToolBlocks`, `isExternalAgentToolOnlyText` parse `[external_agent_tool_call:name]` / `[external_agent_tool_result]` tags. `extractChipsFromMessage` handles tool-only messages as `'tool-single'` chips. All committed.

**Sidebar** — Absolute overlay for hover/active backgrounds. Archive icon fade-in / timestamp fade-out on hover. `SIDEBAR_RIGHT_RAIL_ACTION_RIGHT = 2`. Header transparent. Footer 28×28 icon-only glass. `selectedSessionKey` prevents multi-row selection.

**PanelLayout Tabs** — Theme-aware compact tabs; `workspaceTabActiveBottomGap` / `workspaceTabInactiveBottomGap` are distinct constants.

**Builder Tile** — History persisted to `~/.codesurf/builder/{tileId}.json`; each build appends `{timestamp, prompt, result}`; scrollable history panel.

**Thread Indexer / Session Cache** — Throttled scans, 60s SWR cache, `inflightRefreshes` dedup, tail-based loader for large session files.

---

## Currently Dirty (Unstaged — vs HEAD `2a5e985`)

| File | Change |
|------|--------|
| `src/main/ipc/canvas.ts` | Session title generation: `daemonClient.listExternalSessions()` lookup inserted before SQLite lookup in `getCurrentSessionTitleForTitleGeneration`; `cleanSessionTitleCandidate()` wraps `entryHint.title`; `currentTitleBeforeGeneration` fetched once and reused; `workspacePath` hoisted out of gated block |
| `src/renderer/src/App.tsx` | 1-line cleanup: removes `console.log('[Discovery] Injecting locked connections:...')` from locked-connection injection loop |

---

## Open Threads

- Dirty canvas.ts (daemon-first title lookup) and App.tsx (console.log removal) are both ready to commit
- Archive icon alignment (`SIDEBAR_RIGHT_RAIL_ACTION_RIGHT = 2`) is stable but fragile if sidebar width changes significantly
- `ChatSidebarSection.tsx` (WebSocket) vs `ChatHistorySection.tsx` (IPC): consolidation to IPC version deferred
- grok-cli model catalog wire-up incomplete (persistent across multiple dreams)
- `apps/chat-app` standalone scaffolded with AI SDK + AI Elements; integration depth with main harness unknown

---

_Generated by codesurf-dreaming._
