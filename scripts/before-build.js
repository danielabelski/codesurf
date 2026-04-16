/**
 * electron-builder beforeBuild hook.
 * Runs before native dependencies are rebuilt for the target platform.
 * Patches node-pty and cpu-features so they compile on Windows.
 *
 * MUST return true — a falsy return tells electron-builder to treat
 * node_modules as externally handled, which skips packing them entirely.
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

exports.default = async function (context) {
  console.log('[before-build] Patching native modules for', context.platform.name)

  // Apply node-pty Windows patches
  const patchScript = path.join(__dirname, 'patch-node-pty-win.js')
  if (fs.existsSync(patchScript)) {
    require(patchScript)
  }

  // Generate cpu-features buildcheck.gypi if missing
  const cpuFeaturesDir = path.join(__dirname, '..', 'node_modules', 'cpu-features')
  const buildcheckGypi = path.join(cpuFeaturesDir, 'buildcheck.gypi')
  if (fs.existsSync(cpuFeaturesDir) && !fs.existsSync(buildcheckGypi)) {
    try {
      const output = execSync('node buildcheck.js', { cwd: cpuFeaturesDir, encoding: 'utf8' })
      fs.writeFileSync(buildcheckGypi, output)
      console.log('[before-build] Generated cpu-features buildcheck.gypi')
    } catch (err) {
      // Provide a minimal fallback for Windows (cpu-features is a no-op on win32 x64)
      fs.writeFileSync(buildcheckGypi, JSON.stringify({
        conditions: [['OS!="win" and target_arch not in "ia32 x32 x64"', { defines: [], libraries: [], sources: [] }]]
      }, null, 2))
      console.log('[before-build] Created fallback buildcheck.gypi for Windows')
    }
  }

  return true
}
