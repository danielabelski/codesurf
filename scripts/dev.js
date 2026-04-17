/**
 * Cross-platform dev launcher.
 *
 * Reads CODESURF_MAX_OLD_SPACE_SIZE_MB from the environment (default 8192)
 * and forwards it as a V8 --max-old-space-size flag to the Electron main
 * process. The old bash syntax `${VAR:-8192}` only works on Unix; this
 * script works on Windows, macOS, and Linux.
 */

const { execSync } = require('child_process')

const maxOldSpace = process.env.CODESURF_MAX_OLD_SPACE_SIZE_MB || '8192'
const jsFlags = `--expose-gc --max-old-space-size=${maxOldSpace}`

execSync(`electron-vite dev -- --js-flags="${jsFlags}"`, {
  stdio: 'inherit',
  env: process.env,
})
