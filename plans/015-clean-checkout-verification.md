# Plan 015: Make clean-checkout verification authoritative

> **Executor instructions**: Read this plan fully before editing. Work in the
> assigned isolated worktree. Keep production behavior unchanged. Do not merge
> or push.
>
> **Drift check**: `git diff --stat bc2d0a94..HEAD -- package.json .github/workflows/ci.yml .github/workflows/release-on-tag.yml packages/codesurf-daemon/test/codex-exec-args.test.mjs e2e/security.spec.ts`

## Status

- **Priority**: P1
- **Effort**: S-M
- **Risk**: LOW
- **Depends on**: none
- **Category**: testing, CI
- **Planned at**: commit `bc2d0a94`, 2026-07-30
- **Scoped implementation**: branch `advisor/epic-015-verification`, commit
  `573d5f3b7c79e61b99caf8d4831a1bbca65cd9ea`
- **Review result**: blocked. The commit correctly makes the package lanes
  explicit, repairs the duplicated daemon test, and makes MCP startup
  fail-closed, but a clean install then exposes missing build prerequisites,
  omitted native optional packages, and a terminal-gateway test process that
  retains PTY/TCP handles. Do not treat this plan as merge-ready until those
  three gate failures are resolved.

## Why this matters

The current local green path is not the clean-checkout gate:

- Root `npm test` invokes relay tests, while `test:all` invokes relay twice
  (`package.json:21-24`).
- CI runs `npm test` before installing relay's local Vitest dependency
  (`.github/workflows/ci.yml:31-44`).
- Root tests omit `packages/codesurf-daemon` and
  `packages/codesurf-terminal-gateway`.
- The daemon package suite currently cannot parse
  `test/codex-exec-args.test.mjs` because imports/tests were duplicated at
  lines 74 onward.
- The MCP auth E2E silently skips when the MCP port is missing
  (`e2e/security.spec.ts:11-28`), turning a startup regression green.
- The release workflow runs the same incomplete root test command after only a
  root install.

## Scope

In scope:

- Root test scripts in `package.json`
- `.github/workflows/ci.yml`
- `.github/workflows/release-on-tag.yml`
- Duplicate daemon test cleanup
- Fail-closed MCP E2E startup assertion
- A small verification script only if it removes duplicated workflow logic

Out of scope:

- Adding a formatter/linter
- Expanding product E2E scenarios
- Electrobun/native platform matrices
- Numeric coverage thresholds
- Paid provider calls

## Required design

Define scripts with one meaning each:

- `test:unit`: root Node test globs only
- `test:daemon-package`: `npm --prefix packages/codesurf-daemon test`
- `test:relay`: relay suite
- `test:terminal-gateway`: terminal gateway suite
- `test:packages`: the three package suites exactly once
- `test`: root unit tests plus package suites exactly once
- `test:all`: either an alias of `test` or `test` plus explicitly named extra
  gates; it must not repeat relay

Use `npm ci`, never `npm install`, for nested packages in CI/release. Install
each nested package with its committed lockfile before the test command that
needs it. Prefer a dedicated install step before any tests so order is obvious.

Remove the duplicate import/test block from the daemon test without changing
its intended assertions.

In E2E, assert that `mcp.getPort()` returns a positive number. Missing startup
state must fail with a diagnostic, not call `test.skip`.

## Test plan

- Run the root unit lane independently.
- Run each package lane independently.
- Run aggregate `npm test` and verify relay appears once.
- Temporarily execute from a clean worktree with nested `node_modules` absent
  after `npm ci` in each declared package.
- Run the MCP security spec and the complete E2E suite.
- Validate workflow YAML and check that CI and release use the same aggregate
  gate.

## Verification

```bash
npm run test:unit
npm run test:daemon-package
npm run test:relay
npm run test:terminal-gateway
npm test
npm run typecheck
npx playwright test --config e2e/playwright.config.ts e2e/security.spec.ts
git diff --check
```

## Done criteria

- [ ] A clean checkout installs every suite before invoking it
- [ ] Every maintained package suite is in the aggregate gate exactly once
- [ ] Daemon package tests parse and pass
- [ ] Missing MCP startup fails E2E
- [ ] CI and release run the authoritative aggregate gate
- [ ] No production source was changed

## STOP conditions

Stop and report if:

- A nested lockfile cannot be installed with `npm ci`; do not replace it
  silently with `npm install`.
- Terminal gateway tests require a privileged host service rather than their
  current local fixture.
- The aggregate root suite hangs when run alone after clean installation.
  Capture the active handles/processes and report rather than adding arbitrary
  sleeps.
