import { utf8Bytes, utf8Prefix } from './peer-context-serialization.ts'

export const CHAT_CONTEXT_LIMITS = Object.freeze({
  aggregateBytes: 10_000,
  personaBytes: 980,
  memoryBytes: 980,
  skillsBytes: 980,
  outputConventionBytes: 980,
  insightConventionBytes: 980,
  activityConventionBytes: 980,
  asyncBytes: 980,
  peerBytes: 1_000,
  roomBytes: 980,
  fileReferenceBytes: 980,
} as const)

export type ChatContextFragmentKind =
  | 'persona'
  | 'memory'
  | 'skills'
  | 'output-convention'
  | 'insight-convention'
  | 'activity-convention'
  | 'async'
  | 'peer'
  | 'room'
  | 'file-reference'

export interface ChatContextComposerInput {
  persona?: unknown
  memory?: unknown
  skills?: unknown
  outputConvention?: unknown
  insightConvention?: unknown
  activityConvention?: unknown
  async?: unknown
  peer?: unknown
  room?: unknown
  fileReferences?: unknown
}

export interface ComposedChatContextFragment {
  kind: ChatContextFragmentKind
  owner: 'chat-context-composer'
  placement: 'system' | 'user'
  trust: 'host' | 'untrusted-data'
  maxUtf8Bytes: number
  precedence: number
  originalBytes: number
  includedBytes: number
  truncated: boolean
  text: string
}

export interface ComposedChatContext {
  systemPrompt: string | undefined
  userSuffix: string | undefined
  fragments: readonly ComposedChatContextFragment[]
  metadata: {
    aggregateBytes: number
    maxAggregateBytes: number
    truncatedFragmentCount: number
  }
}

interface FragmentSpec {
  kind: ChatContextFragmentKind
  value: unknown
  maxBytes: number
  placement: 'system' | 'user'
  trust: 'host' | 'untrusted-data'
  open?: string
  close?: string
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function truncationMarker(kind: ChatContextFragmentKind, originalBytes: number, maxBytes: number): string {
  return `[Context truncated: ${kind}; ${originalBytes} original UTF-8 bytes; ${maxBytes} byte limit.]`
}

function boundText(
  kind: ChatContextFragmentKind,
  text: string,
  maxBytes: number,
  open = '',
  close = '',
): { text: string; originalBytes: number; truncated: boolean } {
  const wrapped = [open, text, close].filter(Boolean).join('\n')
  const originalBytes = utf8Bytes(wrapped)
  if (originalBytes <= maxBytes) return { text: wrapped, originalBytes, truncated: false }

  const marker = truncationMarker(kind, originalBytes, maxBytes)
  const fixed = [open, marker, close].filter(Boolean).join('\n')
  const fixedBytes = utf8Bytes(fixed)
  if (fixedBytes >= maxBytes) {
    return { text: utf8Prefix(fixed, maxBytes), originalBytes, truncated: true }
  }
  const separatorBytes = utf8Bytes('\n')
  const bodyBudget = Math.max(0, maxBytes - fixedBytes - separatorBytes)
  const boundedBody = utf8Prefix(text, bodyBudget).trimEnd()
  return {
    text: [open, boundedBody, marker, close].filter(Boolean).join('\n'),
    originalBytes,
    truncated: true,
  }
}

function buildFragment(spec: FragmentSpec, precedence: number): ComposedChatContextFragment | null {
  const text = normalizedText(spec.value)
  if (!text) return null
  const bounded = boundText(spec.kind, text, spec.maxBytes, spec.open, spec.close)
  return Object.freeze({
    kind: spec.kind,
    owner: 'chat-context-composer' as const,
    placement: spec.placement,
    trust: spec.trust,
    maxUtf8Bytes: spec.maxBytes,
    precedence,
    originalBytes: bounded.originalBytes,
    includedBytes: utf8Bytes(bounded.text),
    truncated: bounded.truncated,
    text: bounded.text,
  })
}

/**
 * Compose every model-visible host context source in stable-to-volatile order.
 * Room traffic and expanded file contents remain explicitly untrusted user
 * data; providers must append `userSuffix` to the latest user turn rather than
 * moving it into a system prompt.
 */
export function composeChatContext(input: ChatContextComposerInput): ComposedChatContext {
  const specs: FragmentSpec[] = [
    { kind: 'persona', value: input.persona, maxBytes: CHAT_CONTEXT_LIMITS.personaBytes, placement: 'system', trust: 'host' },
    { kind: 'memory', value: input.memory, maxBytes: CHAT_CONTEXT_LIMITS.memoryBytes, placement: 'system', trust: 'host' },
    { kind: 'skills', value: input.skills, maxBytes: CHAT_CONTEXT_LIMITS.skillsBytes, placement: 'system', trust: 'host' },
    { kind: 'output-convention', value: input.outputConvention, maxBytes: CHAT_CONTEXT_LIMITS.outputConventionBytes, placement: 'system', trust: 'host' },
    { kind: 'insight-convention', value: input.insightConvention, maxBytes: CHAT_CONTEXT_LIMITS.insightConventionBytes, placement: 'system', trust: 'host' },
    { kind: 'activity-convention', value: input.activityConvention, maxBytes: CHAT_CONTEXT_LIMITS.activityConventionBytes, placement: 'system', trust: 'host' },
    { kind: 'async', value: input.async, maxBytes: CHAT_CONTEXT_LIMITS.asyncBytes, placement: 'system', trust: 'host' },
    { kind: 'peer', value: input.peer, maxBytes: CHAT_CONTEXT_LIMITS.peerBytes, placement: 'system', trust: 'host' },
    {
      kind: 'room',
      value: input.room,
      maxBytes: CHAT_CONTEXT_LIMITS.roomBytes,
      placement: 'user',
      trust: 'untrusted-data',
      open: '<codesurf_peer_context trust="untrusted" source="agent-room">',
      close: '</codesurf_peer_context>',
    },
    {
      kind: 'file-reference',
      value: input.fileReferences,
      maxBytes: CHAT_CONTEXT_LIMITS.fileReferenceBytes,
      placement: 'user',
      trust: 'untrusted-data',
      open: '<codesurf_file_context trust="untrusted" source="workspace-files">',
      close: '</codesurf_file_context>',
    },
  ]
  const fragments = specs
    .map((spec, precedence) => buildFragment(spec, precedence))
    .filter((fragment): fragment is ComposedChatContextFragment => fragment !== null)
  const systemPrompt = fragments
    .filter(fragment => fragment.placement === 'system')
    .map(fragment => fragment.text)
    .join('\n\n') || undefined
  const userSuffix = fragments
    .filter(fragment => fragment.placement === 'user')
    .map(fragment => fragment.text)
    .join('\n\n') || undefined
  const aggregate = [systemPrompt, userSuffix].filter(Boolean).join('\n\n')
  const aggregateBytes = utf8Bytes(aggregate)

  if (aggregateBytes > CHAT_CONTEXT_LIMITS.aggregateBytes) {
    throw new Error(`Composed chat context exceeds ${CHAT_CONTEXT_LIMITS.aggregateBytes} UTF-8 bytes`)
  }

  return Object.freeze({
    systemPrompt,
    userSuffix,
    fragments: Object.freeze(fragments),
    metadata: Object.freeze({
      aggregateBytes,
      maxAggregateBytes: CHAT_CONTEXT_LIMITS.aggregateBytes,
      truncatedFragmentCount: fragments.filter(fragment => fragment.truncated).length,
    }),
  })
}
