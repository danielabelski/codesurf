# CodeSurf Workspace Memory — contex (collaborator-clone)

Generated: 2026-04-25 (session batch ending ~01:00)

---

## Overview

**contex** is an Electron 40 / React 19 / TypeScript 5 infinite-canvas workspace. Tiles (terminal, code editor, browser, kanban, chat, image, source-control, extension tiles) live on a 2D canvas. AI agents connect via a local MCP server and communicate through a peer-state protocol. Active branch: `feature/event-bus-mcp`. Working tree is currently clean.

---

## Durable Facts

### Stack

- Electron 40.8.2, React 19.2.4, TypeScript 5.9.3, Vite/electron-vite 7.3.1/5.0.0, Tailwind 4
- xterm + node-pty (terminal), Monaco (code tiles), `@google/genai` (Gemini image generation)
- `@anthropic-ai/claude-agent-sdk` 0.2.79, `@opencode-ai/sdk` 1.2.27
- Build: `npm run dev` · `npm run build` · `npm run rebuild` (node-pty native)
- Dark theme hardcoded — never `prefers-color-scheme`; `body.dark` injected via bridge; solid hex colors, not rgba opacity
- No emoji in UI — use Lucide icons or CSS shapes
- 2-space indent, trailing commas, no semicolons, strict TS

### File Size Warnings (as of 2026-04-25)

- `src/renderer/src/App.tsx` — **6 561 lines** — surgical edits only; changes ripple widely
- `src/renderer/src/components/ChatTile.tsx` — **9 203 lines** — largest file; treat like a monolith
- `src/renderer/src/components/Sidebar.tsx` — **2 553 lines**

### Persistence

- `~/.contex/workspaces/{id}/canvas.json` — 500 ms debounce auto-save
- `~/.contex/workspaces/{id}/tiles/{tileId}.json` — kanban state
- `~/.contex/mcp-server.json` — MCP config (random port; **never hardcode**)
- `~/.contex/permissions.json` — time-scoped permission grants; read at runtime

### IPC Convention

`{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `generation:image:generate`

---

## Active Subsystems

### Canvas Engine

2D pan/zoom/drag/resize/snap/groups/undo-redo all in `App.tsx`. `extensionTileByType` useMemo Map keyed on tile type. `getPanelTileIcon(tileId)` resolves extension icon tokens; passed as `getTileIcon` prop to all `PanelLayout` call sites. Undo max 50 full-state snapshots — never push in hot paths.

### Extension Icon System

`src/renderer/src/components/extensionIcons.tsx` — `renderExtensionIcon(icon?, size?)` maps 14 named tokens to Lucide icons; falls back to `<Puzzle>`. Supported tokens: `sparkles`, `pencil`, `folder`, `git-branch`, `wrench`, `globe`, `bot`, `package`, `puzzle`, `settings`, `message-square`, `terminal`, `history`, `layers-3`. Compact tab icons in `PanelLayout.tsx` now use this same renderer — parity with main toolbar is complete and committed.

### Agent Adapter System

`src/main/agents/` — formal registry for all CLI/SDK backends with capability, execution shape, and readiness modeling. Confirmed adapters: `claude` (native-sdk), `codex` (headless-cli), `opencode`. Relay layer in `src/main/relay/` sits between chat IPC and adapters.

### Checkpoint System

Tool name: `'Checkpoint saved'`, ID prefix: `'codesurf-checkpoint-'`. Actions in `src/renderer/src/components/chat/checkpointToolActions.ts`. Daemon-backed.

### Image Generation

`src/main/image-generation.ts` + `src/main/generation-provider-validation.ts` (231 lines). `@google/genai` for Gemini. Read provider from validated config, not hardcoded strings.

### Chat Jobs Daemon

`bin/chat-jobs.mjs` — uses `@anthropic-ai/claude-agent-sdk` query; loads memory context and context buckets; reads `~/.contex/permissions.json` for time-scoped tool grants.

### Insight Calibration

`scripts/calibrate-insights/` — rubric/score harness for evaluating CodeSurf-generated insights. `node score.mjs <fixture> < model-output.md`.

---

## Open Threads

- **Sidebar divider position** — task to align visible divider with main content left edge, thin to 0.5 px; confirm committed state in `Sidebar.tsx`
- **Sidebar project menu position** — user asked to move Prompts/Skills menu back above "PROJECTS" section; check current rendering order
- **`src/main/ipc/chat.ts`** — legacy `any` sections; not blocking
- **`--ct-font-sidebar`** — referenced in older sessions; not confirmed in committed code; verify before use
- **Unconfirmed**: `AgentRunnerTile` and `cascadeConnectionGraph()` reported in worktree sessions but not found in committed files
