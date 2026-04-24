# CodeSurf Workspace Memory — contex (collaborator-clone)

Generated: 2026-04-24 (consolidated — session batch ending 23:54)

---

## Overview

**contex** is an Electron 40 / React 19 / TypeScript 5 infinite-canvas workspace where tiles (terminal, code editor, browser, kanban, chat, image, theme-builder, agent-runner) live on a 2D canvas. AI agents connect via a local MCP server and communicate through a peer-state protocol. Humans and agents collaborate asynchronously.

Active branch: `feature/event-bus-mcp`

---

## Durable Facts

### Stack

- Electron 40.8.2, React 19.2.4, TypeScript 5.9.3, Vite/electron-vite 7.3.1/5.0.0, Tailwind 4
- xterm + node-pty (terminal), Monaco (code tiles)
- `@anthropic-ai/claude-agent-sdk` 0.2.79, `@opencode-ai/sdk` 1.2.27, `@google/genai` (Gemini image gen)
- Build: `npm run dev` · `npm run build` · `npm run rebuild` (node-pty native)
- Dark theme hardcoded — never `prefers-color-scheme`; `body.dark` injected via bridge
- 2-space indent, trailing commas, no semicolons, strict TS (`any` tolerated only in legacy chat.ts)
- No emoji in UI unless user explicitly requests it
- Verify model names from local codebase before claiming a model is unknown or invalid

### Persistence

- `~/.contex/workspaces/{id}/canvas.json` — 500 ms debounce auto-save
- `~/.contex/workspaces/{id}/tiles/{tileId}.json` — kanban state
- `~/.contex/mcp-server.json` — MCP config (random port; never hardcode)
- `~/.contex/permissions.json` — time-scoped permission grants

### IPC Convention

`{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `generation:image:generate`

---

## Active Subsystems

### Canvas Engine (`src/renderer/src/App.tsx`)

- ~2400 LOC — surgical edits only; changes ripple widely
- `extensionTileByType` memo — `useMemo` Map keyed on `tile.type`, derived from `extensionTiles` array
- `getPanelTileIcon(tileId)` callback — resolves extension icon token from `extensionTileByType`; passed as `getTileIcon` prop to both `PanelLayout` call sites
- Undo max 50 full-state snapshots — never push in hot paths

### Extension Icon System

New shared utility: `src/renderer/src/components/extensionIcons.tsx`. `renderExtensionIcon(icon?, size?)` maps named token strings to Lucide icons; falls back to `<Puzzle>` for unknown tokens. Supported tokens: `sparkles`, `pencil`, `folder`, `git-branch`, `wrench`, `globe`, `bot`, `package`, `puzzle`, `settings`, `message-square`, `terminal`, `history`, `layers-3`. Extension `extension.json` tile entries should include an `"icon"` field with one of these tokens.

### Session Filtering (Committed)

- `src/main/session-sources.ts` — strips `<environment_context>` blocks before deriving imported session titles
- `src/main/ipc/session-title-generation.ts` — same filter during title generation

### Font System

- `App.tsx` (~4607) — exports primary/secondary/mono/legacy CSS variables at root
- `ChatTile.tsx` (~2162) — exports secondary/subtle families into chat surface; `fontSecondary` now in `useMemo` dep array
- `bridge.ts` (~248) — extension primitives consume `--ct-font-secondary` / `--ct-font-subtle`

### ChatTile Start Screen

`isStartScreen = messages.length === 0 && !isStreaming`. Renders a single centered stack: headline then full composer (input + provider/model/tool controls) immediately below. Implementation site: `ChatTile.tsx` ~5476. Treat this layout as stable.

---

## Watch Out For

- App.tsx ~2400 LOC — surgical edits only
- node-pty needs `npm run rebuild` after dependency changes
- MCP port is random — always read from config file, never hardcode
- Canvas undo holds full snapshots — never push in hot paths
- `cluso-widget` is optional (`file:../agentation-real`) — may not exist
- `CODESURF_CHAT_DEBUG=1` for verbose chat IPC logs
- Working tree has several modified/untracked files from concurrent agent sessions — check `git status` before starting work

---

## Open Threads

- **Working tree uncommitted** — extension icon parity, font plumbing, ChatTile start screen, active tab border removal, focus ring suppression, source-control manifest all pending commit
- **`src/main/ipc/chat.ts`** — new untracked file; `any` in older sections; deferred cleanup
- **`--ct-font-sidebar`** — referenced in earlier sessions; not confirmed in current diffs; verify before using
- **`AgentRunnerTile`** — reported created in a worktree session; not found in components on inspection; unconfirmed
- **`ChatTurnStartPayload.contextSnapshot`** — reported added in a worktree session; not confirmed in committed `shared/types.ts`
- **`cascadeConnectionGraph()` renderer integration** — BFS utility reportedly in shared; renderer consumption unconfirmed
