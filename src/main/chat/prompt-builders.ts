/**
 * Pure system/preamble prompt builders, extracted out of `src/main/ipc/chat.ts`
 * (which pulls in Electron main APIs and cannot be unit-tested). These build
 * the peer-collaboration system prompt and the async-execution preamble injected
 * into agent turns. Types are self-contained and structural so chat.ts's own
 * `PeerContext` / `ChatRequest['asyncExecution']` shapes pass through unchanged.
 *
 * See `test/chat-prompt-builders.test.ts`.
 */

export interface PromptPeerAction {
  name: string
  description: string
}

export interface PromptPeerContext {
  peerId: string
  peerType: string
  tools: string[]
  actions?: PromptPeerAction[]
  context?: Record<string, unknown>
}

export interface AsyncExecutionContext {
  requestedRunMode: 'foreground' | 'background'
  backend: 'runtime' | 'daemon'
  hostType: 'runtime' | 'local-daemon' | 'remote-daemon'
  hostLabel: string
  providerNativeBackground: boolean
  detachedDaemonAvailable: boolean
  detachedDaemonPreferred: boolean
}

export function buildAsyncExecutionPrompt(asyncExecution: AsyncExecutionContext | undefined): string | undefined {
  if (!asyncExecution) return undefined

  const lines = [
    '## Async Execution',
    `- Active execution backend: ${asyncExecution.backend} (${asyncExecution.hostLabel}).`,
  ]

  if (asyncExecution.providerNativeBackground) {
    lines.push('- Provider-native background agents may be available. Prefer that path for subagents or long-running delegated work when it keeps the main chat responsive.')
  }

  if (asyncExecution.detachedDaemonAvailable) {
    lines.push('- CodeSurf also supports daemon-backed detached jobs that can continue outside the foreground chat.')
  }

  if (asyncExecution.requestedRunMode === 'background') {
    lines.push('- This turn is running as a detached background orchestration job. Continue autonomously and do not expect interactive clarification from the foreground chat unless the task is blocked.')
  } else if (asyncExecution.detachedDaemonAvailable) {
    lines.push('- If the user wants the main conversation to stay free while work continues, prefer detached daemon orchestration for the main task thread.')
  }

  return lines.join('\n')
}

export function buildPeerSystemPrompt(peers?: PromptPeerContext[]): string | undefined {
  if (!peers || peers.length === 0) return undefined

  const hasExtensionActions = peers.some(peer => peer.actions && peer.actions.length > 0)
  const browserPeers = peers.filter(peer => peer.tools.some(tool => tool.startsWith('browser_')))
  const peerLines = peers.map(peer => {
    const lines: string[] = []
    if (peer.tools.length > 0) {
      lines.push('  Tools: ' + peer.tools.join(', '))
    }
    if (peer.actions && peer.actions.length > 0) {
      lines.push('  Actions (call via ext_invoke_action):')
      for (const action of peer.actions) {
        lines.push(`    - ${action.name}: ${action.description}`)
      }
    }
    if (peer.context && Object.keys(peer.context).length > 0) {
      lines.push('  Current context:')
      for (const [key, value] of Object.entries(peer.context)) {
        const display = value === null ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value)
        lines.push(`    ${key}: ${display}`)
      }
    }
    if (lines.length === 0) lines.push('  (no specific tools)')
    return `- Block "${peer.peerId}" (${peer.peerType}):\n${lines.join('\n')}`
  }).join('\n')

  const browserGuide = browserPeers.length > 0 ? [
    '',
    '## Browser Control',
    'If a connected browser block is relevant, use its browser_* tools with that block\'s tile_id instead of asking the user to navigate manually.',
    'Use the browser context values (for example ctx:browser:url and ctx:browser:navigation) to understand where the browser currently is before deciding the next action.',
  ] : []
  const extActionGuide = hasExtensionActions ? [
    '',
    '## Extension Actions',
    'To control extension blocks, use ext_invoke_action(tile_id, action, params).',
    'To read extension state afterwards, use tile_context_get(tile_id, tag).',
    'IMPORTANT: For artifact/content generation, ALWAYS prefer the "generate" action over "setHtml".',
    'Do NOT generate HTML yourself — let the extension handle it. Just describe what you want in the prompt.',
  ] : []

  return [
    'You are an AI agent running inside CodeSurf, an infinite canvas workspace.',
    '',
    '## Agent room',
    'Canvas wires put you in a shared agent room with the blocks below. Room traffic is injected into your context at the start of each turn (you do not need to poll).',
    'To send to the room: mcp__codesurf__room_post (or peer_send_message). To inspect membership: mcp__codesurf__room_status.',
    'When you finish meaningful work, a turn summary is posted to the room automatically for your peers.',
    '',
    'The following peer blocks share your room:',
    peerLines,
    '',
    'Treat the connected peer list above as authoritative for this turn.',
    'Do not waste time rediscovering tools or the canvas when a connected peer already exposes the needed tool.',
    '',
    '## Room / peer tools (mcp__codesurf__*)',
    '- room_status: Your room id, members, unread count',
    '- room_post: Post a message/task/handoff/summary into the room',
    '- room_consume: Drain unread room traffic (normally auto-injected each turn)',
    '- peer_set_state: Announce your status/task/files to the room',
    '- peer_get_state: Snapshot of other room members',
    '- peer_send_message: Direct message a room member',
    '',
    'Peer bridge tools for connected blocks require the block ID from the list above as tile_id.',
    'When a connected block already exposes a direct tool for the job, use it immediately instead of stalling or asking the user to perform the action manually.',
    'Do not call canvas_list_tiles or list_extensions first unless the connected peers above do not cover the request.',
    ...browserGuide,
    ...extActionGuide,
  ].join('\n')
}

/** Append room membership + consumed traffic for this turn. */
export function appendRoomContext(systemPrompt: string | undefined, roomExtra: string | undefined): string | undefined {
  const extra = roomExtra?.trim()
  if (!extra) return systemPrompt
  if (!systemPrompt?.trim()) return extra
  return `${systemPrompt}\n\n${extra}`
}
