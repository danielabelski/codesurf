# CodeSurf — Generated Memory (2026-07-31)

## Overview

Electron infinite-canvas workspace, three deployment targets (Electron / Browser PWA / Native Zig WebView) sharing one React renderer. Product name is CodeSurf; legacy `window.contex` identifiers and `~/.codesurf/` paths are preserved as-is — do not rename them. The 2026-07-30 full code review produced a BLOCK verdict against `bc2d0a94`; five isolated remediation branches exist, four ready for integration review, one blocked.

---

## Durable Architecture Facts

- **Canvas engine** — Refactored out of monolithic App.tsx into focused hooks under `src/renderer/src/hooks/`. `useAppCanvasInteraction.ts` is the composition root; math in `canvasEngineMath.ts`; drag, pointer, groups, context menus, connection-lock, and keyboard in sibling files. `useCanvasEngine.ts` re-exports all of them so existing import sites are unaffected.
- **Chat tile orchestration** — Split into focused hooks: `useChatTileSessionCore`, `useChatTileStreamBuffer`, `useChatTileTranscript`, `useChatTileShellModel`, `useChatTileSendPath`, `useChatTileAgentModes`, `useChatStreamHandler`, `useShellLayoutMetrics`. Shared: `chatStreamHub.ts`, `chatMessagesStore.ts`, `chatTileLayout.ts`, `transcriptWindow.ts`, `thinkingClock.ts`.
- **Sidebar / TileChrome** — Modularized: Sidebar in `components/sidebar/useSidebarController.tsx`; TileChrome in `components/tile-chrome/*`.
- **Chat chip components** — `ToolBlockView.tsx` is a re-export shell; implementation in `ToolBlockViewCore.tsx`. Thinking/working chips in `ThinkingWorkingChips.tsx`. Grouped chips in `ToolGroupChips.tsx`.
- **Theme presets** — Split into `themePresetsCore.ts`, `themePresetsDark.ts`, `themePresetsLight.ts`; `themePresets.ts` exports a normalized `THEMES` map.
- **Runtime checkpoints** — Centralized in `src/main/chat/runtime-checkpoints.ts`; Claude and Codex providers both import from here.
- **Platform layer** — `src/renderer/src/platform/capabilities.ts` + `__CODESURF_PLATFORM__` marker for host detection.
- **Terminal gateway package** — `packages/codesurf-terminal-gateway/`: authenticated WebSocket terminal broker, local PTY + Docker sandbox adapters, single-use attach tokens, backpressure limits.
- **Native sidecar** — Zig launcher + loopback supervisor at `desktop/sidecar/supervisor.mjs`.
- **MCP peer-bridge** — `src/main/mcp/tools/peer-bridge.ts`. Permission grants are workspace-scoped via `resolveTileWorkspaceDir` (uncommitted).

Key changes versus what the CLAUDE.md says:

- The existing DREAMING.md had a dreaming-agent preamble artifact at lines 1–3 — stripped.
- `test/mcp-auth.test.ts` is now a modified file in the working tree, added to the uncommitted-changes section.
- `plans/README.md` has been updated in-tree to reflect the 012–016 wave and full backlog; the plan table is now synchronized.
- The Agensis sessions visible in the dream evidence were a different repository (`/Users/jkneen/Documents/GitHub/agensis`) and are not recorded here.
