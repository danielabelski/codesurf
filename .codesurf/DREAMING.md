# Project Overview

**contex** — Electron desktop app; infinite 2D canvas workspace where tiles (terminal, code editor, browser, kanban, chat, image) live alongside AI agents connected via MCP. Humans and agents collaborate asynchronously on shared canvas state.

- **Repo:** `/Users/jkneen/clawd/collaborator-clone`
- **Active branch:** `feature/event-bus-mcp`
- **As of:** 2026-04-28

---

# Durable Facts

## Tech Stack (pinned versions)
- Electron 40.8.2 · React 19.2.4 · TypeScript 5.9.3 · Vite/electron-vite 7.3.1/5.0.0
- Tailwind CSS 4.0.0 — dark theme hardcoded; never use `prefers-color-scheme`; solid hex not rgba opacity
- `@anthropic-ai/claude-agent-sdk` 0.2.79 · `@opencode-ai/sdk` 1.2.27
- xterm + node-pty · Monaco editor · framer-motion
- `@ricky0123/vad-web` ^0.0.30 (Silero VAD, ONNX) + `onnxruntime-web` ^1.24.3 — both excluded from Vite dep-opt
- `electron-updater` ^6.8.3 — in package.json only; main-process update lifecycle not yet wired

## Shared Types (`shared/types.ts`)
- `getCurvierBlockRadius(radius?)` — exported; used by App.tsx and ImageTile to synchronise chrome border-radius with inner image clipping wrapper when `TileChrome allowOverflow` is active
- `VoiceSettings` — STT default Deepgram Nova-2; TTS default Cartesia; Spokify model `claude-haiku-4-5-20251001`; `autoSpeak: 'off' | 'last-message'`; `bargeIn: boolean` (default true); API keys encrypted via `safeStorage`

## IPC Naming Convention
`{feature}:{action}` — e.g. `workspace:list`, `canvas:save`, `terminal:write`, `bus:publish`

---

# Active Subsystem State

## Recent commits (HEAD → older)
- `ecc382f` — Fix UI stacking, chat footer & STT API: group zIndex `'auto'` idle, toolbar zIndex lifted, AssemblyAI `speech_models` array fix, Electron version bump
- `33f9063` — Add voice VAD assets and renderer hooks
- `2063c02` — Add voice STT/TTS IPC, spokify, secrets store
- `a19618c` — Add discovery-graph worker and useWorker hook
- `0d08485` — Promote expanded tiles; update MCP port & styles
- `575e217` — Add Electrobun runtime scaffold and tests

## Unstaged working tree (5 files modified, none committed)

**ImageTile external inspector refactor** — Inspector controls (palette swatches, metadata, edit input) render outside the tile block when it is selected. They are negative-positioned and counter-scaled (`1/zoom`) so they stay at constant screen size and constant screen distance regardless of canvas zoom level.

Precise changes per file:

**`App.tsx`**
- Imports `getCurvierBlockRadius` from `shared/types`
- `renderTileBody()` now accepts `isSelected` option; passes `isSelected`, `borderRadius`, `zoom` to `LazyImageTile`
- `TileChrome` receives `allowOverflow={tile.type === 'image' && isSelected}` — gated strictly on selected image tiles
- Link-sensor pointer events disabled when `isSelectedImageTile` (type `=== 'image'` and in selection set) — prevents sensor overlay from swallowing clicks on inspector controls

**`ImageTile.tsx`**
- New props: `isSelected`, `borderRadius` (default 16), `zoom` (default 1)
- `inspectorOpen` is now a derived const `= isSelected` — state variable removed
- Double-click/Escape handlers removed; auto-focus on open removed (ArrowLeft/Right reserved for variant nav)
- Cmd/Ctrl+wheel bubbles to canvas (no longer swallowed for variant nav)
- Outer wrapper: `overflow: visible` so controls escape; inner image-clipping wrapper: `position: absolute, inset: 0, borderRadius` (mirrors chrome value)
- Click-absorber divs at `zIndex 99993` cover left/right/bottom gap zones to prevent accidental canvas deselect

**`TileChrome.tsx`**
- New prop `allowOverflow?: boolean` — both main panel container and content wrapper switch to `overflow: visible` when true

**`.mcp.json`** — MCP server port updated

## Canvas Engine
- All 2D physics in `App.tsx` (~1700 LOC); world coords = screen adjusted for zoom + pan
- Undo snapshots full state (max 50) — never push in hot paths
- `promoteExpandedTileToLayoutGroup()` — single fullscreen tile → layout group at ≥2 tiles

## zIndex layer map (image tile selection mode)
- Inspector controls: `99994`
- Click absorbers: `99993`
- Link sensors: `99991` — disabled (pointer-events: none) when image tile selected

## Voice Subsystem (committed in `ecc382f` / `33f9063` / `2063c02`)
- Main process: `transcribe.ts` (4 STT providers), `tts.ts`, `spokify.ts`, `secrets-ipc.ts`, `secrets.ts`
- Renderer: `src/renderer/public/vad/` (Silero v5 + legacy ONNX, ORT WASM variants, VAD worklet), `useVoiceActivityDetector.ts`, `useAutoSpeak.ts`, `sentenceStream.ts`, `utils/ttsPlayer.ts`, `VoiceSettingsEditor.tsx`
- `TtsPlayer` uses `HTMLAudioElement` (not Web Audio API); no AudioContext unlock required. Barge-in calls `stop()`, drains queue. Per-message tracking via `messageId`.
- AssemblyAI STT: `speech_models` array field was the breakage fixed in `ecc382f`

## ChatTile
- Footer: `[$cost] [turns] [reltime] [Mic]` — reserved `minHeight` prevents streaming layout shift
- `InsightBlock` renders `★ Insight`-tagged output as styled callout cards
- `isDictating` / `isSpeaking` visual states; `transcribeJobRef` prevents out-of-order transcription

## SettingsPanel
- Sections: `'general' | 'daemon' | 'canvas' | 'providers' | 'voice' | 'browser' | 'permissions' | 'mcp' | 'extensions' | 'prompts' | 'skills' | 'tools' | 'agents'`
- Duplicate `case 'voice'` switch block = build warning, not runtime error

---

# Open Threads

- **ImageTile inspector refactor** — 4 renderer source files + `.mcp.json` unstaged; commit once selection/zoom/overflow is confirmed end-to-end visually
- **Voice round-trip** — VAD assets confirmed in `public/vad/`, CSP covers `worker-src blob:` and `media-src blob:`. Runtime confirmation (mic → VAD → STT → LLM → TTS → playback) still needed; user reported "voice is not working"
- **Audio skipping when initiating agent** — reported: audio skips during tile mount / animation. Root cause unresolved. `TtsPlayer` uses `HTMLAudioElement` exclusively; no AudioContext suspend path exists. Likely framer-motion layout animation contending with audio decode, or agent tile mount causing ChatTile re-render mid-playback. Needs profiling.
- **Duplicate `case 'voice'` in SettingsPanel switch** — dedup before shipping
- **`electron-updater` not wired** — main-process update lifecycle not implemented
- **PanelLayout compact tab icons** — hardcoded inline SVGs; needs shared icon component
- **Scrollbar layout shift in SettingsPanel** — unresolved
- **Electrobun Burst 2** — gated on `better-sqlite3` compat and BrowserView parity

---

# Chorus — Separate Swift macOS Project

Chorus (`~/Library/Application Support/Chorus/`) is an entirely separate Swift/SwiftUI kanban task runner. Not part of this repo. Codex sessions use `CHORUS_WORKSPACE`, `CHORUS_PROJECT_DIR`, `CHORUS_TRACE_DIR`.

**Completed cards:**
- **CHO-002** — Workspace identifiers restricted to ASCII path-safe characters; `.` and `..` rejected; workspaces must be descendants of configured root; symlinks resolved; Swift test target + 5 isolation tests; `swift test` passed
- **CHO-003** — Backward-compatible categorized orchestration events (`dispatch`, `retry`, `hook`, `agent`) in `Models.swift`/`Orchestrator.swift`; filtered log panel in `ContentView.swift`; session IDs persisted; `swift test` passed (8 tests)
- **CHO-004** — Narrow `AgentRunner.swift` fixes: consistent run-start workflow snapshots, safer retry backoff, subprocess hardening, task editor field preservation; review notes in `Workspaces/CHO-004/REVIEW_NOTES.md`

**Sandbox constraint:** Codex sandbox denies writes to `$CHORUS_TRACE_DIR` (sibling of project tree) under `workspace-write`. Required trace artifacts (`PLAN.md`, `SUCCESS_CRITERIA.md`, `REVIEW.md`, `TESTS.md`, `RESULT.json`) cannot be created via `apply_patch` or REPL from inside this sandbox — no workaround established yet.

---

# Hazards

- `App.tsx` ~1700 LOC — surgical edits only; changes ripple widely
- node-pty requires `npm run rebuild` after native dep changes
- MCP port is random — always read `~/.contex/mcp-server.json`, never hardcode
- Canvas undo snapshots full-state (max 50) — never push in hot paths
- `cluso-widget` is optional local file dep (`file:../agentation-real`) — may not exist
- `TileChrome allowOverflow` cascades `overflow: visible` through both panel and content wrapper; inner image clipping wrapper must carry explicit `borderRadius` to preserve visual rounding
- ImageTile zIndex ordering: inspector controls `99994` > click absorbers `99993` > link sensors `99991` (pointer-events: none when selected)
- **Chorus** is a separate Swift project at `~/Library/Application Support/Chorus/` — do not conflate with contex
- **muxy** (`/Users/jkneen/Documents/GitHub/muxy`) is a separate Swift macOS app — do not conflate with contex

---

*Generated by CodeSurf dreaming — 2026-04-28*
