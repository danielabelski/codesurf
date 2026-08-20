# CodeSurf — Generated Memory (2026-08-20, rev 32)

## Overview

Electron infinite-canvas workspace with three deployment targets (Electron / Browser PWA / Native electrobun WebView) sharing one React renderer. Product name is **CodeSurf**; legacy `window.contex` preload identifier and `~/.codesurf/` data paths are preserved — never rename either.

AGENTS.md is the authoritative architecture reference. CLAUDE.md lags on persistence paths, canvas engine description, and package versions; when they conflict, AGENTS.md wins.

---

## Durable Architecture Facts

### Package versions (AGENTS.md authoritative)

| Package | Version |
|---|---|
| electron | ^41.3.0 |
| react | 19.2.4 |
| typescript | 5.9.3 |
| vite | 7.3.6 |
| electron-vite | ^5.0.0 |
| @anthropic-ai/claude-agent-sdk | 0.2.141 |
| @opencode-ai/sdk | 1.2.27 |
| tailwindcss | ^4.0.0 |

### Source layout

- `src/main/` — Electron main process
  - `ipc/` — 40+ handler modules: `activity`, `agents`, `appearance`, `bus`, `canvas`, `chat`, `chromeSync`, `collab`, `dreaming`, `execution`, `extensions`, `fs`, `git`, `image`, `jobs`, `localProxy`, `mcp-config`, `owl`, `permissions`, `pets`, `relay`, `secrets-ipc`, `session-title-generation`, `skills`, `spokify`, `stream`, `system`, `terminal`, `tile-context`, `transcribe`, `tts`, `ui`, `updater`, `webview-paint`, `window`, `workspace`
  - `chat/` — ~40 files: lifecycle, context composition, peer authority, local proxy, provider registry, runtime checkpoints, room context
  - Subdirs: `db/`, `relay/`, `agent-room/`, `security/`, `extensions/`, `agents/`, `session-sources/`, `execution/`, `chrome-sync/`, `daemon/`, `mcp/`, `usage/`, `utils/`
- `src/preload/index.ts` — Context bridge exposed as `window.contex` (legacy name — never rename)
- `src/renderer/src/` — Shared React SPA across all targets; 80+ focused hooks
- `shared/` — `types.ts` (TileType union), `agentKanban.ts`, `job-types.ts`, `chat-history.ts`
- `packages/` — `codesurf-daemon`, `codesurf-chat-bridge`, `codesurf-plugin`, `codesurf-relay`, `codesurf-terminal-gateway`
- `desktop/` — Native electrobun WebView thin shell

### Canvas engine

App.tsx is the orchestration surface; interaction composition delegated to `hooks/useAppCanvasInteraction.ts`. Focused hooks own: pan/zoom, drag, resize, snapping, groups, undo/redo, context menus, connection locks. World coords = screen coords adjusted for zoom + pan offset. Undo snapshots full state (max 50). Prefer extracting to hooks over adding logic to App.tsx directly.

### Confirmed subsystems

- **Chrome sync** — `src/main/chrome-sync/`: bookmarks, cookies, keychain, domain-allowlist, history, profiles; cookie decryption via Keychain, AES-128-CBC
- **Dreaming IPC** — `src/main/ipc/dreaming.ts` + renderer hook `useChatTileDreamPolling`; dream memory consolidation is a live runtime feature
- **Collab IPC** — `collab.ts`; agent-room protocol backed by `<project>/.codesurf/{tileId}/`
- **Local proxy** — `localProxy.ts` IPC + `local-proxy-*.ts` chat modules
- **Audio/voice IPC** — `spokify.ts`, `transcribe.ts`, `tts.ts`
- **Owl / pet systems** — `owl.ts`, `pets.ts`, `pets-id.ts`, `pets-path.ts`
- **Usage tracking** — `src/main/usage/`: claude-reader, codex-reader, index

### Persistence paths (canonical — AGENTS.md)

- `~/.codesurf/workspaces/{storageId}/.codesurf/canvas-state.json`
- `~/.codesurf/workspaces/{storageId}/.codesurf/tile-state-{tileId}.json`
- `~/.codesurf/workspaces/{storageId}/.codesurf/kanban-{tileId}.json`
- `<project>/.codesurf/{tileId}/` — project-backed collaboration protocol state
- `~/.codesurf/mcp-server.json` — MCP server config (random port — always read from file, never hardcode)

CLAUDE.md paths (`{id}/canvas.json`, `{id}/tiles/`) are stale — use AGENTS.md paths.

---

## Active Workflows / Capabilities

### Multi-target build

```
npm run dev / web:dev / desktop:dev        # dev modes per target
npm run build / build:web / desktop:build  # production builds
npm run rebuild                            # node-pty native rebuild — required after dep changes
npm run web:pwa                            # web:dev with service worker for install testing
npm run web:preview                        # serve production web build (PWA installable)
```

Details: `docs/multi-target.md`. Electron target is never removed; web/Native share the renderer and talk to `codesurfd` via `scripts/web-host.mjs`.

### Active chat providers (observed in sessions)

| Provider key | Model |
|---|---|
| claude | claude-fable-5 |
| claude | claude-opus-4-8 |
| csagent | anthropic/claude-sonnet-4-6 |
| hermes | openrouter/qwen/qwen3.6-plus |
| codex | gpt-5.5 |

All providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`.

### Agent collaboration protocol

Agents use `mcp__codesurf__*` tools. Mandatory first-action sequence on every session:

1. `room_status(tile_id=$CARD_ID)`
2. `peer_set_state(tile_id=$CARD_ID, status="idle", task="Ready")`
3. `room_consume(tile_id=$CARD_ID)` — if unconsumed > 0

Never edit a file another room member lists in their `files` without prior `room_post` or `peer_send_message` coordination.

Live inbox dump: `~/.codesurf/workspaces/$CODESURF_WORKSPACE_ID/agent-rooms/inboxes/$CARD_ID/ROOM.md`

Multi-agent pairing (@luna + @opus) is an established pattern for parallel code review inside CodeSurf Codex tiles.

### MCP server

Starts on a random port each launch; 34 tools exposed. Config written to `~/.codesurf/mcp-server.json`. Always read port from that file — never hardcode.

---

## Chat Chip Chrome — DO NOT BREAK

- `ThinkingBlockView` and `WorkingChipView` are **independent** full-chip components — changing one must never touch the other (caused three regressions in one session)
- `CollationSummaryChip` / group chips use accent chip style (coloured background/border, still bordered)
- Canvas overlap issues → check `bringToFront`/`nextZIndex` in App.tsx **first**; do not add `position: relative` + `zIndex` to transcript rows to fix canvas stacking
- `textTransform: uppercase` breaks number+unit strings (`${n}s` → `NS`); render number and unit as separate elements or remove uppercase from that span
- Chip expand toggles must use `React.startTransition`
- `collateClusterChips` is lazy — unexploded groups emit zero individual items; mount cost is on expand, not data flow

---

## Open Threads

- **Native CLI binary missing (darwin-arm64)** — `claude` and `csagent` provider tiles error on session start: `Native CLI binary for darwin-arm64 not found. Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set options.pathToClaudeCodeExecutable.` Affects `claude-fable-5` and `claude-opus-4-8`. Fix: reinstall without `--omit=optional` or configure `pathToClaudeCodeExecutable` in provider options.
- **Codex effort selector broken** — effort level dropped before dispatch; fix target likely `src/main/chat/agent-mode-tools.ts` or `agent-mode-resolver.ts`
- **tsc baseline dirty** — ~145 pre-existing errors; gauge regressions per-file, not by exit code
- **`cluso-widget` optional** — `file:../agentation-real` may not exist in all environments; build does not fail but feature unavailable

---

## External Projects Active in CodeSurf Codex Tiles

### titerm (`/Users/jkneen/Documents/GitHub/titerm`)

Swift project developed via CodeSurf Codex tiles with @luna + @opus multi-agent review pattern.

**Recent work (2026-08-19–20):**
- `CodexAppServer.swift` — injectable handshake timeout and separate `thread/start` deadline; detached `warmUp` task with logging
- `PetAssistant.swift` — new lane scheduler for ensemble agent requests; **two unresolved static risks identified:**
  - Later requests can bypass an earlier request in the same ensemble group when the earlier agent lane is busy (ordering not guaranteed)
  - Disabling an active agent releases its keyed backend conversation without marking that agent's state for bootstrap
- `AgentBridgeTests.swift:552` — regression test for `thread/start` deadline; **currently failing** — `handshakeTimeout` set to 0.5s but process startup + `initialize` takes 0.624s; fix: widen startup margin while keeping `thread/start` delay beyond the generic timeout
- Review status: **not ready to merge** as of 2026-08-19 due to failing test

**Key files:**
- `Sources/InfinittyKit/CodexAppServer.swift` — RPC deadlines, warm-up
- `Sources/InfinittyKit/PetAssistant.swift` — lane scheduler
- `Tests/InfinittyKitTests/AgentBridgeTests.swift` — bridge tests

### Agensis / huddle voice system

- LiveKit/Deepgram/Cartesia voice chain fixed and deployed to Fly; production worker `ePJCABRMzHLv`
- Voice transcript format: `@<selected-handle> <speech>`
- **Residual:** huddle dispatch is creation-only; joining an existing active huddle not yet implemented
