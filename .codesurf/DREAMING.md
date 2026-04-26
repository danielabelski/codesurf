# CodeSurf Workspace Memory — collaborator-clone (contex)

_Generated: 2026-04-26 | Branch: `main`_

## Overview

**contex** (package name: `codesurf` v0.1.0, productName: `CodeSurf`) is an Electron 40.x desktop app — an infinite 2D canvas where tiles (terminal, code editor, browser, kanban, chat, note, image, media, extension, file explorer, layout builder, customisation) host AI agents and developer tooling. Agents connect via a local HTTP MCP 2.0 server; humans and agents collaborate asynchronously through an in-process event bus.

GitHub remote: `https://github.com/jasonkneen/codesurf.git`

---

## Durable Facts

### Stack
- Electron 40.8.2, React 19.2.4, TypeScript 5.9.3, Vite / electron-vite 7.3.1 / 5.0.0
- Tailwind CSS 4.0.0 (utility classes + inline `React.CSSProperties`; no CSS-in-JS library)
- xterm + node-pty for terminal tiles; Monaco editor for code tiles
- `@anthropic-ai/claude-agent-sdk` ^0.2.118, `@opencode-ai/sdk` 1.2.27
- chokidar for filesystem watch
- `electrobun` ^1.16.0 — added as dependency for the Electron replacement initiative

### Persistence (file-based, no cloud)
- `~/.contex/workspaces/{id}/canvas.json` — canvas state, 500 ms debounce auto-save
- `~/.contex/workspaces/{id}/tiles/{tileId}.json` — kanban tile state
- `~/.contex/mcp-server.json` — MCP server config (random port written at startup)

### IPC convention
`{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `terminal:write`, `bus:publish`

### Chat providers
| Provider | Integration |
|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` (session resumption, adaptive thinking) |
| Codex | codex CLI subprocess |
| OpenCode | `@opencode-ai/sdk` HTTP server |

All providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.

---

## Active Subsystems

### Dreaming
- Daemon-backed; surfaced in `MainStatusBar` as an "Auto-dream" badge with `active`/`idle`/`error` tone
- Dream completions inject synthetic tool messages into ChatTile history — rendered with a Sparkles icon via `chat/dreamToolActions.ts`; checkpoint chips use a History icon; both excluded from collapsible tool groups
- Footer dream pill removed (redundant after chips landed in chat history)
- `.codesurf/DREAMING.md` is generated output from dream runs; not user-authored

### Chat Tile Composer
- Composer container background = `composerBorder` token (entire rounded rectangle is a uniform solid shape — no secondary backing color)
- Drop-target highlight uses `theme.surface.accentSoft`

### Panel Layout
- Panel-mode shell background uses `theme.surface.app` (not `theme.surface.panel`) to eliminate the secondary color visible behind rounded leaf corners of the split handle
- Split gap gutter background is now `theme.surface.app` (previously `transparent`); hover highlight removed — only the resize cursor changes on hover
- These two changes (`App.tsx` line ~4562 + `PanelLayout.tsx` `ResizeHandle`) are companion fixes; uncommitted as of this dream run

---

## Electrobun Replacement (Burst 1 — Committed)

Committed in `575e217` (2026-04-26). Electron remains the production baseline; Electrobun is a parallel non-destructive spike.

### What exists
- `electrobun.config.ts` — Electrobun build config
- `electrobun/bun/index.ts` — Bun main process, 1800+ LOC, full workspace/settings/canvas/tile/bus/git/MCP handler parity
- `electrobun/bun/runtime-daemon.ts` — daemon integration
- `electrobun/bun/runtime-db.ts` — SQLite via `bun:sqlite`
- `electrobun/bun/chat-streams.ts` — local CLI provider routing (Claude/Codex/OpenCode)
- `electrobun/browser/index.ts` — browser-side bridge
- `electrobun/helpers/pty-host.cjs` — Node.js PTY helper (node-pty hangs under Bun; Node subprocess solves this)
- `src/electrobun/browser/electron-facade.ts` — typed `window.electron` facade (~532 LOC); keeps all 344 renderer call sites unchanged
- `src/shared/electrobun-rpc.ts` — shared RPC types
- `scripts/smoke-electrobun.mjs`, `scripts/accept-electrobun.mjs` — verification scripts
- `test/electrobun-*.{test.mjs,test.ts}` — test suite (facade, PTY host, chat streams, runtime DB)
- Plans in `.hermes/plans/` (three documents covering replacement rationale, burst 1, completion burst)

### npm scripts
```
dev:electrobun        npm run build:renderer && electrobun dev
build:electrobun      npm run build:renderer && electrobun build --targets=current
run:electrobun        electrobun run
smoke:electrobun      npm run build:electrobun && node scripts/smoke-electrobun.mjs
acceptance:electrobun npm run build:electrobun && node scripts/accept-electrobun.mjs
```

### Compatibility findings
- `node-pty` and `sharp` work under Bun; PTY spawn hangs in-process — routed via `pty-host.cjs` Node helper
- `better-sqlite3` is incompatible with Bun — Electrobun runtime uses `bun:sqlite` instead
- `BrowserTile` updated with safe iframe fallback for non-Electron runtimes

### Open risks / next bursts
- Full BrowserView (webContents) parity not yet achieved
- `better-sqlite3` migration: Electron path still uses it; must not break before cutover
- Terminal PTY verified via Node helper standalone test; Bun-native PTY path remains blocked
- No cloud sync — file-based persistence assumption carries forward unchanged

---

## Open Threads

- **Panel backing color (uncommitted)** — `App.tsx` and `PanelLayout.tsx` have companion changes fixing the double-background behind rounded panel corners. Not yet committed; should land together.
- **Electrobun burst 2** — BrowserView/webContents parity, full `better-sqlite3` removal from Electron path, and removing the `window.electron` facade once Electrobun is production baseline. No burst 2 branch yet.

---

## Critical Watch-outs

- `App.tsx` is ~1700 LOC — be surgical; changes ripple widely
- `node-pty` requires native rebuild after dependency changes (`npm run rebuild`)
- MCP server port is random — always read from `~/.contex/mcp-server.json`, never hardcode
- Canvas undo state holds full snapshots — do not push to undo stack in hot paths
- `cluso-widget` (`file:../agentation-real`) is optional — may not exist in all environments
- `better-sqlite3` is incompatible with Bun — never assume it works in Electrobun context
- Never revert uncommitted code without explicit permission
- Two-attempt rule: same fix fails twice → stop, verify assumption, ask user
