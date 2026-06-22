/**
 * CodeSurf Agent (csagent) — the in-process coding-agent runtime, bridged to the
 * normalized agent:stream schema via src/main/chat/pi-runtime.ts.
 */

import { runCodesurfAgent } from '../pi-runtime'
import type { ChatRequest } from '../types'
import { getPreparedMessages, sendStream } from '../runtime'

export async function chatCsagent(req: ChatRequest): Promise<void> {
  const prepared = getPreparedMessages(req)
  const lastUser = [...prepared].reverse().find(m => m.role === 'user')
  if (!lastUser) {
    sendStream(req.cardId, { type: 'error', error: 'No user message to send.' })
    sendStream(req.cardId, { type: 'done' })
    return
  }
  await runCodesurfAgent(
    {
      cardId: req.cardId,
      model: req.model,
      workspaceDir: req.workspaceDir,
      sessionId: req.sessionId ?? null,
      thinking: req.thinking,
      prompt: String(lastUser.content ?? ''),
      agentPersona: req.agentMode?.systemPrompt?.trim() || undefined,
      memoryPrompt: req.memoryPrompt,
      skillsPrompt: req.skillsPrompt,
      asyncExecution: req.asyncExecution,
      imageAttachments: req.imageAttachments?.map(a => ({ path: a.path, mediaType: a.mediaType })),
    },
    (event) => sendStream(req.cardId, event),
  )
}
