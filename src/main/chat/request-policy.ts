import {
  ChatPolicyError,
  assertProviderPersonaEnforceable,
  bindChatRequestToWorkspace,
} from '@codesurf/daemon/chat-policy'
import type { Persona } from '../../shared/types'
import type { ChatRequest } from './types'

export async function canonicalizeElectronChatRequest(
  request: ChatRequest,
  resolveWorkspaceRoot: (workspaceId: string) => Promise<string | null> | string | null,
): Promise<ChatRequest> {
  const workspaceId = typeof request.workspaceId === 'string' ? request.workspaceId.trim() : ''
  if (!workspaceId) {
    throw new ChatPolicyError('CHAT_WORKSPACE_REQUIRED', 'workspaceId is required for chat')
  }
  let workspaceRoot: string | null = null
  try {
    workspaceRoot = await resolveWorkspaceRoot(workspaceId)
  } catch {
    workspaceRoot = null
  }
  if (!workspaceRoot) {
    throw new ChatPolicyError('CHAT_WORKSPACE_UNKNOWN', `Workspace not found: ${workspaceId}`)
  }
  return await bindChatRequestToWorkspace(
    request as unknown as Record<string, unknown>,
    { id: workspaceId, path: workspaceRoot },
  ) as unknown as ChatRequest
}

export function applyAuthoritativePersonaPolicy(
  request: ChatRequest,
  agentMode: Persona | null,
): ChatRequest {
  assertProviderPersonaEnforceable(request.provider, agentMode)
  return {
    ...request,
    agentMode,
  }
}
