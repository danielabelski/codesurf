import type {
  RelayAgentExecutor,
  RelayAgentTurnOutput,
  RelayChannelMessageDraft,
  RelayDirectMessageDraft,
  RelayEvent,
  RelayMessage,
  RelayOperationContext,
  RelayParticipant,
  RelaySpawnRequest,
  RelayTurnInput,
} from './types'
import { CodesurfRelay } from './relay'

export interface RelayRuntimeOptions {
  executorFactory: (participant: RelayParticipant, spawn: RelaySpawnRequest) => RelayAgentExecutor
  turnTimeoutMs?: number
  assertActive?: () => void
}

export class RelayTimeoutError extends Error {
  constructor(participantId: string, timeoutMs: number) {
    super(`Agent ${participantId} turn timed out after ${timeoutMs}ms`)
    this.name = 'RelayTimeoutError'
  }
}

export class RelayRuntimeDisposedError extends Error {
  constructor() {
    super('Relay runtime was disposed during an active operation')
    this.name = 'RelayRuntimeDisposedError'
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
  private readonly operationContext: RelayOperationContext
  private readonly agents = new Map<string, RuntimeAgentState>()
  private readonly activeTurnControllers = new Set<AbortController>()
  private readonly unsubscribe: () => void
  private readonly cancelled: Promise<never>
  private cancel!: (error: Error) => void
  private destroyed = false

  constructor(relay: CodesurfRelay, options: RelayRuntimeOptions) {
    this.relay = relay
    this.options = options
    this.operationContext = {
      assertActive: () => this.assertActive(),
    }
    this.cancelled = new Promise<never>((_resolve, reject) => {
      this.cancel = reject
    })
    void this.cancelled.catch(() => {})
    this.unsubscribe = this.relay.on(event => {
      if (!this.isActive()) return
      void this.onRelayEvent(event).catch(error => {
        if (!this.isActive()) return
        const errorMessage = error instanceof Error ? error.message : String(error)
        this.relay.events.emit('event', {
          type: 'error',
          timestamp: Date.now(),
          payload: { error: errorMessage },
        } satisfies RelayEvent)
      })
    })
  }

  destroy(): void {
    if (this.destroyed) return
    const error = new RelayRuntimeDisposedError()
    this.destroyed = true
    for (const controller of this.activeTurnControllers) {
      controller.abort(error)
    }
    this.activeTurnControllers.clear()
    this.cancel(error)
    this.unsubscribe()
    this.agents.clear()
  }

  async spawn(request: RelaySpawnRequest): Promise<RelayParticipant> {
    this.assertActive()
    const id = request.id ?? request.tileId ?? request.name
    const participant = await this.awaitActive(
      () => this.relay.upsertParticipant({
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
      }, this.operationContext),
    )

    this.assertActive()
    const executor = this.options.executorFactory(participant, { ...request, id })
    this.assertActive()
    const state: RuntimeAgentState = {
      spawn: { ...request, id },
      running: true,
      busy: false,
      ready: false,
      executor,
    }
    this.agents.set(id, state)
    try {
      await this.awaitActive(
        () => this.relay.sendDirectMessage('system', {
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
        }, this.operationContext),
      )

      await this.awaitActive(() => this.schedule(id))
    } catch (error) {
      if (this.agents.get(id) === state) this.agents.delete(id)
      throw error
    }
    this.assertActive()
    return participant
  }

  async stop(participantId: string): Promise<void> {
    this.assertActive()
    const state = this.agents.get(participantId)
    if (!state) return
    state.running = false
    await this.awaitActive(
      () => this.relay.setParticipantStatus(
        participantId,
        'stopped',
        this.operationContext,
      ),
    )
  }

  async start(participantId: string): Promise<void> {
    this.assertActive()
    const state = this.agents.get(participantId)
    if (!state) return
    state.running = true
    await this.awaitActive(() => this.schedule(participantId))
  }

  async schedule(participantId: string): Promise<void> {
    this.assertActive()
    const state = this.agents.get(participantId)
    if (!state || !state.running || state.busy) return
    state.busy = true
    try {
      await this.awaitActive(
        () => this.runAgentTickWithErrorHandling(participantId, state),
      )
    } finally {
      state.busy = false
    }
  }

  private async tick(participantId: string, state: RuntimeAgentState): Promise<void> {
    const participant = await this.awaitActive(
      () => this.relay.getParticipant(participantId, this.operationContext),
    )
    if (!participant) return

    const unreadDirectMessages = await this.awaitActive(
      () => this.relay.listUnreadDirectMessages(participantId),
    )
    const unreadChannelMessages = await this.awaitActive(
      () => this.relay.listUnreadChannelMessages(participantId),
    )
    if (unreadDirectMessages.length === 0 && unreadChannelMessages.length === 0 && state.ready) return

    const relationships = (await this.awaitActive(
      () => this.relay.analyzeRelationships(),
    )).filter(hint => hint.participants.includes(participantId))
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
    await this.awaitActive(
      () => this.relay.setParticipantStatus(
        participantId,
        state.ready ? 'running' : 'spawning',
        this.operationContext,
      ),
    )

    const turnTimeoutMs = this.options.turnTimeoutMs ?? 300_000 // 5 minutes default
    const raw = await this.awaitActive(
      () => this.runTurnWithTimeout(participantId, state, input, turnTimeoutMs),
    )
    const output = parseTurnOutput(raw)

    if (output.work) {
      await this.awaitActive(
        () => this.relay.updateWorkContext(
          participantId,
          output.work!,
          this.operationContext,
        ),
      )
    }

    if (!state.ready && (output.ready ?? true)) {
      state.ready = true
      await this.awaitActive(
        () => this.relay.setParticipantStatus(
          participantId,
          output.status ?? 'ready',
          this.operationContext,
        ),
      )
    } else if (output.status) {
      await this.awaitActive(
        () => this.relay.setParticipantStatus(
          participantId,
          output.status!,
          this.operationContext,
        ),
      )
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
        await this.awaitActive(
          () => this.relay.sendDirectMessage(
            participantId,
            draft,
            this.operationContext,
          ),
        )
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
        await this.awaitActive(
          () => this.relay.sendChannelMessage(
            participantId,
            draft,
            this.operationContext,
          ),
        )
      }
    }

    for (const memory of output.memory ?? []) {
      await this.awaitActive(
        () => this.relay.storeMemory(
          participantId,
          memory.subject,
          memory.body,
          memory.data,
          this.operationContext,
        ),
      )
    }

    if (unreadDirectMessages.length > 0) {
      await this.awaitActive(
        () => this.relay.markDirectMessagesRead(
          participantId,
          unreadDirectMessages,
          this.operationContext,
        ),
      )
    }
    if (unreadChannelMessages.length > 0) {
      const latestByChannel = new Map<string, number>()
      for (const message of unreadChannelMessages) {
        if (!message.meta.channel) continue
        latestByChannel.set(message.meta.channel, Math.max(latestByChannel.get(message.meta.channel) ?? 0, message.meta.createdTs))
      }
      for (const [channel, timestamp] of latestByChannel) {
        await this.awaitActive(
          () => this.relay.advanceChannelCursor(
            participantId,
            channel,
            timestamp,
            this.operationContext,
          ),
        )
      }
    }
  }

  private async onRelayEvent(event: RelayEvent): Promise<void> {
    this.assertActive()
    if (event.type === 'direct_message') {
      const target = (event.payload as { to: string }).to
      if (this.agents.has(target)) {
        await this.awaitActive(() => this.schedule(target))
      }
      return
    }

    if (event.type === 'channel_message') {
      const channel = (event.payload as { channel: string }).channel
      const participants = await this.awaitActive(
        () => this.relay.listParticipants(this.operationContext),
      )
      await this.awaitActive(
        () => Promise.all(participants
          .filter(participant => participant.channels.includes(channel))
          .map(participant => this.schedule(participant.id))),
      )
    }
  }

  private async runTurnWithTimeout(
    participantId: string,
    state: RuntimeAgentState,
    input: RelayTurnInput,
    timeoutMs: number,
  ): Promise<string> {
    const controller = new AbortController()
    this.activeTurnControllers.add(controller)
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (
        outcome: { result: string } | { error: unknown },
      ): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
        this.activeTurnControllers.delete(controller)
        if ('result' in outcome) {
          resolve(outcome.result)
        } else {
          reject(outcome.error)
        }
      }
      const onAbort = (): void => {
        finish({
          error: controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new RelayRuntimeDisposedError(),
        })
      }
      const timer = setTimeout(() => {
        controller.abort(new RelayTimeoutError(participantId, timeoutMs))
      }, timeoutMs)

      controller.signal.addEventListener('abort', onAbort, { once: true })
      try {
        const turn = state.executor.runTurn(input, controller.signal)
        void turn.then(
          result => finish({ result }),
          error => finish({ error }),
        )
      } catch (error) {
        finish({ error })
      }
    })
  }

  private async runAgentTickWithErrorHandling(participantId: string, state: RuntimeAgentState): Promise<void> {
    try {
      await this.awaitActive(() => this.tick(participantId, state))
    } catch (error) {
      if (!this.isActive()) return
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.assertActive()
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
        await this.awaitActive(
          () => this.relay.setParticipantStatus(
            participantId,
            'error',
            this.operationContext,
          ),
        )
      } catch {
        if (!this.isActive()) return
        // Participant gone — nothing left to mark.
      }
      state.running = false
    }
  }

  private assertActive(): void {
    if (this.destroyed) throw new RelayRuntimeDisposedError()
    this.options.assertActive?.()
  }

  private isActive(): boolean {
    try {
      this.assertActive()
      return true
    } catch {
      return false
    }
  }

  private async awaitActive<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive()
    const pending = operation()
    try {
      const result = await Promise.race([pending, this.cancelled])
      this.assertActive()
      return result
    } catch (error) {
      this.assertActive()
      throw error
    }
  }
}
