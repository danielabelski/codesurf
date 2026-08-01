# CodeSurf full-review remediation — reboot handoff

Generated: 2026-08-01 08:22 BST

## Current state

The review branch is being merged into `main`. All ten textual conflicts have
been resolved in the working tree and the resolved files are marker-free. A
merge commit has not been created in this session because the managed runtime
denies writes to `.git/index.lock`; the source tree is ready for staging and
commit in a normal Git-capable session.

```text
review worktree: /private/tmp/codesurf-full-review-integration.mbGkPH
source branch:   review/full-remediation-2026-07-31
source head:     ef6026b (Fix Monaco worker package imports)
review base:     4e51e4e0a8ce75af472accfe236202dac5cf899e
main HEAD:       2da6639a14ca153d5c8738acfe4c0c41400c4f06
merge head:      ef6026b2bc8b103618c9756ae029f12c1a9b073b
merge state:     in progress; source conflicts resolved, metadata not staged
worktree state:  563 changed paths from the integrated review plus main-only edits
commits:         7 remediation commits after the review base
```

Resolved conflict paths:

```text
.codesurf/DREAMING.md
electrobun/bun/index.ts
packages/codesurf-relay/src/relay.ts
plans/015-clean-checkout-verification.md
plans/2026-07-30-full-code-review.md
plans/README.md
src/main/chat/providers/opencode.ts
src/main/mcp-server.ts
src/main/mcp/tools/peer-bridge.ts
test/mcp-auth.test.ts
```

Remediation commits, newest first:

```text
ef6026b Fix Monaco worker package imports
4141265 Fix remediation test lint blockers
87adc72 Clean remediation diff whitespace
56c57ea Wire Electrobun Codex stable context lifecycle
52039f0 Dispose prepared provider state on launch failure
d45c9d1 Guard terminal output from superseded PTYs
a97cf4a Complete full review remediation and terminal session handoff
```

To inspect it after reboot:

```bash
cd /private/tmp/codesurf-full-review-integration.mbGkPH
git switch review/full-remediation-2026-07-31
git status --short
git log --oneline --decorate -5
```

Do not run `git clean`, `git reset --hard`, `git checkout -- .`, or prune the
other worktrees. The repository still has old/prunable worktree registrations;
they were left untouched deliberately. The review branch remains the canonical
source of the integrated changes until the merge commit is made.

## Terminal mode contract (the explicit product requirement)

Chat view terminal mode is a provider terminal, not a generic shell. It must
switch to the provider CLI and resume the existing conversation:

- `ChatTile` resolves the provider session id and passes an explicit CLI launch
  contract to `TerminalTile`.
- Claude launches `claude --resume <id>`; Codex launches
  `codex resume <id>`; OpenCode launches `opencode --session <id>`;
  OpenClaw launches `openclaw tui --session <id>`; Hermes launches
  `hermes --resume <id>`; csagent uses `pi --resume <id>`.
- Provider-specific no-id forms open the provider's own picker/start surface.
  Unknown providers fail closed with an explanatory terminal-view message.
- Renderer dependencies include the launch argv, so changing provider/session
  remounts the terminal. Electron and Electrobun compare launch identity and
  replace the old PTY instead of reusing a tile id for the wrong conversation.
- Web/Native use the same contract through the terminal gateway. The gateway
  accepts only the six allowlisted binaries, bounded provider grammar, and safe
  session ids; it rejects shell paths, arbitrary flags, and injection before
  spawning. No shell wrapper is used.
- Electrobun Codex stable context is acceptance-gated: a resumed turn omits
  stable persona/memory only after the exact thread accepted the prior prefix;
  failed launches, changed context, process restart, clear, and session
  replacement reinstall it.

Regression coverage includes provider mapping, gateway grammar, transport
forwarding, launch-identity replacement, stable-context lifecycle, stale PTY
output, and provider launch cleanup.

## Major remediation included

- OpenCode server lifecycle: readiness gating, shutdown generation fencing,
  process-tree cleanup, and authenticated shared clients.
- Chat lifecycle: preparation fences, session persistence, replacement/stop
  ordering, bounded provider context, output limits, and stale callback guards.
- Workspace/MCP/peer authority: workspace-scoped grants, canonical path and
  note boundaries, host-validated peer authority, and fail-closed injection.
- Attachments: durable one-shot capabilities, ownership/device/inode checks,
  bounded reads, atomic selections, safe cleanup, and Windows profile rules.
- Daemon/SSE: bounded frames and subscribers, contiguous event identity,
  restart-safe state, process-tree termination, and deterministic dist checks.
- Electrobun: host-authoritative filesystem/terminal RPC, stable Codex context,
  parser sealing/error handling, multimodal/attachment lifecycle, and parity
  with Electron facade contracts.
- Web target: canonical project registry, no-follow path checks, remote
  terminal launch forwarding, runtime fallback artifacts, and built-web smoke
  verification.
- Renderer/build: Monaco worker imports now use the package export map (clean
  installs no longer resolve `esm/vs/esm/vs/...`), focused chat/terminal hooks,
  and expanded behavior-level tests.

## Verification evidence

Green on the committed review tree:

- `npm run check` (lint, format check, and `tsgo` typecheck)
- `npm --prefix packages/codesurf-daemon run typecheck -- --pretty false`
- `npm --prefix packages/codesurf-daemon run verify:dist`
- `npm run build` (Electron main, preload, renderer)
- `npm run build:web` and `npm run verify:web-build` (web/PWA artifacts)
- `npm run build:electrobun` (renderer plus Electrobun package build)
- `npm run rebuild` (better-sqlite3 and node-pty Electron rebuild)
- `npm run verify:chat-context-mirrors`
- `npm run format:check`
- `git diff --check 4e51e4e0a8ce75af472accfe236202dac5cf899e`
- Expanded focused cross-target suite: **101/101 passed**
- Monaco worker browser proof: **1/1 passed**
- Electrobun PTY host proof after native rebuild: **1/1 passed**
- Terminal launch-contract subset: **3/3 passed**; gateway integration is
  sandbox-blocked before the server can listen
- Daemon non-smoke package suite: **71/71 passed**
- Stable-context, terminal-exit, and provider-launch focused checks: **39/39 passed**

The expanded focused command was:

```bash
node --experimental-strip-types --test \
  test/chat-terminal-launch.test.ts \
  test/terminal-managed-local-proxy.test.ts \
  test/electrobun-facade.test.ts \
  test/electrobun-chat-streams.test.mjs \
  test/electrobun-trust-policy.test.ts \
  test/electrobun-codex-stable-context-runtime.test.ts \
  test/platform/terminal-transport.test.mjs \
  test/daemon/attachment-capabilities.test.mjs \
  test/daemon/attachment-selections.test.mjs \
  test/terminal-exit-lifecycle.test.ts \
  test/provider-launch-guard.test.ts
```

Known environment/tooling limits (not silently treated as product passes):

- A broad concurrent `npm run test:unit:core` run was stopped by the 180-second
  cap (`RESULT=124`, 682 completed passes, 79 contention/environment failures,
  and 72 interrupted files). The serial daemon attempt was separately stopped
  by the 240-second package-smoke harness timeout; the authoritative daemon
  non-smoke suite is green at 71/71, and daemon HTTP suites pass in isolation.
- The managed sandbox rejects direct loopback listeners with
  `listen EPERM: operation not permitted 127.0.0.1`. This blocks the nine
  terminal-gateway integration cases and local-proxy backend cases before
  product code executes; the launch grammar cases remain green.
- `npm run test:unit:electron-hosts` reaches all 39 tests, but 37 fail because
  the Electron 41 binary and broker/OWL child hosts abort with `SIGABRT` in
  this managed runtime (direct `node_modules/.bin/electron --version` shows
  the same abort). Two non-host assertions pass.
- Vite emits existing dynamic-import and large-chunk warnings; builds exit 0.

## Main checkout / merge preservation

`/Users/jkneen/clawd/collaborator-clone` is on `main` with the review merge
in progress. The integrated source is present in the working tree and all
conflict markers have been removed. Main-only changes were preserved; no reset,
clean, worktree prune, or push was performed.

```text
/Users/jkneen/clawd/collaborator-clone/status.md
/Users/jkneen/clawd/collaborator-clone/review-full-remediation.patch
/Users/jkneen/clawd/collaborator-clone/review-full-remediation-snapshot.tar.gz
```

The patch and snapshot were regenerated at 08:04 BST from the review base and
include all seven remediation commits. They remain recoverable backups of the
source branch, not a replacement for the in-progress merge. The patch is
byte-identical to
`git diff --binary 4e51e4e0a8ce75af472accfe236202dac5cf899e`; SHA-256 values:

```text
patch:   296dc588652cf0109fe7409fe25d9e5d52fb58dbce7df565a9776fc5a11b67d7
archive: 56a33c6c90e76198077f0ba9d3008712db5fcba2332a86e6081b93b897f6b78c
```

The patch contains tracked-file changes;
the source snapshot contains the full isolated tree (excluding `node_modules`,
generated `dist`, `dist-electron`, `out`, and `.git`) so untracked implementation
and test files are also recoverable.

The managed session cannot create `.git/index.lock`, so the resolved files
could not be staged or committed here. Do not discard the merge state. In a
normal Git-capable session, run:

```bash
git status --short
git diff --check
git add -f .codesurf/DREAMING.md
git add status.md electrobun/bun/index.ts \
  packages/codesurf-relay/src/relay.ts plans/015-clean-checkout-verification.md \
  plans/2026-07-30-full-code-review.md plans/README.md \
  src/main/chat/providers/opencode.ts src/main/mcp-server.ts \
  src/main/mcp/tools/peer-bridge.ts test/mcp-auth.test.ts
git diff --name-only --diff-filter=U  # must be empty
git commit -m "Merge review/full-remediation-2026-07-31 into main"
```

## Tool/hook note

No Alexandria skill or hook was invoked for this remediation.

## Safe next action after reboot

Start in this checkout, confirm the ten paths above are staged with no unmerged
entries, create the merge commit, then run the expanded focused command above.
Remaining red evidence is environment-backed socket/Electron validation, not a
source conflict. Do not claim the merge is complete until `git log -1` shows a
new merge commit and `git status --short` is clean.
