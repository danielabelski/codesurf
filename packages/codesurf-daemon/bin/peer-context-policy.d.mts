export interface BoundedPeerAction {
  name: string
  description: string
}

export interface BoundedPeerContextEntry {
  key: string
  value: string
}

export interface BoundedPeerContext {
  peerId: string
  peerType: string
  tools: string[]
  actions: BoundedPeerAction[]
  contextEntries: BoundedPeerContextEntry[]
  notices: string[]
}

export interface PeerContextPolicyMetadata {
  originalPeerCount: number
  includedPeerCount: number
  omittedPeerCount: number
  malformedPeerCount: number
  truncatedFieldCount: number
  omittedFieldCount: number
  renderedPeerCount: number
  renderedBytes: number
  promptTruncated: boolean
}

export interface PeerContextPolicyResult {
  peers: BoundedPeerContext[]
  fragment: Readonly<{
    owner: 'peer-context-policy'
    volatility: 'per-turn'
    maxUtf8Bytes: number
    text: string
  }> | undefined
  metadata: PeerContextPolicyMetadata
}

export const PEER_CONTEXT_LIMITS: Readonly<{
  peers: 16
  peerIdBytes: 128
  peerTypeBytes: 64
  toolsPerPeer: 48
  toolNameBytes: 128
  actionsPerPeer: 24
  actionNameBytes: 128
  actionDescriptionBytes: 512
  contextEntriesPerPeer: 32
  contextKeyBytes: 128
  contextValueBytes: 1024
  contextNodesPerValue: 128
  contextDepth: 6
  containerEntries: 32
  collectionInspectionEntries: 256
  peerRenderedBytes: 256
  promptRenderedBytes: number
}>

export function buildPeerContextPrompt(value: unknown): PeerContextPolicyResult
