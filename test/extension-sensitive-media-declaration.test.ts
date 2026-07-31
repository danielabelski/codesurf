import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  getDeclaredSensitiveMediaCapabilities,
  getDeclaredSensitiveMediaDeclaration,
} from '../src/shared/extension-sensitive-media.ts'

describe('extension sensitive-media declarations', () => {
  test('preserves the first reason for each valid capability in canonical order', () => {
    const declaration = getDeclaredSensitiveMediaDeclaration([
      { name: 'camera', reason: 'Join video calls' },
      { name: 'fs', reason: 'Not a media capability' },
      { name: 'microphone', reason: 'Join audio calls' },
      { name: 'camera', reason: 'A duplicate must not replace the reviewed reason' },
      { name: 'display-capture' },
    ])

    assert.deepEqual(declaration.capabilities, [
      'microphone',
      'camera',
      'display-capture',
    ])
    assert.deepEqual(declaration.reasons, {
      microphone: 'Join audio calls',
      camera: 'Join video calls',
    })
    assert.deepEqual(
      getDeclaredSensitiveMediaCapabilities([
        { name: 'display-capture', reason: 'Present a window' },
        { name: 'camera' },
      ]),
      ['camera', 'display-capture'],
    )
  })

  test('does not coerce malformed reasons', () => {
    const declaration = getDeclaredSensitiveMediaDeclaration([
      { name: 'microphone', reason: undefined },
      { name: 'camera', reason: 42 as unknown as string },
    ])

    assert.deepEqual(declaration.capabilities, ['microphone', 'camera'])
    assert.deepEqual(declaration.reasons, {})
  })
})
