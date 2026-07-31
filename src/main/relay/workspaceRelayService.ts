import type {
  CodesurfRelay,
  RelayAgentExecutor,
  RelayEvent,
  RelayOperationContext,
  RelayParticipant,
  RelayRuntimeOptions,
  RelaySpawnRequest,
  RelayTurnInput,
} from '../../../packages/codesurf-relay/src/index.ts'
import type { TileState } from '../../shared/types'

export type RelayOperationGuard = {
  isActive: () => boolean
}

type RelayRuntimeLike = {
  spawn(request: RelaySpawnRequest): Promise<RelayParticipant>
  stop(participantId: string): Promise<void>
  destroy(): void
}

export type WorkspaceRelayInstance = {
  relay: CodesurfRelay
  runtime: RelayRuntimeLike
  unsubscribe: () => void
  generation: number
  disposed: boolean
}

export type WorkspaceRelayServiceDependencies = {
  createRelay: (workspacePath: string) => CodesurfRelay
  createRuntime: (
    relay: CodesurfRelay,
    options: RelayRuntimeOptions,
  ) => RelayRuntimeLike
  createExecutor: (
    participant: RelayParticipant,
    request: RelaySpawnRequest,
  ) => RelayAgentExecutor
  readTileState: (workspaceId: string, tileId: string) => Promise<any | null>
  broadcast: (event: RelayEvent, workspacePath: string) => void
}

type RelayLifecycleGuard = RelayOperationGuard & {
  generation: number
  signal: AbortSignal
}

export class RelayOperationCancelledError extends Error {
  constructor() {
    super('Relay operation was cancelled during lifecycle transition')
    this.name = 'RelayOperationCancelledError'
  }
}

export class WorkspaceRelayService {
  private readonly dependencies: WorkspaceRelayServiceDependencies
  private readonly instances = new Map<string, WorkspaceRelayInstance>()
  private generation = 0
  private active = false
  private abortController: AbortController | null = null

  constructor(dependencies: WorkspaceRelayServiceDependencies) {
    this.dependencies = dependencies
  }

  start(): void {
    if (this.active) return
    this.generation += 1
    this.abortController = new AbortController()
    this.active = true
  }

  captureGeneration(): number | null {
    return this.active ? this.generation : null
  }

  isGenerationActive(generation: number): boolean {
    return this.active && this.generation === generation
  }

  activeInstanceCount(): number {
    return this.instances.size
  }

  async getWorkspaceRelay(
    workspacePath: string,
    guard?: RelayOperationGuard,
  ): Promise<WorkspaceRelayInstance> {
    const lifecycleGuard = this.captureOperationGuard(guard)
    const instance = await this.getWorkspaceRelayForGuard(
      workspacePath,
      lifecycleGuard,
    )
    this.assertActive(lifecycleGuard)
    return instance
  }

  async syncWorkspaceRelayParticipants(
    workspaceId: string,
    workspacePath: string,
    tiles: TileState[],
    guard?: RelayOperationGuard,
  ): Promise<RelayParticipant[]> {
    let lifecycleGuard: RelayLifecycleGuard
    try {
      lifecycleGuard = this.captureOperationGuard(guard)
    } catch (error) {
      if (error instanceof RelayOperationCancelledError) return []
      throw error
    }

    try {
      const { relay } = await this.getWorkspaceRelayForGuard(
        workspacePath,
        lifecycleGuard,
      )
      const operationContext = this.createRelayOperationContext(lifecycleGuard)
      const seen = new Set<string>()

      for (const tile of tiles) {
        if (tile.type !== 'chat') continue
        const tileState = await this.awaitGuarded(
          () => this.dependencies.readTileState(workspaceId, tile.id),
          lifecycleGuard,
        )
        const provider = tileState?.provider ?? 'claude'
        const model = tileState?.model ?? undefined
        const agentMode = Boolean(tileState?.agentMode)
        const name = (tileState?.title as string | undefined)
          ?? `Agent ${tile.id.slice(-4)}`

        seen.add(tile.id)
        await this.awaitGuarded(
          () => relay.upsertParticipant({
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
          }, operationContext),
          lifecycleGuard,
        )
      }

      const existing = await this.awaitGuarded(
        () => relay.listParticipants(),
        lifecycleGuard,
      )
      const stale = existing.filter(participant => (
        participant.kind === 'agent'
        && participant.tileId
        && !seen.has(participant.tileId)
      ))
      for (const participant of stale) {
        await this.awaitGuarded(
          () => relay.setParticipantStatus(
            participant.id,
            'stopped',
            operationContext,
          ),
          lifecycleGuard,
        )
      }

      return await this.awaitGuarded(
        () => relay.listParticipants(),
        lifecycleGuard,
      )
    } catch (error) {
      if (error instanceof RelayOperationCancelledError) return []
      throw error
    }
  }

  stopAll(): void {
    this.active = false
    this.abortController?.abort()
    this.abortController = null
    for (const instance of this.instances.values()) {
      this.disposeInstance(instance)
    }
    this.instances.clear()
  }

  private captureOperationGuard(
    guard?: RelayOperationGuard,
  ): RelayLifecycleGuard {
    const generation = this.captureGeneration()
    const signal = this.abortController?.signal
    if (generation === null || !signal) {
      throw new RelayOperationCancelledError()
    }
    const lifecycleGuard: RelayLifecycleGuard = {
      generation,
      signal,
      isActive: () => (
        this.isGenerationActive(generation)
        && (guard?.isActive() ?? true)
      ),
    }
    this.assertActive(lifecycleGuard)
    return lifecycleGuard
  }

  private assertActive(guard: RelayOperationGuard): void {
    if (!guard.isActive()) throw new RelayOperationCancelledError()
  }

  private createRelayOperationContext(
    guard: RelayLifecycleGuard,
  ): RelayOperationContext {
    return {
      assertActive: () => this.assertActive(guard),
      signal: guard.signal,
    }
  }

  private async awaitGuarded<T>(
    operation: () => Promise<T>,
    guard: RelayLifecycleGuard,
  ): Promise<T> {
    this.assertActive(guard)
    let cancel!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new RelayOperationCancelledError())
    })
    guard.signal.addEventListener('abort', cancel, { once: true })
    try {
      const result = await Promise.race([operation(), cancelled])
      this.assertActive(guard)
      return result
    } catch (error) {
      this.assertActive(guard)
      throw error
    } finally {
      guard.signal.removeEventListener('abort', cancel)
    }
  }

  private createGuardedExecutor(
    participant: RelayParticipant,
    request: RelaySpawnRequest,
    guard: RelayLifecycleGuard,
  ): RelayAgentExecutor {
    this.assertActive(guard)
    const executor = this.dependencies.createExecutor(participant, request)
    this.assertActive(guard)
    return {
      runTurn: async (input: RelayTurnInput): Promise<string> => {
        return this.awaitGuarded(
          () => executor.runTurn(input),
          guard,
        )
      },
    }
  }

  private async getWorkspaceRelayForGuard(
    workspacePath: string,
    guard: RelayLifecycleGuard,
  ): Promise<WorkspaceRelayInstance> {
    this.assertActive(guard)
    const existing = this.instances.get(workspacePath)
    if (existing && existing.generation === guard.generation) {
      this.assertActive(guard)
      return existing
    }
    if (existing) {
      this.instances.delete(workspacePath)
      this.disposeInstance(existing)
    }

    const relay = this.dependencies.createRelay(workspacePath)
    this.assertActive(guard)
    await this.awaitGuarded(
      () => relay.init(this.createRelayOperationContext(guard)),
      guard,
    )

    const raced = this.instances.get(workspacePath)
    if (raced && raced.generation === guard.generation) {
      this.assertActive(guard)
      return raced
    }
    if (raced) {
      this.instances.delete(workspacePath)
      this.disposeInstance(raced)
    }

    let runtime: RelayRuntimeLike | null = null
    let unsubscribe: (() => void) | null = null
    let published: WorkspaceRelayInstance | null = null
    try {
      this.assertActive(guard)
      runtime = this.dependencies.createRuntime(relay, {
        executorFactory: (participant, request) => (
          this.createGuardedExecutor(participant, request, guard)
        ),
        assertActive: () => this.assertActive(guard),
      })
      this.assertActive(guard)
      unsubscribe = relay.on(event => {
        if (guard.isActive()) this.dependencies.broadcast(event, workspacePath)
      })
      this.assertActive(guard)

      published = {
        relay,
        runtime,
        unsubscribe,
        generation: guard.generation,
        disposed: false,
      }
      this.assertActive(guard)
      this.instances.set(workspacePath, published)
      this.assertActive(guard)
      return published
    } catch (error) {
      if (published && this.instances.get(workspacePath) === published) {
        this.instances.delete(workspacePath)
      }
      if (published) {
        this.disposeInstance(published)
      } else {
        try {
          unsubscribe?.()
        } catch {}
        try {
          runtime?.destroy()
        } catch {}
      }
      throw error
    }
  }

  private disposeInstance(instance: WorkspaceRelayInstance): void {
    if (instance.disposed) return
    instance.disposed = true
    try {
      instance.unsubscribe()
    } catch {}
    try {
      instance.runtime.destroy()
    } catch {}
  }
}
