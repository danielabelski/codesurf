# CodeSurf Workspace Memory — contex (collaborator-clone)

*Generated 2026-04-23. Workspace: `/Users/jkneen/clawd/collaborator-clone`. Branch: `feature/event-bus-mcp`.*

---

## Overview

CodeSurf is an Electron infinite-canvas workspace where AI agents and developers collaborate through canvas tiles. Repo: `~/clawd/collaborator-clone`. Active branch: `feature/event-bus-mcp`.

Static CLAUDE.md/AGENTS.md use the legacy name "contex" — not authoritative. The live product name is CodeSurf (`package.json` name: `codesurf`, productName: `CodeSurf`).

---

## Durable Facts

**Identity**
- `package.json`: `name: codesurf`, `productName: CodeSurf`, `version: 0.1.0`
- CLAUDE.md/AGENTS.md retain "contex" naming — legacy, not product truth
- Workspace display label at creation (`App.tsx` ~line 2830): `basename(normalizedProjectPath) || 'Project'` — no `productName` inference in committed code

**SDK / CLI versions (as of 2026-04-23)**
- `@anthropic-ai/claude-agent-sdk`: `0.2.118` in running env (static docs say `0.2.79` — outdated)
- `claude` CLI: `/Users/jkneen/.local/bin/claude`, version `2.1.118`
- `claude-sonnet-4-6` confirmed valid in this environment
- SDK 0.2.118 requires both `permissionMode: 'bypassPermissions'` AND `allowDangerouslySkipPermissions: true`; the latter alone is insufficient

**Persistence layout**
- Canvas state: `~/.contex/workspaces/{id}/canvas.json` (auto-save, 500 ms debounce)
- Kanban tile state: `~/.contex/workspaces/{id}/tiles/{tileId}.json`
- MCP server config: `~/.contex/mcp-server.json` (random port — never hardcode)
- Generated workspace memory: `<workspace>/.codesurf/DREAMING.md` (this file)

**Memory loader**
- `bin/memory-loader.mjs` injects `.codesurf/DREAMING.md` as local-only context into every chat run
- Also injected into Codex sessions via "Workspace Local Instructions" header — confirmed working

**Critical file warnings**
- `src/renderer/src/App.tsx` is ~1700 LOC, owns all canvas 2D physics — edit surgically
- `node-pty` requires `npm run rebuild` after any native dependency change
- MCP server port is random — always read from `~/.contex/mcp-server.json`, never hardcode

**Known non-blocking build warnings**
- `npm run build:renderer` emits Vite chunking warnings for `PanelLayout.tsx` and `MediaTile.tsx` — pre-existing, not failures

---

## Active Subsystems

### Canvas Engine
- All 2D physics in `App.tsx`: pan/zoom, drag, resize, snapping, groups, undo/redo
- Undo snapshots full state (max 50) — do not push to undo stack in hot paths
- Tiles lazy-loaded via `React.lazy` + `Suspense`

### Workspace Tab Geometry (settled — committed in `fdd1999`)
- `workspaceTabActiveHeight = 31`, `workspaceTabInactiveHeight = 24`
- `workspaceTabTextOffset = -1` (active), `workspaceTabInactiveTextOffset = 0` (inactive — was `-2`, corrected over seven+ sessions)
- `workspaceTabInactiveBottomGap = 3`, `workspaceTabAttachedBottomGap = -1`
- Main panel corner radius conditional on first workspace tab being selected

### ChatTile — Chip Row Judder Fix (uncommitted, working tree modified)
- Root cause: chip text wrapping to 2 lines changed row height on every 500 ms collapse event
- Fix: chip row `flexWrap: 'nowrap'` + `overflow: hidden`; all chip text spans (`ThinkingBlockView`, `WorkingChipView`, `MixedToolGroup`, `CollapsedToolGroup`, `ToolBlockView`) now have `whiteSpace: 'nowrap'` + ellipsis
- Design constraint: chips are single-line always — never two-line chips at any width
- Also fixed: collapsed-messages drawer `paddingBottom` always `12` (was `0` when collapsed, clipping "N queued" text)

### Session Tools (committed `1ff343d`)
- `src/main/ipc/session-title-generation.ts`, `src/renderer/src/components/sidebar/session-title-generation.ts`
- `src/renderer/src/components/sidebar/session-open.ts` — session open intent detection
- Tests: `test/session-openability.test.ts`, `test/session-title-generation.test.ts`

### Dreaming Subsystem
- `packages/codesurf-dreaming/src/index.mjs`, `src/main/ipc/dreaming.ts`
- Orphan-run reconciliation: runs stuck "running" > 10 min flipped to failed on daemon restart
- Stderr sanitization: cleaned Claude CLI stderr surfaced as formatted error on job failure

### Event Bus / MCP Server
- `src/main/event-bus.ts`: wildcard pub/sub, ring-buffer 500 events/channel, no persistence
- `src/main/mcp-server.ts`: HTTP MCP 2.0, 17 tools, random port, config at `~/.contex/mcp-server.json`

---

## Open Threads

### Codex Investigation — Blank/Large Chat List Entries (2026-04-23, unresolved)
Some session list entries show blank content; one is 1.2 MB but displays ~50 lines. Hypothesis: different agent log formats not fully parsed by `src/main/db/thread-indexer.ts` / `src/main/session-sources.ts`. Investigation ongoing.

### Uncommitted Working Tree
- `src/renderer/src/components/ChatTile.tsx` — chip judder fix, needs commit
- `.mcp.json` — contex server port updated, needs review and commit
- `docs/` — several untracked plans/research files, intent unclear

### `cluso-widget` Optional Dependency
`file:../agentation-real` in `package.json` — may not exist in all environments, not a build error.
