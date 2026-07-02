# CodeSurf Workspace — Generated Memory

Last updated: 2026-07-02

---

## Overview

CodeSurf (internal legacy name: contex) is an Electron desktop app — an infinite-canvas workspace where tiles (terminal, code editor, browser, kanban, chat, pets) live on a 2D canvas. AI agents connect via a local HTTP MCP 2.0 server. Current active branch: `main`.

---

## Durable Facts

### Repository state
- Current branch: `main`
- Latest commit: `518998b` — "Mark plans 007–011 merged in plans index"
- Only dirty file: `bun.lock` (modified, not committed)
- All eleven plans (001–011) are tracked in `plans/README.md`

### Plan status (as of 2026-07-02)
| Plan | Title | Status |
|------|-------|--------|
| 001–004 | Security/guard fixes (broker deactivate, manifest path traversal, workspace scope, channel validation) | DONE |
| 005 | Unit tests for isPowerActivationPermitted | **TODO** |
| 006 | Quick cleanups (tile-type normalisation, test glob, LiveKit creds) | **TODO** |
| 007–011 | Runtime fixes + security (Codex abort, PTY exit, Pets, MCP token scope, fs denylist) | DONE — all merged to main |

Plans 005 and 006 are the only remaining TODO items; both are independent and unblocked.

### Cron agents
| Cron | Outcome | Blocker |
|------|---------|---------|
| Tom Doerr tweet tracker | Blocked every run | X.com login wall — Chrome agent profile not authenticated |
| VibeClaw article generator | Draft at `/Users/jkneen/clawd/memory/vibeclaw-article-2026-07-01.md` | DGX unavailable for header image |
| OpenClaw MC Gateway heartbeat | Repeated connection refused on localhost:8000 | Unknown |

### Open threads
- **Plans 005 & 006** — only unexecuted plans; both unblocked
- **SEC-05** — MCP per-tile token guards are wired but dormant (callers never send tile tokens); fix is passing `tileId` into `buildContexHttpMcpServerEntry`
- **X.com / VibeClaw / MC Gateway** — three cron blockers requiring external action
- **bun.lock drift** — only uncommitted file on main; `package-lock.json` (electron 41.3) vs `bun.lock` (electron 41.7) disagree
- **Harness desktop UI** — daemon side complete and tested; desktop `useHarness` toggle not yet built; re-symlink `node_modules/@codesurf/daemon` after every `npm install`
- **gpt-5.5 model config** — Codex sessions use it; verify it's in `providers.ts` DEFAULT_MODELS
