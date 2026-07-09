import type {
  RelayAgentExecutor,
  RelayAgentTurnOutput,
  RelayChannelMessageDraft,
  RelayDirectMessageDraft,
  RelayEvent,
  RelayMessage,
  RelayParticipant,
  RelaySpawnRequest,
  RelayTurnInput,
} from './types'
import { CodesurfRelay } from './relay'

export interface RelayRuntimeOptions {
  executorFactory: (participant: RelayParticipant, spawn: RelaySpawnRequest) => RelayAgentExecutor
  turnTimeoutMs?: number
}

export class RelayTimeoutError extends Error {
  constructor(participantId: string, timeoutMs: number) {
    super(`Agent ${participantId} turn timed out after ${timeoutMs}ms`)
    this.name = 'RelayTimeoutError'
  }
}

interface RuntimeAgentState {
  spawn: RelaySpawnRequest
  running: boolean
  busy: boolean
  ready: boolean
  executor: RelayAgentExecutor
}

function extractJsonBlock(raw: string): string {
  const fenced = raw.match(/```json\n([\s\S]*?)\n```/)
  if (fenced) return fenced[1]
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start !== -1 && end !== -1 && end > start) return raw.slice(start, end + 1)
  return raw
}

function sanitizeForPrompt(text: string, maxLength = 4000): string {
  return text
    .replace(/```/g, '\\`\\`\\`')
    .replace(/<\|/g, '\\<\\|')
    .replace(/\|>/g, '\\|\\>')
    .slice(0, maxLength)
}

function sanitizeMessageForPrompt(msg: RelayMessage): { meta: RelayMessage['meta']; body: string; data?: Record<string, unknown> } {
  return {
    meta: msg.meta,
    body: sanitizeForPrompt(msg.body),
    data: msg.data,
  }
}

function parseTurnOutput(raw: string): RelayAgentTurnOutput {
  const json = extractJsonBlock(raw)
  return JSON.parse(json) as RelayAgentTurnOutput
}

function buildPrompt(input: RelayTurnInput, task: string): string {
  const relationships = input.relationships.map(item => ({
    with: item.participants.find(id => id !== input.participant.id),
    priority: item.priority,
    summary: item.summary,
    overlappingFiles: item.overlappingFiles,
    sharedChannels: item.sharedChannels,
  }))

  return [
    `You are ${input.participant.name} in the CodeSurf relay runtime.`,
    `Your persistent task: ${task}`,
    '',
    'You are coordinating work, surfacing dependencies, and telling others when your work could affect them.',
    'Messaging priority is NOT tied to spatial/canvas connections.',
    '',
    'Return JSON only with this schema:',
    '{',
    '  "ready": true,',
    '  "status": "ready|running|blocked|done|error",',
    '  "work": {',
    '    "summary": "what you are currently doing",',
    '    "branch": "optional git branch",',
    '    "worktreePath": "optional worktree path",',
    '    "files": ["optional file paths"],',
    '    "topics": ["optional topics"],',
    '    "collaborators": ["optional participant ids"],',
    '    "blockers": ["optional blockers"],',
    '    "impacts": [{"targetType":"agent|human|system","targetId":"optional","description":"impact","severity":"low|medium|high"}]',
    '  },',
    '  "messages": [',
    '    {"mode":"direct","to":"participantId","subject":"subject","body":"markdown body","priority":"low|normal|high|critical","kind":"request|reply|update|handoff|alert|memory|channel|system"},',
    '    {"mode":"channel","channel":"channelId","subject":"subject","body":"markdown body","priority":"low|normal|high|critical","kind":"channel|update|alert"}',
    '  ],',
    '  "memory": [{"subject":"short title","body":"markdown note"}]',
    '}',
    '',
    'Rules:',
    '- only send a message when there is a real coordination need',
    '- always mention branch/worktree/files if overlap or impact matters',
    '- if your work could affect a human or another agent, record it in work.impacts and usually send a message',
    '- use channels for shared-room updates, direct messages for targeted coordination',
    '- if nothing needs sending, return an empty messages array',
    '',
    'Current participant state:',
    JSON.stringify(input.participant, null, 2),
    '',
    'Unread direct messages:',
    '<<<BEGIN MESSAGES>>>',
    JSON.stringify(input.unreadDirectMessages.map(sanitizeMessageForPrompt), null, 2),
    '<<<END MESSAGES>>>',
    '',
    'Unread channel messages:',
    '<<<BEGIN MESSAGES>>>',
    JSON.stringify(input.unreadChannelMessages.map(sanitizeMessageForPrompt), null, 2),
    '<<<END MESSAGES>>>',
    '',
    'Relationship hints:',
    JSON.stringify(relationships, null, 2),
  ].join('\n')
}

export class RelayRuntime {
  private readonly relay: CodesurfRelay
  private readonly options: RelayRuntimeOptions
  private readonly agents = new Map<string, RuntimeAgentState>()
  private readonly unsubscribe: () => void

  constructor(relay: CodesurfRelay, options: RelayRuntimeOptions) {
    this.relay = relay
    this.options = options
    this.unsubscribe = this.relay.on(event => { void this.onRelayEvent(event) })
  }

  destroy(): void {
    this.unsubscribe()
    this.agents.clear()
  }

  async spawn(request: RelaySpawnRequest): Promise<RelayParticipant> {
    const id = request.id ?? request.tileId ?? request.name
    const participant = await this.relay.upsertParticipant({
      id,
      name: request.name,
      kind: 'agent',
      status: 'spawning',
      tileId: request.tileId,
      provider: request.provider ?? 'unknown',
      model: request.model,
      task: request.task,
      channels: request.channels ?? [],
      metadata: {
        ...(request.metadata ?? {}),
        relayMode: request.mode,
        relayThinking: request.thinking,
      },
    })

    const executor = this.options.executorFactory(participant, { ...request, id })
    this.agents.set(id, {
      spawn: { ...request, id },
      running: true,
      busy: false,
      ready: false,
      executor,
    })

    await this.relay.sendDirectMessage('system', {
      to: id,
      subject: 'Initial task',
      body: request.task,
      kind: 'system',
      priority: 'high',
      data: {
        relaySpawn: true,
        channels: request.channels ?? [],
        provider: request.provider,
        model: request.model,
      },
    })

    await this.schedule(id)
    return participant
  }

  async stop(participantId: string): Promise<void> {
    const state = this.agents.get(participantId)
    if (!state) return
    state.running = false
    await this.relay.setParticipantStatus(participantId, 'stopped')
  }

  async start(participantId: string): Promise<void> {
    const state = this.agents.get(participantId)
    if (!state) return
    state.running = true
    await this.schedule(participantId)
  }

  async schedule(participantId: string): Promise<void> {
    const state = this.agents.get(participantId)
    if (!state || !state.running || state.busy) return
    state.busy = true
    try {
      await this.runAgentTickWithErrorHandling(participantId, state)
    } finally {
      state.busy = false
    }
  }

  private async tick(participantId: string, state: RuntimeAgentState): Promise<void> {
    const participant = await this.relay.getParticipant(participantId)
    if (!participant) return

    const unreadDirectMessages = await this.relay.listUnreadDirectMessages(participantId)
    const unreadChannelMessages = await this.relay.listUnreadChannelMessages(participantId)
    if (unreadDirectMessages.length === 0 && unreadChannelMessages.length === 0 && state.ready) return

    const relationships = (await this.relay.analyzeRelationships()).filter(hint => hint.participants.includes(participantId))
    const prompt = buildPrompt({
      participant,
      prompt: '',
      unreadDirectMessages,
      unreadChannelMessages,
      relationships,
    }, state.spawn.task)

    const input: RelayTurnInput = {
      participant,
      prompt,
      unreadDirectMessages,
      unreadChannelMessages,
      relationships,
    }
    await this.relay.setParticipantStatus(participantId, state.ready ? 'running' : 'spawning')

    const turnTimeoutMs = this.options.turnTimeoutMs ?? 300_000 // 5 minutes default
    const raw = await this.runTurnWithTimeout(participantId, state, input, turnTimeoutMs)
    const output = parseTurnOutput(raw)

    if (output.work) {
      await this.relay.updateWorkContext(participantId, output.work)
    }

    if (!state.ready && (output.ready ?? true)) {
      state.ready = true
      await this.relay.setParticipantStatus(participantId, output.status ?? 'ready')
    } else if (output.status) {
      await this.relay.setParticipantStatus(participantId, output.status)
    }

    for (const message of output.messages ?? []) {
      if (message.mode === 'direct') {
        const draft: RelayDirectMessageDraft = {
          to: message.to,
          subject: message.subject,
          body: message.body,
          kind: message.kind,
          priority: message.priority,
          threadId: message.threadId,
          replyToId: message.replyToId,
          data: message.data,
        }
        await this.relay.sendDirectMessage(participantId, draft)
      } else {
        const draft: RelayChannelMessageDraft = {
          channel: message.channel,
          subject: message.subject,
          body: message.body,
          kind: message.kind,
          priority: message.priority,
          threadId: message.threadId,
          replyToId: message.replyToId,
          data: message.data,
        }
        await this.relay.sendChannelMessage(participantId, draft)
      }
    }

    for (const memory of output.memory ?? []) {
      await this.relay.storeMemory(participantId, memory.subject, memory.body, memory.data)
    }

    if (unreadDirectMessages.length > 0) {
      await this.relay.markDirectMessagesRead(participantId, unreadDirectMessages)
    }
    if (unreadChannelMessages.length > 0) {
      const latestByChannel = new Map<string, number>()
      for (const message of unreadChannelMessages) {
        if (!message.meta.channel) continue
        latestByChannel.set(message.meta.channel, Math.max(latestByChannel.get(message.meta.channel) ?? 0, message.meta.createdTs))
      }
      for (const [channel, timestamp] of latestByChannel) {
        await this.relay.advanceChannelCursor(participantId, channel, timestamp)
      }
    }
  }

  private async onRelayEvent(event: RelayEvent): Promise<void> {
    if (event.type === 'direct_message') {
      const target = (event.payload as { to: string }).to
      if (this.agents.has(target)) await this.schedule(target)
      return
    }

    if (event.type === 'channel_message') {
      const channel = (event.payload as { channel: string }).channel
      const participants = await this.relay.listParticipants()
      await Promise.all(participants
        .filter(participant => participant.channels.includes(channel))
        .map(participant => this.schedule(participant.id)))
    }
  }

  private async runTurnWithTimeout(
    participantId: string,
    state: RuntimeAgentState,
    input: RelayTurnInput,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new RelayTimeoutError(participantId, timeoutMs))
      }, timeoutMs)

      state.executor.runTurn(input).then(
        (result) => {
          clearTimeout(timer)
          resolve(result)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  private async runAgentTickWithErrorHandling(participantId: string, state: RuntimeAgentState): Promise<void> {
    try {
      await this.tick(participantId, state)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.relay.events.emit('event', {
        type: 'error',
        timestamp: Date.now(),
        payload: { participantId, error: errorMessage },
      } satisfies RelayEvent)
      // The participant may have been removed between scheduling and this tick;
      // setParticipantStatus throws on an unknown id. This handler runs detached
      // from schedule() (not awaited), so a throw here becomes an unhandled
      // rejection — guard it so error recovery can never itself reject.
      try {
        await this.relay.setParticipantStatus(participantId, 'error')
      } catch {
        // Participant gone — nothing left to mark.
      }
      state.running = false
    }
  }
}
