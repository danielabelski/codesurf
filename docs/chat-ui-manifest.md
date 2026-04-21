# Chat UI Manifest For Memory And Checkpoints

## Rule

Do not add new dedicated renderer components for memory loading or checkpoint saving.

Use the UI primitives that already exist in the chat surface.

## Existing renderer surfaces

### 1. Chat tool/status chips

Primary file:

- `src/renderer/src/components/ChatTile.tsx`

Existing renderer primitives already handle streamed operational state:

- `tool_start`
- `tool_input`
- `tool_use`
- `tool_summary`
- `tool_progress`
- `fileChanges`
- permission request / resolution cards
- grouped/collapsed tool chips

Relevant components inside `ChatTile.tsx`:

- `ToolBlockView`
- `CollapsedToolGroup`
- `MixedToolGroup`
- `ThinkingBlockView`
- `ToolPermissionCard`

These are the correct surfaces for operational chat events like:

- checkpoint saved
- checkpoint restore
- workspace instructions loaded
- file-change summary after checkpointed edits

### 2. Workspace/customisation file editing

Primary file:

- `src/renderer/src/components/CustomisationTile.tsx`

This tile already discovers and exposes:

- `<workspace>/AGENTS.md`

as a prompt/configuration source.

That means AGENTS memory already has a natural editing/discovery entry point in the UI. Do not build a parallel AGENTS editor surface.

### 3. Existing AI elements already in use

Current local AI element wrappers in the repo are:

- `src/renderer/src/components/ai-elements/ToolPermission.tsx`
- `src/renderer/src/components/ai-elements/JSXPreview.tsx`

The important point is not to invent another renderer subsystem. Reuse the same chat/tool rendering pattern already used by these AI elements and by `ChatTile` tool blocks.

## How the new backend work should show up in UI

## Memory loading

### Current reality

What is already true today:

- AGENTS memory is now loaded daemon-side
- the resulting prompt is injected into local runtime and daemon chat paths
- there is no dedicated visible memory badge or panel yet
- AGENTS files themselves are discoverable/editable via `CustomisationTile`

### Correct UI manifestation

Use the existing chat tool/status chip model.

Recommended manifestation:

- emit a normal tool/status event into the chat stream when workspace instructions are loaded
- render it through existing `ToolBlockView`
- summary text should include:
  - which buckets were included
  - which files/sections contributed
  - whether execution is local or cloud-safe filtered

That gives the user an inspectable "what context was loaded" trace without creating any new component family.

### What not to do

Do not create:

- a separate "memory panel" inside chat
- a new React component just for AGENTS sections
- a second AGENTS browser/editor when `CustomisationTile` already exposes the file

## Checkpoints

### Current reality

What is already true today:

- checkpoints are daemon-owned
- local runtime Claude/Codex create checkpoints before risky file edits
- checkpoint records can be listed/restored through daemon APIs
- runtime session state now carries checkpoint metadata
- there is no dedicated rewind button in the renderer yet

### Correct UI manifestation

Again, use the existing chat tool/status chips and existing session/file-change surfaces.

Recommended manifestation:

- checkpoint save should appear as a normal operational chip in the message stream
- checkpoint restore should appear as a normal operational chip in the message stream
- file changes after checkpointed edits continue using existing file-change chips/diff expanders
- session/history surfaces can later reuse existing list-row patterns to show checkpoint count or latest checkpoint timestamp

### Rewind / restore affordance

When rewind is surfaced, do not create a standalone checkpoint UI framework.

Use one of these existing surfaces:

- action button on an existing chat tool block
- action in the existing message action row / history row
- action in the existing session/history list item

The actual restore work remains daemon-side. The renderer only needs to invoke the restore API and then refresh state.

## Concrete renderer mapping

### Memory

Backend source:

- `GET /memory/load`
- `src/main/ipc/chat.ts` runtime memory prompt loading
- `bin/chat-jobs.mjs` daemon memory prompt usage

Renderer mapping:

- stream a normal tool/status chip in `ChatTile`
- edit the underlying AGENTS file through `CustomisationTile`

### Checkpoints

Backend source:

- `POST /checkpoint/create`
- `POST /checkpoint/list`
- `POST /checkpoint/restore`
- `runtime-session-*.json` checkpoint metadata

Renderer mapping:

- checkpoint save/restore as normal tool/status chips in `ChatTile`
- file diffs continue through `ToolBlockView`
- session/history counts later piggyback on existing session-row UI

## What app docs should say

For product/app documentation, describe the UI this way:

- CodeSurf loads layered AGENTS instructions automatically for each workspace
- local/private instructions are kept local and are not sent to cloud execution paths
- before risky local edits, CodeSurf saves daemon-owned checkpoints
- checkpointed edits and file changes appear in the normal chat operation stream
- AGENTS instructions are edited through the existing workspace customisation flow
- rewind/restore is an action on existing chat/history surfaces, not a separate mode or screen

## Short version for docs writers

Memory and checkpoints are not separate mini-apps inside CodeSurf. They are backend systems that surface through the existing chat tool chips, file-change chips, session rows, and workspace customisation file editing flow.
