import { describe, expect, test } from 'bun:test'
import { isExternalSessionImportableInChat } from '../src/main/session-sources'
import { getSessionOpenIntent } from '../src/renderer/src/components/sidebar/session-open'

describe('external session chat openability', () => {
  test('treats hook-only/title-only external sessions as not chat-loadable', () => {
    expect(isExternalSessionImportableInChat(0, null)).toBe(false)
    expect(isExternalSessionImportableInChat(0, '')).toBe(false)
    expect(isExternalSessionImportableInChat(0, '   ')).toBe(false)

    expect(isExternalSessionImportableInChat(1, null)).toBe(true)
    expect(isExternalSessionImportableInChat(0, 'A real parsed transcript preview')).toBe(true)
  })

  test('sidebar does not route non-chat sessions into a blank chat tile', () => {
    expect(getSessionOpenIntent({ canOpenInChat: false, canOpenInApp: true, filePath: '/tmp/session.jsonl' })).toEqual({ kind: 'app' })
    expect(getSessionOpenIntent({ canOpenInChat: true, canOpenInApp: true, filePath: '/tmp/session.jsonl', messageCount: 0, lastMessage: null })).toEqual({ kind: 'app' })
    expect(getSessionOpenIntent({ canOpenInChat: false, canOpenInApp: false, filePath: '/tmp/session.jsonl' })).toEqual({ kind: 'file', persist: false })
    expect(getSessionOpenIntent({ canOpenInChat: true, canOpenInApp: true, filePath: '/tmp/session.jsonl' }, { persist: true })).toEqual({ kind: 'chat', persist: true })
  })
})
