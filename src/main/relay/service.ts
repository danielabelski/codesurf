import type {
  CodesurfRelay,
  RelayChannelMessageDraft,
  RelayDirectMessageDraft,
  RelayEvent,
  RelayParticipant,
  RelaySpawnRequest,
} from '../../../packages/codesurf-relay/src'
import { CodesurfRelay as RelayCore, RelayRuntime } from '../../../packages/codesurf-relay/src'
import type { TileState } from '../../shared/types'
import { bus } from '../event-bus'
import { broadcastToRenderer } from '../utils/broadcast'
import { loadWorkspaceTileState } from '../storage/workspaceArtifacts'
import { createMainProcessRelayExecutor } from './provider-executor'

interface WorkspaceRelayInstance {
  relay: CodesurfRelay
  runtime: RelayRuntime
  unsubscribe: () => void
}

const instances = new Map<string, WorkspaceRelayInstance>()
let relayServiceGeneration = 0
let relayServicesActive = false

export type RelayOperationGuard = {
  isActive: () => boolean
}

class RelayOperationCancelledError extends Error {
  constructor() {
    super('Relay operation was cancelled during lifecycle transition')
    this.name = 'RelayOperationCancelledError'
  }
}

export function startRelayServices(): void {
  relayServicesActive = true
  relayServiceGeneration += 1
}

export function captureRelayServiceGeneration(): number | null {
  return relayServicesActive ? relayServiceGeneration : null
}

export function isRelayServiceGenerationActive(generation: number): boolean {
  return relayServicesActive && relayServiceGeneration === generation
}

function broadcast(event: RelayEvent, workspacePath: string): void {
  const channel = event.type === 'channel_message' && 'channel' in event.payload
    ? `relay:channel:${event.payload.channel}`
    : event.type === 'direct_message' && 'to' in event.payload
      ? `relay:participant:${event.payload.to}`
      : 'relay:system'

  bus.publish({
    channel,
    type: 'data',
    source: 'relay',
    payload: { workspacePath, event },
  })

  broadcastToRenderer('relay:event', { workspacePath, event })
}

async function readTileState(workspaceId: string, tileId: string): Promise<any | null> {
  return loadWorkspaceTileState(workspaceId, tileId, null)
}

export async function getWorkspaceRelay(
  workspacePath: string,
  guard?: RelayOperationGuard,
): Promise<WorkspaceRelayInstance> {
  if (guard && !guard.isActive()) throw new RelayOperationCancelledError()
  const existing = instances.get(workspacePath)
  if (existing) return existing

  const relay = new RelayCore({ workspacePath })
  await relay.init()
  if (guard && !guard.isActive()) throw new RelayOperationCancelledError()

  const raced = instances.get(workspacePath)
  if (raced) return raced
  const runtime = new RelayRuntime(relay, {
    executorFactory: (participant, spawn) => createMainProcessRelayExecutor(participant.id, spawn),
  })
  const unsubscribe = relay.on(event => broadcast(event, workspacePath))
  if (guard && !guard.isActive()) {
    unsubscribe()
    runtime.destroy()
    throw new RelayOperationCancelledError()
  }
  const instance = { relay, runtime, unsubscribe }
  instances.set(workspacePath, instance)
  return instance
}

export async function syncWorkspaceRelayParticipants(
  workspaceId: string,
  workspacePath: string,
  tiles: TileState[],
  guard?: RelayOperationGuard,
): Promise<RelayParticipant[]> {
  const isActive = (): boolean => guard?.isActive() ?? true
  if (!isActive()) return []
  let relay: CodesurfRelay
  try {
    ({ relay } = await getWorkspaceRelay(workspacePath, guard))
  } catch (error) {
    if (error instanceof RelayOperationCancelledError) return []
    throw error
  }
  if (!isActive()) return []
  const seen = new Set<string>()

  for (const tile of tiles) {
    if (tile.type !== 'chat') continue
    const tileState = await readTileState(workspaceId, tile.id)
    if (!isActive()) return []
    const provider = tileState?.provider ?? 'claude'
    const model = tileState?.model ?? undefined
    const agentMode = Boolean(tileState?.agentMode)
    const name = (tileState?.title as string | undefined) ?? `Agent ${tile.id.slice(-4)}`

    seen.add(tile.id)
    await relay.upsertParticipant({
      id: tile.id,
      name,
      kind: 'agent',
      status: agentMode ? 'ready' : 'stopped',
      tileId: tile.id,
      provider,
      model,
      channels: [],
      metadata: {
        tileType: tile.type,
        x: tile.x,
        y: tile.y,
        width: tile.width,
        height: tile.height,
        agentMode,
      },
    })
    if (!isActive()) return []
  }

  const existing = await relay.listParticipants()
  if (!isActive()) return []
  const stale = existing.filter(participant => participant.kind === 'agent' && participant.tileId && !seen.has(participant.tileId))
  for (const participant of stale) {
    await relay.setParticipantStatus(participant.id, 'stopped')
    if (!isActive()) return []
  }

  if (!isActive()) return []
  return relay.listParticipants()
}

export async function spawnWorkspaceRelayAgent(workspacePath: string, request: RelaySpawnRequest): Promise<RelayParticipant> {
  const { runtime } = await getWorkspaceRelay(workspacePath)
  return runtime.spawn(request)
}

export async function stopWorkspaceRelayAgent(workspacePath: string, participantId: string): Promise<void> {
  const { runtime } = await getWorkspaceRelay(workspacePath)
  await runtime.stop(participantId)
}

export async function sendWorkspaceDirectRelayMessage(workspacePath: string, from: string, draft: RelayDirectMessageDraft) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.sendDirectMessage(from, draft)
}

export async function sendWorkspaceChannelRelayMessage(workspacePath: string, from: string, draft: RelayChannelMessageDraft) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.sendChannelMessage(from, draft)
}

export async function listWorkspaceRelayParticipants(workspacePath: string) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.listParticipants()
}

export async function listWorkspaceRelayChannels(workspacePath: string) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.listChannels()
}

export async function listWorkspaceRelayCentralFeed(workspacePath: string, limit?: number) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.listCentralFeed(limit)
}

export async function listWorkspaceRelayMessages(workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', limit?: number) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.listMessages(participantId, mailbox, limit)
}

export async function readWorkspaceRelayMessage(workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.readParticipantMessage(participantId, mailbox, filename)
}

export async function updateWorkspaceRelayMessageStatus(workspacePath: string, participantId: string, mailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string, status: 'unread' | 'read' | 'sent' | 'archived') {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.updateMessageStatus(participantId, mailbox, filename, status)
}

export async function moveWorkspaceRelayMessage(workspacePath: string, participantId: string, fromMailbox: 'inbox' | 'sent' | 'memory' | 'bin', toMailbox: 'inbox' | 'sent' | 'memory' | 'bin', filename: string) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.moveMessage(participantId, fromMailbox, toMailbox, filename)
}

export async function setWorkspaceRelayWorkContext(workspacePath: string, participantId: string, work: any) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.updateWorkContext(participantId, work)
}

export async function analyzeWorkspaceRelayRelationships(workspacePath: string) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.analyzeRelationships()
}

export async function waitForWorkspaceRelayReady(workspacePath: string, ids: string[], timeoutMs?: number) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  await relay.waitForReady(ids, { timeoutMs })
  return true
}

export async function waitForWorkspaceRelayAny(workspacePath: string, ids: string[], timeoutMs?: number) {
  const { relay } = await getWorkspaceRelay(workspacePath)
  return relay.waitForAny(ids, { timeoutMs })
}

export function stopAllRelayServices(): void {
  relayServicesActive = false
  relayServiceGeneration += 1
  for (const instance of instances.values()) {
    instance.unsubscribe()
    instance.runtime.destroy()
  }
  instances.clear()
}
