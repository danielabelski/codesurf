/**
 * Extension registry — scans, validates, and manages contex extensions.
 *
 * Extensions live in:
 *   ~/.contex/extensions/       (global)
 *   {workspace}/.contex/extensions/  (per-workspace, loaded later)
 *
 * Each extension dir contains an extension.json manifest.
 */

import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import { CONTEX_HOME } from '../paths'
import { ExtensionContext } from './context'
import { loadPowerExtension } from './loader'
import { bus } from '../event-bus'
import { adapters, tryAdaptExtension } from './adapters'
import type { ExtensionManifest, ExtensionTileContrib, ExtensionChatSurfaceContrib, ExtensionMCPToolContrib, ExtensionContextMenuContrib } from '../../shared/types'

// ── Persisted disabled-extension set ──────────────────────────────────────────

const DISABLED_EXTS_PATH = join(CONTEX_HOME, 'disabled-extensions.json')
/** Catalog extensions the user has explicitly enabled via the Gallery. Without
 *  this, a rescan would re-apply the catalog default-off and silently
 *  uninstall what the user just installed. */
const ENABLED_CATALOG_PATH = join(CONTEX_HOME, 'enabled-catalog-extensions.json')

async function loadDisabledSet(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(DISABLED_EXTS_PATH, 'utf8')
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

async function saveDisabledSet(ids: Set<string>): Promise<void> {
  await fs.mkdir(CONTEX_HOME, { recursive: true })
  await fs.writeFile(DISABLED_EXTS_PATH, JSON.stringify([...ids], null, 2))
}

async function loadEnabledCatalogSet(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(ENABLED_CATALOG_PATH, 'utf8')
    const arr = JSON.parse(raw)
    return new Set(Array.isArray(arr) ? arr : [])
  } catch {
    return new Set()
  }
}

async function saveEnabledCatalogSet(ids: Set<string>): Promise<void> {
  await fs.mkdir(CONTEX_HOME, { recursive: true })
  await fs.writeFile(ENABLED_CATALOG_PATH, JSON.stringify([...ids], null, 2))
}

export interface LoadedExtension {
  manifest: ExtensionManifest
  deactivate?: () => void
}

const EXTENSIONS_DIRNAME = 'extensions'

function normalizeManifestUi(manifest: ExtensionManifest): void {
  manifest.ui = manifest.ui ?? {}
  if (!manifest.ui.mode) {
    manifest.ui.mode = manifest.tier === 'safe' ? 'native' : 'custom'
  }
}

export class ExtensionRegistry {
  private extensions = new Map<string, LoadedExtension>()
  private extraMCPTools: Array<ExtensionMCPToolContrib & { extId: string; handler?: (args: Record<string, unknown>) => Promise<string> }> = []
  private activeWorkspacePath: string | null = null
  private disabledIds: Set<string> = new Set()
  private enabledCatalogIds: Set<string> = new Set()
  private bundledDirs: string[]
  /** Catalog dirs: scanned for manifests but extensions default to DISABLED
   *  so their power-tier main scripts do not execute. They appear in the
   *  gallery as available-to-install entries. */
  private catalogDirs: string[]

  constructor(opts?: { bundledDirs?: string[]; catalogDirs?: string[] }) {
    this.bundledDirs = (opts?.bundledDirs ?? []).filter(Boolean)
    this.catalogDirs = (opts?.catalogDirs ?? []).filter(Boolean)
  }

  async scan(): Promise<void> {
    this.disabledIds = await loadDisabledSet()
    this.enabledCatalogIds = await loadEnabledCatalogSet()
    for (const bundledDir of this.bundledDirs) {
      await this.scanDir(bundledDir)
    }
    const globalDir = join(CONTEX_HOME, EXTENSIONS_DIRNAME)
    await this.scanDir(globalDir)
    // Catalog dirs load last — any id already loaded from bundled/global wins,
    // so shipped bundled extensions override the catalog copies.
    for (const catalogDir of this.catalogDirs) {
      await this.scanDir(catalogDir, { defaultEnabled: false })
    }
  }

  async scanWorkspace(workspacePath: string): Promise<void> {
    const wsDir = join(workspacePath, '.contex', EXTENSIONS_DIRNAME)
    await this.scanDir(wsDir)
  }

  async rescan(workspacePath?: string | null): Promise<void> {
    this.deactivateAll()
    this.extensions.clear()
    this.extraMCPTools = []
    this.activeWorkspacePath = workspacePath ?? null
    await this.scan()
    if (workspacePath) {
      await this.scanWorkspace(workspacePath)
    }
  }

  async scanLightweight(workspacePath?: string | null): Promise<ExtensionManifest[]> {
    const disabledIds = await loadDisabledSet()
    const manifests = new Map<string, ExtensionManifest>()
    const targetWorkspacePath = workspacePath ?? this.activeWorkspacePath

    for (const bundledDir of this.bundledDirs) {
      await this.scanDirLight(bundledDir, manifests, disabledIds)
    }
    await this.scanDirLight(join(CONTEX_HOME, EXTENSIONS_DIRNAME), manifests, disabledIds)
    if (targetWorkspacePath) {
      await this.scanDirLight(join(targetWorkspacePath, '.contex', EXTENSIONS_DIRNAME), manifests, disabledIds)
    }
    // Catalog dirs — scanned last, default-disabled unless the user has
    // explicitly enabled the id (reflected in disabledIds set membership).
    for (const catalogDir of this.catalogDirs) {
      await this.scanDirLight(catalogDir, manifests, disabledIds, { defaultEnabled: false })
    }

    return [...manifests.values()]
  }

  getActiveWorkspacePath(): string | null {
    return this.activeWorkspacePath
  }

  private async scanDir(dir: string, opts?: { defaultEnabled?: boolean }): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return // dir doesn't exist yet — that's fine
    }

    for (const name of entries) {
      if (name.startsWith('.')) continue
      const extDir = join(dir, name)
      const stat = await fs.stat(extDir).catch(() => null)
      if (!stat?.isDirectory()) continue

      try {
        await this.loadExtension(extDir, opts)
      } catch {
        // Not a native contex extension — try adapters
        try {
          const adapted = await tryAdaptExtension(extDir)
          if (adapted) {
            await this.loadFromManifest(adapted, opts)
          }
        } catch (err) {
          console.error(`[Extensions] Failed to load ${extDir}:`, err)
        }
      }
    }
  }

  private async scanDirLight(
    dir: string,
    manifests: Map<string, ExtensionManifest>,
    disabledIds: Set<string>,
    opts?: { defaultEnabled?: boolean },
  ): Promise<void> {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return
    }

    for (const name of entries) {
      if (name.startsWith('.')) continue
      const extDir = join(dir, name)
      const stat = await fs.stat(extDir).catch(() => null)
      if (!stat?.isDirectory()) continue

      const manifest = await this.readManifestLight(extDir, disabledIds, opts)
      if (!manifest) continue
      // Catalog scans run last — do not overwrite an id that was already
      // loaded from bundled or global, so bundled copies win.
      if (manifests.has(manifest.id)) continue
      manifests.set(manifest.id, manifest)
    }
  }

  private async readManifestLight(extDir: string, disabledIds: Set<string>, opts?: { defaultEnabled?: boolean }): Promise<ExtensionManifest | null> {
    try {
      const raw = await fs.readFile(join(extDir, 'extension.json'), 'utf8')
      const manifest: ExtensionManifest = JSON.parse(raw)
      if (!manifest.id || !manifest.name || !manifest.version) {
        return null
      }
      if (!manifest.tier) manifest.tier = 'safe'
      normalizeManifestUi(manifest)
      manifest._path = resolve(extDir)
      // Catalog entries default to disabled unless the user has explicitly
      // flipped them (persisted disabledIds treats presence==disabled; absence
      // normally means enabled — for catalog we invert that default).
      const defaultEnabled = opts?.defaultEnabled !== false
      manifest._enabled = disabledIds.has(manifest.id)
        ? false
        : (defaultEnabled ? (manifest._enabled !== false) : false)
      if (manifest.contributes?.tiles) {
        for (const tile of manifest.contributes.tiles) {
          if (!tile.type.startsWith('ext:')) {
            tile.type = `ext:${tile.type}`
          }
        }
      }
      return manifest
    } catch {
      try {
        let adapted: ExtensionManifest | null = null
        for (const adapter of adapters) {
          if (await adapter.canLoad(extDir)) {
            adapted = await adapter.toManifest(extDir)
            break
          }
        }
        if (!adapted) return null
        normalizeManifestUi(adapted)
        adapted._path = resolve(extDir)
        const defaultEnabledAdapted = opts?.defaultEnabled !== false
        adapted._enabled = disabledIds.has(adapted.id)
          ? false
          : (defaultEnabledAdapted ? (adapted._enabled !== false) : false)
        if (adapted.contributes?.tiles) {
          for (const tile of adapted.contributes.tiles) {
            if (!tile.type.startsWith('ext:')) {
              tile.type = `ext:${tile.type}`
            }
          }
        }
        return adapted
      } catch {
        return null
      }
    }
  }

  private async loadExtension(extDir: string, opts?: { defaultEnabled?: boolean }): Promise<void> {
    const manifestPath = join(extDir, 'extension.json')
    const raw = await fs.readFile(manifestPath, 'utf8')
    const manifest: ExtensionManifest = JSON.parse(raw)

    // Validate required fields
    if (!manifest.id || !manifest.name || !manifest.version) {
      throw new Error(`Invalid manifest in ${extDir}: missing id, name, or version`)
    }
    if (!manifest.tier) manifest.tier = 'safe'
    normalizeManifestUi(manifest)

    // Attach runtime metadata. Catalog entries default to disabled unless the
    // user has explicitly enabled them via the gallery (tracked in the
    // enabledCatalogIds set, which is persisted).
    manifest._path = resolve(extDir)
    const defaultEnabled = opts?.defaultEnabled !== false
    const catalogUserEnabled = !defaultEnabled && this.enabledCatalogIds.has(manifest.id)
    manifest._enabled = this.disabledIds.has(manifest.id)
      ? false
      : (defaultEnabled
          ? (manifest._enabled !== false)
          : catalogUserEnabled)

    // Namespace tile types with ext: prefix
    if (manifest.contributes?.tiles) {
      for (const tile of manifest.contributes.tiles) {
        if (!tile.type.startsWith('ext:')) {
          tile.type = `ext:${tile.type}`
        }
      }
    }

    // Skip if already loaded (workspace overrides global)
    if (this.extensions.has(manifest.id)) {
      const existing = this.extensions.get(manifest.id)!
      // Workspace extensions override global — deactivate old one
      if (existing.deactivate) existing.deactivate()
      this.extensions.delete(manifest.id)
    }

    const loaded: LoadedExtension = { manifest }

    // Load power tier extensions
    if (manifest.tier === 'power' && manifest.main && manifest._enabled) {
      const ctx = new ExtensionContext(manifest, bus, this)
      const deactivate = await loadPowerExtension(manifest, ctx)
      loaded.deactivate = deactivate ?? undefined

      // Collect MCP tools registered by the extension
      for (const tool of ctx.getRegisteredTools()) {
        this.extraMCPTools.push({ ...tool, extId: manifest.id })
      }
    }

    this.extensions.set(manifest.id, loaded)
    console.log(`[Extensions] Loaded: ${manifest.name} v${manifest.version} (${manifest.tier})`)
  }

  /** Load an already-parsed manifest (used by adapters) */
  async loadFromManifest(manifest: ExtensionManifest, opts?: { defaultEnabled?: boolean }): Promise<void> {
    if (this.extensions.has(manifest.id)) return

    normalizeManifestUi(manifest)

    // Apply persisted disabled state (+ catalog default-off)
    const defaultEnabled = opts?.defaultEnabled !== false
    if (this.disabledIds.has(manifest.id)) manifest._enabled = false
    else if (!defaultEnabled) manifest._enabled = false

    // Namespace tiles
    if (manifest.contributes?.tiles) {
      for (const tile of manifest.contributes.tiles) {
        if (!tile.type.startsWith('ext:')) {
          tile.type = `ext:${tile.type}`
        }
      }
    }

    const loaded: LoadedExtension = { manifest }

    if (manifest.tier === 'power' && manifest.main && manifest._enabled && manifest._path) {
      const ctx = new ExtensionContext(manifest, bus, this)
      const deactivate = await loadPowerExtension(manifest, ctx)
      loaded.deactivate = deactivate ?? undefined
      for (const tool of ctx.getRegisteredTools()) {
        this.extraMCPTools.push({ ...tool, extId: manifest.id })
      }
    }

    this.extensions.set(manifest.id, loaded)
    console.log(`[Extensions] Loaded (adapted): ${manifest.name} v${manifest.version}`)
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getAll(): ExtensionManifest[] {
    return [...this.extensions.values()].map(e => e.manifest)
  }

  get(id: string): LoadedExtension | undefined {
    return this.extensions.get(id)
  }

  getTileTypes(): ExtensionTileContrib[] {
    const tiles: ExtensionTileContrib[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.tiles) {
        for (const tile of ext.manifest.contributes.tiles) {
          tiles.push({ ...tile, extId: ext.manifest.id, uiMode: ext.manifest.ui?.mode })
        }
      }
    }
    return tiles
  }

  getChatSurfaces(): ExtensionChatSurfaceContrib[] {
    const surfaces: ExtensionChatSurfaceContrib[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.chatSurfaces) {
        for (const surface of ext.manifest.contributes.chatSurfaces) {
          surfaces.push({ ...surface, extId: ext.manifest.id, uiMode: ext.manifest.ui?.mode })
        }
      }
    }
    return surfaces
  }

  getExtensionActions(): Map<string, Array<{ name: string; description: string }>> {
    const result = new Map<string, Array<{ name: string; description: string }>>()
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      const contributes = ext.manifest.contributes as any
      const actions = contributes?.actions
      if (Array.isArray(actions) && actions.length > 0) {
        result.set(ext.manifest.id, actions.map((a: any) => ({ name: String(a.name ?? ''), description: String(a.description ?? '') })))
      }
    }
    return result
  }

  getMCPTools(): Array<ExtensionMCPToolContrib & { extId: string; handler?: (args: Record<string, unknown>) => Promise<string> }> {
    const tools: typeof this.extraMCPTools = []
    // Declarative tools from manifests
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.mcpTools) {
        for (const tool of ext.manifest.contributes.mcpTools) {
          tools.push({ ...tool, extId: ext.manifest.id })
        }
      }
    }
    // Programmatic tools from power tier activate()
    tools.push(...this.extraMCPTools)
    return tools
  }

  getContextMenuItems(): ExtensionContextMenuContrib[] {
    const items: ExtensionContextMenuContrib[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.contextMenu) {
        for (const item of ext.manifest.contributes.contextMenu) {
          items.push({ ...item, extId: ext.manifest.id })
        }
      }
    }
    return items
  }

  getTileEntry(extId: string, tileType: string, tileId?: string): string | null {
    const ext = this.extensions.get(extId)
    if (!ext?.manifest._path || !ext.manifest._enabled) return null
    const tile = ext.manifest.contributes?.tiles?.find(t => t.type === tileType)
    if (!tile) return null

    const entrySegments = tile.entry
      .split(/[\\/]/)
      .filter(Boolean)
      .map(segment => encodeURIComponent(segment))
    const query = tileId ? `?tileId=${encodeURIComponent(tileId)}&_t=${Date.now()}` : ''

    return `contex-ext://extension/${encodeURIComponent(extId)}/${entrySegments.join('/')}${query}`
  }

  getChatSurfaceEntry(extId: string, surfaceId: string, instanceId?: string): string | null {
    const ext = this.extensions.get(extId)
    if (!ext?.manifest._path || !ext.manifest._enabled) return null
    const surface = ext.manifest.contributes?.chatSurfaces?.find(s => s.id === surfaceId)
    if (!surface) return null

    const entrySegments = surface.entry
      .split(/[\\/]/)
      .filter(Boolean)
      .map(segment => encodeURIComponent(segment))
    const params: string[] = []
    if (instanceId) params.push(`surfaceId=${encodeURIComponent(instanceId)}`)
    params.push(`surfaceKind=chat`)
    params.push(`_t=${Date.now()}`)
    const query = `?${params.join('&')}`

    return `contex-ext://extension/${encodeURIComponent(extId)}/${entrySegments.join('/')}${query}`
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Is this extension's path under one of the registered catalog dirs? */
  private isCatalogExtension(manifest: ExtensionManifest): boolean {
    if (!manifest._path) return false
    const p = resolve(manifest._path)
    return this.catalogDirs.some(dir => {
      const root = resolve(dir)
      return p === root || p.startsWith(root + '/') || p.startsWith(root + '\\')
    })
  }

  async enable(id: string): Promise<boolean> {
    const ext = this.extensions.get(id)
    if (!ext) return false
    ext.manifest._enabled = true
    this.disabledIds.delete(id)
    // If this was installed from a catalog dir, persist that the user has
    // explicitly enabled it so future rescans do not revert the default-off.
    const isCatalog = this.isCatalogExtension(ext.manifest)
    if (isCatalog) {
      this.enabledCatalogIds.add(id)
    }
    // Await disk writes so a subsequent ext:refresh rescan reads the latest
    // sets from disk (scan() reloads both sets from files).
    await Promise.allSettled([
      saveDisabledSet(this.disabledIds),
      isCatalog ? saveEnabledCatalogSet(this.enabledCatalogIds) : Promise.resolve(),
    ])
    // Power-tier extensions may not have been activated on first scan (catalog
    // default-off). Load the main script now that it's enabled.
    const m = ext.manifest
    if (m.tier === 'power' && m.main && !ext.deactivate && m._path) {
      try {
        const ctx = new ExtensionContext(m, bus, this)
        const deactivate = await loadPowerExtension(m, ctx)
        ext.deactivate = deactivate ?? undefined
        for (const tool of ctx.getRegisteredTools()) {
          this.extraMCPTools.push({ ...tool, extId: m.id })
        }
      } catch (err) {
        console.error(`[Extensions] enable() failed to load power ext ${m.id}:`, err)
      }
    }
    return true
  }

  async disable(id: string): Promise<boolean> {
    const ext = this.extensions.get(id)
    if (!ext) return false
    ext.manifest._enabled = false
    this.disabledIds.add(id)
    const isCatalog = this.isCatalogExtension(ext.manifest)
    if (isCatalog) {
      this.enabledCatalogIds.delete(id)
    }
    await Promise.allSettled([
      saveDisabledSet(this.disabledIds),
      isCatalog ? saveEnabledCatalogSet(this.enabledCatalogIds) : Promise.resolve(),
    ])
    if (ext.deactivate) {
      ext.deactivate()
      ext.deactivate = undefined
    }
    // Drop any MCP tools the extension programmatically registered.
    this.extraMCPTools = this.extraMCPTools.filter(t => t.extId !== id)
    return true
  }

  deactivateAll(): void {
    for (const ext of this.extensions.values()) {
      if (ext.deactivate) ext.deactivate()
    }
  }

  /** Register a programmatic MCP tool (called from ExtensionContext) */
  registerMCPTool(extId: string, tool: ExtensionMCPToolContrib & { handler?: (args: Record<string, unknown>) => Promise<string> }): void {
    this.extraMCPTools.push({ ...tool, extId })
  }
}
