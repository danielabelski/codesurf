import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SESSION_ACTION_BUTTON_SIZE,
  SESSION_ACTION_ICON_SIZE,
  SESSION_ROW_EXTRA_WIDTH,
  getSessionArchiveActionLabel,
} from '../../src/renderer/src/components/sidebar/session-actions.ts'

const ROOT_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('conversation archive action uses human labels instead of delete wording', () => {
  assert.equal(getSessionArchiveActionLabel(false), 'Archive conversation')
  assert.equal(getSessionArchiveActionLabel(true), 'Unarchive conversation')
})

test('conversation archive action is not tiny', () => {
  assert.ok(SESSION_ACTION_BUTTON_SIZE >= 24)
  assert.ok(SESSION_ACTION_ICON_SIZE >= 14)
  assert.ok(SESSION_ROW_EXTRA_WIDTH >= 64)
})

test('Sidebar declares archive mutation callback before menu actions that capture it', async () => {
  const sidebarPath = join(ROOT_DIR, 'src/renderer/src/components/Sidebar.tsx')
  const source = await readFile(sidebarPath, 'utf8')
  const archiveCallbackIndex = source.indexOf('const setSessionArchived = useCallback(')
  const menuCallbackIndex = source.indexOf('const sessionContextMenuItems = useCallback(')

  assert.ok(archiveCallbackIndex >= 0)
  assert.ok(menuCallbackIndex >= 0)
  assert.ok(archiveCallbackIndex < menuCallbackIndex)
})
