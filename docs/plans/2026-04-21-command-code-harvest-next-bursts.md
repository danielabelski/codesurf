# Command Code Harvest — Next Bursts Plan

> For Hermes: execute in small controlled bursts, test-first, and do not create new React component families for memory/checkpoint UI. Reuse existing ChatTile, ToolBlockView, Sidebar row/context-menu, and CustomisationTile surfaces.

Goal: finish the actually visible memory/checkpoint UX first, then move into the next high-value Command Code harvests: skill indexing, file-reference expansion, and context buckets.

Architecture: keep persistence/privacy/resume logic daemon-authoritative in `bin/*.mjs`, keep Electron main as a thin client/controller, and surface state only through existing renderer affordances. Memory and checkpoint UI should feel like normal chat/tool/status behavior, not like bolt-on mini apps.

Tech stack: Electron main/preload/renderer, React, TypeScript, ESM daemon modules, node --test, electron-vite.

---

## Already landed — do not redo

These are already in product code and/or docs. Treat them as baseline, not TODOs:

- daemon checkpoints / rewind primitives
- daemon AGENTS memory loader with `@import` and privacy buckets
- `Workspace Instructions` chat chip at turn start
- `Checkpoint saved` chat chip before risky local runtime edits
- runtime session checkpoint metadata in daemon session state
- latest-checkpoint restore via existing session context menu
- docs:
  - `docs/daemon-memory-and-checkpoints.md`
  - `docs/chat-ui-manifest.md`

Before touching any of this, inspect current files and confirm whether the target behavior already exists in the active branch/worktree.

---

## Burst 1 — Make checkpoint state obviously visible in existing thread rows

Objective: make it impossible to miss that a runtime thread has checkpoint state, using only the existing Sidebar row affordances.

Files:
- Modify: `src/shared/session-types.ts`
- Modify: `bin/codesurfd.mjs`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Test: `test/daemon/checkpoints.test.mjs`

### Step 1: Write failing daemon test for session-list checkpoint count

Add/keep a test in `test/daemon/checkpoints.test.mjs` that:
- creates a runtime session
- creates a checkpoint
- calls `/session/local/list`
- asserts the runtime entry exposes `checkpointCount: 1`

Run:
- `node --test test/daemon/checkpoints.test.mjs`

Expected:
- FAIL if `checkpointCount` is missing from runtime session list payload

### Step 2: Make runtime session list expose checkpoint count

In `bin/codesurfd.mjs`:
- ensure runtime session summary includes `checkpointCount`
- ensure `listLocalWorkspaceSessions()` forwards that onto runtime entries

In `src/shared/session-types.ts`:
- add optional `checkpointCount?: number` to `AggregatedSessionEntry`

### Step 3: Surface checkpoint count in the existing Sidebar row

In `src/renderer/src/components/Sidebar.tsx`:
- keep current row structure
- add a small count pill in `extra={...}` only when `checkpointCount > 0`
- keep existing tooltip text updated with checkpoint count
- do not add a new component file

### Step 4: Verify

Run:
- `node --test test/daemon/checkpoints.test.mjs`
- `npm run build`

Manual verification:
- open runtime session list
- confirm checkpointed runtime sessions show a visible count pill in the existing row

### Step 5: Commit

Suggested commit message:
- `feat: expose checkpoint count in thread rows`

---

## Burst 2 — Add a visible restore affordance directly in the existing thread row

Objective: users should not have to discover restore only via context menu.

Files:
- Modify: `src/main/ipc/canvas.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/env.d.ts`
- Modify: `src/renderer/src/components/Sidebar.tsx`
- Test: `test/daemon/checkpoints.test.mjs`

### Step 1: Write failing test for restore flow survival

In `test/daemon/checkpoints.test.mjs`:
- assert restore still updates runtime session state
- assert restore leaves checkpoint metadata intact after subsequent runtime upsert

Run:
- `node --test test/daemon/checkpoints.test.mjs`

Expected:
- PASS baseline if backend already works
- if adding more assertions, fail first until new behavior is covered

### Step 2: Ensure restore APIs are exposed to renderer

In:
- `src/main/ipc/canvas.ts`
- `src/preload/index.ts`
- `src/renderer/src/env.d.ts`

Wire/confirm:
- `canvas:listCheckpoints(workspaceId, sessionEntryId)`
- `canvas:restoreCheckpoint(workspaceId, checkpointId, sessionEntryId?)`

### Step 3: Add restore button to existing Sidebar row actions

In `src/renderer/src/components/Sidebar.tsx`:
- inside existing row `extra={...}` block
- add a small restore icon button only when `checkpointCount > 0`
- clicking it should:
  - confirm with the user
  - list checkpoints
  - restore the latest one
  - refresh sessions
  - reopen/focus the session in chat

Do not:
- add a new modal component
- add a new checkpoint list component
- create a new row type

### Step 4: Keep context menu restore entry in sync

In `Sidebar.tsx`:
- reuse the same restore helper from both the visible row button and context menu action
- avoid duplicated restore logic

### Step 5: Verify

Run:
- `node --test test/daemon/checkpoints.test.mjs`
- `npm run build`

Manual verification:
- checkpointed runtime session row shows restore button
- clicking restore reopens/restores the chat

### Step 6: Commit

Suggested commit message:
- `feat: add restore controls to runtime thread rows`

---

## Burst 3 — Emit a visible `Checkpoint restored` chip in chat

Objective: restoring should produce visible feedback in the chat stream using the same existing chip flow as other tool/status operations.

Files:
- Modify: `bin/checkpoints.mjs`
- Modify: `src/renderer/src/components/ChatTile.tsx` only if needed for existing tool-block rendering compatibility
- Test: `test/daemon/checkpoints.test.mjs`

### Step 1: Write failing test for restored-notice message

In `test/daemon/checkpoints.test.mjs`:
- restore a checkpoint
- fetch runtime session state
- assert there is an assistant message/tool block named `Checkpoint restored`

Run:
- `node --test test/daemon/checkpoints.test.mjs`

Expected:
- FAIL until restore appends the notice message

### Step 2: Append restore notice in daemon-owned session state

In `bin/checkpoints.mjs`:
- after successful restore, append a synthetic assistant message to the runtime session snapshot
- shape it to match existing chat/tool block expectations:
  - `role: 'assistant'`
  - empty `content`
  - `toolBlocks: [{ name: 'Checkpoint restored', summary: ... }]`
  - `contentBlocks: [{ type: 'tool', toolId }]`

### Step 3: Ensure existing ChatTile renders it without new UI code

In `ChatTile.tsx`:
- prefer using the current `tool_start` / `tool_summary` / restored session replay path
- only touch renderer if the restored message shape needs a tiny compatibility fix
- do not add a new component file

### Step 4: Verify

Run:
- `node --test test/daemon/checkpoints.test.mjs`
- `npm run build`

Manual verification:
- restore a checkpoint from Sidebar row/button/context menu
- reopened chat shows a visible `Checkpoint restored` tool chip

### Step 5: Commit

Suggested commit message:
- `feat: show checkpoint restored in chat stream`

---

## Burst 4 — Harden the memory chip so it is always obvious and not noisy

Objective: make `Workspace Instructions` reliably visible but still compact.

Files:
- Modify: `src/main/ipc/chat.ts`
- Modify: `bin/chat-jobs.mjs`
- Modify: `src/renderer/src/components/ChatTile.tsx` only if needed for summary presentation
- Test: `test/daemon/memory-loader.test.mjs`

### Step 1: Add/keep summary generation rules

Memory summary should include:
- number of visible sections
- included buckets
- first 2-3 source paths
- compact `+N more` suffix

### Step 2: Ensure both runtime and daemon paths emit it

Runtime:
- `src/main/ipc/chat.ts`
- emit `Workspace Instructions` before local runtime execution

Daemon-backed:
- `bin/chat-jobs.mjs`
- emit `Workspace Instructions` as timeline events before provider execution

### Step 3: Verify it does not create duplicate/no-op spam

Rules:
- only emit when there is a non-empty prompt
- do not emit empty or redundant chips
- do not create a special renderer-only memory component

### Step 4: Verify

Run:
- `node --test test/daemon/memory-loader.test.mjs`
- `npm run build`

Manual verification:
- local runtime chat shows chip
- daemon-backed chat shows chip
- empty/no-memory workspace does not show chip

### Step 5: Commit

Suggested commit message:
- `feat: tighten workspace instruction chip behavior`

---

## Burst 5 — Daemon-owned skill resolution/indexing

Objective: bring over the next major Command Code harvest after memory/checkpoints.

Files:
- Create: `bin/skills-index.mjs`
- Modify: `bin/codesurfd.mjs`
- Modify: `src/main/daemon/client.ts`
- Modify: `src/main/ipc/chat.ts`
- Review existing: `src/main/ipc/skills.ts`
- Test: `test/daemon/skills-index.test.mjs`
- Docs: `docs/daemon-skills.md`

### Step 1: Write failing daemon tests

Cover:
- global skill root: `~/.codesurf/skills`
- workspace skill root: `<workspace>/.codesurf/skills`
- compat dirs if needed
- list/get/install routes
- summary generation for prompt inclusion

Run:
- `node --test test/daemon/skills-index.test.mjs`

Expected:
- FAIL for missing routes/module

### Step 2: Implement daemon skill index

Routes:
- `/skills/list`
- `/skills/get`
- `/skills/install`

Behavior:
- merge global + workspace scopes
- expose metadata first, content on demand
- keep renderer/browser/install flow simple

### Step 3: Wire prompt-side skill injection

In `src/main/ipc/chat.ts`:
- load selected skill summaries into provider prompt assembly
- keep outbound inclusion inspectable

### Step 4: UI manifestation

Use existing surfaces only:
- existing skill install/browser surfaces
- existing chat/tool/status surfaces for “included skills” summary if needed
- do not create a separate skill-chat UI family

### Step 5: Verify + commit

Run:
- `node --test test/daemon/skills-index.test.mjs`
- `npm run build`

Suggested commit message:
- `feat: add daemon skill indexing`

---

## Burst 6 — File-reference expansion (`@file`, `@path`)

Objective: bring over the next highly visible Command Code behavior after skills.

Files:
- Create: `bin/file-references.mjs`
- Modify: `bin/codesurfd.mjs`
- Modify: `src/main/daemon/client.ts`
- Modify: `src/main/ipc/chat.ts`
- Test: `test/daemon/file-references.test.mjs`
- Docs: `docs/file-reference-expansion.md`

### Step 1: Write failing tests

Cover:
- `@path`
- relative resolution from workspace
- path sanitization
- cloud filtering / preview behavior

### Step 2: Implement daemon expander

Route:
- `/context/expand-references`

### Step 3: UI manifestation

Use existing surfaces only:
- existing attachment/reference chips in chat composer and chat stream
- existing tool/status chips for “expanded references” summary

### Step 4: Verify + commit

Suggested commit message:
- `feat: add daemon file reference expansion`

---

## Burst 7 — Explicit context buckets and inspectable outbound context

Objective: make memory/skills/files/privacy inspectable before remote send.

Files:
- Create: `bin/context-buckets.mjs`
- Modify: `src/main/ipc/chat.ts`
- Modify: `bin/chat-jobs.mjs`
- Modify: docs under `docs/`
- Test: `test/daemon/context-buckets.test.mjs`

### Step 1: Define buckets

Start with:
- `local-only`
- `remote-safe`
- later if needed: `user-approved-remote`

### Step 2: Assemble inspectable context bundle

Include:
- messages
- memory
- skills
- referenced files
- repo metadata

### Step 3: Surface through existing UI

Use:
- existing chat tool/status chips
- existing settings/customisation flows
- existing thread/session/history affordances

### Step 4: Verify + commit

Suggested commit message:
- `feat: add inspectable context buckets`

---

## Manual acceptance checklist

A burst is not done until these are true:

- [ ] I can start a workspace-backed chat and see `Workspace Instructions`
- [ ] I can trigger a risky local file edit and see `Checkpoint saved`
- [ ] I can see checkpoint count in the runtime session row itself
- [ ] I can restore from the runtime session row or context menu
- [ ] Reopened chat shows `Checkpoint restored`
- [ ] Nothing required a new React component family
- [ ] Daemon tests pass
- [ ] `npm run build` passes
- [ ] docs reflect the real implemented behavior, not the aspirational one

---

## Recommended execution order

1. Burst 1 — checkpoint count in row
2. Burst 2 — restore button in row
3. Burst 3 — `Checkpoint restored` chip
4. Burst 4 — memory chip robustness
5. Burst 5 — daemon skill indexing
6. Burst 6 — file-reference expansion
7. Burst 7 — context buckets

This order maximizes actual visible product value first, then continues the deeper Command Code harvests.
