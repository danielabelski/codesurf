# CodeSurf multi-target architecture

CodeSurf runs on **three hosts** with **one React renderer** and **one shared daemon**.  
**Nothing is removed from Electron.** Web and Native are additive shells in the Agensis style.

## Surfaces

| Command | Shell | Backend | Capability |
| --- | --- | --- | --- |
| `npm run dev` | Electron | Electron main IPC + `codesurfd` | **Full** (terminals, extensions, node-pty, MCP…) |
| `npm run web:dev` | Browser (Vite `:5173`) | `web-host` `:4177` → `codesurfd` | Core (workspace, canvas, chat jobs, sessions, basic fs) |
| `npm run web:preview` / `build:web` | Installed PWA (Chrome app / Safari Dock) | same host stack | Installable standalone desktop web app |
| `npm run desktop:dev` | Vercel Native WebView | same as web | same as web + native dialogs / openUrl |

Production:

| Command | Output |
| --- | --- |
| `npm run build` | Electron main + preload + renderer → `dist-electron/` |
| `npm run build:web` | Renderer only → `dist/` (browser + Native package assets) |
| `npm run desktop:build` | `build:web` + Native package → `desktop/zig-out/package/` |
| `npm run dist:mac` (etc.) | Electron installers (unchanged) |

## Layout

```
src/renderer/          shared UI (Electron + web + Native)
src/main/              Electron only (full product)
src/preload/           Electron only
packages/codesurf-daemon/   shared codesurfd
scripts/web-host.mjs   fixed-port host API for non-Electron
scripts/web-dev.mjs    browser dev loop
scripts/desktop-dev.mjs    Native shell dev loop
desktop/               Native SDK thin shell (app.zon + Zig)
vite.web.config.ts     standalone renderer for web/Native
electron.vite.config.ts    Electron (unchanged)
```

## Data flow

```
┌──────────────┐     IPC      ┌─────────────┐
│  Electron UI │ ───────────► │ Electron    │──┐
└──────────────┘              │ main        │  │
                              └─────────────┘  │
┌──────────────┐   HTTP       ┌─────────────┐  │   ┌──────────┐
│ Browser UI   │ ───────────► │ web-host    │──┼──►│ codesurfd│
└──────────────┘              │ :4177       │  │   │ localhost│
┌──────────────┐   HTTP       └─────────────┘  │   └──────────┘
│ Native WebView│ ───────────►       ▲         │        │
└──────────────┘              Vite proxy /host │        ▼
                              and /d/*         │   ~/.codesurf/
```

- Browser never sees the daemon bearer token. `web-host` injects `Authorization` on `/d/*`.
- Canvas/settings for web live under the same `~/.codesurf/` trees Electron uses.
- Platform bridge (`src/renderer/src/platform`) installs `window.electron` only when preload did not.

## Capability matrix

| Feature | Electron | Web / Native |
| --- | --- | --- |
| Workspaces / projects | ✅ | ✅ (daemon) |
| Canvas load/save | ✅ | ✅ (web-host, same files) |
| Chat jobs / agents | ✅ | ✅ (daemon) |
| Sessions / checkpoints | ✅ | ✅ (daemon) |
| Settings | ✅ | ✅ (web-host) |
| Basic fs read/write | ✅ | ✅ (web-host, local only) |
| Terminals (node-pty) | ✅ | ❌ stub (use Electron) |
| Extensions / tiles | ✅ | ❌ stub |
| MCP HTTP tools | ✅ | partial (daemon paths) |
| Folder picker | native dialog | Native: `window.zero`; Web: OS dialog via `web-host` `/host/dialog/openFolder` (no `window.prompt`). Browser File System Access API is fallback for permission UX only. |

## PWA (Chrome desktop app + Safari)

Web builds include `vite-plugin-pwa`:

| Browser | Install path |
| --- | --- |
| Chrome / Edge (desktop) | Install icon in omnibox, or the in-app **Install CodeSurf** banner |
| Safari (macOS) | **File → Add to Dock** (or Share → Add to Dock) on the web origin |

```bash
npm run build:web
npm run web:host          # terminal 1 — daemon API
npm run web:preview       # terminal 2 — serves dist/ with SW
# open http://127.0.0.1:4173 and install
```

Dev SW (optional): `CODESURF_PWA_DEV=1 npm run web:dev`

Service worker **never** caches `/host/*` or `/d/*` (always network to local daemon).

## Prerequisites (Native)

- Zig `0.16+`
- `native` CLI (`npm i -g @native-sdk/cli`)
- [zero-native](https://github.com/vercel-labs/zero-native) checkout  
  Default discovery: `NATIVE_SDK_PATH` or `~/Documents/GitHub/native`

## Env vars

| Var | Default | Role |
| --- | --- | --- |
| `CODESURF_HOME` | `~/.codesurf` | State root |
| `CODESURF_WEB_HOST_PORT` | `4177` | web-host bind port |
| `CODESURF_WEB_HOST_URL` / `VITE_CODESURF_HOST` | `http://127.0.0.1:4177` | Renderer → host |
| `NATIVE_SDK_PATH` | auto-discovered | Zig Native SDK |

## What “nothing lost” means

1. **Electron remains the default full product.** All main/preload/IPC paths stay.
2. **Web and Native share one renderer build path** so UI work lands once.
3. **Daemon is the shared brain** for multi-host collaboration (TUI already used it).
4. **Gaps are explicit stubs**, not silent deletions — terminal/extension code still ships in Electron.

## Next increments (not required for foundation)

- PTY-over-WebSocket for web/Native terminals
- Broader fs sandbox policy on web-host
- Hosted remote backend (Agensis Fly-style) with auth
- Parity tests for each `window.electron` namespace
