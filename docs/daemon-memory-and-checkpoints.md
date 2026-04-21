# CodeSurf Daemon Memory And Checkpoint Architecture

## Purpose

This document describes the two chat safety/context systems now living behind the daemon boundary:

- layered AGENTS-style memory loading
- daemon-owned checkpoints / rewind primitives

These systems are designed so local runtime chat, local daemon chat, and remote daemon chat can converge on the same model:

- context is loaded by daemon-owned logic
- sensitive instruction buckets are classified before remote execution
- checkpoint storage and restore live in daemon-owned workspace state

## Commits

- `c95b4ce` — daemon checkpoints / rewind primitives
- `29621a0` — daemon memory loader

## High-level split

### Daemon-owned

- `bin/checkpoints.mjs`
- `bin/memory-loader.mjs`
- `bin/codesurfd.mjs`

The daemon owns:

- checkpoint file storage
- checkpoint listing/restoration
- AGENTS file discovery
- `@import` resolution
- privacy bucket classification
- workspace-level memory loading API

### Main-process seam

- `src/main/daemon/client.ts`
- `src/main/ipc/chat.ts`

The Electron main process currently acts as a client/controller:

- asks the daemon for memory context
- injects the returned prompt into local runtime provider calls
- asks the daemon to create/list/restore checkpoints
- triggers checkpoints before risky local runtime edits

## Memory model

## Supported AGENTS locations

For a workspace with one or more mounted project folders, the loader currently resolves:

- user: `~/.codesurf/AGENTS.md`
- project root: `<project>/AGENTS.md`
- project local/private: `<project>/.codesurf/AGENTS.md`
- nested mounted projects inside the same workspace:
  - `<nested-project>/AGENTS.md`
  - `<nested-project>/.codesurf/AGENTS.md`

The loader sorts project roots shallowest-first so the prompt keeps the same layered precedence as the workspace model.

## Buckets

Every section is classified into one of two buckets today:

- `remote-safe`
  - normal project `AGENTS.md`
  - imports that remain outside `.codesurf/`
- `local-only`
  - user/global `~/.codesurf/AGENTS.md`
  - project-local `.codesurf/AGENTS.md`
  - imports inside `.codesurf/`

Execution target decides which buckets make it into the outbound prompt:

- local execution includes:
  - `local-only`
  - `remote-safe`
- cloud / remote-daemon execution includes:
  - `remote-safe`
  - excludes `local-only`

## Import resolution

`@import <path>` lines inside AGENTS files are resolved relative to the importing file.

Important safety rules:

- symlink escape is rejected
- imported files must stay inside the importing project root
- `.codesurf/*` imports stay `local-only`
- import cycles/self-imports are deduped by canonical file path

The loader strips `@import ...` lines from the section body and emits imported files as separate ordered sections with `importedFrom` metadata.

## Memory loader output

`bin/memory-loader.mjs` returns:

- `executionTarget`
- `includedBuckets`
- `sections[]`
  - `scope`
  - `bucket`
  - `displayPath`
  - `path`
  - `importedFrom`
  - `content`
- `prompt`

The prompt is the already-layered markdown block used for provider injection.

## Memory APIs

### GET `/memory/load?workspaceId=...&executionTarget=local|cloud`

Implemented in:

- `bin/codesurfd.mjs`

Used by:

- `src/main/daemon/client.ts`
- `src/main/ipc/chat.ts`

Behavior:

- resolves the workspace
- materializes all mounted project paths
- loads layered AGENTS context
- filters by bucket for the requested execution target
- returns the final prompt plus section metadata

## Chat memory injection

### Local runtime chat

`src/main/ipc/chat.ts` now calls daemon memory loading before provider execution.

That memory prompt is then injected into:

- Claude system prompt assembly
- Codex prompt preamble

So local runtime chat now uses the same daemon-owned AGENTS loader as daemon-backed chat.

### Daemon-backed chat

`src/main/ipc/chat.ts` now forwards `memoryPrompt` when routing to a daemon host.

`bin/codesurfd.mjs` also backfills `memoryPrompt` at `/chat/job/start` if the request only contains `workspaceId` and not a prebuilt prompt.

`bin/chat-jobs.mjs` prefers `request.memoryPrompt` and falls back to loading memory itself.

That means:

- local runtime
- local daemon
- remote daemon

all have a consistent prompt path, with the initiating host able to preserve multi-project workspace layering.

## Checkpoint model

## Storage

Checkpoints are stored under workspace daemon state:

- `~/.codesurf/workspaces/<workspaceId>/.contex/checkpoints/<checkpointId>.json`

Runtime sessions remain at:

- `~/.codesurf/workspaces/<workspaceId>/.contex/runtime-session-<tileId>.json`

Checkpoint records capture:

- checkpoint id
- workspace id
- session entry id
- label / reason / metadata
- file snapshots
- runtime session snapshot
- restore timestamp

File snapshots store both:

- logical display path
- effective filesystem path used for safe restore
- content as base64 when the file existed
- deletion marker when the file did not yet exist

## Checkpoint APIs

### POST `/checkpoint/create`

Creates a daemon-owned checkpoint record for a session entry.

### POST `/checkpoint/list`

Lists checkpoints, optionally filtered by `sessionEntryId`.

### POST `/checkpoint/restore`

Restores the checkpoint's file snapshots and runtime session snapshot.

Safety/consistency behavior:

- path confinement to workspace roots
- symlink escape rejection
- best-effort rollback of restored files on failure
- best-effort rollback of runtime-session/checkpoint metadata writes on failure

## Runtime session metadata

Runtime session state now carries checkpoint metadata such as:

- checkpoint count
- latest checkpoint id/time
- last restored checkpoint id/time

`bin/codesurfd.mjs` merges daemon-owned checkpoint metadata forward on later runtime upserts so checkpoint state is not lost when the conversation continues.

## Checkpoint triggers today

Checkpoint storage is daemon-owned, but trigger wiring is currently in the main-process runtime chat seam.

Implemented today in `src/main/ipc/chat.ts`:

- Claude local runtime:
  - `Edit`
  - `MultiEdit`
  - `Write`
  - `NotebookEdit`
- Codex local runtime:
  - `file_change` batches

Behavior:

- create checkpoint before risky mutation
- deny the tool call if checkpoint creation fails
- continue normally if checkpoint creation succeeds

## Important current limitation

The daemon owns checkpoint storage and restore, but daemon-side provider loops in `bin/chat-jobs.mjs` are not yet creating checkpoints before their own file mutations.

So today:

- local runtime chat has checkpoint-before-edit behavior
- daemon-backed chat has daemon-owned checkpoint infrastructure available
- but daemon-backed provider loops still need direct checkpoint trigger wiring for full parity

That is the next checkpoint follow-up, not a new architecture direction.

## Renderer/UI manifestation rules

Do not introduce new dedicated memory/checkpoint React surface areas.

These systems should manifest through existing chat UI primitives:

- existing tool/status chips in `ChatTile`
- existing `ToolBlockView` / grouped tool chips
- existing file-change rendering
- existing workspace/customisation file editing flows

See `docs/chat-ui-manifest.md` for the renderer-specific mapping.

## Source file map

### Daemon/backend

- `bin/memory-loader.mjs`
- `bin/checkpoints.mjs`
- `bin/codesurfd.mjs`
- `bin/chat-jobs.mjs`

### Main process

- `src/main/daemon/client.ts`
- `src/main/ipc/chat.ts`

### Renderer touchpoints

- `src/renderer/src/components/ChatTile.tsx`
- `src/renderer/src/components/CustomisationTile.tsx`
- `src/renderer/src/components/ai-elements/ToolPermission.tsx`
- `src/renderer/src/components/ai-elements/JSXPreview.tsx`

### Tests

- `test/daemon/checkpoints.test.mjs`
- `test/daemon/memory-loader.test.mjs`
- `test/daemon/runtime-session-store.test.mjs`
- `test/daemon/project-context-daemon.test.mjs`
- `test/daemon/provider-context-policy.test.mjs`

## Practical summary

Memory loading now works as a daemon-owned layered AGENTS system with import resolution and privacy buckets, while checkpoints are stored/restored by the daemon and currently triggered for risky local runtime edits.
