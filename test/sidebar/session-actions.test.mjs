import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_ACTION_BUTTON_SIZE,
  SESSION_ACTION_ICON_SIZE,
  SESSION_ROW_EXTRA_WIDTH,
  getSessionArchiveActionLabel,
} from '../../src/renderer/src/components/sidebar/session-actions.ts'

test('conversation archive action uses human labels instead of delete wording', () => {
  assert.equal(getSessionArchiveActionLabel(false), 'Archive conversation')
  assert.equal(getSessionArchiveActionLabel(true), 'Unarchive conversation')
})

test('conversation archive action is not tiny', () => {
  assert.ok(SESSION_ACTION_BUTTON_SIZE >= 24)
  assert.ok(SESSION_ACTION_ICON_SIZE >= 14)
  assert.ok(SESSION_ROW_EXTRA_WIDTH >= 64)
})
