import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildAsyncExecutionPrompt,
  buildPeerSystemPrompt,
} from '../src/main/chat/prompt-builders.ts'

describe('buildAsyncExecutionPrompt', () => {
  test('returns undefined when there is no async execution context', () => {
    assert.equal(buildAsyncExecutionPrompt(undefined), undefined)
  })

  test('always includes the heading and active backend line', () => {
    const out = buildAsyncExecutionPrompt({
      requestedRunMode: 'foreground',
      backend: 'daemon',
      hostType: 'local-daemon',
      hostLabel: 'My Mac',
      providerNativeBackground: false,
      detachedDaemonAvailable: false,
      detachedDaemonPreferred: false,
    })
    assert.match(out ?? '', /^## Async Execution/)
    assert.match(out ?? '', /Active execution backend: daemon \(My Mac\)\./)
    // No optional lines when every flag is false and run mode is foreground.
    assert.equal(out?.split('\n').length, 2)
  })

  test('adds provider-native, detached, and background lines when flagged', () => {
    const out = buildAsyncExecutionPrompt({
      requestedRunMode: 'background',
      backend: 'runtime',
      hostType: 'runtime',
      hostLabel: 'Runtime',
      providerNativeBackground: true,
      detachedDaemonAvailable: true,
      detachedDaemonPreferred: true,
    }) ?? ''
    assert.match(out, /Provider-native background agents/)
    assert.match(out, /daemon-backed detached jobs/)
    assert.match(out, /detached background orchestration job/)
  })

  test('foreground with detached available suggests detached orchestration instead of the background line', () => {
    const out = buildAsyncExecutionPrompt({
      requestedRunMode: 'foreground',
      backend: 'daemon',
      hostType: 'remote-daemon',
      hostLabel: 'Remote',
      providerNativeBackground: false,
      detachedDaemonAvailable: true,
      detachedDaemonPreferred: false,
    }) ?? ''
    assert.match(out, /prefer detached daemon orchestration/)
    assert.doesNotMatch(out, /detached background orchestration job/)
  })
})

describe('buildPeerSystemPrompt', () => {
  test('returns undefined for no peers', () => {
    assert.equal(buildPeerSystemPrompt(undefined), undefined)
    assert.equal(buildPeerSystemPrompt([]), undefined)
  })

  test('lists peer blocks, their tools, and the collaboration section', () => {
    const out = buildPeerSystemPrompt([
      { peerId: 'term-1', peerType: 'terminal', tools: ['terminal_send_input'] },
    ]) ?? ''
    assert.match(out, /Block "term-1" \(terminal\):/)
    assert.match(out, /Tools: terminal_send_input/)
    assert.match(out, /## Agent room/)
    assert.match(out, /peer_get_state: Snapshot of other room members/)
  })

  test('emits the Browser Control guide only when a peer exposes a browser_ tool', () => {
    const withBrowser = buildPeerSystemPrompt([
      { peerId: 'b', peerType: 'browser', tools: ['browser_navigate'] },
    ]) ?? ''
    assert.match(withBrowser, /## Browser Control/)
    const withoutBrowser = buildPeerSystemPrompt([
      { peerId: 't', peerType: 'terminal', tools: ['terminal_send_input'] },
    ]) ?? ''
    assert.doesNotMatch(withoutBrowser, /## Browser Control/)
  })

  test('emits the Extension Actions guide and action lines when actions exist', () => {
    const out = buildPeerSystemPrompt([
      {
        peerId: 'ext-1',
        peerType: 'extension',
        tools: [],
        actions: [{ name: 'generate', description: 'Generate content' }],
      },
    ]) ?? ''
    assert.match(out, /## Extension Actions/)
    assert.match(out, /- generate: Generate content/)
  })

  test('renders peer context with null and object value handling', () => {
    const out = buildPeerSystemPrompt([
      {
        peerId: 'c',
        peerType: 'chat',
        tools: [],
        context: { url: null, nav: { page: 2 } },
      },
    ]) ?? ''
    assert.match(out, /Current context:/)
    assert.match(out, /url: null/)
    assert.match(out, /nav: \{"page":2\}/)
  })

  test('falls back to "(no specific tools)" for an empty peer', () => {
    const out = buildPeerSystemPrompt([
      { peerId: 'empty', peerType: 'unknown', tools: [] },
    ]) ?? ''
    assert.match(out, /\(no specific tools\)/)
  })
})
