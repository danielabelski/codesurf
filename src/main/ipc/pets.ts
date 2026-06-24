// Pets IPC — discover, install, select, and remove pet bundles.
//
// Bundle format matches codex-rs / grok-cli / hermes / cursorbuddy:
//   <pet-id>/pet.json + <pet-id>/spritesheet.webp
//
// Scan dirs (first hit wins):
//   1. ~/.codesurf/pets  (primary — installs go here)
//   2. ~/.codex/pets     (codex overlay)
//   3. ~/.hermes/pets    (hermes overlay)
//
// The renderer loads spritesheets via the contex-file:// protocol and animates
// using CSS background-position — no frame extraction needed in main.

import { ipcMain } from 'electron'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { extname, join, resolve } from 'path'
import { CONTEX_HOME } from '../paths'
import type {
  PetGalleryEntry,
  PetGalleryResponse,
  PetInstallResponse,
  PetListResponse,
  PetManifest,
  PetRemoveResponse,
} from '../../shared/pet-types'
import { broadcastToRenderer } from '../utils/broadcast'

// ── Scan dirs ───────────────────────────────────────────────────────────────────

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

function hermesHome(): string {
  return process.env.HERMES_HOME ?? join(homedir(), '.hermes')
}

function petsDirs(): string[] {
  return [
    join(CONTEX_HOME, 'pets'),
    join(codexHome(), 'pets'),
    join(hermesHome(), 'pets'),
  ]
}

const PRIMARY_PETS_DIR = join(CONTEX_HOME, 'pets')

// ── Manifest loading ───────────────────────────────────────────────────────────

interface RawManifest {
  id?: unknown
  displayName?: unknown
  description?: unknown
  spritesheetPath?: unknown
  category?: unknown
  sourceUrl?: unknown
}

function mimeFor(filePath: string): PetManifest['spritesheetMime'] {
  switch (extname(filePath).toLowerCase()) {
    case '.webp':
      return 'image/webp'
    case '.png':
      return 'image/png'
    default:
      return 'application/octet-stream'
  }
}

function loadBundleMetadata(
  bundleDir: string,
  installedDirs: Set<string>,
): PetManifest | null {
  const manifestPath = join(bundleDir, 'pet.json')
  if (!existsSync(manifestPath)) return null

  let raw: RawManifest
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as RawManifest
  } catch {
    return null
  }

  const required: Array<keyof RawManifest> = ['id', 'displayName', 'description', 'spritesheetPath']
  for (const key of required) {
    if (typeof raw[key] !== 'string' || (raw[key] as string).length === 0) {
      return null
    }
  }

  let spritesheetPath = resolve(bundleDir, raw.spritesheetPath as string)
  if (!existsSync(spritesheetPath)) {
    for (const fallback of ['spritesheet.webp', 'spritesheet.png']) {
      const candidate = join(bundleDir, fallback)
      if (existsSync(candidate)) {
        spritesheetPath = candidate
        break
      }
    }
  }
  if (!existsSync(spritesheetPath)) return null

  return {
    id: raw.id as string,
    displayName: raw.displayName as string,
    description: raw.description as string,
    spritesheetPath,
    bundleDir,
    spritesheetMime: mimeFor(spritesheetPath),
    installed: installedDirs.has(bundleDir),
    category: typeof raw.category === 'string' ? raw.category : undefined,
    sourceUrl: typeof raw.sourceUrl === 'string' ? raw.sourceUrl : undefined,
  }
}

function loadInstalledIds(): Set<string> {
  const installed = new Set<string>()
  if (!existsSync(PRIMARY_PETS_DIR)) return installed
  try {
    for (const entry of readdirSync(PRIMARY_PETS_DIR)) {
      if (entry.startsWith('.')) continue
      installed.add(join(PRIMARY_PETS_DIR, entry))
    }
  } catch {
    // ignore
  }
  return installed
}

/** Discover every valid pet across all scan dirs. */
function listPetManifests(): PetManifest[] {
  const out: PetManifest[] = []
  const seenIds = new Set<string>()
  const installedDirs = loadInstalledIds()

  for (const dir of petsDirs()) {
    if (!existsSync(dir)) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const bundleDir = join(dir, entry)
      const stat = statSync(bundleDir)
      if (!stat.isDirectory()) continue

      const meta = loadBundleMetadata(bundleDir, installedDirs)
      if (!meta) continue

      if (seenIds.has(meta.id)) {
        const suffixed = `${meta.id}__${entry.replace(/[^a-zA-Z0-9_-]/g, '-')}`
        out.push({
          ...meta,
          id: suffixed,
          displayName: `${meta.displayName} (${entry})`,
        })
        seenIds.add(suffixed)
        continue
      }

      seenIds.add(meta.id)
      out.push(meta)
    }
  }

  out.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return out
}

/** Load a specific pet by id. Honours scan order. */
function loadPetManifest(id: string): PetManifest | null {
  const installedDirs = loadInstalledIds()
  for (const dir of petsDirs()) {
    const candidate = join(dir, id)
    if (!existsSync(candidate)) continue
    const m = loadBundleMetadata(candidate, installedDirs)
    if (m && m.id === id) return m
  }
  return null
}

// ── Gallery fetch (petdex.dev) ─────────────────────────────────────────────────

const PETDEX_GALLERY_URL = 'https://petdex.dev/api/manifest.json'
const PETDEX_DOWNLOAD_BASE = 'https://petdex.dev/api/pets'

interface PetdexEntry {
  id: string
  displayName: string
  description: string
  category?: string
}

async function fetchGallery(): Promise<PetGalleryEntry[]> {
  try {
    const resp = await fetch(PETDEX_GALLERY_URL, { signal: AbortSignal.timeout(10000) })
    if (!resp.ok) return []
    const data = (await resp.json()) as PetdexEntry[] | { pets: PetdexEntry[] }
    const entries = Array.isArray(data) ? data : data.pets ?? []
    const installedIds = new Set(listPetManifests().map((p) => p.id))
    return entries.map((e) => ({
      id: e.id,
      displayName: e.displayName,
      description: e.description,
      category: e.category,
      installed: installedIds.has(e.id),
    }))
  } catch {
    return []
  }
}

async function downloadAndInstallPet(slug: string): Promise<PetInstallResponse> {
  try {
    // Download the bundle as a JSON manifest + spritesheet pair.
    const manifestResp = await fetch(`${PETDEX_DOWNLOAD_BASE}/${slug}/manifest.json`, {
      signal: AbortSignal.timeout(15000),
    })
    if (!manifestResp.ok) {
      return { ok: false, error: `Failed to fetch manifest (HTTP ${manifestResp.status})` }
    }
    const manifest = (await manifestResp.json()) as RawManifest

    // Validate manifest
    const required: Array<keyof RawManifest> = ['id', 'displayName', 'description', 'spritesheetPath']
    for (const key of required) {
      if (typeof manifest[key] !== 'string' || (manifest[key] as string).length === 0) {
        return { ok: false, error: `Invalid manifest: missing ${String(key)}` }
      }
    }

    // Create bundle dir
    const bundleDir = join(PRIMARY_PETS_DIR, slug as string)
    if (!existsSync(bundleDir)) {
      mkdirSync(bundleDir, { recursive: true })
    }

    // Download spritesheet
    const sheetResp = await fetch(`${PETDEX_DOWNLOAD_BASE}/${slug}/spritesheet.webp`, {
      signal: AbortSignal.timeout(60000),
    })
    if (!sheetResp.ok) {
      return { ok: false, error: `Failed to fetch spritesheet (HTTP ${sheetResp.status})` }
    }
    const sheetBuf = Buffer.from(await sheetResp.arrayBuffer())
    writeFileSync(join(bundleDir, 'spritesheet.webp'), sheetBuf)

    // Write manifest
    writeFileSync(
      join(bundleDir, 'pet.json'),
      JSON.stringify(
        {
          id: manifest.id,
          displayName: manifest.displayName,
          description: manifest.description,
          spritesheetPath: 'spritesheet.webp',
          ...(typeof manifest.category === 'string' ? { category: manifest.category } : {}),
          ...(typeof manifest.sourceUrl === 'string' ? { sourceUrl: manifest.sourceUrl } : {}),
        },
        null,
        2,
      ),
    )

    broadcastToRenderer('pets:gallery-changed', { slug })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

function removePet(slug: string): PetRemoveResponse {
  try {
    const bundleDir = join(PRIMARY_PETS_DIR, slug)
    if (!existsSync(bundleDir)) {
      return { ok: false, error: `Pet "${slug}" is not installed locally` }
    }
    // Safety: only remove if the dir contains a pet.json (prevents accidental
    // deletion of non-pet dirs that happen to share the slug name).
    if (!existsSync(join(bundleDir, 'pet.json'))) {
      return { ok: false, error: `"${slug}" is not a valid pet bundle` }
    }
    rmSync(bundleDir, { recursive: true, force: true })
    broadcastToRenderer('pets:gallery-changed', { slug })
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

// ── Thumbnail generation ────────────────────────────────────────────────────────

const THUMBS_DIR = join(CONTEX_HOME, 'pets', '.thumbs')

async function ensureThumbnail(manifest: PetManifest): Promise<string | null> {
  // Thumbnails are PNG extractions of the first frame (idle[0]) from the
  // spritesheet. They're displayed in the picker at small size.
  const thumbPath = join(THUMBS_DIR, `${manifest.id}.png`)

  if (existsSync(thumbPath)) {
    // Check freshness — re-extract if source changed
    const thumbStat = statSync(thumbPath)
    const srcStat = statSync(manifest.spritesheetPath)
    if (thumbStat.mtimeMs > srcStat.mtimeMs) {
      return thumbPath
    }
  }

  try {
    if (!existsSync(THUMBS_DIR)) {
      mkdirSync(THUMBS_DIR, { recursive: true })
    }
    const { default: sharp } = await import('sharp')
    const meta = await sharp(manifest.spritesheetPath).metadata()

    // Extract top-left cell (192×208) if canonical spritesheet; otherwise
    // resize the whole image to fit a cell-sized thumbnail.
    if (meta.width === 1536 && meta.height === 1872) {
      await sharp(manifest.spritesheetPath, { page: 0 })
        .extract({ left: 0, top: 0, width: 192, height: 208 })
        .png()
        .toFile(thumbPath)
    } else {
      await sharp(manifest.spritesheetPath, { page: 0 })
        .resize(192, 208, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toFile(thumbPath)
    }
    return thumbPath
  } catch {
    return null
  }
}

// ── IPC registration ────────────────────────────────────────────────────────────

export function registerPetsIPC(): void {
  ipcMain.handle('pets:list', (): PetListResponse => {
    return listPetManifests()
  })

  ipcMain.handle('pets:gallery', async (): Promise<PetGalleryResponse> => {
    return fetchGallery()
  })

  ipcMain.handle('pets:gallery-local', (): PetGalleryResponse => {
    // Offline gallery — just list installed pets as gallery entries
    return listPetManifests().map((p) => ({
      id: p.id,
      displayName: p.displayName,
      description: p.description,
      category: p.category,
      installed: p.installed,
    }))
  })

  ipcMain.handle('pets:install', async (_evt, slug: string): Promise<PetInstallResponse> => {
    if (typeof slug !== 'string' || slug.length === 0) {
      return { ok: false, error: 'Invalid slug' }
    }
    return downloadAndInstallPet(slug)
  })

  ipcMain.handle('pets:remove', (_evt, slug: string): PetRemoveResponse => {
    if (typeof slug !== 'string' || slug.length === 0) {
      return { ok: false, error: 'Invalid slug' }
    }
    return removePet(slug)
  })

  ipcMain.handle('pets:thumbnail', async (_evt, slug: string): Promise<string | null> => {
    if (typeof slug !== 'string') return null
    const manifest = loadPetManifest(slug)
    if (!manifest) return null
    return ensureThumbnail(manifest)
  })

  ipcMain.handle('pets:getManifest', (_evt, slug: string): PetManifest | null => {
    if (typeof slug !== 'string') return null
    return loadPetManifest(slug)
  })
}
