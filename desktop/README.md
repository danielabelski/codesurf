# CodeSurf desktop shell (Native SDK)

Thin native window around the **same Vite/React renderer** used by web mode.
Electron remains the full-capability product path — this shell does **not**
remove or replace Electron.

Pattern matches [agensis](https://github.com/) multi-target:

| Surface | Shell | Backend |
| --- | --- | --- |
| `npm run dev` | Electron | Electron main + `@codesurf/daemon` |
| `npm run web:dev` | Browser | `web-host` + `codesurfd` |
| `npm run desktop:dev` | Native WebView | `web-host` + `codesurfd` |

## Layout

| Path | Role |
| --- | --- |
| `app.zon` | App identity, window chrome, frontend dev URL, security |
| `src/main.zig` | WebView source + dialog/openUrl bridge policy |
| `src/runner.zig` | Platform host bootstrap (Native SDK scaffold) |
| `../dist` | Production UI assets (`npm run build:web`) |
| Native SDK | `NATIVE_SDK_PATH` or `../../../Documents/GitHub/native` |

## Prerequisites

- Zig `0.16+` on `PATH`
- `native` CLI (`npm i -g @native-sdk/cli`) for `zig build dev` / `package`
- [vercel-labs/zero-native](https://github.com/vercel-labs/zero-native) checkout
  (default: `~/Documents/GitHub/native`). Override with `NATIVE_SDK_PATH`.

## Dev

From the repo root (starts daemon + web-host if needed, then Vite + native shell):

```bash
npm run desktop:dev
```

Or from this directory once the host stack is already up:

```bash
zig build dev -Dnative-sdk-path="$NATIVE_SDK_PATH"
```

## Package

```bash
npm run desktop:build
```

Artifacts land in `desktop/zig-out/package/`.

## Bridge (replaces Electron IPC for this shell)

| Need | API |
| --- | --- |
| Folder / file picker | `window.zero.invoke('native-sdk.dialog.openFile', { allowDirectories: true })` |
| Native shell detect | `Boolean(window.zero)` |
| Host capability | `window.__CODESURF_PLATFORM__` (`electron` \| `native` \| `web`) |
| App API surface | `window.electron.*` installed by `src/renderer/src/platform` (daemon/web-host backed) |
| External links | `security.navigation.external_links = open_system_browser` |

Nothing in Electron main/preload is deleted or gated off. Full canvas/terminal
features remain on `npm run dev`.
