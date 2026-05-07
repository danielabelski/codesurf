The file is now updated. Here is the full replacement content for `.codesurf/DREAMING.md`:

# Workspace Memory — contex (collaborator-clone)

Generated: 2026-05-07. Supplements CLAUDE.md/AGENTS.md — does not replace them.

---

## Overview

**contex** is an Electron desktop app — infinite canvas workspace for AI agents and humans. Also branded **CodeSurf**. Active branch: `main-latest`. HEAD: `fd23f34` ("Parse external-agent markup; UI/Sidebar tweaks"). Working tree has two unstaged files. The branch referenced in CLAUDE.md/AGENTS.md (`feature/event-bus-mcp`) is long merged; ignore it.

---

## Architectural NorthStar

"The desktop is dumb as shit. The daemon is smart." — all intelligence belongs in `grok-cli` at `~/Documents/GitHub/grok-cli/`. Desktop is a rendering shell; code-index, agent memory, and model intelligence live in grok-cli, not this repo.

---

## Monorepo Layout

- `src/` — Electron host app (main + preload + renderer)
- `packages/codesurf-daemon` — CodeSurf daemon binary
- `packages/codesurf-dreaming` — Dreaming agent package
- `packages/contex-chat-bridge` — Chat bridge package
- `packages/contex-relay` — Relay layer
- `apps/chat-app` — Standalone React chat UI (scaffolded; integration completeness unknown)

---

## Durable Facts

**Stack:** Electron 40.8.2, React 19.2.4, TypeScript 5.9.3, electron-vite 5.0.0, Tailwind CSS 4.0.0, xterm+node-pty, Monaco, `@anthropic-ai/claude-agent-sdk` 0.2.79, `@opencode-ai/sdk` 1.2.27. All chat providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.

**IPC:** `{feature}:{action}` naming convention; handlers in `src/main/ipc/`; context bridge in `src/preload/index.ts`. Use `window.electron.invoke()` — not `window.electron.ipcRenderer.invoke()`.

**MCP:** Agent-facing MCP server on random port — always read from `~/.contex/mcp-server.json`. Claude Code/Codex contex MCP port is session-local — read from `.mcp.json`, never hardcode.

**Persistence:**
- `~/.contex/workspaces/{id}/canvas.json` — canvas state (500ms debounce auto-save)
- `~/.contex/workspaces/{id}/tiles/{id}.json` — kanban tile state
- `~/.codesurf/sessions/` — chat session files (read by `chat:list-threads`)
- `~/.codesurf/builder/{tileId}.json` — builder history (per tile, persisted as of `9cbb578`)
- `~/.contex/mcp-server.json` — MCP server config
- `~/.codesurf/` — daemon state (distinct namespace from `~/.contex/`)
- SQLite DB in `src/main/db/` — thread indexing, jobs, migrations

**Style:** Dark theme hardcoded (`#1e1e1e`, `#252525`, `#333`). Tailwind + inline `React.CSSProperties`. No CSS-in-JS library. 2-space indent, trailing commas, no semicolons. No `prefers-color-scheme`; dark mode toggled via `body.dark` through bridge.

**App.tsx:** ~1700 LOC containing the entire canvas engine (pan/zoom, drag, resize, snapping, groups, undo/redo). Be surgical — changes ripple widely. Undo snapshots full state (max 50); never push to undo stack in hot paths.

**Typecheck:** `npm run typecheck:go` has pre-existing repo-wide TypeScript errors unrelated to recent work. Renderer build (`npm run build:renderer`) is the practical compile check for UI changes.

---

## Recently Landed (committed)

| Commit | Summary |
|--------|---------|
| `fd23f34` | Parse external-agent markup in ChatTile; toolbar pill sizing tweaks; sidebar right-rail offset 4→2; CSS table exclusion from border→shadow rule |
| `343da2d` | Update index.css (edge shadow rules) |
| `35dab31` | Update App.tsx (Tahoe toolbar, tab polish) |
| `4977141` / `8a437e8` | Update ChatTile.tsx (chat UI iteration) |
| `b290336` | Refine UI shadows, tabs, sidebar selection |
| `6ee42e6` | Use text.primary for active tab labels |
| `e8daa10` | Polish chat UI, tool labels, code wrapping |
| `82f6c77` | Refactor UI: edge shadows, light-mode visuals (large — 15 files) |
| `8390242` | Update Sidebar.tsx (hover states, archive icon interaction) |
| `67f17be` | Throttle thread scans; SWR and dedupe sessions |
| `b6ca934` | Persist sessions, compact log, optimize streaming |
| `c9131ac` | Support large messages and diffs; stream flush |
| `9cbb578` | Persist builder history and chat-surface state |

---

## Active Subsystems

**Edge Shadow System** — committed `82f6c77` + refined in follow-ups. `getEdgeShadow(theme, tone)` and `stackEdgeShadow()` in `theme.ts`; CSS vars `--cs-edge-shadow-*` applied to `#root` in `App.tsx`; global CSS rule in `index.css` replaces flat hairline borders on rounded/pill elements with multi-layer `box-shadow`; tables excluded (`:not(table)`); sidebar header transparent, no border; `SidebarFooter` glass resting state, always 28×28 icon-only.

**Chat Tile / Composer** — all committed. Composer fill uses `composerBackground`; `ChatComposerCard` applies `stackEdgeShadow()`; unfenced-diff blocks rendered as `<pre>`; chat-md tables flat (no edge-shadow, border-radius 0). Large content support (`c9131ac`): `largeContent.ts`, `GuardedChatMarkdown`, `LargeTextBlock`, `RawDiffBlock`. Streaming buffer: 50ms flush; deferred normalization; 2000ms/500ms state-persist debounce; `beforeunload` flush. `getToolDisplayName()` maps tool IDs to display labels.

**External Agent Markup** — `splitExternalAgentMarkup(text)` in ChatTile (committed `fd23f34`) parses `[external_agent_tool_call:name]` / `[external_agent_tool_result]` tags into `ExternalAgentMarkupSegment[]`; tool segments render as `ToolBlockView` chip rows inline with text. Two more helpers unstaged (see Dirty): `getExternalAgentToolBlocks()` and `isExternalAgentToolOnlyText()` extend chip extraction to tool-only messages.

**Sidebar** — all committed. Session list: hover with archive icon fade-in / timestamp fade-out; parity across both list sections. `SIDEBAR_RIGHT_RAIL_ACTION_RIGHT = 2` (committed `fd23f34`). Header transparent, no border. Footer icon-only 28×28, glass resting. `selectedSessionKey` prevents multi-row selection.

**Builder Tile** — history persisted (`9cbb578`); each build appends `{timestamp, prompt, result}` to tile state; scrollable history panel.

**Thread Indexer / Session Cache** — throttled scans, 60s SWR cache with stale-while-revalidate, `inflightRefreshes` dedup, tail-based loader for large session files (`67f17be`).

---

## Currently Dirty (Unstaged — vs HEAD `fd23f34`)

| File | Change |
|------|--------|
| `src/renderer/src/App.tsx` | Workspace tab margin fix: split single `workspaceTabInactiveBottomGap = 3` into `workspaceTabActiveBottomGap = 3` and `workspaceTabInactiveBottomGap = workspaceTabActiveBottomGap + 3`; active and inactive tabs now use distinct bottom margins |
| `src/renderer/src/components/ChatTile.tsx` | Two new helpers: `getExternalAgentToolBlocks(text)` extracts `ToolBlock[]` from external agent markup; `isExternalAgentToolOnlyText(text)` detects tool-only messages. `extractChipsFromMessage` now handles messages with no `contentBlocks` but external-agent tool markup — pushes those as `'tool-single'` chip items |

---

## Open Threads

- Unstaged App.tsx + ChatTile.tsx changes are small, coherent, and ready to commit
- Archive icon alignment in sidebar thread list iterated multiple times today; `SIDEBAR_RIGHT_RAIL_ACTION_RIGHT = 2` is committed — optically aligned but fragile if sidebar width changes significantly
- `ChatSidebarSection.tsx` (WebSocket) vs `ChatHistorySection.tsx` (IPC): consolidation to IPC version deferred
- grok-cli model catalog wire-up remains incomplete (persistent across multiple dreams)
- `apps/chat-app` standalone app scaffolded with AI SDK + AI Elements; integration depth with main harness unknown
- `npm run typecheck:go` has pre-existing repo-wide TS errors; not a blocker for UI work

---

_Generated by codesurf-dreaming._
