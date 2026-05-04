#!/usr/bin/env node
// Launcher shim. Source of truth: packages/codesurf-daemon/bin/codesurfd.mjs
// This file is preserved so package.json "bin" (codesurfd), electron-builder
// packaging, and any external scripts that target ./bin/codesurfd.mjs continue
// to work after the daemon was extracted to @codesurf/daemon.
import('../packages/codesurf-daemon/bin/codesurfd.mjs')
