# CodeSurf — Generated Memory (2026-08-09)

## Overview

Electron infinite-canvas workspace with three deployment targets (Electron / Browser PWA / Native electrobun WebView) sharing one React renderer. Product name is **CodeSurf**; legacy `window.contex` preload identifier and `~/.codesurf/` data paths are preserved as-is — do not rename either.

AGENTS.md is the authoritative architecture reference. CLAUDE.md lags behind on persistence paths and canvas engine description; when they conflict, AGENTS.md wins.

---

## Durable Architecture Facts

### Package versions (confirmed in AGENTS.md)

| Package | Version |
|---|---|
| electron | ^41.3.0 |
| react | ^19.2.4 |
| typescript | ^5.9.3 |
| vite | 7.3.6 |
| electron-vite | ^5.0.0 |
| @anthropic-ai/claude-agent-sdk | 0.2.141 |
| @opencode-ai/sdk | 1.2.27 |
| tailwindcss | ^4.0.0 |

### Source layout

- `src/main/` — Electron main process
  - `ipc/` — 40+ IPC handler modules: `activity.ts`, `agents.ts`, `appearance.ts`, `bus.ts`, `canvas.ts`, `chat.ts`, `chromeSync.ts`, `collab.ts`, `dreaming.ts`, `execution.ts`, `extensions.ts`, `fs.ts`, `git.ts`, `image.ts`, `jobs.ts`, `localProxy.ts`, `mcp-config.ts`, `owl.ts`, `permissions.ts`, `pets.ts`, `relay.ts`, `secrets-ipc.ts`, `session-title-generation.ts`, `skills.ts`, `spokify.ts`, `stream.ts`, `system.ts`, `terminal.ts`, `tile-context.ts`, `transcribe.ts`, `tts.ts`, `ui.ts`, `updater.ts`, `webview-paint.ts`, `window.ts`, `workspace.ts`
  - `chat/` — 40 files covering lifecycle, context composition, peer authority, local proxy, provider registry, runtime checkpoints, and room context
  - Subdirs: `db/`, `relay/`, `agent-room/`, `security/`, `extensions/`, `agents/`, `session-sources/`, `execution/`, `chrome-sync/`, `daemon/`, `mcp/`, `usage/`, `utils/`
- `src/preload/index.ts` — Context bridge exposed as `window.contex` (legacy name — never rename)
- `src/renderer/src/` — Shared React SPA across all targets; 80+ focused hooks
- `shared/` — `types.ts` (TileType union), `agentKanban.ts`, `job-types.ts`, `chat-history.ts`
- `packages/` — `codesurf-daemon`, `codesurf-chat-bridge`, `codesurf-plugin`, `codesurf-relay`, `codesurf-terminal-gateway`
- `desktop/` — Native electrobun WebView thin shell

### Canvas engine

App.tsx is the orchestration surface; interaction composition delegated to `hooks/useAppCanvasInteraction.ts`. Focused hooks own: pan/zoom, drag, resize, snapping, groups, undo/redo, context menus, connection locks. World coords = screen coords adjusted for zoom + pan offset. Undo snapshots full state (max 50). Prefer extracting to hooks over adding logic to App.tsx.

### Confirmed subsystems

- **Chrome sync** — `src/main/chrome-sync/`: bookmarks, cookies, keychain, domain-allowlist, history, profiles. Cookie decryption via Keychain, AES-128-CBC.
- **Dreaming IPC** — `src/main/ipc/dreaming.ts` + renderer hook `useChatTileDreamPolling`; dream memory consolidation is a live feature, not just a daemon job
- **Collab IPC** — `collab.ts`; agent-room collaboration protocol backed by `<project>/.codesurf/{tileId}/`
- **Local proxy** — `localProxy.ts` IPC + `local-proxy-*.ts` chat modules
- **Audio/voice IPC** — `spokify.ts`, `transcribe.ts`, `tts.ts`
- **Owl / pet systems** — `owl.ts`, `pets.ts`, `pets-id.ts`, `pets-path.ts`
- **Usage tracking** — `src/main/usage/`: claude-reader, codex-reader, index

### Persistence paths (canonical — AGENTS.md)

- `~/.codesurf/workspaces/{storageId}/.codesurf/canvas-state.json`
- `~/.codesurf/workspaces/{storageId}/.codesurf/tile-state-{tileId}.json`
- `~/.codesurf/workspaces/{storageId}/.codesurf/kanban-{tileId}.json`
- `<project>/.codesurf/{tileId}/` — project-backed collaboration protocol state
- `~/.codesurf/mcp-server.json` — MCP server config (random port — always read from file)

CLAUDE.md persistence paths (`{id}/canvas.json`, `{id}/tiles/`) are stale — use AGENTS.md paths.

---

## Active Workflows / Capabilities

### Multi-target build

```
npm run dev / web:dev / desktop:dev   # dev modes per target
npm run build / build:web / desktop:build
npm run rebuild                        # node-pty native rebuild — required after dep changes
```

Details: `docs/multi-target.md`

### Agent collaboration protocol

Agents use `mcp__codesurf__*` tools. Mandatory first-action sequence: `room_status` → `peer_set_state(idle)` → `room_consume` (if unconsumed > 0). Never edit a file another room member lists in their `files` without prior `room_post` coordination.

---

## Chat Chip Chrome — DO NOT BREAK

`ThinkingBlockView` and `WorkingChipView` are independent full-chip components — changing one must never touch the other (caused three regressions). Canvas overlap = check `bringToFront`/`nextZIndex` in App.tsx first. `textTransform: uppercase` breaks number+unit strings. Chip expand toggles must use `React.startTransition`.

---

## Open Threads

- **Codex effort selector broken** — effort level dropped before dispatch; fix target likely `src/main/chat/agent-mode-tools.ts` or `agent-mode-resolver.ts`
- **tsc baseline dirty** — ~145 pre-existing errors; gauge regressions per-file, not by exit code
- **`cluso-widget` optional** — `file:../agentation-real` may not exist; build does not fail but feature is unavailable

## Recent Session Evidence (2026-08-09)

All sessions were external tasks run inside CodeSurf's Codex tiles — no CodeSurf source files modified:

- WebSocket reconnect patch review: partial flush can duplicate messages; `socket.send()` success ≠ delivery (no `readyState` check); backoff reset on handshake-open defeats jitter under crash-loop. Verdict: not production-safe.
- B2B observability copywriting critique (multiple rounds, gpt-5.6-sol): top rewrites — "Find the change behind the incident." (33/40), "Ask why production broke. Get an evidence-backed answer." (30/40). Generic benefit headlines scored 16/40.
- Trivial coordination pings confirm Codex tile is active and responsive.
