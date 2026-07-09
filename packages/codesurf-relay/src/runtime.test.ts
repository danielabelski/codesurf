import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { RelayParticipant, RelayAgentExecutor, RelayTurnInput, RelayMessage, RelayEvent } from './types'
import type { CodesurfRelay } from './relay'
import { RelayRuntime, RelayTimeoutError } from './runtime'

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
        })
      )

      expect(mockRelay.sendDirectMessage).toHaveBeenCalledWith(
        'system',
        expect.objectContaining({
          to: 'agent-1',
          subject: 'Initial task',
          body: 'Do something',
          kind: 'system',
        })
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

      expect(mockRelay.setParticipantStatus).toHaveBeenCalledWith('agent-1', 'error')
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

      expect(mockRelay.setParticipantStatus).toHaveBeenCalledWith('agent-1', 'error')

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
      })

      expect(mockRelay.sendDirectMessage).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          to: 'agent-2',
          subject: 'Coordination needed',
          body: 'I need to discuss the auth changes',
          priority: 'high',
        })
      )

      runtime.destroy()
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
