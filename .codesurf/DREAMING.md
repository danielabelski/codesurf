The file was already updated by a concurrent process with richer detail than my draft — it correctly captured the hook extraction, including the stale-job guard and transcription API details from `useChatDictation`. The current on-disk content is accurate and complete. Here is the full replacement content for `.codesurf/DREAMING.md`:

---

# Workspace Memory — contex (collaborator-clone)

Generated: 2026-05-08. Supplements CLAUDE.md/AGENTS.md — does not replace them.

---

## Overview

**contex** is an Electron desktop app — infinite canvas workspace for AI agents and humans. Also branded **CodeSurf**. Active branch: `main`. HEAD: `7277c9f` ("Update DREAMING.md"). Working tree has unstaged changes to `ChatTile.tsx` and `.mcp.json`, plus two new untracked hook files (see Pending / In-Flight below).

The branch referenced in CLAUDE.md/AGENTS.md (`feature/event-bus-mcp`) is long merged; ignore it.

---

## Architectural NorthStar

"The desktop is dumb as shit. The daemon is smart." — all intelligence belongs in `grok-cli` at `~/Documents/GitHub/grok-cli/`. Desktop is a rendering shell; code-index, agent memory, and model intelligence live in grok-cli, not this repo. `getCurrentSessionTitleForTitleGeneration` in `canvas.ts` queries `daemonClient.listExternalSessions()` before falling back to SQLite — daemon-first data ownership pattern is live and committed.

---

## Monorepo Layout

- `src/` — Electron host app (main + preload + renderer)
- `packages/codesurf-daemon` — CodeSurf daemon binary
- `packages/codesurf-dreaming` — Dreaming agent package
- `packages/contex-chat-bridge` — Chat bridge package
- `packages/contex-relay` — Relay layer
- `apps/chat-app` — Standalone React chat UI (scaffolded; integration depth with main harness unknown)
- `bundled-extensions/builder/` — Builder surface extension (history UI + localStorage + tile state persistence added in 9cbb578)

---

## Durable Facts

**Stack:** Electron 40.8.2, React 19.2.4, TypeScript 5.9.3, electron-vite 5.0.0, Tailwind CSS 4.0.0, xterm+node-pty, Monaco, `@anthropic-ai/claude-agent-sdk` 0.2.79, `@opencode-ai/sdk` 1.2.27. All chat providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.

**IPC:** `{feature}:{action}` convention; handlers in `src/main/ipc/`; context bridge in `src/preload/index.ts`. Use `window.electron.invoke()` — not `window.electron.ipcRenderer.invoke()`.

**MCP:** Agent-facing MCP server on random port — always read from `~/.contex/mcp-server.json`. Claude Code/Codex contex MCP port is session-local — read from `.mcp.json`, never hardcode.

**Persistence:**
- `~/.contex/workspaces/{id}/canvas.json` — canvas state (500ms debounce)
- `~/.contex/workspaces/{id}/tiles/{tileId}.json` — kanban tile state
- `~/.codesurf/sessions/` — chat threads
- `~/.codesurf/builder/{tileId}.json` — builder history (each build: `{timestamp, prompt, result}`)
- `~/.contex/mcp-server.json` — MCP server config
- SQLite DB in `src/main/db/`
- Builder surface additionally uses `localStorage` + `tile.getState`/`tile.setState` for immediate cross-session hydration
- `openChatSurfaces` / `activeChatSurfaceId` persisted in `ChatTile.tsx` runtime state

**Default theme:** `shared/types.ts` sets app appearance to `"paper-light"` (light theme) with adjusted canvas/grid colors and updated default font stacks, sizes, and weights. Previous default was dark.

**Style:** Theme-aware (light/dark). Tailwind + inline `React.CSSProperties`. 2-space indent, trailing commas, no semicolons. No `prefers-color-scheme`; dark mode via `body.dark` bridge.

**Typecheck:** `npm run typecheck:go` has pre-existing repo-wide TS errors across unrelated files — not a signal for UI-only changes. Use `npm run build:renderer` as the practical compile check for renderer/UI work.

---

## Recently Landed (committed)

| Commit | Summary |
|--------|---------|
| `7277c9f` | DREAMING.md update (generated memory) |
| `864084a` | Edge shadow opacity tuning for light/dark: lower white alpha, higher dark alpha; `getEdgeShadow` fully mode-aware; `mainPanelInsetEdgeShadow` in App.tsx adjusted |
| `c30b3d8` | Daemon-first session titles live; `renameSessionTitleForSidebar` introduced; TileChrome light-mode edge-shadow variants; types.ts defaults updated (fonts, sizes, "paper-light") |
| `9cbb578` | Builder history persistence — `bundled-extensions/builder/surface/index.html` and `ChatTile.tsx` |
| `2a5e985` | Merge branch 'main-latest' — 18 files, 914 insertions |
| `61e2e92` | UI spacing: workspace tab heights, scrollbar gutter, user bubble margins, compact tab sizing |
| `b3dadfe` | ChatTile tool parsing helpers; workspace tab gap constants split; sidebar hover overlay |
| `fd23f34` | Parse external-agent markup; toolbar pill sizing; sidebar right-rail offset 4→2; CSS table exclusion |

---

## Pending / In-Flight (unstaged / untracked)

**Hook extraction from `ChatTile.tsx`** — two modules extracted to keep ChatTile.tsx lean. Both files are untracked and not yet committed:

- `src/renderer/src/hooks/useChatDictation.ts` — encapsulates all voice dictation state (`isDictating`, `dictationText`, `dictationError`), VAD lifecycle (`useVoiceActivityDetector`), transcription via `window.electron.transcribe.run({ audio, mimeType, provider, lang, localBaseUrl })`, and barge-in on speech start. Replaces direct `useVoiceActivityDetector` / `float32ToWav` imports in ChatTile. Exposes `{ isDictating, dictationText, dictationError, toggleDictation, onTranscription }`. Stale-job guard via `transcribeJobRef`.

- `src/renderer/src/hooks/useChatGitState.ts` — encapsulates module-level git state cache (`gitStateCache`, `gitStateInflight`, 15s TTL), `loadGitState`, `getCachedGitState`. Cache is module-level and shared across all ChatTile instances. Exposes `{ gitStatus, gitBranches, refreshGitState }`. Types `GitStatusSummary` and `GitBranchSummary` are now exported from this hook.

`ChatTile.tsx` diff: inline git state types/functions and voice dictation state removed; replaced by `useChatGitState(_workspaceDir)` and `useChatDictation(...)` hook calls. Pure extraction refactor — no behavior change.

---

## Active Subsystems

**Edge Shadow System** — `getEdgeShadow(theme, tone)` and `stackEdgeShadow()` in `theme.ts`; fully mode-aware. CSS vars `--cs-edge-shadow-*` on `#root`; global CSS rule in `index.css` replaces hairline borders with `box-shadow` on rounded/pill elements; tables excluded (`:not(table)`).

**TileChrome** — Light-mode variant uses `drawerPanelShadow` / `tilePanelShadow`. Tile panel and drawer render distinct shadow styles depending on theme mode.

**Light-Mode Theming** — Default app appearance is `"paper-light"`. LayoutBuilder computes `leafSurface`, `leafEdge`, `dividerHandle` from `theme.mode`; leaf tiles use `borderRadius: 2` and edge shadow.

**Session Title / Rename Flow** — `getCurrentSessionTitleForTitleGeneration` queries daemon first, falls back to SQLite. `renameSessionTitleForSidebar` cascade: local → scoped daemon → global daemon → re-index fallback. `cleanSessionTitleCandidate()` applied to hint titles.

**Chat Tile / Composer** — Composer fill uses `composerBackground`; `ChatComposerCard` applies `stackEdgeShadow()`; unfenced-diff blocks as `<pre>`; chat-md tables flat. Large content: `largeContent.ts`, `GuardedChatMarkdown`, `LargeTextBlock`, `RawDiffBlock`. Streaming: 50ms flush; 2000ms/500ms persist debounce.

**Voice Dictation** — Extracted to `useChatDictation` (pending commit). VAD-based auto-detect; barge-in on speech start; transcription via `window.electron.transcribe.run()`; stale-job guard.

**Git State in ChatTile** — Extracted to `useChatGitState` (pending commit). Module-level cache shared across all ChatTile instances; 15s TTL; `loadGitState(dir, force?)` deduped via inflight map.

**External Agent Markup** — `splitExternalAgentMarkup`, `getExternalAgentToolBlocks`, `isExternalAgentToolOnlyText` parse `[external_agent_tool_call:name]` / `[external_agent_tool_result]` tags. `extractChipsFromMessage` handles tool-only messages as `'tool-single'` chips.

**Sidebar** — Absolute overlay for hover/active backgrounds. Archive icon fade-in / timestamp fade-out on hover. `SIDEBAR_RIGHT_RAIL_ACTION_RIGHT = 2`. Header transparent. Footer 28×28 icon-only glass. `selectedSessionKey` prevents multi-row selection.

**PanelLayout Tabs** — Theme-aware compact tabs; `workspaceTabActiveBottomGap` / `workspaceTabInactiveBottomGap` are distinct constants.

**Builder Tile** — `bundled-extensions/builder/surface/index.html`. History persisted to `~/.codesurf/builder/{tileId}.json` via IPC and to `localStorage` for immediate restore; state versioned with `BUILDER_STATE_VERSION`; each build appends `{timestamp, prompt, result}`; scrollable history select UI.

**Thread Indexer / Session Cache** — Throttled scans, 60s SWR cache, `inflightRefreshes` dedup, tail-based loader for large session files.

---

## Open Threads

- **Pending commit: hook extractions** — `useChatDictation.ts` and `useChatGitState.ts` are untracked; `ChatTile.tsx` changes are unstaged. Commit together after `npm run build:renderer` passes.
- **Builder tile canvas UX** — History persistence is done (`9cbb578`). How the current in-progress build renders on the canvas alongside spatial rearrangements is still unresolved.
- **ChatSidebarSection.tsx vs ChatHistorySection.tsx** — WebSocket vs IPC: consolidation to IPC version deferred; two parallel sidebar session list implementations remain.
- **grok-cli model catalog wire-up** — `src/renderer/src/config/providers.ts` DEFAULT_MODELS must mirror `~/Documents/GitHub/grok-cli/src/core/extensions/builtin/codesurf-desktop-provider.ts` MODELS array; permission system blocked in daemon mode needs a UI.
- **`apps/chat-app`** — Standalone scaffolded with AI SDK + AI Elements; integration depth with main harness unknown.

---

*Generated by codesurf-dreaming.*
