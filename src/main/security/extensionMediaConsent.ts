import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { CODESURF_HOME } from '../paths.ts'
import { isValidExtensionId } from '../extensions/identity.ts'
import {
  isSensitiveMediaCapability,
  type SensitiveMediaCapability,
} from '../../shared/extension-sensitive-media.ts'

export type ExtensionMediaConsentDecision = 'allow' | 'deny'

interface PersistedConsent {
  readonly version: 1
  readonly decisions: Record<
    string,
    Partial<Record<SensitiveMediaCapability, ExtensionMediaConsentDecision>>
  >
}

export interface ExtensionMediaConsentPrompt {
  readonly extensionId: string
  readonly extensionName: string
  readonly kind: SensitiveMediaCapability
  readonly owner?: unknown
}

export interface ExtensionMediaConsentStoreOptions {
  readonly filePath?: string
}

const DEFAULT_CONSENT_PATH = join(CODESURF_HOME, 'extension-sensitive-media-consent.json')

function emptyConsent(): PersistedConsent {
  return { version: 1, decisions: {} }
}

function parseConsent(raw: string): PersistedConsent {
  try {
    const parsed = JSON.parse(raw) as {
      version?: unknown
      decisions?: unknown
    }
    if (parsed.version !== 1 || !parsed.decisions || typeof parsed.decisions !== 'object') {
      return emptyConsent()
    }

    const decisions: PersistedConsent['decisions'] = {}
    for (const [extensionId, value] of Object.entries(parsed.decisions)) {
      if (!isValidExtensionId(extensionId) || !value || typeof value !== 'object') continue
      const extensionDecisions: Partial<
        Record<SensitiveMediaCapability, ExtensionMediaConsentDecision>
      > = {}
      for (const [kind, decision] of Object.entries(value)) {
        if (
          isSensitiveMediaCapability(kind)
          && (decision === 'allow' || decision === 'deny')
        ) {
          extensionDecisions[kind] = decision
        }
      }
      if (Object.keys(extensionDecisions).length > 0) {
        decisions[extensionId] = extensionDecisions
      }
    }
    return { version: 1, decisions }
  } catch {
    return emptyConsent()
  }
}

export class ExtensionMediaConsentStore {
  private readonly filePath: string
  private readonly loadPromise: Promise<void>
  private persisted = emptyConsent()
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options?: ExtensionMediaConsentStoreOptions) {
    this.filePath = options?.filePath ?? DEFAULT_CONSENT_PATH
    this.loadPromise = this.load()
  }

  get ready(): Promise<void> {
    return this.loadPromise
  }

  getDecision(
    extensionId: string,
    kind: SensitiveMediaCapability,
  ): ExtensionMediaConsentDecision | undefined {
    if (!isValidExtensionId(extensionId)) return undefined
    return this.persisted.decisions[extensionId]?.[kind]
  }

  async setDecision(
    extensionId: string,
    kind: SensitiveMediaCapability,
    decision: ExtensionMediaConsentDecision,
  ): Promise<void> {
    if (!isValidExtensionId(extensionId)) {
      throw new Error(`Invalid extension id: ${extensionId}`)
    }
    await this.ready
    this.persisted.decisions[extensionId] = {
      ...this.persisted.decisions[extensionId],
      [kind]: decision,
    }
    await this.persist()
  }

  async revokeExtension(extensionId: string): Promise<void> {
    if (!isValidExtensionId(extensionId)) return
    await this.ready
    if (!(extensionId in this.persisted.decisions)) return
    delete this.persisted.decisions[extensionId]
    await this.persist()
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      this.persisted = parseConsent(raw)
      await fs.chmod(this.filePath, 0o600)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') this.persisted = emptyConsent()
    }
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.persisted, null, 2)
    const run = async (): Promise<void> => {
      const directory = dirname(this.filePath)
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      const temporaryPath = join(
        directory,
        `.${basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`,
      )
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined
      try {
        handle = await fs.open(temporaryPath, 'wx', 0o600)
        await handle.writeFile(snapshot, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await fs.rename(temporaryPath, this.filePath)
        await fs.chmod(this.filePath, 0o600)
      } finally {
        await handle?.close().catch(() => undefined)
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
      }
    }
    const result = this.writeQueue.then(run, run)
    this.writeQueue = result.catch(() => undefined)
    await result
  }
}

export class ExtensionMediaConsentManager {
  private readonly pendingByKey = new Map<string, Promise<boolean>>()
  private readonly extensionGenerations = new Map<string, number>()
  private promptQueue: Promise<void> = Promise.resolve()
  private readonly store: ExtensionMediaConsentStore
  private readonly prompt: (
    request: ExtensionMediaConsentPrompt,
  ) => Promise<boolean>

  constructor(
    store: ExtensionMediaConsentStore,
    prompt: (request: ExtensionMediaConsentPrompt) => Promise<boolean>,
  ) {
    this.store = store
    this.prompt = prompt
  }

  get ready(): Promise<void> {
    return this.store.ready
  }

  hasConsent(extensionId: string, kind: SensitiveMediaCapability): boolean {
    return this.store.getDecision(extensionId, kind) === 'allow'
  }

  async requestConsent(request: ExtensionMediaConsentPrompt): Promise<boolean> {
    if (!isValidExtensionId(request.extensionId)) return false
    await this.ready
    const stored = this.store.getDecision(request.extensionId, request.kind)
    if (stored) return stored === 'allow'

    const key = `${request.extensionId}:${request.kind}`
    const pending = this.pendingByKey.get(key)
    if (pending) return pending
    const generation = this.extensionGenerations.get(request.extensionId) ?? 0

    const promptResult = this.promptQueue.then(async () => {
      if ((this.extensionGenerations.get(request.extensionId) ?? 0) !== generation) {
        return false
      }
      const current = this.store.getDecision(request.extensionId, request.kind)
      if (current) return current === 'allow'
      let allowed = false
      try {
        allowed = await this.prompt(request)
      } catch {
        allowed = false
      }
      if ((this.extensionGenerations.get(request.extensionId) ?? 0) !== generation) {
        return false
      }
      await this.store.setDecision(
        request.extensionId,
        request.kind,
        allowed ? 'allow' : 'deny',
      )
      if ((this.extensionGenerations.get(request.extensionId) ?? 0) !== generation) {
        await this.store.revokeExtension(request.extensionId)
        return false
      }
      return allowed
    })
    this.promptQueue = promptResult.then(
      () => undefined,
      () => undefined,
    )
    this.pendingByKey.set(key, promptResult)
    const cleanUp = (): void => {
      if (this.pendingByKey.get(key) === promptResult) {
        this.pendingByKey.delete(key)
      }
    }
    void promptResult.then(cleanUp, cleanUp)
    return promptResult
  }

  revokeExtension(extensionId: string): Promise<void> {
    this.extensionGenerations.set(
      extensionId,
      (this.extensionGenerations.get(extensionId) ?? 0) + 1,
    )
    return this.store.revokeExtension(extensionId)
  }
}
