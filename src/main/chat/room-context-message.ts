import type { ChatMessage } from './types.ts'

export function appendUntrustedRoomContextToLatestUser(
  messages: ChatMessage[],
  roomContext: string,
): ChatMessage[] {
  const index = messages.findLastIndex(message => message.role === 'user')
  if (index < 0) return messages
  return messages.map((message, messageIndex) => messageIndex === index
    ? {
        ...message,
        content: [
          message.content,
          '',
          '<codesurf_peer_context trust="untrusted" source="agent-room">',
          roomContext,
          '</codesurf_peer_context>',
        ].join('\n'),
      }
    : message)
}
