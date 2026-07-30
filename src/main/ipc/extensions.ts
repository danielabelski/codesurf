/**
 * IPC handlers for the extension system.
 * Exposes ext:* channels to the renderer.
 */

import { ipcMain, dialog, BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { join, isAbsolute } from 'path'

import { execFile, spawn } from 'child_process'
import { promisify } from 'util'
import type { ExtensionRegistry } from '../extensions/registry'
import { getBridgeScript } from '../extensions/bridge'
import { CODESURF_HOME } from '../paths'
import { readSettingsSync } from './workspace'
import { getPluginState, setPluginState, replacePluginState } from '../extensions/plugin-store'
import { assertValidExtensionId, resolveExtensionSettingsPath } from '../extensions/identity'
import { assertSafePathSegment, resolveInside } from '../security/pathSegments'
import { log } from '../utils/logger.ts'

const extLog = log.scope('Extensions')

const execFileAsync = promisify(execFile)
const EXTENSIONS_DIR = join(CODESURF_HOME, 'extensions')
const EXTENSION_SETTINGS_DIR = join(CODESURF_HOME, 'extension-settings')

/** Result of installing a packaged plugin (.vsix / .zip) into the plugins dir. */
interface InstallPluginResult {
  ok: boolean
  extId?: string
  name?: string
  error?: string
}

// ---------------------------------------------------------------------------
// Zip entry safety helpers
// ---------------------------------------------------------------------------

function runCmd(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr || stdout}`))
    })
  })
}

/**
 * Validate all archive entries before extraction.
 * Rejects:
 *   - entries with absolute paths
 *   - entries containing `..` segments
 *   - symlink entries (permissions starting with 'l' in zipinfo output)
 *
 * Uses `unzip -Z` (zipinfo mode) which lists permissions + filename per line.
 * The first character of the permissions field is:
 *   '-' regular file, 'd' directory, 'l' symlink.
 */
async function assertSafeZipEntries(archivePath: string): Promise<void> {
  const { stdout } = await runCmd('/usr/bin/unzip', ['-Z', archivePath])
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('Archive:') || trimmed.startsWith('Zip file size:')) continue
    // Only process lines that start with a Unix file-type character.
    if (!/^[-dls]/.test(trimmed)) continue
    if (trimmed.startsWith('l')) {
      // Last whitespace-separated token is the filename.
      const name = trimmed.split(/\s+/).pop() ?? ''
      throw new Error(`Archive entry is a symlink: ${name}`)
    }
    // Extract filename (last token).
    const name = trimmed.split(/\s+/).pop() ?? ''
    if (!name) continue
    if (isAbsolute(name)) {
      throw new Error(`Archive entry has absolute path: ${name}`)
    }
    const segments = name.split('/')
    for (const seg of segments) {
      if (seg === '..') {
        throw new Error(`Archive entry contains path traversal: ${name}`)
      }
    }
  }
}

/**
 * Parse and validate the plugin manifest from a directory.
 * Returns the manifest object. Throws if the manifest is missing, unparseable,
 * or lacks the required `id`, `name`, and `version` fields.
 */
async function readAndValidateManifest(dir: string): Promise<{ id: string; name: string; version: string }> {
  const manifestPath = join(dir, 'package.json')
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf8')
  } catch {
    throw new Error('Plugin archive is missing package.json manifest')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Plugin manifest (package.json) is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Plugin manifest must be a JSON object')
  }
  const manifest = parsed as Record<string, unknown>
  const id = assertValidExtensionId(manifest.id, `plugin manifest directory ${dir}`)
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
    throw new Error('Plugin manifest is missing required field: name')
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    throw new Error('Plugin manifest is missing required field: version')
  }
  return { id, name: manifest.name.trim(), version: manifest.version.trim() }
}

/**
 * Install a packaged plugin archive (.vsix or plain .zip) into ~/.codesurf/extensions
 * and rescan. vsix archives nest content under extension/; plain plugin zips put the
 * manifest at the root — both are handled. Shared by ext:install-vsix and the
 * marketplace's ext:install-from-file (file-picker) path.
 *
 * Security measures:
 *   1. Validate all archive entries for traversal/absolute/symlink before extraction.
 *   2. Extract into a scoped temp directory inside EXTENSIONS_DIR.
 *   3. Read and validate the manifest (must have id/name/version) BEFORE moving into place.
 *   4. Key the final install directory on the validated manifest `id`, not the archive filename.
 */
async function installPluginArchive(registry: ExtensionRegistry, archivePath: string): Promise<InstallPluginResult> {
  try {
    await fs.mkdir(EXTENSIONS_DIR, { recursive: true })

    // Step 1: validate all entries before touching the extensions directory.
    await assertSafeZipEntries(archivePath)

    // Step 2: extract into a scoped temp dir inside EXTENSIONS_DIR.
    // Using a fixed suffix makes it easy to clean up on failure.
    const tempName = `__tmp_install_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const tempDir = resolveInside(EXTENSIONS_DIR, tempName)
    await fs.mkdir(tempDir, { recursive: true })

    try {
      await execFileAsync('/usr/bin/unzip', ['-o', archivePath, '-d', tempDir])

      // vsix archives nest everything under extension/ — flatten it up a level.
      const extensionSubdir = join(tempDir, 'extension')
      const hasExtDir = await fs.stat(extensionSubdir).then(s => s.isDirectory()).catch(() => false)
      if (hasExtDir) {
        for (const item of await fs.readdir(extensionSubdir)) {
          // Validate each item name before renaming to avoid unexpected paths.
          assertSafePathSegment(item, 'extension entry name')
          await fs.rename(join(extensionSubdir, item), join(tempDir, item)).catch(() => {})
        }
        await fs.rm(extensionSubdir, { recursive: true, force: true }).catch(() => {})
      }
      // Strip vsix packaging junk.
      for (const junk of ['[Content_Types].xml', '_rels']) {
        await fs.rm(join(tempDir, junk), { recursive: true, force: true }).catch(() => {})
      }

      // Step 3: validate the manifest BEFORE moving into place.
      const manifest = await readAndValidateManifest(tempDir)

      // Step 4: key the final directory on the manifest id, not the archive filename.
      // assertSafePathSegment ensures the id cannot be used to escape EXTENSIONS_DIR.
      assertSafePathSegment(manifest.id, 'plugin id')
      const destDir = resolveInside(EXTENSIONS_DIR, manifest.id)

      // Remove any existing installation with this id (deterministic on collision).
      await fs.rm(destDir, { recursive: true, force: true }).catch(() => {})

      // Move the validated temp dir into its final location.
      await fs.rename(tempDir, destDir)

      await registry.rescan(registry.getActiveWorkspacePath())
      return { ok: true, extId: manifest.id, name: manifest.name }
    } catch (err) {
      // Clean up temp dir on any failure.
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  } catch (err) {
    console.error('[ext:install] Failed:', err)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function extensionSettingsPath(extId: string): string {
  return resolveExtensionSettingsPath(EXTENSION_SETTINGS_DIR, extId)
}

async function readExtensionSettings(registry: ExtensionRegistry, extId: string): Promise<Record<string, unknown>> {
  const settingsPath = extensionSettingsPath(extId)
  const ext = registry.get(extId)
  if (!ext) return {}

  const defaults: Record<string, unknown> = {}
  for (const s of ext.manifest.contributes?.settings ?? []) {
    defaults[s.key] = s.default
  }
  // v2 settingsSections control defaults
  for (const section of ext.manifest.contributes?.settingsSections ?? []) {
    for (const item of section.items) {
      if ('key' in item && item.key && 'default' in item && item.default !== undefined) {
        defaults[item.key] = item.default
      }
    }
  }

  try {
    const raw = await fs.readFile(settingsPath, 'utf8')
    return { ...defaults, ...(JSON.parse(raw) as Record<string, unknown>) }
  } catch {
    return defaults
  }
}

function requireRegisteredExtensionId(
  registry: ExtensionRegistry,
  extId: unknown,
  context: string,
): string {
  const validExtId = assertValidExtensionId(extId, context)
  if (!registry.get(validExtId)) {
    throw new Error(`Extension is not registered for ${context}`)
  }
  return validExtId
}

export function registerExtensionIPC(registry: ExtensionRegistry): void {
  let lastScannedWorkspacePath: string | null = null
  let hasScanned = false
  let inFlightLoad: { workspacePath: string | null; promise: Promise<void> } | null = null

  const ensureLoaded = async (workspacePath?: string | null, force = false): Promise<void> => {
    const settings = readSettingsSync()
    if (settings.extensionsDisabled) {
      lastScannedWorkspacePath = null
      hasScanned = false
      return
    }

    const targetWorkspacePath = workspacePath ?? registry.getActiveWorkspacePath() ?? null
    if (!force && hasScanned && lastScannedWorkspacePath === targetWorkspacePath) return

    if (!force && inFlightLoad && inFlightLoad.workspacePath === targetWorkspacePath) {
      await inFlightLoad.promise
      return
    }

    const loadPromise = registry.rescan(targetWorkspacePath)
      .then(() => {
        lastScannedWorkspacePath = targetWorkspacePath
        hasScanned = true
      })
      .finally(() => {
        if (inFlightLoad?.promise === loadPromise) inFlightLoad = null
      })

    inFlightLoad = { workspacePath: targetWorkspacePath, promise: loadPromise }
    await loadPromise
  }

  // List all loaded extensions
  ipcMain.handle('ext:list', async () => {
    await ensureLoaded()
    return registry.getAll().map(m => ({
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.author,
      tier: m.tier,
      ui: m.ui,
      enabled: m._enabled !== false,
      contributes: m.contributes,
      capabilities: m.capabilities ?? [],
      dirPath: m._path ?? null,
    }))
  })

  ipcMain.handle('ext:list-sidebar', async (_, workspacePath?: string | null) => {
    const settings = readSettingsSync()
    if (settings.extensionsDisabled) {
      return { entries: [], tiles: [] }
    }

    const manifests = await registry.scanLightweight(workspacePath)
    const extActions = registry.getExtensionActions()

    return {
      entries: manifests.map(m => ({
        id: m.id,
        name: m.name,
        icon: m.contributes?.tiles?.[0]?.icon ?? m.contributes?.chatSurfaces?.[0]?.icon ?? null,
        enabled: m._enabled !== false,
      })),
      tiles: manifests
        .filter(m => m._enabled !== false)
        .flatMap(m => (m.contributes?.tiles ?? []).map(tile => ({
          extId: m.id,
          type: tile.type,
          label: tile.label,
          icon: tile.icon,
          entry: tile.entry,
          defaultSize: tile.defaultSize ?? { w: 400, h: 300 },
          minSize: tile.minSize ?? { w: 200, h: 150 },
          uiMode: m.ui?.mode,
          actions: extActions.get(m.id),
        }))),
    }
  })

  // List contributed tile types (for renderer to add to context menu / addTile)
  ipcMain.handle('ext:list-tiles', async () => {
    await ensureLoaded()
    const extActions = registry.getExtensionActions()
    return registry.getTileTypes().map(t => {
      const actions = extActions.get(t.extId)
      return {
        extId: t.extId,
        type: t.type,
        label: t.label,
        icon: t.icon,
        defaultSize: t.defaultSize ?? { w: 400, h: 300 },
        minSize: t.minSize ?? { w: 200, h: 150 },
        uiMode: t.uiMode,
        actions,
      }
    })
  })

  // Get the custom protocol URL for a tile's entry HTML
  ipcMain.handle('ext:tile-entry', async (_, extId: string, tileType: string, tileId?: string) => {
    await ensureLoaded()
    const url = registry.getTileEntry(extId, tileType, tileId)
    return url
  })

  // List contributed chat-surface contributions for the composer `+` menu
  ipcMain.handle('ext:list-chat-surfaces', async () => {
    await ensureLoaded()
    return registry.getChatSurfaces().map(s => ({
      extId: s.extId,
      id: s.id,
      label: s.label,
      description: s.description,
      icon: s.icon,
      entry: s.entry,
      emits: s.emits ?? 'image',
      defaultHeight: s.defaultHeight ?? 260,
      minHeight: s.minHeight ?? 160,
      uiMode: s.uiMode,
    }))
  })

  // Resolve the custom-protocol URL for an active chat-surface instance
  ipcMain.handle('ext:chat-surface-entry', async (_, extId: string, surfaceId: string, instanceId?: string) => {
    await ensureLoaded()
    return registry.getChatSurfaceEntry(extId, surfaceId, instanceId)
  })

  // List v2 contributions (commands, footer, panels, settingsSections, layoutPresets)
  // aggregated across enabled plugins. One round-trip; the renderer fans out to <Slot>s.
  ipcMain.handle('ext:contributions', async (_, kind?: string) => {
    await ensureLoaded()
    const all = registry.getContributions()
    if (!kind) return all
    return (all as unknown as Record<string, unknown[]>)[kind] ?? []
  })

  // Get the bridge script to inject into extension iframes
  ipcMain.handle('ext:get-bridge-script', (_, tileId: string, extId: string) => {
    const validExtId = requireRegisteredExtensionId(registry, extId, 'bridge script request')
    return getBridgeScript(tileId, validExtId, registry.getCapabilityGate(validExtId))
  })

  // P1 capability gate for a plugin — the host RPC dispatcher (ExtensionTile)
  // rejects gated namespaces (chat/relay/canvas) the plugin wasn't granted.
  ipcMain.handle('ext:capability-gate', (_, extId: string) => {
    const validExtId = requireRegisteredExtensionId(registry, extId, 'capability gate request')
    return registry.getCapabilityGate(validExtId)
  })

  // Enable/disable an extension
  ipcMain.handle('ext:enable', async (_, extId: string) => {
    return registry.enable(extId)
  })

  ipcMain.handle('ext:disable', async (_, extId: string) => {
    return registry.disable(extId)
  })

  ipcMain.handle('ext:refresh', async (_, workspacePath?: string | null) => {
    if (readSettingsSync().extensionsDisabled) {
      extLog.info('Refresh skipped — extensions globally disabled')
      lastScannedWorkspacePath = null
      hasScanned = false
      return []
    }
    await ensureLoaded(workspacePath ?? registry.getActiveWorkspacePath(), true)
    return registry.getAll().map(m => ({
      id: m.id,
      name: m.name,
      version: m.version,
      description: m.description,
      author: m.author,
      tier: m.tier,
      ui: m.ui,
      enabled: m._enabled !== false,
      contributes: m.contributes,
    }))
  })


  // Extension settings (persisted in ~/.codesurf/extension-settings/{extId}.json)
  ipcMain.handle('ext:settings-get', async (_, extId: string) => {
    return readExtensionSettings(registry, extId)
  })

  ipcMain.handle('ext:settings-set', async (_, extId: string, settings: Record<string, unknown>) => {
    const settingsPath = extensionSettingsPath(extId)
    const ext = registry.get(extId)
    if (!ext) return false

    const allowedKeys = new Set((ext.manifest.contributes?.settings ?? []).map(setting => setting.key))
    // v2 settingsSections control keys are also persistable
    for (const section of ext.manifest.contributes?.settingsSections ?? []) {
      for (const item of section.items) {
        if ('key' in item && item.key) allowedKeys.add(item.key)
      }
    }
    const filtered = Object.fromEntries(
      Object.entries(settings ?? {}).filter(([key]) => allowedKeys.has(key)),
    )

    await fs.mkdir(EXTENSION_SETTINGS_DIR, { recursive: true, mode: 0o700 })
    await fs.chmod(EXTENSION_SETTINGS_DIR, 0o700).catch(() => {})
    await fs.writeFile(settingsPath, JSON.stringify(filtered, null, 2), { mode: 0o600 })
    await fs.chmod(settingsPath, 0o600).catch(() => {})
    return true
  })

  // Resolve a contribution's entry file to HTML (for render:'mcp-ui' / 'iframe' html feed).
  ipcMain.handle('ext:surface-html', async (_, extId: string, kind: string, surfaceId: string) => {
    await ensureLoaded()
    return registry.getSurfaceHtml(extId, kind, surfaceId)
  })

  // Plugin Store — durable reactive per-plugin state (~/.codesurf/plugin-state/{id}.json).
  // Changes broadcast on the bus channel plugin:<id>:state (see plugin-store.ts).
  ipcMain.handle('ext:store-get', async (_, extId: string) => {
    const validExtId = requireRegisteredExtensionId(registry, extId, 'plugin store read')
    return getPluginState(validExtId)
  })

  ipcMain.handle('ext:store-set', async (_, extId: string, patch: Record<string, unknown>) => {
    const validExtId = requireRegisteredExtensionId(registry, extId, 'plugin store write')
    return setPluginState(validExtId, patch ?? {})
  })

  ipcMain.handle('ext:store-replace', async (_, extId: string, value: Record<string, unknown>) => {
    const validExtId = requireRegisteredExtensionId(registry, extId, 'plugin store replace')
    return replacePluginState(validExtId, value ?? {})
  })

  // List context menu contributions
  ipcMain.handle('ext:context-menu-items', () => {
    return registry.getContextMenuItems()
  })

  // Install a .vsix file — extract and register as an extension
  ipcMain.handle('ext:install-vsix', async (_, vsixPath: string) => {
    const result = await installPluginArchive(registry, vsixPath)
    if (!result.ok) return result
    return {
      ...result,
      tiles: registry.getTileTypes().filter(t => t.extId === result.extId),
    }
  })

  // Marketplace: install a plugin the user picks from disk (.vsix / .zip). The
  // dialog runs in main so the renderer never passes an arbitrary path; installed
  // plugins land disabled-by-default and are capability-gated (see P1).
  ipcMain.handle('ext:install-from-file', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow() ?? undefined
    const picked = await dialog.showOpenDialog(win!, {
      title: 'Install plugin from file',
      properties: ['openFile'],
      filters: [{ name: 'Plugin package', extensions: ['vsix', 'zip'] }],
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, canceled: true }
    }
    return installPluginArchive(registry, picked.filePaths[0])
  })
}
