/**
 * IPC for the secrets store. Renderer can list / set / clear named secrets
 * (API keys for STT/TTS/spokify providers). Values flow renderer → main → disk.
 *
 * Renderer never reads decrypted secrets back. The boolean `hasSecret`
 * lookup is the only way to ask "is this provider configured?"
 */
import { ipcMain } from 'electron'
import { deleteSecret, hasSecret, listSecretNames, setSecret } from '../secrets'

export function registerSecretsIpc(): void {
  ipcMain.handle('secrets:set', (_event, args: { name: string; value: string }) => {
    try {
      const name = String(args?.name ?? '').trim()
      if (!name) return { ok: false, error: 'name required' }
      setSecret(name, String(args?.value ?? ''))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('secrets:delete', (_event, name: string) => {
    try {
      deleteSecret(String(name ?? ''))
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('secrets:list', () => {
    return { ok: true, names: listSecretNames() }
  })

  ipcMain.handle('secrets:has', (_event, name: string) => {
    return { ok: true, has: hasSecret(String(name ?? '')) }
  })
}
