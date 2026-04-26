Here is the full replacement content for `.codesurf/DREAMING.md`:

---

# CodeSurf Workspace Memory — collaborator-clone (contex)

_Generated: 2026-04-26 | Branch: `main`_

## Overview

**contex** (package name: `codesurf`, productName: `CodeSurf`) is an Electron 40.x desktop app — an infinite 2D canvas where tiles (terminal, code editor, browser, kanban, chat, note, image, media, extension, file explorer, layout builder, customisation) host AI agents and developer tooling. Agents connect via a local HTTP MCP 2.0 server; humans and agents collaborate asynchronously through an in-process event bus.

GitHub remote: `https://github.com/jasonkneen/codesurf.git`

---

## Durable Facts

### Stack
- Electron 40.8.2, React 19.2.4, TypeScript 5.9.3, Vite / electron-vite 7.3.1 / 5.0.0
- Tailwind CSS 4.0.0 (utility classes + inline `React.CSSProperties`; no CSS-in-JS library)
- xterm + node-pty for terminal tiles; Monaco editor for code tiles
- `@anthropic-ai/claude-agent-sdk` ^0.2.118, `@opencode-ai/sdk` 1.2.27
- chokidar for filesystem watch
- `electrobun` ^1.16.0 added as a dependency (Electron replacement — see below)

### Persistence (file-based, no cloud)
- `~/.contex/workspaces/{id}/canvas.json` — canvas state, 500 ms debounce auto-save
- `~/.contex/workspaces/{id}/tiles/{tileId}.json` — kanban tile state
- `~/.contex/mcp-server.json` — MCP server config (random port written at startup)

### IPC convention
`{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `terminal:write`, `bus:publish`

...

### Dreaming subsystem
- Daemon-backed; surfaced in `MainStatusBar` as an "Auto-dream" badge with `active`/`idle`/`error` tone
- Dream completions inject synthetic tool messages into ChatTile history — rendered with a Sparkles icon via `chat/dreamToolActions.ts`; checkpoint chips use a History icon; both excluded from collapsible tool groups
- Footer dream pill removed (redundant after chips landed in chat history)
- `.codesurf/DREAMING.md` is the generated output written by dream runs; not user-authored

### Chat tile composer
- Composer container background = `composerBorder` token (entire rounded rectangle is a uniform solid shape)
- Drop-target highlight still uses `theme.surface.accentSoft`

---

## Active Work: Electrobun Replacement (Burst 1 In Progress)

Burst 1 scaffolding is present and untracked — config, electron facade, RPC types, tests, npm scripts, and a build artifact (`build-electrobun/dev-macos-arm64/`). Runtime wiring not fully verified in this dream run. Not yet committed; awaiting review/approval.

Key compatibility findings: `node-pty` and `sharp` work under Bun; `better-sqlite3` does NOT — must migrate to `bun:sqlite` before final Electron removal. Approach: dual-runtime adapter injects a typed `window.electron` facade via `src/electrobun/browser/electron-facade.ts`, keeping all 344 renderer call sites unchanged in burst 1.

---

## Critical Watch-outs

- `App.tsx` is ~1700 LOC — changes ripple widely; be surgical
- `node-pty` requires native rebuild after dependency changes (`npm run rebuild`)
- MCP server port is random — always read from `~/.contex/mcp-server.json`, never hardcode
- Canvas undo state holds full snapshots — do not push to undo stack in hot paths
- `cluso-widget` (`file:../agentation-real`) is optional — may not exist
- `better-sqlite3` is incompatible with Bun — do not assume it works in Electrobun context
- Never revert uncommitted code without explicit permission
- Two-attempt rule: same fix fails twice → stop, verify assumption, ask user
