import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'
import {
  buildPeerCommandPayload,
  getDisconnectedPeerBridgeMcpToolNames,
  getPeerBridgeNodeTools,
  normalizeNodeToolName,
} from '../src/shared/nodeTools.ts'

describe('node peer bridge tools', () => {
  test('keeps only disconnected peer bridge tools in the Claude disallow list', () => {
    const disallowed = getDisconnectedPeerBridgeMcpToolNames([
      'browser_navigate',
      'tool:browser_reload',
      'mcp__contex__chat_send_message',
    ])

    expect(disallowed).not.toContain('mcp__contex__browser_navigate')
    expect(disallowed).not.toContain('mcp__contex__browser_reload')
    expect(disallowed).not.toContain('mcp__contex__chat_send_message')
    expect(disallowed).not.toContain('mcp__contex__tile_context_get')
    expect(disallowed).toContain('mcp__contex__terminal_send_input')
  })

  test('does not classify universal context tools as peer bridge tools', () => {
    const peerBridgeTools = getPeerBridgeNodeTools().map(tool => tool.name)

    expect(peerBridgeTools).not.toContain('tile_context_get')
    expect(peerBridgeTools).not.toContain('tile_context_set')
  })

  test('normalizes capability and MCP tool prefixes for comparison', () => {
    expect(normalizeNodeToolName('tool:browser_navigate')).toBe('browser_navigate')
    expect(normalizeNodeToolName('mcp__contex__browser_navigate')).toBe('browser_navigate')
  })

  test('peer command payloads include the explicit target fields chat tiles require', () => {
    expect(buildPeerCommandPayload('chat-1', 'chat_send_message', { message: 'hello' })).toEqual({
      tileId: 'chat-1',
      cardId: 'chat-1',
      command: 'chat_send_message',
      message: 'hello',
    })
  })
})
