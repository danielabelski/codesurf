import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  RelayAgentExecutor,
  RelayEvent,
  RelayMessage,
  RelayOperationContext,
  RelayParticipant,
  RelayTurnInput,
} from './types'
import type { CodesurfRelay } from './relay'
import {
  RelayRuntime,
  RelayRuntimeDisposedError,
  RelayTimeoutError,
} from './runtime'

// Mock relay that properly handles events
function createMockRelay(): CodesurfRelay {
  const eventHandlers: Array<(event: RelayEvent) => void> = []
  
  return {
    init: vi.fn().mockResolvedValue(undefined),
    on: vi.fn().mockImplementation((handler: (event: RelayEvent) => void) => {
      eventHandlers.push(handler)
      return () => {
        const idx = eventHandlers.indexOf(handler)
        if (idx > -1) eventHandlers.splice(idx, 1)
      }
    }),
    events: { 
      emit: vi.fn().mockImplementation((type: string, event: RelayEvent) => {
        if (type === 'event') {
          eventHandlers.forEach(h => h(event))
        }
      })
    },
    workspacePath: '/tmp/test',
    paths: {
      root: '/tmp/test/.codesurf/relay',
      participants: '/tmp/test/.codesurf/relay/participants',
      channels: '/tmp/test/.codesurf/relay/channels',
      archive: '/tmp/test/.codesurf/relay/archive/all',
      relationships: '/tmp/test/.codesurf/relay/relationships',
    },
    upsertParticipant: vi.fn().mockImplementation((p) => Promise.resolve(p as RelayParticipant)),
    getParticipant: vi.fn(),
    setParticipantStatus: vi.fn().mockImplementation((id, status) => 
      Promise.resolve({ id, status } as RelayParticipant)),
    updateWorkContext: vi.fn().mockImplementation((id, work) => 
      Promise.resolve({ id, work } as RelayParticipant)),
    sendDirectMessage: vi.fn().mockResolvedValue({}),
    sendChannelMessage: vi.fn().mockResolvedValue({}),
    listUnreadDirectMessages: vi.fn().mockResolvedValue([]),
    listUnreadChannelMessages: vi.fn().mockResolvedValue([]),
    markDirectMessagesRead: vi.fn().mockResolvedValue(undefined),
    advanceChannelCursor: vi.fn().mockResolvedValue(undefined),
    analyzeRelationships: vi.fn().mockResolvedValue([]),
    storeMemory: vi.fn().mockResolvedValue({}),
  } as unknown as CodesurfRelay
}

describe('runtime', () => {
  describe('RelayRuntime', () => {
    let mockRelay: CodesurfRelay
    let mockExecutor: RelayAgentExecutor

    beforeEach(() => {
      vi.clearAllMocks()
      mockRelay = createMockRelay()
      mockExecutor = {
        runTurn: vi.fn().mockResolvedValue('{"ready": true, "status": "ready"}'),
      }
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('should spawn agent and send initial task message', async () => {
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => mockExecutor,
      })

      await runtime.spawn({
        id: 'agent-1',
        name: 'Test Agent',
        task: 'Do something',
        provider: 'claude',
      })

      expect(mockRelay.upsertParticipant).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'agent-1',
          name: 'Test Agent',
          kind: 'agent',
          status: 'spawning',
        }),
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )

      expect(mockRelay.sendDirectMessage).toHaveBeenCalledWith(
        'system',
        expect.objectContaining({
          to: 'agent-1',
          subject: 'Initial task',
          body: 'Do something',
          kind: 'system',
        }),
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )

      runtime.destroy()
    })

    it('should run agent turn when messages arrive', async () => {
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => mockExecutor,
      })

      const mockMessage: RelayMessage = {
        mailbox: 'inbox',
        filename: 'test.md',
        meta: {
          protocol: 'codesurf-relay/v1',
          id: 'msg-1',
          threadId: 'msg-1',
          scope: 'direct',
          kind: 'request',
          priority: 'normal',
          from: 'agent-2',
          to: 'agent-1',
          subject: 'Hello',
          status: 'unread',
          createdAt: '2024-01-01T00:00:00.000Z',
          createdTs: Date.now(),
          updatedAt: '2024-01-01T00:00:00.000Z',
          updatedTs: Date.now(),
          bcc: 'central',
        },
        body: 'Test message',
      }

      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([mockMessage])
      vi.mocked(mockRelay.listUnreadChannelMessages).mockResolvedValue([])
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      } as RelayParticipant)

      await runtime.spawn({
        id: 'agent-1',
        name: 'Test Agent',
        task: 'Test task',
      })

      // Wait for async scheduling
      await new Promise(r => setTimeout(r, 10))

      expect(mockExecutor.runTurn).toHaveBeenCalled()
      const callArg = vi.mocked(mockExecutor.runTurn).mock.calls[0][0] as RelayTurnInput
      expect(callArg.unreadDirectMessages).toHaveLength(1)
      expect(callArg.unreadDirectMessages[0].meta.from).toBe('agent-2')

      runtime.destroy()
    })

    it('should emit error event when agent fails', async () => {
      const failingExecutor: RelayAgentExecutor = {
        runTurn: vi.fn().mockRejectedValue(new Error('Agent crashed')),
      }

      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => failingExecutor,
      })

      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([{
        mailbox: 'inbox',
        filename: 'test.md',
        meta: {
          protocol: 'codesurf-relay/v1',
          id: 'msg-1',
          threadId: 'msg-1',
          scope: 'direct',
          kind: 'request',
          priority: 'normal',
          from: 'agent-2',
          to: 'agent-1',
          subject: 'Hello',
          status: 'unread',
          createdAt: '2024-01-01T00:00:00.000Z',
          createdTs: Date.now(),
          updatedAt: '2024-01-01T00:00:00.000Z',
          updatedTs: Date.now(),
          bcc: 'central',
        },
        body: 'Test',
      }])
      vi.mocked(mockRelay.listUnreadChannelMessages).mockResolvedValue([])
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      } as RelayParticipant)

      await runtime.spawn({
        id: 'agent-1',
        name: 'Test Agent',
        task: 'Test',
      })

      // Wait for async operations
      await new Promise(r => setTimeout(r, 50))

      expect(mockRelay.setParticipantStatus).toHaveBeenCalledWith(
        'agent-1',
        'error',
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )
      expect(mockRelay.events.emit).toHaveBeenCalledWith(
        'event',
        expect.objectContaining({
          type: 'error',
          payload: expect.objectContaining({
            participantId: 'agent-1',
            error: 'Agent crashed',
          }),
        })
      )

      runtime.destroy()
    })

    it('aborts an active executor turn when the runtime is destroyed', async () => {
      let markTurnEntered!: () => void
      const turnEntered = new Promise<void>(resolve => {
        markTurnEntered = resolve
      })
      let receivedSignal: AbortSignal | undefined
      const blockingExecutor: RelayAgentExecutor = {
        runTurn: vi.fn().mockImplementation((
          _input: RelayTurnInput,
          signal?: AbortSignal,
        ) => {
          receivedSignal = signal
          markTurnEntered()
          return new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(signal.reason)
            }, { once: true })
          })
        }),
      }
      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => blockingExecutor,
      })

      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-active',
        name: 'Active Agent',
        kind: 'agent',
        status: 'spawning',
        channels: [],
      })
      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([])
      vi.mocked(mockRelay.listUnreadChannelMessages).mockResolvedValue([])
      vi.mocked(mockRelay.analyzeRelationships).mockResolvedValue([])

      const spawning = runtime.spawn({
        id: 'agent-active',
        name: 'Active Agent',
        task: 'Keep working until cancelled',
      })
      await turnEntered
      runtime.destroy()

      await expect(spawning).rejects.toBeInstanceOf(
        RelayRuntimeDisposedError,
      )
      expect(receivedSignal?.aborted).toBe(true)
      expect(receivedSignal?.reason).toBeInstanceOf(
        RelayRuntimeDisposedError,
      )
    })

    it('should timeout long-running agent turns', async () => {
      const slowExecutor: RelayAgentExecutor = {
        runTurn: vi.fn().mockImplementation(() => 
          new Promise(resolve => setTimeout(resolve, 10000))
        ),
      }

      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => slowExecutor,
        turnTimeoutMs: 50, // Very short for testing
      })

      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([{
        mailbox: 'inbox',
        filename: 'test.md',
        meta: {
          protocol: 'codesurf-relay/v1',
          id: 'msg-1',
          threadId: 'msg-1',
          scope: 'direct',
          kind: 'request',
          priority: 'normal',
          from: 'agent-2',
          to: 'agent-1',
          subject: 'Hello',
          status: 'unread',
          createdAt: '2024-01-01T00:00:00.000Z',
          createdTs: Date.now(),
          updatedAt: '2024-01-01T00:00:00.000Z',
          updatedTs: Date.now(),
          bcc: 'central',
        },
        body: 'Test',
      }])
      vi.mocked(mockRelay.listUnreadChannelMessages).mockResolvedValue([])
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      } as RelayParticipant)

      await runtime.spawn({
        id: 'agent-1',
        name: 'Test Agent',
        task: 'Test',
      })

      // Wait for timeout
      await new Promise(r => setTimeout(r, 100))

      expect(mockRelay.setParticipantStatus).toHaveBeenCalledWith(
        'agent-1',
        'error',
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )

      runtime.destroy()
    })

    it('should parse agent output and send messages', async () => {
      const executorWithOutput: RelayAgentExecutor = {
        runTurn: vi.fn().mockResolvedValue(JSON.stringify({
          ready: true,
          status: 'running',
          work: {
            summary: 'Working on auth',
            files: ['src/auth.ts'],
          },
          messages: [
            {
              mode: 'direct',
              to: 'agent-2',
              subject: 'Coordination needed',
              body: 'I need to discuss the auth changes',
              priority: 'high',
            },
          ],
        })),
      }

      const runtime = new RelayRuntime(mockRelay, {
        executorFactory: () => executorWithOutput,
      })

      vi.mocked(mockRelay.listUnreadDirectMessages).mockResolvedValue([{
        mailbox: 'inbox',
        filename: 'test.md',
        meta: {
          protocol: 'codesurf-relay/v1',
          id: 'msg-1',
          threadId: 'msg-1',
          scope: 'direct',
          kind: 'request',
          priority: 'normal',
          from: 'agent-2',
          to: 'agent-1',
          subject: 'Hello',
          status: 'unread',
          createdAt: '2024-01-01T00:00:00.000Z',
          createdTs: Date.now(),
          updatedAt: '2024-01-01T00:00:00.000Z',
          updatedTs: Date.now(),
          bcc: 'central',
        },
        body: 'Test',
      }])
      vi.mocked(mockRelay.listUnreadChannelMessages).mockResolvedValue([])
      vi.mocked(mockRelay.getParticipant).mockResolvedValue({
        id: 'agent-1',
        name: 'Agent 1',
        kind: 'agent',
        status: 'ready',
        channels: [],
      } as RelayParticipant)

      await runtime.spawn({
        id: 'agent-1',
        name: 'Test Agent',
        task: 'Test',
      })

      await new Promise(r => setTimeout(r, 10))

      expect(mockRelay.updateWorkContext).toHaveBeenCalledWith('agent-1', {
        summary: 'Working on auth',
        files: ['src/auth.ts'],
      }, expect.objectContaining({
        assertActive: expect.any(Function),
      }))

      expect(mockRelay.sendDirectMessage).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          to: 'agent-2',
          subject: 'Coordination needed',
          body: 'I need to discuss the auth changes',
          priority: 'high',
        }),
        expect.objectContaining({
          assertActive: expect.any(Function),
        }),
      )

      runtime.destroy()
    })

    it('cancels deferred spawn boundaries before later publication or provider work', async () => {
      for (const deferredBoundary of ['upsert', 'send', 'schedule'] as const) {
        let release!: () => void
        const released = new Promise<void>(resolve => {
          release = resolve
        })
        let markEntered!: () => void
        const entered = new Promise<void>(resolve => {
          markEntered = resolve
        })
        const listeners = new Set<(event: RelayEvent) => void>()
        const participants = new Map<string, RelayParticipant>()
        let stopped = false
        let postStopPublishInvocations = 0
        let postStopBackingCommits = 0
        let postStopMutationCalls = 0
        let executorCreations = 0
        let processStarts = 0
        let sendCalls = 0
        let scheduleReads = 0

        const publish = (event: RelayEvent) => {
          if (stopped) postStopPublishInvocations += 1
          for (const listener of listeners) {
            listener(event)
          }
        }
        const recordMutation = () => {
          if (stopped) postStopMutationCalls += 1
        }

        const relay = {
          events: {
            emit(_type: string, event: RelayEvent) {
              publish(event)
            },
          },
          on(listener: (event: RelayEvent) => void) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          async upsertParticipant(
            input: RelayParticipant,
            context?: RelayOperationContext,
          ) {
            recordMutation()
            if (deferredBoundary === 'upsert') {
              markEntered()
              await released
            }
            context?.assertActive()
            if (stopped) postStopBackingCommits += 1
            const participant = {
              ...input,
              channels: input.channels ?? [],
            }
            participants.set(input.id, participant)
            publish({
              type: 'participant_upserted',
              timestamp: Date.now(),
              payload: { participant },
            })
            return participant
          },
          async sendDirectMessage(
            from: string,
            draft: { to: string; body: string },
            context?: RelayOperationContext,
          ) {
            recordMutation()
            sendCalls += 1
            if (deferredBoundary === 'send') {
              markEntered()
              await released
            }
            context?.assertActive()
            if (stopped) postStopBackingCommits += 1
            const message = {
              mailbox: 'sent' as const,
              filename: 'initial-task.md',
              meta: {
                protocol: 'codesurf-relay/v1' as const,
                id: 'initial-task',
                threadId: 'initial-task',
                scope: 'system' as const,
                kind: 'system' as const,
                priority: 'high' as const,
                from,
                to: draft.to,
                subject: 'Initial task',
                status: 'sent' as const,
                createdAt: new Date().toISOString(),
                createdTs: Date.now(),
                updatedAt: new Date().toISOString(),
                updatedTs: Date.now(),
                bcc: 'central' as const,
              },
              body: draft.body,
            }
            publish({
              type: 'direct_message',
              timestamp: Date.now(),
              payload: { from, to: draft.to, message },
            })
            return message
          },
          async getParticipant(id: string) {
            scheduleReads += 1
            if (deferredBoundary === 'schedule') {
              markEntered()
              await released
            }
            return participants.get(id) ?? null
          },
          async listUnreadDirectMessages() {
            return []
          },
          async listUnreadChannelMessages() {
            return []
          },
          async analyzeRelationships() {
            return []
          },
          async setParticipantStatus(
            id: string,
            status: RelayParticipant['status'],
            context?: RelayOperationContext,
          ) {
            recordMutation()
            context?.assertActive()
            if (stopped) postStopBackingCommits += 1
            const participant = { ...participants.get(id)!, status }
            participants.set(id, participant)
            publish({
              type: 'participant_status',
              timestamp: Date.now(),
              payload: { participantId: id, status },
            })
            return participant
          },
          async updateWorkContext() {
            recordMutation()
          },
          async sendChannelMessage() {
            recordMutation()
          },
          async storeMemory() {
            recordMutation()
          },
          async markDirectMessagesRead() {
            recordMutation()
          },
          async advanceChannelCursor() {
            recordMutation()
          },
          async listParticipants() {
            return Array.from(participants.values())
          },
        } as unknown as CodesurfRelay

        const runtime = new RelayRuntime(relay, {
          executorFactory: () => {
            executorCreations += 1
            return {
              async runTurn() {
                processStarts += 1
                return '{}'
              },
            }
          },
          assertActive: () => {
            if (stopped) throw new Error('stale runtime generation')
          },
        })

        let spawnSettled = false
        const spawn = runtime.spawn({
          id: `agent-${deferredBoundary}`,
          name: `Agent ${deferredBoundary}`,
          provider: 'codex',
          task: 'must stop at the deferred boundary',
        })
        void spawn.then(
          () => { spawnSettled = true },
          () => { spawnSettled = true },
        )

        await entered
        expect(spawnSettled).toBe(false)
        stopped = true
        runtime.destroy()

        await expect(spawn).rejects.toBeInstanceOf(
          RelayRuntimeDisposedError,
        )

        release()
        await new Promise(resolve => setTimeout(resolve, 0))

        expect(postStopPublishInvocations).toBe(0)
        expect(postStopBackingCommits).toBe(0)
        expect(postStopMutationCalls).toBe(0)
        expect(processStarts).toBe(0)
        expect(listeners.size).toBe(0)

        if (deferredBoundary === 'upsert') {
          expect(sendCalls).toBe(0)
          expect(executorCreations).toBe(0)
          expect(scheduleReads).toBe(0)
        } else if (deferredBoundary === 'send') {
          expect(sendCalls).toBe(1)
          expect(executorCreations).toBe(1)
          expect(scheduleReads).toBe(0)
        } else {
          expect(sendCalls).toBe(1)
          expect(executorCreations).toBe(1)
          expect(scheduleReads).toBeGreaterThanOrEqual(1)
        }
      }
    })
  })

  describe('RelayTimeoutError', () => {
    it('should have correct error message', () => {
      const error = new RelayTimeoutError('agent-1', 300000)
      expect(error.message).toBe('Agent agent-1 turn timed out after 300000ms')
      expect(error.name).toBe('RelayTimeoutError')
    })
  })
})
