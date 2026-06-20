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
import { activatePowerExtension, type ExtensionScope } from './loader'
import { bus } from '../event-bus'
import { adapters, tryAdaptExtension } from './adapters'
import type { ExtensionManifest, ExtensionTileContrib, ExtensionChatSurfaceContrib, ExtensionMCPToolContrib, ExtensionContextMenuContrib, ExtensionCommandContrib, ExtensionFooterContrib, ExtensionPanelContrib, ExtensionSettingsSectionContrib, ExtensionLayoutPresetContrib } from '../../shared/types'
import { resolveExtensionEnabled } from './activation-policy'

/** A v2 contribution tagged with its owning plugin id. */
export type OwnedContribution<T> = T & { extId: string }

/** All v2 contributions aggregated across enabled plugins, grouped by surface kind. */
export interface AggregatedContributions {
  commands: OwnedContribution<ExtensionCommandContrib>[]
  footer: OwnedContribution<ExtensionFooterContrib>[]
  panels: OwnedContribution<ExtensionPanelContrib>[]
  settingsSections: OwnedContribution<ExtensionSettingsSectionContrib>[]
  layoutPresets: OwnedContribution<ExtensionLayoutPresetContrib>[]
}

// ── Persisted disabled-extension set ──────────────────────────────────────────

const DISABLED_EXTS_PATH = join(CONTEX_HOME, 'disabled-extensions.json')
/** Catalog extensions the user has explicitly enabled via the Gallery. Without
 *  this, a rescan would re-apply the catalog default-off and silently
 *  uninstall what the user just installed. */
const ENABLED_CATALOG_PATH = join(CONTEX_HOME, 'enabled-catalog-extensions.json')
/** Capability grants (P1): extId -> consented capability names (see loadGrantsMap). */
const GRANTS_PATH = join(CONTEX_HOME, 'plugin-capability-grants.json')

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

/**
 * Capability grants (P1). Maps extId -> the capability names the user consented
 * to at enable time. Authoritative + persisted so activation/the bridge gate
 * survive restarts. A plugin update that adds a capability is NOT auto-granted —
 * the new capability stays ungranted until the user re-enables (re-consents).
 */
async function loadGrantsMap(): Promise<Record<string, string[]>> {
  try {
    const raw = await fs.readFile(GRANTS_PATH, 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

async function saveGrantsMap(grants: Record<string, string[]>): Promise<void> {
  await fs.mkdir(CONTEX_HOME, { recursive: true })
  await fs.writeFile(GRANTS_PATH, JSON.stringify(grants, null, 2))
}

export interface LoadedExtension {
  manifest: ExtensionManifest
  deactivate?: () => void
}

const EXTENSIONS_DIRNAME = 'extensions'

function normalizeTileTypes(manifest: ExtensionManifest): void {
  if (manifest.contributes?.tiles) {
    for (const tile of manifest.contributes.tiles) {
      if (!tile.type.startsWith('ext:')) {
        tile.type = `ext:${tile.type}`
      }
    }
  }
}

function normalizeManifestUi(manifest: ExtensionManifest): void {
  manifest.ui = manifest.ui ?? {}
  if (!manifest.ui.mode) {
    manifest.ui.mode = manifest.tier === 'safe' ? 'native' : 'custom'
  }
  // ── v2 axis derivation (back-compat aliases; see docs/plugins/00-architecture.md) ──
  // execution and render are orthogonal; when omitted they derive from tier/ui.mode so
  // every existing (v1) manifest resolves to its exact current behaviour.
  if (!manifest.execution) {
    manifest.execution = manifest.tier === 'power' ? 'node' : 'iframe'
  }
  if (!manifest.render) {
    // v1 'native' was never implemented and actually rendered as an iframe — keep that.
    // Only v2 plugins opt into the real mcp-ui path via ui.mode:'native' or render:'mcp-ui'.
    manifest.render = manifest.manifestVersion === 2 && manifest.ui.mode === 'native'
      ? 'mcp-ui'
      : manifest.ui.mode === 'custom'
        ? 'iframe'
        : 'iframe'
  }
}

export class ExtensionRegistry {
  private extensions = new Map<string, LoadedExtension>()
  private extraMCPTools: Array<ExtensionMCPToolContrib & { extId: string; handler?: (args: Record<string, unknown>) => Promise<string> }> = []
  private activeWorkspacePath: string | null = null
  private disabledIds: Set<string> = new Set()
  private enabledCatalogIds: Set<string> = new Set()
  /** P1 capability grants: extId -> consented capability names. */
  private grants: Record<string, string[]> = {}
  private bundledDirs: string[]
  /** Catalog dirs: scanned for manifests but extensions default to DISABLED
   *  so their power-tier main scripts do not execute. They appear in the
   *  gallery as available-to-install entries. */
  private catalogDirs: string[]
  private rescanQueue: Promise<void> = Promise.resolve()

  constructor(opts?: { bundledDirs?: string[]; catalogDirs?: string[] }) {
    this.bundledDirs = (opts?.bundledDirs ?? []).filter(Boolean)
    this.catalogDirs = (opts?.catalogDirs ?? []).filter(Boolean)
  }

  async scan(): Promise<void> {
    this.disabledIds = await loadDisabledSet()
    this.enabledCatalogIds = await loadEnabledCatalogSet()
    this.grants = await loadGrantsMap()
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
    // A workspace's .contex/extensions dir is attacker-controllable (it ships
    // with any cloned repo). Mark the scan untrusted so power-tier extensions
    // there require explicit user enablement instead of auto-activating.
    await this.scanDir(wsDir, { untrustedScope: true })
  }

  async rescan(workspacePath?: string | null): Promise<void> {
    const run = async (): Promise<void> => {
      this.deactivateAll()
      this.extensions.clear()
      this.extraMCPTools = []
      this.activeWorkspacePath = workspacePath ?? null
      await this.scan()
      if (workspacePath) {
        await this.scanWorkspace(workspacePath)
      }
    }

    this.rescanQueue = this.rescanQueue.then(run, run)
    return this.rescanQueue
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
      await this.scanDirLight(join(targetWorkspacePath, '.contex', EXTENSIONS_DIRNAME), manifests, disabledIds, { untrustedScope: true })
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

  private async scanDir(dir: string, opts?: { defaultEnabled?: boolean; untrustedScope?: boolean }): Promise<void> {
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
    opts?: { defaultEnabled?: boolean; untrustedScope?: boolean },
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

  private async readManifestLight(extDir: string, disabledIds: Set<string>, opts?: { defaultEnabled?: boolean; untrustedScope?: boolean }): Promise<ExtensionManifest | null> {
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
      manifest._enabled = resolveExtensionEnabled({
        untrustedScope: opts?.untrustedScope,
        defaultEnabledOption: opts?.defaultEnabled,
        tier: manifest.tier,
        disabled: disabledIds.has(manifest.id),
        enabledCatalogIds: this.enabledCatalogIds,
        extensionId: manifest.id,
        manifestEnabled: manifest._enabled,
      })
      normalizeTileTypes(manifest)
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
        normalizeTileTypes(adapted)
        return adapted
      } catch {
        return null
      }
    }
  }

  private async loadExtension(extDir: string, opts?: { defaultEnabled?: boolean; untrustedScope?: boolean }): Promise<void> {
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
    // Power-tier extensions found in an untrusted scope (a workspace's
    // .contex/extensions dir) run Node in the main process, so they must be
    // explicitly enabled by the user before activation — never auto-run on
    // workspace open. They reuse the same persisted enabled set as catalog
    // entries.
    manifest._enabled = resolveExtensionEnabled({
      untrustedScope: opts?.untrustedScope,
      defaultEnabledOption: opts?.defaultEnabled,
      tier: manifest.tier,
      disabled: this.disabledIds.has(manifest.id),
      enabledCatalogIds: this.enabledCatalogIds,
      extensionId: manifest.id,
      manifestEnabled: manifest._enabled,
    })

    // Namespace tile types with ext: prefix
    normalizeTileTypes(manifest)

    // Skip catalog duplicates; installed/bundled copies win over gallery entries.
    if (this.extensions.has(manifest.id) && opts?.defaultEnabled === false) {
      return
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
      // Derive the scope for the audit log and defense-in-depth gate in loader.ts.
      const scope: ExtensionScope = opts?.untrustedScope
        ? 'workspace'
        : opts?.defaultEnabled === false
          ? 'catalog'
          : this.bundledDirs.some(d => resolve(extDir).startsWith(resolve(d)))
            ? 'bundled'
            : 'global'
      const ctx = new ExtensionContext(manifest, bus, this)
      const deactivate = await activatePowerExtension(manifest, ctx, scope, this)
      loaded.deactivate = deactivate ?? undefined
      // NOTE: MCP tools are registered directly into this.extraMCPTools during
      // activate() via ExtensionContext.mcp.registerTool -> registry.registerMCPTool.
      // Do NOT push ctx.getRegisteredTools() here as well — that would cause each
      // tool to appear twice in getMCPTools() output (double-registration bug).
    }

    this.extensions.set(manifest.id, loaded)
    console.log(`[Extensions] Loaded: ${manifest.name} v${manifest.version} (${manifest.tier})`)
  }

  /** Load an already-parsed manifest (used by adapters) */
  async loadFromManifest(manifest: ExtensionManifest, opts?: { defaultEnabled?: boolean; untrustedScope?: boolean }): Promise<void> {
    if (this.extensions.has(manifest.id)) return

    normalizeManifestUi(manifest)

    // Apply persisted disabled state (+ catalog / untrusted-power default-off)
    manifest._enabled = resolveExtensionEnabled({
      untrustedScope: opts?.untrustedScope,
      defaultEnabledOption: opts?.defaultEnabled,
      tier: manifest.tier,
      disabled: this.disabledIds.has(manifest.id),
      enabledCatalogIds: this.enabledCatalogIds,
      extensionId: manifest.id,
      manifestEnabled: manifest._enabled,
    })

    // Namespace tiles
    normalizeTileTypes(manifest)

    const loaded: LoadedExtension = { manifest }

    if (manifest.tier === 'power' && manifest.main && manifest._enabled && manifest._path) {
      const scope: ExtensionScope = opts?.untrustedScope
        ? 'workspace'
        : opts?.defaultEnabled === false
          ? 'catalog'
          : 'global'
      const ctx = new ExtensionContext(manifest, bus, this)
      const deactivate = await activatePowerExtension(manifest, ctx, scope, this)
      loaded.deactivate = deactivate ?? undefined
      // NOTE: tools are registered directly via registerMCPTool during activate();
      // do not push ctx.getRegisteredTools() here to avoid double-registration.
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

  /**
   * P1 capability gate for the iframe bridge (least privilege). A plugin that
   * declares NO capabilities is ungated (full SDK surface — no regression). A
   * plugin that declares capabilities only receives the namespaces matching its
   * GRANTED set (recorded at enable time); a plugin enabled before grants existed
   * is grandfathered to its declared set so it keeps working.
   */
  getCapabilityGate(id: string): { enforced: boolean; granted: string[] } {
    const manifest = this.extensions.get(id)?.manifest
    const declared = manifest?.capabilities
    if (!Array.isArray(declared) || declared.length === 0) {
      return { enforced: false, granted: [] }
    }
    const granted = this.grants[id] ?? declared.map(c => c.name)
    return { enforced: true, granted }
  }

  getTileTypes(): ExtensionTileContrib[] {
    const tiles: ExtensionTileContrib[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      if (ext.manifest.contributes?.tiles) {
        for (const tile of ext.manifest.contributes.tiles) {
          tiles.push({ ...tile, extId: ext.manifest.id, uiMode: ext.manifest.ui?.mode, render: ext.manifest.render })
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

  // ── v2 contribution aggregation (additive; surfaces opt into these) ─────────
  // Each getter collects a single contribution kind from every enabled plugin and
  // tags it with the owning plugin id. `getContributions()` returns them grouped so
  // the renderer can fetch everything in one IPC round-trip and fan out to <Slot>s.

  private collect<T>(pick: (m: ExtensionManifest) => T[] | undefined): OwnedContribution<T>[] {
    const out: OwnedContribution<T>[] = []
    for (const ext of this.extensions.values()) {
      if (!ext.manifest._enabled) continue
      for (const item of pick(ext.manifest) ?? []) {
        out.push({ ...item, extId: ext.manifest.id })
      }
    }
    return out
  }

  getCommands(): OwnedContribution<ExtensionCommandContrib>[] {
    return this.collect(m => m.contributes?.commands)
  }

  getFooterItems(): OwnedContribution<ExtensionFooterContrib>[] {
    return this.collect(m => m.contributes?.footer)
  }

  getPanels(): OwnedContribution<ExtensionPanelContrib>[] {
    return this.collect(m => m.contributes?.panels)
  }

  getSettingsSections(): OwnedContribution<ExtensionSettingsSectionContrib>[] {
    return this.collect(m => m.contributes?.settingsSections)
  }

  getLayoutPresets(): OwnedContribution<ExtensionLayoutPresetContrib>[] {
    return this.collect(m => m.contributes?.layoutPresets)
  }

  getContributions(): AggregatedContributions {
    return {
      commands: this.getCommands(),
      footer: this.getFooterItems(),
      panels: this.getPanels(),
      settingsSections: this.getSettingsSections(),
      layoutPresets: this.getLayoutPresets(),
    }
  }

  /** Read a contribution's entry file as HTML for the render:'mcp-ui' (or iframe)
   *  html feed. If the entry is an MCP-UI createUIResource JSON, extract its html
   *  text. Path-guarded to the extension root. */
  async getSurfaceHtml(extId: string, kind: string, surfaceId: string): Promise<string | null> {
    const ext = this.extensions.get(extId)
    if (!ext?.manifest._path || !ext.manifest._enabled) return null
    const c = ext.manifest.contributes
    let entry: string | undefined
    if (kind === 'footer') entry = c?.footer?.find(f => f.id === surfaceId)?.entry
    else if (kind === 'panel') entry = c?.panels?.find(p => p.id === surfaceId)?.entry
    else if (kind === 'tile') entry = c?.tiles?.find(t => t.type === surfaceId)?.entry
    else if (kind === 'chat') entry = c?.chatSurfaces?.find(s => s.id === surfaceId)?.entry
    if (!entry) return null
    const root = resolve(ext.manifest._path)
    const abs = resolve(root, ...entry.split(/[\\/]/).filter(Boolean))
    if (abs !== root && !abs.startsWith(root + '/')) return null // path-traversal guard
    try {
      const raw = await fs.readFile(abs, 'utf8')
      if (raw.trimStart().startsWith('{')) {
        try {
          const obj = JSON.parse(raw) as { resource?: { contents?: Array<{ text?: string }> }; contents?: Array<{ text?: string }> }
          const text = obj?.resource?.contents?.[0]?.text ?? obj?.contents?.[0]?.text
          if (typeof text === 'string') return text
        } catch { /* not mcp-ui resource json; serve raw */ }
      }
      return raw
    } catch {
      return null
    }
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

    return `contex-ext://${encodeURIComponent(extId)}/${entrySegments.join('/')}${query}`
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

    return `contex-ext://${encodeURIComponent(extId)}/${entrySegments.join('/')}${query}`
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
    // Persist explicit enablement for catalog entries AND any power-tier
    // extension. Workspace power extensions default to off (untrusted scope);
    // recording the opt-in here keeps them enabled across rescans.
    const persistEnabled = isCatalog || ext.manifest.tier === 'power'
    if (persistEnabled) {
      this.enabledCatalogIds.add(id)
    }
    // P1 consent: enabling a plugin that declares capabilities grants exactly
    // those, recorded authoritatively + persisted. The "Wants: <cap>" row in the
    // gallery is the consent surface; clicking Add/enable is the consent.
    const caps = ext.manifest.capabilities
    const persistGrants = Array.isArray(caps) && caps.length > 0
    if (persistGrants) {
      this.grants[id] = caps.map(c => c.name)
    }
    // Await disk writes so a subsequent ext:refresh rescan reads the latest
    // sets from disk (scan() reloads both sets from files).
    await Promise.allSettled([
      saveDisabledSet(this.disabledIds),
      persistEnabled ? saveEnabledCatalogSet(this.enabledCatalogIds) : Promise.resolve(),
      persistGrants ? saveGrantsMap(this.grants) : Promise.resolve(),
    ])
    // Power-tier extensions may not have been activated on first scan (catalog
    // or workspace default-off). Load the main script now that the user has
    // explicitly enabled it — this is the explicit user opt-in for untrusted scope.
    const m = ext.manifest
    if (m.tier === 'power' && m.main && !ext.deactivate && m._path) {
      // Determine scope for audit log.  isCatalogExtension is already computed
      // above; workspace extensions are not under any catalogDir but were loaded
      // with untrustedScope so their path is not under bundledDirs or the global dir.
      const scope: ExtensionScope = isCatalog
        ? 'catalog'
        : this.bundledDirs.some(d => m._path && resolve(m._path).startsWith(resolve(d)))
          ? 'bundled'
          : m._path && resolve(m._path).startsWith(resolve(join(CONTEX_HOME, EXTENSIONS_DIRNAME)))
            ? 'global'
            : 'workspace'
      console.warn(
        `[Security] User explicitly enabled power extension "${m.name}" (${m.id}) ` +
        `from scope "${scope}" — runs with full main-process privileges.`,
      )
      try {
        const ctx = new ExtensionContext(m, bus, this)
        const deactivate = await activatePowerExtension(m, ctx, scope, this)
        ext.deactivate = deactivate ?? undefined
        // NOTE: tools are registered directly via registerMCPTool during activate();
        // do not push ctx.getRegisteredTools() here to avoid double-registration.
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
    const persistEnabled = isCatalog || ext.manifest.tier === 'power'
    if (persistEnabled) {
      this.enabledCatalogIds.delete(id)
    }
    await Promise.allSettled([
      saveDisabledSet(this.disabledIds),
      persistEnabled ? saveEnabledCatalogSet(this.enabledCatalogIds) : Promise.resolve(),
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
