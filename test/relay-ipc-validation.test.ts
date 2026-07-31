import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  isRelayChannelMessageDraft,
  isRelayDirectMessageDraft,
  isRelaySpawnRequest,
  isRelayWorkContext,
} from '../src/main/relay/ipc-validation.ts'

describe('relay IPC payload validation', () => {
  test('accepts the canonical direct-message `to` field', () => {
    assert.equal(isRelayDirectMessageDraft({
      to: 'agent-b',
      subject: 'Coordination',
      body: 'Please review the shared file.',
      kind: 'request',
      priority: 'high',
    }), true)
    assert.equal(isRelayDirectMessageDraft({
      toParticipantId: 'agent-b',
      subject: 'Legacy shape',
      body: 'This must not cross IPC.',
    }), false)
  })

  test('requires canonical spawn name and task while accepting optional id', () => {
    assert.equal(isRelaySpawnRequest({
      id: 'agent-b',
      name: 'Reviewer',
      task: 'Review the shared file',
      provider: 'codex',
      channels: ['review'],
    }), true)
    assert.equal(isRelaySpawnRequest({
      participantId: 'agent-b',
      provider: 'codex',
    }), false)
    assert.equal(isRelaySpawnRequest({
      id: 42,
      name: 'Reviewer',
      task: 'Review the shared file',
    }), false)
  })

  test('rejects malformed channel, work, and optional message fields', () => {
    assert.equal(isRelayChannelMessageDraft({
      channel: 'review',
      subject: 'Update',
      body: 'Ready',
      data: { files: ['src/main/ipc/relay.ts'] },
    }), true)
    assert.equal(isRelayChannelMessageDraft({
      channel: 'review',
      subject: 'Update',
      body: 'Ready',
      priority: 'urgent',
    }), false)
    assert.equal(isRelayWorkContext({
      summary: 'Reviewing IPC boundaries',
      files: ['src/main/ipc/relay.ts'],
      impacts: [{
        targetType: 'agent',
        targetId: 'agent-b',
        description: 'Shared IPC types',
        severity: 'medium',
      }],
    }), true)
    assert.equal(isRelayWorkContext({
      summary: 'Invalid work',
      files: [42],
    }), false)
  })
})
