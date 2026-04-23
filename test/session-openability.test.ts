import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getExternalSessionChatState, isExternalSessionImportableInChat } from '../src/main/session-sources'
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

  test('loads modern Claude JSONL messages from message.content blocks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codesurf-claude-session-'))
    const filePath = join(dir, 'session.jsonl')
    try {
      await writeFile(filePath, [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-04-23T15:00:00.000Z',
          sessionId: 'session',
          message: { role: 'user', content: [{ type: 'text', text: 'Why is this blank?' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-04-23T15:00:01.000Z',
          sessionId: 'session',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Because the parser missed nested content.' }] },
        }),
      ].join('\n'))

      const state = await getExternalSessionChatState('/tmp/workspace', `claude:${filePath}`, {
        entryHint: {
          id: `claude:${filePath}`,
          source: 'claude',
          filePath,
          sessionId: 'session',
          provider: 'claude',
          model: '',
          messageCount: 2,
          title: 'Claude session',
          projectPath: '/tmp/workspace',
        },
      })

      expect(state?.messages.map(message => message.content)).toEqual([
        'Why is this blank?',
        'Because the parser missed nested content.',
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
