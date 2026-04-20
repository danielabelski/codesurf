/**
 * Skills IPC — handles .skill files (zip archives containing a top-level
 * `<skill-name>/SKILL.md` plus optional assets/references/scripts folders).
 *
 * Two entry points are exposed:
 *   - `skills:inspect`  → peek at a .skill without extracting so the renderer
 *                         can preview the skill name / description / file list
 *                         in a confirmation modal.
 *   - `skills:install`  → actually extract the .skill into the configured
 *                         Claude skills directory.
 *
 * Also tracks `.skill` files opened via macOS file-association / drag-to-dock
 * (forwarded from `open-file` + `second-instance` events in main/index.ts) and
 * forwards their paths to the focused renderer via `skill:file-opened` so the
 * frontend can surface the install modal automatically.
 */

import { app, BrowserWindow, ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import path from 'node:path'
import { spawn } from 'node:child_process'

// Default install location for Claude-format skills on macOS. Users can
// override this via the renderer by passing an explicit `targetDir` to
// `skills:install`. We keep the installed layout identical to what Claude
// itself writes so these skills are picked up by both apps.
export const DEFAULT_SKILLS_DIR = path.join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'skills',
)

// Queue of .skill paths opened before the renderer is ready. Drained when the
// first BrowserWindow reports `did-finish-load`.
const pendingSkillFiles: string[] = []
let rendererReady = false

export function queuePendingSkillFile(filePath: string): void {
  if (!filePath || !filePath.toLowerCase().endsWith('.skill')) return
  if (rendererReady) {
    broadcastSkillFile(filePath)
  } else {
    pendingSkillFiles.push(filePath)
  }
}

function broadcastSkillFile(filePath: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) {
    pendingSkillFiles.push(filePath)
    return
  }
  win.webContents.send('skill:file-opened', { path: filePath })
}

export function markRendererReadyAndFlushSkillQueue(): void {
  rendererReady = true
  while (pendingSkillFiles.length > 0) {
    const next = pendingSkillFiles.shift()
    if (next) broadcastSkillFile(next)
  }
}

// --- Zip helpers -----------------------------------------------------------

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

// macOS / Linux: `unzip -Z1 <file>` lists archive entries, one per line.
async function listZipEntries(zipPath: string): Promise<string[]> {
  const { stdout } = await runCmd('/usr/bin/unzip', ['-Z1', zipPath])
  return stdout.split('\n').map(l => l.trim()).filter(Boolean)
}

// Print a single archive member to stdout without touching disk.
async function readZipEntry(zipPath: string, entryName: string): Promise<string> {
  const { stdout } = await runCmd('/usr/bin/unzip', ['-p', zipPath, entryName])
  return stdout
}

// Strip an optional leading `<folder>/` from every entry so we can detect the
// canonical skill-folder name (matches the Claude convention of one top-level
// folder inside the .skill archive).
function inferTopFolder(entries: string[]): string | null {
  const tops = new Set<string>()
  for (const entry of entries) {
    const first = entry.split('/')[0]
    if (!first) continue
    tops.add(first)
  }
  if (tops.size !== 1) return null
  return Array.from(tops)[0] ?? null
}

interface SkillManifest {
  name: string
  description: string
  topFolder: string
  entryCount: number
  hasSkillMd: boolean
  preview: string
}

async function readSkillManifest(zipPath: string): Promise<SkillManifest> {
  const entries = await listZipEntries(zipPath)
  const topFolder = inferTopFolder(entries) ?? path.basename(zipPath, path.extname(zipPath))
  const skillEntry = entries.find(e => /(^|\/)skill\.md$/i.test(e))
  let name = topFolder
  let description = ''
  let preview = ''
  let hasSkillMd = false
  if (skillEntry) {
    hasSkillMd = true
    const content = await readZipEntry(zipPath, skillEntry)
    preview = content.slice(0, 4000)
    const nameMatch = content.match(/^---[\s\S]*?name:\s*(.+?)$/m)
    const descMatch = content.match(/^---[\s\S]*?description:\s*(.+?)$/m)
    if (nameMatch?.[1]) name = nameMatch[1].trim()
    if (descMatch?.[1]) description = descMatch[1].trim()
  }
  return { name, description, topFolder, entryCount: entries.length, hasSkillMd, preview }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

async function pathExists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true } catch { return false }
}

async function extractSkill(
  zipPath: string,
  targetDir: string,
  opts: { overwrite: boolean },
): Promise<{ installedPath: string; entries: string[] }> {
  await ensureDir(targetDir)
  const manifest = await readSkillManifest(zipPath)
  const installedPath = path.join(targetDir, manifest.topFolder)
  if (await pathExists(installedPath)) {
    if (!opts.overwrite) {
      throw new Error(`Skill already installed at ${installedPath}. Pass overwrite=true to replace.`)
    }
    await fs.rm(installedPath, { recursive: true, force: true })
  }
  // `-o` = overwrite without prompt; `-d` = target directory. The archive
  // already contains a `<folder>/` prefix so extracting into `targetDir`
  // yields `targetDir/<folder>/…`.
  await runCmd('/usr/bin/unzip', ['-o', '-qq', zipPath, '-d', targetDir])
  const entries = await listZipEntries(zipPath)
  return { installedPath, entries }
}

// --- IPC registration ------------------------------------------------------

export function registerSkillsIPC(): void {
  ipcMain.handle('skills:inspect', async (_evt, zipPath: string) => {
    if (typeof zipPath !== 'string' || !zipPath.toLowerCase().endsWith('.skill')) {
      throw new Error('skills:inspect requires a .skill file path')
    }
    const stat = await fs.stat(zipPath)
    if (!stat.isFile()) throw new Error(`${zipPath} is not a file`)
    const manifest = await readSkillManifest(zipPath)
    return { ...manifest, zipPath, sizeBytes: stat.size }
  })

  ipcMain.handle('skills:install', async (_evt, args: { zipPath: string; targetDir?: string; overwrite?: boolean }) => {
    const zipPath = args?.zipPath
    if (typeof zipPath !== 'string' || !zipPath.toLowerCase().endsWith('.skill')) {
      throw new Error('skills:install requires args.zipPath pointing at a .skill file')
    }
    const targetDir = typeof args?.targetDir === 'string' && args.targetDir.trim()
      ? args.targetDir.trim()
      : DEFAULT_SKILLS_DIR
    const { installedPath, entries } = await extractSkill(zipPath, targetDir, { overwrite: !!args?.overwrite })
    return { installedPath, entries, targetDir }
  })

  ipcMain.handle('skills:getDefaultTargetDir', () => DEFAULT_SKILLS_DIR)

  // Called once by the renderer when ChatTile/App mounts so any .skill queued
  // via `open-file` before the window existed gets flushed immediately.
  ipcMain.handle('skills:rendererReady', () => {
    markRendererReadyAndFlushSkillQueue()
    return true
  })

  // Ensure freshly-launched windows that auto-open a .skill don't miss the
  // broadcast if the renderer mounts fast enough to race the queue drain.
  app.on('browser-window-created', (_evt, win) => {
    win.webContents.once('did-finish-load', () => {
      markRendererReadyAndFlushSkillQueue()
    })
  })
}
