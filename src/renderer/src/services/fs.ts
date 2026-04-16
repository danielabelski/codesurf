function api() {
  return window.electron.fs
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  ext: string
}

export function readDir(path: string): Promise<DirEntry[]> {
  return api().readDir(path)
}

export function readFile(path: string): Promise<string> {
  return api().readFile(path)
}

export function writeFile(path: string, content: string): Promise<void> {
  return api().writeFile(path, content)
}

export function createFile(path: string): Promise<void> {
  return api().createFile(path)
}

export function createDir(path: string): Promise<void> {
  return api().createDir(path)
}

export function deleteFile(path: string): Promise<void> {
  return api().deleteFile(path)
}

export function renameFile(oldPath: string, newPath: string): Promise<void> {
  return api().renameFile(oldPath, newPath)
}

export function watch(dirPath: string, callback: () => void): () => void {
  return api().watch(dirPath, callback)
}

export function revealInFinder(path: string): Promise<void> {
  return api().revealInFinder(path)
}

export function stat(path: string): Promise<unknown | null> {
  return api().stat(path)
}

export function isProbablyTextFile(path: string): Promise<boolean> {
  return api().isProbablyTextFile(path)
}

export function copyIntoDir(sourcePath: string, destDir: string): Promise<unknown> {
  return api().copyIntoDir(sourcePath, destDir)
}
