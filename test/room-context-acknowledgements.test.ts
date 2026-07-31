import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RoomContextAcknowledgements } from '../src/main/chat/room-context-acknowledgements.ts'

describe('room context acknowledgement reservations', () => {
  test('an immediate synthetic stop discards the current turn without consuming the next one', () => {
    const acknowledgements = new RoomContextAcknowledgements()
    const scope = { workspaceId: 'workspace-a', cardId: 'card-a' }

    acknowledgements.register(scope, 11)
    assert.equal(acknowledgements.settle(scope, 'stopped'), undefined)

    // The synthetic done emitted by stop is not provider delivery and has
    // nothing left to acknowledge.
    assert.equal(acknowledgements.settle(scope, 'delivered'), undefined)

    acknowledgements.register(scope, 12)
    assert.deepEqual(acknowledgements.settle(scope, 'delivered'), {
      workspaceId: 'workspace-a',
      cardId: 'card-a',
      sequence: 12,
    })
  })

  test('provider errors discard pending context instead of acknowledging it', () => {
    const acknowledgements = new RoomContextAcknowledgements()
    const scope = { workspaceId: 'workspace-a', cardId: 'card-a' }

    acknowledgements.register(scope, 21)

    assert.equal(acknowledgements.settle(scope, 'failed'), undefined)
    assert.equal(acknowledgements.settle(scope, 'delivered'), undefined)
  })
})
