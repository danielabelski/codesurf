import { createHash } from 'node:crypto'
import {
  chatStreamScopeKey,
  type ChatStreamScope,
} from './room-stream-scope.ts'

/**
 * Providers without a true system channel carry host-owned stable context in a
 * user turn. Remember which version was installed in the active provider
 * session so resumed turns only contain the current user/room/file context.
 *
 * The cache stores hashes, never prompt bodies, and is intentionally process
 * local: an app/provider process restart must install the stable context again.
 */
export const MAX_STABLE_SESSION_CONTEXTS = 256

interface StableContextEntry {
  scopeKey: string
  provider: string
  sessionId: string | null
  contextHash: string
}

export interface StableContextTurnInput {
  scope: ChatStreamScope
  provider: string
  sessionId?: string | null
  contextPrompt?: string
}

export interface StableContextSelection {
  readonly cacheKey: string
  readonly scopeKey: string
  readonly provider: string
  readonly generation: number
  readonly sessionId: string | null
  readonly contextHash: string
  readonly installsContext: boolean
  readonly contextPrompt: string | undefined
}

export interface StableContextCompletion {
  readonly accepted: boolean
  readonly sessionId?: string | null
}

export interface StableContextCliCompletion {
  readonly exitCode: number | null
  readonly sawProviderAcceptance: boolean
  readonly providerError?: boolean
  readonly sessionId?: string | null
}

export function hasNonEmptyProviderResult(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizedProvider(provider: string): string {
  return String(provider ?? '').trim()
}

function normalizedSessionId(sessionId: string | null | undefined): string | null {
  const value = String(sessionId ?? '').trim()
  return value || null
}

function normalizedContext(contextPrompt: string | undefined): string {
  return String(contextPrompt ?? '').trim()
}

function contextHash(contextPrompt: string): string {
  return createHash('sha256').update(contextPrompt, 'utf8').digest('hex')
}

function stableContextKey(scope: ChatStreamScope, provider: string): string {
  return JSON.stringify([
    scope.workspaceId,
    scope.cardId,
    normalizedProvider(provider),
  ])
}

/** Fixed-size LRU used by the Electron runtime and directly in lifecycle tests. */
export class StableSessionContextCache {
  private readonly entries = new Map<string, StableContextEntry>()
  private readonly latestSelections = new Map<string, number>()
  private readonly maxEntries: number
  private generation = 0

  constructor(maxEntries = MAX_STABLE_SESSION_CONTEXTS) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error('Stable session context cache size must be a positive integer')
    }
    this.maxEntries = maxEntries
  }

  get size(): number {
    return this.entries.size
  }

  /**
   * Select the stable prefix for one provider turn. An unchanged context is
   * omitted only when it was committed in this exact active session. Selection
   * itself never marks context installed.
   */
  select(input: StableContextTurnInput): StableContextSelection {
    const provider = normalizedProvider(input.provider)
    const scopeKey = chatStreamScopeKey(input.scope)
    const cacheKey = stableContextKey(input.scope, provider)
    const sessionId = normalizedSessionId(input.sessionId)
    const prompt = normalizedContext(input.contextPrompt)
    const hash = contextHash(prompt)
    const current = this.entries.get(cacheKey)
    const installsContext = !current
      || sessionId === null
      || current.sessionId !== sessionId
      || current.contextHash !== hash
    const generation = ++this.generation

    if (current && !installsContext) {
      this.entries.delete(cacheKey)
      this.entries.set(cacheKey, current)
    }
    this.latestSelections.delete(cacheKey)
    this.latestSelections.set(cacheKey, generation)
    this.evictOldest(this.latestSelections)

    return Object.freeze({
      cacheKey,
      scopeKey,
      provider,
      generation,
      sessionId,
      contextHash: hash,
      installsContext,
      contextPrompt: installsContext && prompt ? prompt : undefined,
    })
  }

  /**
   * Commit an accepted selection against the real session id returned by the
   * provider. A supposedly resumed turn that unexpectedly moves to a new id
   * without sending context is deliberately not committed.
   */
  bindSession(selection: StableContextSelection, sessionId: string | null | undefined): boolean {
    const boundSessionId = normalizedSessionId(sessionId)
    if (!boundSessionId) return false
    if (this.latestSelections.get(selection.cacheKey) !== selection.generation) return false
    const current = this.entries.get(selection.cacheKey)

    if (!selection.installsContext) {
      if (
        current?.sessionId === boundSessionId
        && current.contextHash === selection.contextHash
      ) {
        this.entries.delete(selection.cacheKey)
        this.entries.set(selection.cacheKey, current)
        return true
      }
      return false
    }

    this.entries.delete(selection.cacheKey)
    this.entries.set(selection.cacheKey, {
      scopeKey: selection.scopeKey,
      provider: selection.provider,
      sessionId: boundSessionId,
      contextHash: selection.contextHash,
    })
    this.evictOldest(this.entries)
    return true
  }

  /** Commit only after an adapter proves prompt acceptance and a real session. */
  complete(selection: StableContextSelection, completion: StableContextCompletion): boolean {
    if (!completion.accepted) {
      this.invalidate(selection)
      return false
    }
    const committed = this.bindSession(selection, completion.sessionId)
    if (!committed) this.invalidate(selection)
    return committed
  }

  completeCli(selection: StableContextSelection, completion: StableContextCliCompletion): boolean {
    return this.complete(selection, {
      accepted: completion.exitCode === 0
        && completion.sawProviderAcceptance
        && completion.providerError !== true,
      sessionId: completion.sessionId,
    })
  }

  /** Retry safely after a provider rejected/failed before installing context. */
  invalidate(selection: StableContextSelection): void {
    if (this.latestSelections.get(selection.cacheKey) === selection.generation) {
      this.latestSelections.delete(selection.cacheKey)
    }
  }

  clear(scope: ChatStreamScope, provider?: string): void {
    const scopeKey = chatStreamScopeKey(scope)
    const normalized = provider === undefined ? undefined : normalizedProvider(provider)
    for (const [key, entry] of this.entries) {
      if (entry.scopeKey === scopeKey && (normalized === undefined || entry.provider === normalized)) {
        this.entries.delete(key)
        this.latestSelections.delete(key)
      }
    }
    if (normalized !== undefined) {
      this.latestSelections.delete(stableContextKey(scope, normalized))
    } else {
      for (const key of this.latestSelections.keys()) {
        const parsed = JSON.parse(key)
        if (parsed[0] === scope.workspaceId && parsed[1] === scope.cardId) {
          this.latestSelections.delete(key)
        }
      }
    }
  }

  private evictOldest<T>(cache: Map<string, T>): void {
    while (cache.size > this.maxEntries) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) return
      cache.delete(oldest)
    }
  }
}

const stableSessionContexts = new StableSessionContextCache()

export function selectStableContextForTurn(input: StableContextTurnInput): StableContextSelection {
  return stableSessionContexts.select(input)
}

export function bindStableContextSession(
  selection: StableContextSelection,
  sessionId: string | null | undefined,
): boolean {
  return stableSessionContexts.bindSession(selection, sessionId)
}

export function completeStableContextTurn(
  selection: StableContextSelection,
  completion: StableContextCompletion,
): boolean {
  return stableSessionContexts.complete(selection, completion)
}

export function completeStableContextCliTurn(
  selection: StableContextSelection,
  completion: StableContextCliCompletion,
): boolean {
  return stableSessionContexts.completeCli(selection, completion)
}

export function invalidateStableContextSelection(selection: StableContextSelection): void {
  stableSessionContexts.invalidate(selection)
}

export function clearStableSessionContext(scope: ChatStreamScope, provider?: string): void {
  stableSessionContexts.clear(scope, provider)
}
