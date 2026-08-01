# CodeSurf full-review remediation — reboot handoff

Generated: 2026-08-01 08:04 BST

## Current state

The remediation is implemented and committed on an isolated review branch.
The original checkout was not reset, cleaned, merged, or pushed.

```text
review worktree: /private/tmp/codesurf-full-review-integration.mbGkPH
branch:          review/full-remediation-2026-07-31
head:            ef6026b (Fix Monaco worker package imports)
review base:     4e51e4e0a8ce75af472accfe236202dac5cf899e
main baseline:   bc2d0a94d1a7188419b7bbf01fc083f8fdbd4296
worktree state:  clean
commit size:     194 files, 22,818 insertions, 2,243 deletions
commits:         7 remediation commits after the review base
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
they were left untouched deliberately.

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

## Main checkout preservation

`/Users/jkneen/clawd/collaborator-clone` remains on its original `main`
checkout with its pre-existing user edits preserved. The review did not copy
the remediation source into main. The only new main-root artifacts are this
handover and the recoverable backups below.

```text
/Users/jkneen/clawd/collaborator-clone/status.md
/Users/jkneen/clawd/collaborator-clone/review-full-remediation.patch
/Users/jkneen/clawd/collaborator-clone/review-full-remediation-snapshot.tar.gz
```

The patch and snapshot were regenerated at 08:04 BST from the review base and
include all seven remediation commits. The patch is byte-identical to
`git diff --binary 4e51e4e0a8ce75af472accfe236202dac5cf899e`; SHA-256 values:

```text
patch:   296dc588652cf0109fe7409fe25d9e5d52fb58dbce7df565a9776fc5a11b67d7
archive: 56a33c6c90e76198077f0ba9d3008712db5fcba2332a86e6081b93b897f6b78c
```

The patch contains tracked-file changes;
the source snapshot contains the full isolated tree (excluding `node_modules`,
generated `dist`, `dist-electron`, `out`, and `.git`) so untracked implementation
and test files are also recoverable.

To apply the reviewed branch to main later, make a separate backup first and
explicitly cherry-pick the remediation commits; do not apply them automatically
during reboot.

## Tool/hook note

No Alexandria skill or hook was invoked for this remediation.

## Safe next action after reboot

Start in the review worktree, confirm `git status --short` is empty, and run the
expanded focused command above. If the product should land on main, review the
seven commits and cherry-pick them deliberately. Remaining red evidence is
environment-backed socket/Electron validation, not an uncommitted code handoff.
