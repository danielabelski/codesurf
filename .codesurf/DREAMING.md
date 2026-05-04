File is clean and written. Here is the full replacement content for `.codesurf/DREAMING.md`:

---

# Workspace Memory — contex (collaborator-clone)

Generated: 2026-05-04. Supplements CLAUDE.md/AGENTS.md — does not replace them.

---

## Overview

**contex** is an Electron desktop app (v40.8.2) — infinite canvas workspace where AI agents and humans collaborate via tiles. Also branded **CodeSurf** (`electrobun.config.ts`, bundle ID `com.huggiapps.codesurf.electrobun`).

Active branch: `main-merge`. HEAD: `cbbf1b5`. ~40+ dirty/untracked files uncommitted. CLAUDE.md and AGENTS.md both still reference `feature/event-bus-mcp` — stale in both.

---

## Architectural NorthStar

> "The desktop is dumb as shit. The daemon is smart." (commit `587a239`)

- All intelligence belongs in `grok-cli` (the `codesurf` CLI at `~/Documents/GitHub/grok-cli/`), not in this repo
- Desktop is a rendering shell: input → output → daemon
- Code-index lib modules must live in `grok-cli`, not the desktop
- CLI/SDK providers own native execution state; CodeSurf collates normalized conversation output and stable pointers

---

## Durable Facts

### Stack
- Electron 40.8.2, React 19.2.4, TypeScript 5.9.3, Vite/electron-vite 7.3.1/5.0.0, Tailwind CSS 4.0.0
- xterm + node-pty for terminal; Monaco for code tiles
- `@anthropic-ai/claude-agent-sdk` (session resumption + adaptive thinking); `@opencode-ai/sdk` 1.2.27; chokidar for fs watch
- All providers stream via NDJSON/SSE parsed in `src/main/ipc/stream.ts`

### IPC
- Naming: `{feature}:{action}` — handlers in `src/main/ipc/`; context bridge in `src/preload/index.ts`

### MCP Endpoints (two separate concerns)
- **Agent tool MCP**: config at `~/.contex/mcp-server.json` — random port per launch; never hardcode
- **Claude Code / Codex MCP**: `.mcp.json` at `http://127.0.0.1:56009/mcp` — hardcoded port; produces `data did not match any variant of untagged enum JsonRpcMessage` when contex is not running; always read live port from `~/.contex/mcp-server.json`

### Persistence
- `~/.contex/workspaces/{id}/canvas.json` (500ms debounce auto-save)
- `~/.contex/workspaces/{id}/tiles/{id}.json` (kanban tile state)
- `~/.contex/mcp-server.json` (MCP config)
- `~/.codesurf/` (daemon state — **distinct from `~/.contex/`**)

### Style
- Dark `#1e1e1e`/`#252525`/`#333`; Tailwind + inline `React.CSSProperties`; strict TS; 2-space, trailing commas, no semicolons; no emoji
- Extension tiles: `body.dark` via bridge, solid hex only, never `prefers-color-scheme`

---

## Internal Packages

| Package | Description |
|---|---|
| `packages/codesurf-daemon/` | `@codesurf/daemon` v0.1.0 — `DaemonManager`, `DaemonClient`, `paths.ts`; all `bin/*.mjs` are shims pointing here; **untracked — must commit before merge** |
| `packages/codesurf-dreaming/` | `@codesurf/dreaming` v0.1.0 — `consolidate(sessions) → string` |
| `packages/contex-relay/` | `@contex/relay` v0.1.0 — local-first agent messaging; archive at `<workspace>/.contex/relay/` |
| `packages/contex-chat-bridge/` | `@contex/chat-bridge` v0.1.0 — `PROTOCOL_VERSION=1`, `BRIDGE_NAMESPACE='contex-chat-bridge'`; exports: `onContext`, `callHost`, `subscribe`, `BridgeContext`, `ChannelName` |
| `apps/chat-app/` | Standalone chat web app — `@assistant-ui/react` + Vercel AI SDK v6 + Tailwind 4; webview host target |

---

## Daemon Package — Stable

- All package-level tests pass as of 2026-05-04
- Permission routes: `/permissions`, `/permissions/grant`, `/permissions/resolve`, `/permissions/replace`, `/permissions/clear` — integration-tested
- `DaemonManagerConfig` requires: `homeDir`, `getAppVersion()`, `resolveDaemonScriptPath()`, optional `extraEnv()`
- Desktop wires via `src/main/daemon/client.ts` + `manager.ts` — thin shims; daemon logic must not go here
- `createDaemonClient({ ensureRunning, getStatus, invalidate })` pattern confirmed

---

## Chat Tile V2 (assistant-ui pivot)

**V1 `ChatTile.tsx` (~8,764 LOC, ~83 useState, ~40 IPC channels, ~12,372 LOC total surface) is still live and must remain until V2 reaches full parity.**

- V2 scaffolded in `apps/chat-app/`; confirmed on disk: `ChatApp.tsx`, `main.tsx`, `Thread.tsx`, `styles.css`, `runtime/ContexRuntimeProvider.tsx`
- `ChatApp.tsx`: `onContext` from `@contex/chat-bridge`; 1.5s standalone fallback; injects `ctx.theme`/`ctx.fonts` as CSS vars on `document.documentElement`; header shows tile ID + workspace dir when connected, amber dot for standalone
- `ContexRuntimeProvider.tsx`: subscribes to `stream:${tileId}` channel; calls `callHost('chat.send', { cardId, workspaceId, workspaceDir, messages })` and `callHost('chat.stop', tileId)`; 120ms standalone echo fallback; handles `text`/`done`/`error` chunk types only — **thinking/tool_*/permission chunk types explicitly deferred**
- `Thread.tsx`: `@assistant-ui/react` primitives; `--thread-max-width: 48rem`; welcome screen with `sm:grid-cols-2` suggestion grid; Composer with paperclip/send/stop; ScrollToBottom; UserMessage/AssistantMessage; `lucide-react` icons
- `chatRequestAdapter.ts` — planned decoupling layer; **not yet on disk**
- Parity gate: `.planning/chat-tile-v2-parity.md` (~1,144 lines); V1 props: `tileId, workspaceId, workspaceDir, width, height, reloadToken, settings, onChatModePreferenceChange, isConnected, isAutoConnected, connectedPeers`
- V2 portability targets: contex desktop, mini-window, daemon web UI, mcp-app-studio widget, Swift WKWebView (muxy)

---

## ChatTile V1 Performance Work (uncommitted)

- Pagination: `CHAT_RENDER_PAGE_SIZE=20`, `CHAT_INITIAL_RENDER_PAGES=2`, `CHAT_INITIAL_RENDER_WINDOW=40`; `content-visibility: auto`, `containIntrinsicSize: '0 160px'`
- Lazy Shiki: `useStreamdownPlugins(text)` hook — bare `streamdownPlugins` export is now `{}`; callers must use hook
- Render perf probe in `src/main/index.ts`: `CODESURF_PERF_RENDER=1`; `CODESURF_PERF_EXIT_AFTER_RENDER=1`; `scripts/measure-render.js` exists on disk (untracked)

---

## Agent and Relay Subsystems

### `src/main/agents/` (all tracked)
- `agent-adapter-registry.ts` — `AGENT_ADAPTER_DEFINITIONS: AgentAdapterDefinition[]`; `capabilities(enabled, notes?)` helper
- `agent-adapter-types.ts` — `AgentAdapterCapabilityId`: `headlessRun | streamJson | resume | modelSelect | cwdSelect | approvalMode | mcp | acp | sessionImport | readOnlyHistory`; `AgentAdapterExecutionShape`: `native-sdk | headless-cli | daemon-cli | acp-capable | server-capable | import-only`
- `agent-cli-contracts.ts` — arg builders/output parsers; `resolveHermesModelSelection` handles `vendor/model` prefix strings
- `opencode-permissions.ts` — **untracked (new, not committed)**; `READ_SAFE_PERMISSIONS` always allowed; `RISKY_PERMISSIONS` denied/prompted/allowed per mode; `DAEMON_AUTOREAD_PREFIXES`: `~/.contex/chat-attachments/`, `~/.contex/chat-vision/`, `/tmp/contex-chat-attach/`

### `src/main/relay/`
- `registration.ts` — `isRelayHostActive()` / `setRelayHostActive()` guard prevents double-registration of `relay:*` IPC handlers
- `service.ts` — `WorkspaceRelayInstance` holds `ContexRelay` + `RelayRuntime`; wires relay events to main-process bus; loads tile state via `loadWorkspaceTileState`
- `provider-executor.ts` — **tracked, modified, uncommitted**; implements `RelayAgentExecutor`; bridges relay spawn to provider session maps; relay contract drift risk; session maps: `claudeSessions`, `hermesSessions`, `openClawSessions`

---

## Provider Mode Resolution (`src/renderer/src/config/providers.ts`)

- `resolveProviderModeId(providerId, preferredModeId?)` — always use; never hardcode mode strings
- `getApproxContextWindowTokens(providerId, modelId)` — GPT-5.x → 258K; o3/o4/Claude → 200K; others → 128K
- `DEFAULT_MODELS: Record<BuiltinProvider, ModelOption[]>` — authoritative model list for this repo; must stay in sync with grok-cli `MODELS`
- Permission modes: Claude (default/acceptEdits/plan/bypassPermissions), Codex (default/auto/read-only/full-access), OpenCode (default/plan/bypassPermissions), OpenClaw (default/auto/plan/full-auto), Hermes (full/terminal/web/query)

---

## Code-Index Extension

- Scaffolded as `examples/extensions/code-index/` (untracked); has `extension.json`, `main.js`, `tiles/dashboard/`, `lib/`, `evals/`, `vitest.config.mjs`
- Implementation logic belongs in `grok-cli`, not this desktop repo — extension manifest here only

---

## TypeScript-Go Integration

- `scripts/dev-go.js` — on disk, **untracked**; TypeScript-Go fast typechecker in watch mode; `CODESURF_MAX_OLD_SPACE_SIZE_MB` env var (default 8192)
- `tsconfig.tsgo.json` — on disk, **untracked**; tsgo-specific config
- `bun run typecheck` clean as of 2026-05-04

---

## grok-cli (`~/Documents/GitHub/grok-cli/`) — Separate Repo

- Desktop is a thin shell; all intelligence goes here
- **RAG fix (confirmed resolved 2026-05-04):** nested `sharp@0.32.6` in `@xenova/transformers` caused duplicate libvips delegate when root `sharp@0.34.5` also loaded. Fix: `package.json` + `bun.lock` override forces `sharp@^0.34.5` across all transitive deps. Verified: only one `@img/sharp-libvips-darwin-arm64` dylib present; no duplicate delegate warning on import; typecheck clean; targeted RAG/code-index tests pass. Override must remain — do not remove.
- `MODELS` array in `src/core/extensions/builtin/codesurf-desktop-provider.ts` must mirror `DEFAULT_MODELS` in desktop `providers.ts`
- **Model catalog wrapper (partial):** `bin/codesurfd.mjs` patches daemon HTTP server to serve authenticated `GET /chat/model-catalog` before delegating to `@codesurf/daemon`; `src/daemon/codesurf-daemon.ts` updated to prefer this wrapper via `resolveDaemonScriptPath()`; live HTTP smoke blocked by sandbox network-bind EPERM (not a regression). Desktop provider still has hard-coded model list — wire-up incomplete.
- **SSE stream fix:** provider tracks daemon event `sequence`, checks `/chat/job/state` after premature EOF, reattaches with `since=<last sequence>`
- **Daemon-as-source cleanup:** provider uses `getCodesurfDaemonBridge(home)` — do not parse pid files directly
- **Split-session fix:** retrospective repair tool at `src/daemon/session-repair.ts`
- Three pre-existing test failures (not regressions): Anthropic provider default enablement, payments group default enablement, Anthropic credential rejection expectation

---

## Open Threads

- `packages/codesurf-daemon/` is untracked — blocks clean merge; must commit
- `opencode-permissions.ts` untracked — must commit
- `provider-executor.ts` modified/uncommitted — relay contract drift risk
- V2 `ContexRuntimeProvider` — thinking/tool_*/permission chunk types not yet mapped; full parity gated on `.planning/chat-tile-v2-parity.md`
- `chatRequestAdapter.ts` planned but not on disk
- ChatTile V1 perf work (pagination + lazy Shiki) uncommitted — commit or stash before merge
- `scripts/dev-go.js` and `tsconfig.tsgo.json` untracked — TypeScript-Go integration not fully wired
- `examples/extensions/code-index/` untracked — confirm commit or ignore
- `.commandcode/` and `.grok/` — add to `.gitignore`
- grok-cli desktop provider still uses hard-coded model list; daemon route exists via wrapper, wire-up not done
- CLAUDE.md and AGENTS.md branch name stale — both say `feature/event-bus-mcp`; actual branch is `main-merge`

---

## Stable Contracts (Do Not Break)

- MCP port random — always read `~/.contex/mcp-server.json`; never hardcode; `.mcp.json` is a stale approximation
- `~/.codesurf/` (daemon state) ≠ `~/.contex/` (MCP config + workspaces) — do not conflate
- `App.tsx` ~1700 LOC — surgical edits only; canvas undo max 50 snapshots; never push to undo stack in hot paths
- `node-pty` requires `npm run rebuild` after native dep changes
- `cluso-widget` is `file:../agentation-real` — optional; build degrades silently if absent
- Extension tiles: `body.dark` via bridge; solid hex only; no `prefers-color-scheme`
- No emoji; `resolveProviderModeId` always; IPC `{feature}:{action}`
- Chat V2 bridge: `PROTOCOL_VERSION=1`, `BRIDGE_NAMESPACE='contex-chat-bridge'`; stream channel: `stream:${tileId}`
- `streamdown-utils`: `useStreamdownPlugins(text)` hook only; bare export is `{}`
- Relay host guard: check `isRelayHostActive()` before registering `relay:*` IPC handlers
- grok-cli RAG: top-level `sharp` override in `package.json` must remain to prevent duplicate libvips
- grok-cli provider: use `getCodesurfDaemonBridge(home)` — do not parse pid files directly
- grok-cli daemon wrapper: `bin/codesurfd.mjs` serves `/chat/model-catalog`; resolve via `resolveDaemonScriptPath()`

---

_Generated by codesurf-dreaming._
