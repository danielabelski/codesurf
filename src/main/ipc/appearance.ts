import { BrowserWindow, ipcMain, nativeTheme } from 'electron'

function broadcastAppearanceToRenderers(): void {
  const payload = { shouldUseDark: nativeTheme.shouldUseDarkColors }
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send('appearance:updated', payload)
  }
}

export function registerAppearanceIPC(): void {
  // Native dark/light preference — drives "system" appearance in renderer
  nativeTheme.on('updated', broadcastAppearanceToRenderers)

  ipcMain.handle('appearance:shouldUseDark', () => nativeTheme.shouldUseDarkColors)
  ipcMain.handle('appearance:setThemeSource', (_, mode: string) => {
    if (mode === 'dark' || mode === 'light' || mode === 'system') {
      nativeTheme.themeSource = mode
    }
    broadcastAppearanceToRenderers()
    return true
  })
}
