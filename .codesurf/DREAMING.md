CodeSurf — Generated Memory (2026-07-13)

## Overview

CodeSurf is an Electron desktop app — infinite-canvas workspace where tiles (terminal, code editor, browser, kanban, chat) live on a 2D canvas. AI agents connect via MCP and collaborate with humans asynchronously.

Multi-target architecture is live: one React renderer shared across Electron (full), browser PWA, and a Native Zig shell. Electron is never removed; web and Native are additive. Reference: `docs/multi-target.md`.

CodeSurf is actively used as an agent orchestration platform. Canvas Codex tiles (gpt-5.6-sol, gpt-5.5) act as specialized subagents on external projects. This is normal usage — external project work passes through CodeSurf, not changes to this repo.

---

## Durable Facts

### Identity

- Product name: **CodeSurf** — never "contex" in user-facing copy
- Legacy internal namespace (`window.contex`, `~/.codesurf/`) is stable — do not rename

### Codebase Anchors

Key paths and their roles are catalogued in `.codesurf/DREAMING.md` — 44 rows covering main process, platform bridge, chat components, packages, desktop native, and scripts.

### Uncommitted Surface (as of 2026-07-13)

44 items: 30 modified tracked + 14 untracked. ~2,907 insertions, 792 deletions ahead of HEAD. Largest new additions: entire `packages/codesurf-terminal-gateway/` (1,601 LOC, untracked), `src/renderer/src/platform/terminalTransport.ts` (576 LOC, untracked), `desktop/src/sidecar_launcher.zig`, `desktop/sidecar/supervisor.mjs`, three new test files, three new scripts.

### Recent Commits

```
52921bd Upgrade to native zero
ba94e3a Major updates for collaboration
a76d425 Update DREAMING.md
16f2e00 Fix chat-send git stall, stream error loss, codex backpressure, settings re-parse
f861473 Add flag-gated canvas perf optimisations
```

### Build Commands

```
npm run dev / web:dev / web:preview / web:pwa / desktop:dev / build / build:web / desktop:build / rebuild
```

Multi-target data flow: Browser/Native → `web-host :4177` → `codesurfd`; terminal sessions via `terminal-gateway :4178`.

---

## Active Workflows / Capabilities

**Terminal Gateway** — `packages/codesurf-terminal-gateway/` v0.1.0 (untracked). WebSocket broker; node-pty + docker adapters. Fixes TerminalTile P0 on web/Native. Needs commit before further branching.

**Native Zero** — "Upgrade to native zero" landed. Root cause of beachball: `std.process.run` synchronous; fix requires persistent async controller path. Boot screen added; white screen may persist.

**Canvas perf flags** — Four ON by default; master off-switch `CODESURF_PERF_ALL=0`.

**Chip chrome map** — `ThinkingBlockView`/`WorkingChipView`/`ToolBlockView` = full chips; `CollationSummaryChip` = accent chip. Components are independent — never change both Thinking and Working chips in one edit.

**IPC surface** — 41 handlers; recent additions include `dreaming.ts`, `owl.ts`, `spokify.ts`, `transcribe.ts`, `tts.ts`, `execution.ts`, `jobs.ts`, `agents.ts`, `collab.ts`.

**Chat tile components** — 27 files; recent additions include Plan* components, `AskUserQuestionForm`, `DiffView`, `BlockNoteAffordance`, `toolChipCollation.ts`, `dreamToolActions.ts`, `checkpointToolActions.ts`.

**Wikipedia research + Workflow designer pipelines** — Both confirmed working via canvas Codex tiles. Fal variable naming confirmed: image takes `{{input}}` (not `{{start.input}}`), video takes no variable.

---

## External Project: flows/workflow/simple

Security issues (committed credential, unauthenticated endpoints, SSRF) pre-exist and are unresolved. 9 plan slices completed. Two read-only audits (spinner + fal) done but fixes not yet applied. See `.codesurf/DREAMING.md` for full detail.

---

## Open Threads

- Commit the untracked surface (gateway, transport, sidecar, tests, scripts) — highest priority
- Native Zero white screen — async controller path, not a loading screen
- `render.toolChips.dim` flag — in-progress; verify commit state
- `/permissions` Codex coverage — not wired
- flows: fal fixes still need application after read-only audits
- flows: committed MCP credential must be revoked externally
- tsc baseline dirty — ~145 pre-existing errors; measure regressions per-file
