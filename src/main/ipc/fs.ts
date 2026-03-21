import { app, ipcMain, shell, BrowserWindow } from 'electron'
import { promises as fs, watch as fsWatch, FSWatcher } from 'fs'
import path from 'node:path'
import { basename, extname, join, parse } from 'path'
import { homedir } from 'os'

const watchers = new Map<string, FSWatcher>()

// --- Security: path validation (SEC-03) ---
const SENSITIVE_DIRS = ['.ssh', '.gnupg', '.aws', '.config']

function validateFsPath(filePath: string): string {
  const resolved = path.resolve(resolveFsPath(filePath))
  const home = resolveHome()
  const contexConfig = path.join(home, '.contex')

  // Always allow ~/.contex/* paths (app config)
  if (resolved.startsWith(contexConfig + path.sep) || resolved === contexConfig) return resolved

  // Reject paths to sensitive directories
  for (const dir of SENSITIVE_DIRS) {
    const sensitive = path.join(home, dir)
    if (resolved.startsWith(sensitive + path.sep) || resolved === sensitive) {
      throw new Error(`Access denied: path "${filePath}" targets a sensitive directory (~/${dir})`)
    }
  }

  // Reject if resolved path still contains traversal (shouldn't after resolve, but defense-in-depth)
  if (resolved.includes(`${path.sep}..${path.sep}`) || resolved.endsWith(`${path.sep}..`)) {
    throw new Error(`Path "${filePath}" contains directory traversal`)
  }

  // Warn for paths outside the home directory
  if (!resolved.startsWith(home)) {
    console.warn(`[fs] Warning: path "${filePath}" resolves outside home directory: ${resolved}`)
  }

  return resolved
}

const resolveHome = (): string => app.getPath('home') || process.env.HOME || process.env.USERPROFILE || homedir()

function resolveFsPath(rawPath: string): string {
  const home = resolveHome()
  if (rawPath === '~') return home
  if (rawPath.startsWith('~/.contex/')) {
    return join(home, '.contex', rawPath.slice('~/.contex/'.length))
  }
  if (rawPath.startsWith('~\\.contex\\')) {
    return join(home, '.contex', rawPath.slice('~\\.contex\\'.length))
  }
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) return join(home, rawPath.slice(2))
  if (rawPath.startsWith('/.contex/')) return join(home, rawPath.slice(1))
  if (rawPath === '/.contex') return join(home, '.contex')
  return rawPath
}

export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
}

async function getUniqueCopyPath(destDir: string, sourcePath: string): Promise<string> {
  const resolvedDir = resolveFsPath(destDir)
  const parsed = parse(resolveFsPath(sourcePath))
  let attempt = 0

  while (true) {
    const suffix = attempt === 0 ? '' : ` ${attempt + 1}`
    const candidate = join(resolvedDir, `${parsed.name}${suffix}${parsed.ext}`)
    try {
      await fs.access(candidate)
      attempt += 1
    } catch {
      return candidate
    }
  }
}

export function registerFsIPC(): void {
  ipcMain.handle('fs:readDir', async (_, dirPath: string) => {
    try {
      const resolvedDirPath = validateFsPath(dirPath)
      const entries = await fs.readdir(resolvedDirPath, { withFileTypes: true })
      const result: FsEntry[] = entries.map(e => ({
        name: e.name,
        path: `${resolvedDirPath}/${e.name}`,
        isDir: e.isDirectory(),
        ext: e.isDirectory() ? '' : extname(e.name).toLowerCase()
      }))
      // Dirs first, then files, both alphabetical
      result.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return result
    } catch {
      return []
    }
  })

  ipcMain.handle('fs:readFile', async (_, filePath: string) => {
    return await fs.readFile(validateFsPath(filePath), 'utf8')
  })

  ipcMain.handle('fs:writeFile', async (_, filePath: string, content: string) => {
    await fs.writeFile(validateFsPath(filePath), content, 'utf8')
  })

  ipcMain.handle('fs:createFile', async (_, filePath: string) => {
    await fs.writeFile(validateFsPath(filePath), '', 'utf8')
  })

  ipcMain.handle('fs:createDir', async (_, dirPath: string) => {
    await fs.mkdir(validateFsPath(dirPath), { recursive: true })
  })

  ipcMain.handle('fs:delete', async (_, fspath: string) => {
    await fs.rm(validateFsPath(fspath), { recursive: true, force: true })
  })

  // Aliases used by renderer
  ipcMain.handle('fs:deleteFile', async (_, fspath: string) => {
    await fs.rm(validateFsPath(fspath), { recursive: true, force: true })
  })

  ipcMain.handle('fs:rename', async (_, oldPath: string, newPath: string) => {
    await fs.rename(validateFsPath(oldPath), validateFsPath(newPath))
  })

  ipcMain.handle('fs:renameFile', async (_, oldPath: string, newPath: string) => {
    await fs.rename(validateFsPath(oldPath), validateFsPath(newPath))
  })

  ipcMain.handle('fs:basename', async (_, filePath: string) => {
    return basename(filePath)
  })

  ipcMain.handle('fs:revealInFinder', async (_, filePath: string) => {
    shell.showItemInFolder(validateFsPath(filePath))
  })

  ipcMain.handle('fs:writeBrief', async (_, cardId: string, content: string) => {
    const { join } = await import('path')
    const briefDir = join(resolveHome(), '.contex', 'briefs')
    await fs.mkdir(briefDir, { recursive: true })
    const briefPath = join(briefDir, `${cardId}.md`)
    await fs.writeFile(briefPath, content, 'utf8')
    return briefPath
  })

  ipcMain.handle('fs:stat', async (_, filePath: string) => {
    const stats = await fs.stat(validateFsPath(filePath))
    return {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      isFile: stats.isFile(),
      isDir: stats.isDirectory(),
    }
  })

  ipcMain.handle('fs:copyIntoDir', async (_, sourcePath: string, destDir: string) => {
    const resolvedSource = validateFsPath(sourcePath)
    const resolvedDestDir = validateFsPath(destDir)
    await fs.mkdir(resolvedDestDir, { recursive: true })

    const sourceStats = await fs.stat(resolvedSource)
    if (!sourceStats.isFile()) throw new Error('Only files can be copied into a workspace')

    const directTarget = join(resolvedDestDir, basename(resolvedSource))
    const destPath = directTarget === resolvedSource ? resolvedSource : await getUniqueCopyPath(resolvedDestDir, resolvedSource)

    if (destPath !== resolvedSource) {
      await fs.copyFile(resolvedSource, destPath)
    }

    return { path: destPath }
  })

  ipcMain.handle('fs:watchStart', async (event, dirPath: string) => {
    const resolved = validateFsPath(dirPath)
    if (watchers.has(resolved)) return
    let debounce: ReturnType<typeof setTimeout> | null = null
    try {
      const watcher = fsWatch(resolved, { recursive: true }, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          if (event.sender.isDestroyed()) return
          const win = BrowserWindow.fromWebContents(event.sender)
          win?.webContents.send(`fs:watch:${dirPath}`)
        }, 200)
      })
      watchers.set(resolved, watcher)

      // Clean up watcher if the renderer process crashes or is destroyed
      event.sender.once('destroyed', () => {
        if (debounce) clearTimeout(debounce)
        watcher.close()
        watchers.delete(resolved)
      })
    } catch { /* ignore */ }
  })

  ipcMain.handle('fs:watchStop', async (_, dirPath: string) => {
    const resolved = validateFsPath(dirPath)
    const watcher = watchers.get(resolved)
    if (watcher) { watcher.close(); watchers.delete(resolved) }
  })
}
