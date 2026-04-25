The file is written. Here is the full replacement content for `.codesurf/DREAMING.md`:

---

# CodeSurf Workspace Memory — collaborator-clone (contex)

_Generated: 2026-04-25 | Branch: feature/event-bus-mcp (active)_

## Overview

**contex** is an Electron desktop app: an infinite-canvas IDE where tiles (terminal, code editor, browser, kanban, chat, image, note, extension) live in 2D space and AI agents collaborate via a local MCP server. Rapid feature velocity — 20+ recent commits covering sidebar, chat tile, dreaming daemon, agent adapters, CLI agent support, image generation, connection graph, node tools, theme system, and panel layout tree.

## Durable Facts

**Stack**: Electron 40.8.2 · React 19.2.4 · TypeScript 5.9.3 · Vite 7 / electron-vite 5 · xterm + node-pty · Monaco · `@anthropic-ai/claude-agent-sdk` 0.2.79 · `@opencode-ai/sdk` 1.2.27 · Codex CLI subprocess. All providers stream NDJSON/SSE via `src/main/ipc/stream.ts`. Local packages: `packages/codesurf-dreaming/` and `packages/contex-relay/`.

**Styling**: dark theme hardcoded (`#1e1e1e` / `#252525` / `#333`); never `prefers-color-scheme`; `body.dark` class applied via bridge; solid hex only, no rgba opacity. Tailwind 4 + inline `React.CSSProperties`; 2-space indent, trailing commas, no semicolons. No emoji.

**IPC convention**: `{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `bus:publish`, `dreaming:run`.

**Persistence**: file-only, no cloud sync. Canvas auto-saved at 500 ms debounce. MCP port always random — always read from `~/.contex/mcp-server.json`. Dreaming daemon tracked via `~/.codesurf/daemon/pid.json` + startup.lock.

**Key file sizes**: `App.tsx` ~1700+ LOC (canvas engine — be surgical), `Sidebar.tsx` ~1000+ LOC, `ChatTile.tsx` heavily active (6800+ lines), `src/main/ipc/chat.ts` 386+ lines, `mcp-server.ts` 328+ lines, `agent-cli-contracts.ts` 398 lines.

## Active Subsystems

- **Canvas engine** (`App.tsx`): pan/zoom/drag/resize/snapping/groups/undo-redo; sidebar collapse control lives here (commit `3c68d86`). Undo holds full-state snapshots (max 50) — never push to undo stack in hot paths.
- **Dreaming daemon** (`bin/codesurfd.mjs`): dreaming, checkpoints, chat jobs via `@anthropic-ai/claude-agent-sdk` query, memory loading, skill indexing, file-reference expansion, context buckets, session indexing. Defaults: `claude-sonnet-4-6`, max 6 sessions × 6 msgs, 500 chars/msg, 16 000 chars memory budget, auto-trigger ≥3 sessions / 30-min interval / 5-sec debounce.
- **Agent adapters** (`src/main/agents/`): registry `AGENT_ADAPTER_DEFINITIONS`, CLI contracts, execution shapes (`native-sdk`, `headless-cli`, `daemon-cli`, `acp-capable`, `server-capable`, `import-only`), capability flags. Adapters: Claude Code, Codex, OpenCode, Gemini, Cline, Amp, GitHub Copilot, and others.
- **Chat tile chip parser** (`ChatTile.tsx`): Codex lifecycle lines must be consumed before body assembly. Patterns to suppress: `Reading additional input from stdin...`, Codex banner + horizontal rule, `| Setting | Value |` tables, `| Token | Count |` usage footer.
- **MCP server** (`src/main/mcp-server.ts`): 17 tools, random port, always read from `~/.contex/mcp-server.json`.
- **Extensions**: bridge RPC, `extensionIcons.tsx`; `hiddenFromSidebarExtIds` / `settingsPanelExtIds` control sidebar/settings visibility. `cluso-widget` is optional local dep (`file:../agentation-real`) — degrade gracefully if absent.
- **Panel layout** (`panelLayoutTree.ts`, 199 LOC): `PanelLeaf | PanelSplit` tree; dock zones: left/right/top/bottom/center. Compact tab strip in `PanelLayout.tsx`.
- **Theme** (`src/renderer/src/theme.ts`, 135 lines): typed `AppTheme` tokens; surface token set includes `.panelMuted`, `.panelElevated`, `.selection`, `.hover`.

## Working Tree State (2026-04-25)

| File | Status |
|---|---|
| `src/renderer/src/components/PanelLayout.tsx` | Modified, **uncommitted** — inactive tab bg: `transparent` → `theme.surface.panelMuted`; hover bg: `theme.surface.hover` → `theme.surface.panelElevated` |
| `.mcp.json` | Modified, uncommitted — unrelated config; leave alone |
| `ChatTile.tsx` | Clean against HEAD — recent style attempts applied then reverted |

## Build Verification

- Renderer-only: `npm run build:renderer` — use for ChatTile/PanelLayout changes
- Full build: `npm run build`
- After native dep changes: `npm run rebuild` (node-pty)

## Recent ChatTile.tsx Activity (2026-04-25)

Two styling passes applied (both verified with `npm run build:renderer`) then reverted:
1. **File-change drawer compaction**: row font 13→12px, tighter header padding, compacted per-file rows
2. **Chat-surface tab underline**: transparent bg, `borderRadius: 0`, 1px active bottom border, no close-button boxed border
3. **Revert**: "the previous pass" was reverted; file is now clean against HEAD

Whether pass 1 (drawer compaction) is committed to HEAD or also reverted is ambiguous — verify with `git show HEAD -- src/renderer/src/components/ChatTile.tsx` before re-applying.

## Open Threads

- **PanelLayout.tsx tab strip**: uncommitted; confirm `panelMuted`/`panelElevated` exist on `AppTheme` type before committing
- **ChatTile.tsx styling intent**: line-style tabs and drawer compaction desired but not confirmed landed — verify HEAD state
- **Codex chip parser leak**: pattern documented; not yet confirmed fixed in this repo
- **App.tsx LOC**: creeping toward 2000; targeted subsystem extraction needed
- **Panel layout vs canvas tile engine**: dual layout systems; relationship not documented
- **Theme token adoption**: audit tile components for hardcoded hex vs typed `AppTheme` tokens
- **Auto-dreaming trigger from chat/job completion**: not yet wired
- **Command-code harvest**: docs in `docs/research/command-code-harvest/`; no implementation committed
- **`calibrate-insights` scorer** (`scripts/`): not integrated into CI

## Cross-Workspace Notes

`muxy` (`/Users/jkneen/Documents/GitHub/muxy`, iOS/Swift) is the reference impl for Codex lifecycle suppression — 11 tests pass; use as reference when fixing contex chip parser. `muxy` requires `mise exec` for `.tool-versions`. `claude doctor` hangs non-interactively — use `claude --version` as liveness check.

## Do Not Touch Without Care

- `App.tsx` — never push to undo stack in hot paths; undo snapshots full-state (max 50)
- `ChatTile.tsx` — 6800+ LOC; always `npm run build:renderer`; verify HEAD state before re-applying any style change
- `node-pty` — `npm run rebuild` after any dependency change
- MCP server port — always read from `~/.contex/mcp-server.json`; never hardcode
- Extension bridge CSS — never `prefers-color-scheme`; always `body.dark` + solid hex
- `.mcp.json` — has local modifications; leave alone unless specifically targeting MCP config
