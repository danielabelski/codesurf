import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { parseRelayMessage, renderRelayMessage } from './markdown'
import type {
  RelayChannel,
  RelayChannelMessageDraft,
  RelayDirectMessageDraft,
  RelayEvent,
  RelayEventMap,
  RelayMailbox,
  RelayMessage,
  RelayMessageListItem,
  RelayMessageMeta,
  RelayMessageStatus,
  RelayParticipant,
  RelayParticipantStatus,
  RelayPriority,
  RelayRelationshipHint,
  RelayWaitOptions,
  RelayWorkContext,
} from './types'

interface RelayPaths {
  root: string
  participants: string
  channels: string
  archive: string
  relationships: string
}

const INVALID_ID_PATTERN = /\.\.|\/|\\|^\.|\0/

export interface CodesurfRelayOptions {
  workspacePath: string
}

function nowStamp(): { iso: string; ts: number } {
  const now = new Date()
  return { iso: now.toISOString(), ts: now.getTime() }
}

function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'message'
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

function validateParticipantId(id: string): void {
  if (!id || typeof id !== 'string') throw new Error('Participant ID is required')
  if (INVALID_ID_PATTERN.test(id)) throw new Error(`Invalid participant ID: ${id}`)
  if (id.length > 128) throw new Error('Participant ID too long (max 128 chars)')
}

function validateChannelId(id: string): void {
  if (!id || typeof id !== 'string') throw new Error('Channel ID is required')
  if (INVALID_ID_PATTERN.test(id)) throw new Error(`Invalid channel ID: ${id}`)
  if (id.length > 128) throw new Error('Channel ID too long (max 128 chars)')
}

async function ensureDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true })
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureDir(join(path, '..'))
  await fs.writeFile(path, JSON.stringify(value, null, 2))
}

async function readMessage(path: string, mailbox: RelayMailbox, filename: string): Promise<RelayMessage | null> {
  try {
    return parseRelayMessage(await fs.readFile(path, 'utf8'), mailbox, filename)
  } catch {
    return null
  }
}

export class CodesurfRelay {
  readonly workspacePath: string
  readonly paths: RelayPaths
  readonly events = new EventEmitter()
  private initialized = false
  private initializing: Promise<void> | null = null

  constructor(options: CodesurfRelayOptions) {
    this.workspacePath = options.workspacePath
    this.paths = {
      root: join(this.workspacePath, '.codesurf', 'relay'),
      participants: join(this.workspacePath, '.codesurf', 'relay', 'participants'),
      channels: join(this.workspacePath, '.codesurf', 'relay', 'channels'),
      archive: join(this.workspacePath, '.codesurf', 'relay', 'archive', 'all'),
      relationships: join(this.workspacePath, '.codesurf', 'relay', 'relationships'),
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return
    if (this.initializing) return this.initializing

    this.initializing = (async () => {
      await Promise.all([
        ensureDir(this.paths.participants),
        ensureDir(this.paths.channels),
        ensureDir(this.paths.archive),
        ensureDir(this.paths.relationships),
      ])

      const systemFile = this.participantFile('system')
      const existing = await readJson<RelayParticipant | null>(systemFile, null)
      if (!existing) {
        const stamp = nowStamp()
        const systemParticipant: RelayParticipant = {
          id: 'system',
          name: 'System',
          kind: 'system',
          status: 'ready',
          channels: [],
          readyAt: stamp.iso,
          readyTs: stamp.ts,
          metadata: {},
        }
        await Promise.all([
          ensureDir(this.participantMailboxDir('system', 'inbox')),
          ensureDir(this.participantMailboxDir('system', 'sent')),
          ensureDir(this.participantMailboxDir('system', 'memory')),
          ensureDir(this.participantMailboxDir('system', 'bin')),
          ensureDir(join(this.participantDir('system'), 'cursors')),
        ])
        await writeJson(systemFile, systemParticipant)
      }

      this.initialized = true
      this.initializing = null
    })()

    return this.initializing
  }

  on(listener: (event: RelayEvent) => void): () => void {
    this.events.on('event', listener)
    return () => this.events.off('event', listener)
  }

  private emit<K extends keyof RelayEventMap>(type: K, payload: RelayEventMap[K]): void {
    this.events.emit('event', { type, timestamp: Date.now(), payload } as RelayEvent)
  }

  participantDir(id: string): string {
    validateParticipantId(id)
    return join(this.paths.participants, id)
  }

  participantFile(id: string): string {
    return join(this.participantDir(id), 'participant.json')
  }

  participantMailboxDir(id: string, mailbox: Exclude<RelayMailbox, 'channel' | 'central'>): string {
    return join(this.participantDir(id), 'mailboxes', mailbox)
  }

  participantCursorFile(id: string, channel: string): string {
    return join(this.participantDir(id), 'cursors', `${channel}.json`)
  }

  channelDir(id: string): string {
    validateChannelId(id)
    return join(this.paths.channels, id)
  }

  channelFile(id: string): string {
    return join(this.channelDir(id), 'channel.json')
  }

  channelMessagesDir(id: string): string {
    return join(this.channelDir(id), 'messages')
  }

  tileMailboxDir(tileId: string, mailbox: Exclude<RelayMailbox, 'channel' | 'central'>): string {
    return join(this.workspacePath, '.codesurf', tileId, 'messages', mailbox)
  }

  async listParticipants(): Promise<RelayParticipant[]> {
    await this.init()
    try {
      const entries = await fs.readdir(this.paths.participants)
      const participants = await Promise.all(entries.map(id => readJson<RelayParticipant | null>(this.participantFile(id), null)))
      return participants.filter(Boolean).sort((a, b) => a!.name.localeCompare(b!.name)) as RelayParticipant[]
    } catch {
      return []
    }
  }

  async getParticipant(id: string): Promise<RelayParticipant | null> {
    await this.init()
    return readJson<RelayParticipant | null>(this.participantFile(id), null)
  }

  async upsertParticipant(input: Partial<RelayParticipant> & Pick<RelayParticipant, 'id' | 'name' | 'kind' | 'status'>): Promise<RelayParticipant> {
    validateParticipantId(input.id)
    await this.init()
    const existing = await this.getParticipant(input.id)
    const participant: RelayParticipant = {
      id: input.id,
      name: input.name,
      kind: input.kind,
      status: input.status,
      task: input.task ?? existing?.task,
      tileId: input.tileId ?? existing?.tileId,
      provider: input.provider ?? existing?.provider,
      model: input.model ?? existing?.model,
      channels: unique(input.channels ?? existing?.channels ?? []),
      readyAt: input.readyAt ?? existing?.readyAt,
      readyTs: input.readyTs ?? existing?.readyTs,
      startedAt: input.startedAt ?? existing?.startedAt,
      startedTs: input.startedTs ?? existing?.startedTs,
      stoppedAt: input.stoppedAt ?? existing?.stoppedAt,
      stoppedTs: input.stoppedTs ?? existing?.stoppedTs,
      work: input.work ?? existing?.work,
      metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
    }

    await Promise.all([
      ensureDir(this.participantMailboxDir(participant.id, 'inbox')),
      ensureDir(this.participantMailboxDir(participant.id, 'sent')),
      ensureDir(this.participantMailboxDir(participant.id, 'memory')),
      ensureDir(this.participantMailboxDir(participant.id, 'bin')),
      ensureDir(join(this.participantDir(participant.id), 'cursors')),
    ])
    await writeJson(this.participantFile(participant.id), participant)

    for (const channel of participant.channels) {
      await this.joinChannel(channel, participant.id)
    }

    this.emit('participant_upserted', { participant })
    if (participant.status === 'ready') {
      this.emit('ready', { participantId: participant.id })
    }
    await this.writeRelationshipsSnapshot()
    return participant
  }

  async setParticipantStatus(participantId: string, status: RelayParticipantStatus): Promise<RelayParticipant> {
    const participant = await this.getParticipant(participantId)
    if (!participant) throw new Error(`Unknown participant: ${participantId}`)
    const stamp = nowStamp()
    const next: RelayParticipant = {
      ...participant,
      status,
      readyAt: status === 'ready' && !participant.readyAt ? stamp.iso : participant.readyAt,
      readyTs: status === 'ready' && !participant.readyTs ? stamp.ts : participant.readyTs,
      startedAt: status === 'running' && !participant.startedAt ? stamp.iso : participant.startedAt,
      startedTs: status === 'running' && !participant.startedTs ? stamp.ts : participant.startedTs,
      stoppedAt: ['done', 'stopped', 'error'].includes(status) ? stamp.iso : participant.stoppedAt,
      stoppedTs: ['done', 'stopped', 'error'].includes(status) ? stamp.ts : participant.stoppedTs,
    }
    await this.upsertParticipant(next)
    this.emit('participant_status', { participantId, status })
    return next
  }

  async updateWorkContext(participantId: string, work: RelayWorkContext): Promise<RelayParticipant> {
    const participant = await this.getParticipant(participantId)
    if (!participant) throw new Error(`Unknown participant: ${participantId}`)
    const stamp = nowStamp()
    return this.upsertParticipant({
      ...participant,
      status: participant.status,
      work: {
        ...participant.work,
        ...work,
        files: unique(work.files ?? participant.work?.files ?? []),
        topics: unique(work.topics ?? participant.work?.topics ?? []),
        collaborators: unique(work.collaborators ?? participant.work?.collaborators ?? []),
        blockers: unique(work.blockers ?? participant.work?.blockers ?? []),
        impacts: work.impacts ?? participant.work?.impacts ?? [],
        updatedAt: stamp.iso,
        updatedTs: stamp.ts,
      },
    })
  }

  async listChannels(): Promise<RelayChannel[]> {
    await this.init()
    try {
      const entries = await fs.readdir(this.paths.channels)
      const channels = await Promise.all(entries.map(id => readJson<RelayChannel | null>(this.channelFile(id), null)))
      return channels.filter(Boolean).sort((a, b) => a!.name.localeCompare(b!.name)) as RelayChannel[]
    } catch {
      return []
    }
  }

  async getChannel(id: string): Promise<RelayChannel | null> {
    await this.init()
    return readJson<RelayChannel | null>(this.channelFile(id), null)
  }

  async upsertChannel(input: Pick<RelayChannel, 'id' | 'name'> & Partial<RelayChannel>): Promise<RelayChannel> {
    await this.init()
    const existing = await this.getChannel(input.id)
    const stamp = nowStamp()
    const channel: RelayChannel = {
      id: input.id,
      name: input.name,
      description: input.description ?? existing?.description,
      members: unique(input.members ?? existing?.members ?? []),
      bridges: input.bridges ?? existing?.bridges ?? [],
      metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
      createdAt: existing?.createdAt ?? stamp.iso,
      createdTs: existing?.createdTs ?? stamp.ts,
      updatedAt: stamp.iso,
      updatedTs: stamp.ts,
    }

    await ensureDir(this.channelMessagesDir(channel.id))
    await writeJson(this.channelFile(channel.id), channel)
    return channel
  }

  async joinChannel(channelId: string, participantId: string): Promise<RelayChannel> {
    const channel = await this.upsertChannel({ id: channelId, name: channelId })
    if (!channel.members.includes(participantId)) {
      const next = await this.upsertChannel({ ...channel, members: [...channel.members, participantId] })
      return next
    }
    return channel
  }

  async leaveChannel(channelId: string, participantId: string): Promise<RelayChannel | null> {
    const channel = await this.getChannel(channelId)
    if (!channel) return null
    return this.upsertChannel({ ...channel, members: channel.members.filter(member => member !== participantId) })
  }

  private async writeMessageCopies(options: {
    filename: string
    meta: RelayMessageMeta
    body: string
    data?: Record<string, unknown>
    sender?: RelayParticipant | null
    recipient?: RelayParticipant | null
    channelId?: string
  }): Promise<RelayMessage> {
    const content = renderRelayMessage(options.meta, options.body, options.data)

    if (options.meta.scope === 'direct' || options.meta.scope === 'system') {
      await Promise.all([
        ensureDir(this.participantMailboxDir(options.meta.from, 'sent')),
        fs.writeFile(join(this.participantMailboxDir(options.meta.from, 'sent'), options.filename), content),
        options.sender?.tileId
          ? (ensureDir(this.tileMailboxDir(options.sender.tileId, 'sent')).then(() => fs.writeFile(join(this.tileMailboxDir(options.sender!.tileId!, 'sent'), options.filename), content)))
          : Promise.resolve(),
      ])

      if (options.meta.to) {
        const inboxMeta: RelayMessageMeta = { ...options.meta, status: 'unread' }
        const inboxContent = renderRelayMessage(inboxMeta, options.body, options.data)
        await Promise.all([
          ensureDir(this.participantMailboxDir(options.meta.to, 'inbox')),
          fs.writeFile(join(this.participantMailboxDir(options.meta.to, 'inbox'), options.filename), inboxContent),
          options.recipient?.tileId
            ? (ensureDir(this.tileMailboxDir(options.recipient.tileId, 'inbox')).then(() => fs.writeFile(join(this.tileMailboxDir(options.recipient!.tileId!, 'inbox'), options.filename), inboxContent)))
            : Promise.resolve(),
        ])
      }
    }

    if (options.meta.scope === 'channel' && options.channelId) {
      await ensureDir(this.channelMessagesDir(options.channelId))
      await fs.writeFile(join(this.channelMessagesDir(options.channelId), options.filename), content)
    }

    await ensureDir(this.paths.archive)
    await fs.writeFile(join(this.paths.archive, options.filename), content)

    return {
      mailbox: options.meta.scope === 'channel' ? 'channel' : 'sent',
      filename: options.filename,
      meta: options.meta,
      body: options.body,
      data: options.data,
    }
  }

  async sendDirectMessage(from: string, draft: RelayDirectMessageDraft): Promise<RelayMessage> {
    await this.init()
    const sender = await this.getParticipant(from)
    const recipient = await this.getParticipant(draft.to)
    if (!sender) throw new Error(`Unknown sender: ${from}`)
    if (!recipient) throw new Error(`Unknown recipient: ${draft.to}`)

    const stamp = nowStamp()
    const id = randomUUID()
    const filename = `${stamp.iso.replace(/[:.]/g, '-')}-${safeSlug(draft.subject)}.md`
    const meta: RelayMessageMeta = {
      protocol: 'codesurf-relay/v1',
      id,
      threadId: draft.threadId ?? id,
      scope: from === 'system' ? 'system' : 'direct',
      kind: draft.kind ?? 'request',
      priority: draft.priority ?? 'normal',
      from,
      to: draft.to,
      subject: draft.subject,
      status: 'sent',
      createdAt: stamp.iso,
      createdTs: stamp.ts,
      updatedAt: stamp.iso,
      updatedTs: stamp.ts,
      replyToId: draft.replyToId,
      bcc: 'central',
    }

    const message = await this.writeMessageCopies({
      filename,
      meta,
      body: draft.body,
      data: draft.data,
      sender,
      recipient,
    })

    this.emit('direct_message', { from, to: draft.to, message })
    this.emit('central_message', { message: { ...message, mailbox: 'central' } })
    return message
  }

  async sendChannelMessage(from: string, draft: RelayChannelMessageDraft): Promise<RelayMessage> {
    await this.init()
    const sender = await this.getParticipant(from)
    if (!sender) throw new Error(`Unknown sender: ${from}`)
    const channel = await this.joinChannel(draft.channel, from)

    const stamp = nowStamp()
    const id = randomUUID()
    const filename = `${stamp.iso.replace(/[:.]/g, '-')}-${safeSlug(draft.subject)}.md`
    const meta: RelayMessageMeta = {
      protocol: 'codesurf-relay/v1',
      id,
      threadId: draft.threadId ?? id,
      scope: 'channel',
      kind: draft.kind ?? 'channel',
      priority: draft.priority ?? 'normal',
      from,
      channel: channel.id,
      subject: draft.subject,
      status: 'sent',
      createdAt: stamp.iso,
      createdTs: stamp.ts,
      updatedAt: stamp.iso,
      updatedTs: stamp.ts,
      replyToId: draft.replyToId,
      bcc: 'central',
    }

    const message = await this.writeMessageCopies({
      filename,
      meta,
      body: draft.body,
      data: draft.data,
      sender,
      channelId: channel.id,
    })

    this.emit('channel_message', { from, channel: channel.id, message })
    this.emit('central_message', { message: { ...message, mailbox: 'central' } })
    return message
  }

  async storeMemory(participantId: string, subject: string, body: string, data?: Record<string, unknown>): Promise<RelayMessage> {
    const participant = await this.getParticipant(participantId)
    if (!participant) throw new Error(`Unknown participant: ${participantId}`)
    const stamp = nowStamp()
    const id = randomUUID()
    const filename = `${stamp.iso.replace(/[:.]/g, '-')}-${safeSlug(subject)}.md`
    const meta: RelayMessageMeta = {
      protocol: 'codesurf-relay/v1',
      id,
      threadId: id,
      scope: 'system',
      kind: 'memory',
      priority: 'normal',
      from: participantId,
      to: participantId,
      subject,
      status: 'archived',
      createdAt: stamp.iso,
      createdTs: stamp.ts,
      updatedAt: stamp.iso,
      updatedTs: stamp.ts,
      bcc: 'central',
    }
    const content = renderRelayMessage(meta, body, data)
    await Promise.all([
      ensureDir(this.participantMailboxDir(participantId, 'memory')),
      fs.writeFile(join(this.participantMailboxDir(participantId, 'memory'), filename), content),
      participant.tileId
        ? ensureDir(this.tileMailboxDir(participant.tileId, 'memory')).then(() => fs.writeFile(join(this.tileMailboxDir(participant.tileId!, 'memory'), filename), content))
        : Promise.resolve(),
      fs.writeFile(join(this.paths.archive, filename), content),
    ])
    return { mailbox: 'memory', filename, meta, body, data }
  }

  async listMessages(participantId: string, mailbox: Exclude<RelayMailbox, 'channel' | 'central'>, limit?: number): Promise<RelayMessageListItem[]> {
    const dir = this.participantMailboxDir(participantId, mailbox)
    try {
      const files = (await fs.readdir(dir)).filter(name => name.endsWith('.md')).sort().reverse()
      const selected = limit ? files.slice(0, limit) : files
      const messages = await Promise.all(selected.map(async filename => {
        const message = await readMessage(join(dir, filename), mailbox, filename)
        return message ? { mailbox, filename, meta: message.meta } : null
      }))
      return messages.filter(Boolean) as RelayMessageListItem[]
    } catch {
      return []
    }
  }

  async readParticipantMessage(participantId: string, mailbox: Exclude<RelayMailbox, 'channel' | 'central'>, filename: string): Promise<RelayMessage | null> {
    return readMessage(join(this.participantMailboxDir(participantId, mailbox), filename), mailbox, filename)
  }

  async updateMessageStatus(participantId: string, mailbox: Exclude<RelayMailbox, 'channel' | 'central'>, filename: string, status: RelayMessageStatus): Promise<boolean> {
    const existing = await this.readParticipantMessage(participantId, mailbox, filename)
    if (!existing) return false
    const stamp = nowStamp()
    const next: RelayMessage = {
      ...existing,
      meta: {
        ...existing.meta,
        status,
        updatedAt: stamp.iso,
        updatedTs: stamp.ts,
      },
    }
    const content = renderRelayMessage(next.meta, next.body, next.data)
    await fs.writeFile(join(this.participantMailboxDir(participantId, mailbox), filename), content)
    const participant = await this.getParticipant(participantId)
    if (participant?.tileId) {
      await ensureDir(this.tileMailboxDir(participant.tileId, mailbox))
      await fs.writeFile(join(this.tileMailboxDir(participant.tileId, mailbox), filename), content)
    }
    return true
  }

  async listChannelMessages(channelId: string, limit?: number): Promise<RelayMessageListItem[]> {
    try {
      const files = (await fs.readdir(this.channelMessagesDir(channelId))).filter(name => name.endsWith('.md')).sort().reverse()
      const selected = limit ? files.slice(0, limit) : files
      const messages = await Promise.all(selected.map(async filename => {
        const message = await readMessage(join(this.channelMessagesDir(channelId), filename), 'channel', filename)
        return message ? { mailbox: 'channel', filename, meta: message.meta } : null
      }))
      return messages.filter(Boolean) as RelayMessageListItem[]
    } catch {
      return []
    }
  }

  async readChannelMessage(channelId: string, filename: string): Promise<RelayMessage | null> {
    return readMessage(join(this.channelMessagesDir(channelId), filename), 'channel', filename)
  }

  async listCentralFeed(limit?: number): Promise<RelayMessageListItem[]> {
    try {
      const files = (await fs.readdir(this.paths.archive)).filter(name => name.endsWith('.md')).sort().reverse()
      const selected = limit ? files.slice(0, limit) : files
      const messages = await Promise.all(selected.map(async filename => {
        const message = await readMessage(join(this.paths.archive, filename), 'central', filename)
        return message ? { mailbox: 'central', filename, meta: message.meta } : null
      }))
      return messages.filter(Boolean) as RelayMessageListItem[]
    } catch {
      return []
    }
  }

  async listUnreadDirectMessages(participantId: string): Promise<RelayMessage[]> {
    const items = await this.listMessages(participantId, 'inbox')
    const unread = items.filter(item => item.meta.status === 'unread')
    const messages = await Promise.all(unread.map(item => this.readParticipantMessage(participantId, 'inbox', item.filename)))
    return messages.filter(Boolean) as RelayMessage[]
  }

  async listUnreadChannelMessages(participantId: string): Promise<RelayMessage[]> {
    const participant = await this.getParticipant(participantId)
    if (!participant) return []
    const all: RelayMessage[] = []
    for (const channel of participant.channels) {
      const cursor = await readJson<{ lastReadTs: number }>(this.participantCursorFile(participantId, channel), { lastReadTs: 0 })
      const items = await this.listChannelMessages(channel)
      const fresh = items.filter(item => item.meta.createdTs > cursor.lastReadTs && item.meta.from !== participantId)
      const messages = await Promise.all(fresh.map(item => this.readChannelMessage(channel, item.filename)))
      all.push(...(messages.filter(Boolean) as RelayMessage[]))
    }
    return all.sort((a, b) => a.meta.createdTs - b.meta.createdTs)
  }

  async markDirectMessagesRead(participantId: string, messages: RelayMessage[]): Promise<void> {
    await Promise.all(messages.map(message => this.updateMessageStatus(participantId, 'inbox', message.filename, 'read')))
  }

  async advanceChannelCursor(participantId: string, channelId: string, timestamp: number): Promise<void> {
    await writeJson(this.participantCursorFile(participantId, channelId), { lastReadTs: timestamp })
  }

  async analyzeRelationships(): Promise<RelayRelationshipHint[]> {
    const participants = (await this.listParticipants()).filter(participant => participant.id !== 'system')
    const hints: RelayRelationshipHint[] = []

    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        const a = participants[i]
        const b = participants[j]
        const sharedChannels = a.channels.filter(channel => b.channels.includes(channel))
        const overlappingFiles = (a.work?.files ?? []).filter(file => (b.work?.files ?? []).includes(file))
        const sameBranch = !!a.work?.branch && a.work?.branch === b.work?.branch
        const sameWorktree = !!a.work?.worktreePath && a.work?.worktreePath === b.work?.worktreePath
        const impacts = [
          ...(a.work?.impacts ?? []).filter(impact => impact.targetType === 'agent' && impact.targetId === b.id),
          ...(b.work?.impacts ?? []).filter(impact => impact.targetType === 'agent' && impact.targetId === a.id),
        ]
        if (!sharedChannels.length && !overlappingFiles.length && !sameBranch && !sameWorktree && !impacts.length) continue

        const parts: string[] = []
        if (sharedChannels.length) parts.push(`share channels ${sharedChannels.join(', ')}`)
        if (overlappingFiles.length) parts.push(`touch the same files (${overlappingFiles.slice(0, 5).join(', ')})`)
        if (sameBranch) parts.push(`are on the same branch ${a.work?.branch}`)
        if (sameWorktree) parts.push('share the same worktree')
        if (impacts.length) parts.push(`have explicit impact alerts (${impacts.map(impact => impact.description).join('; ')})`)

        const priority: RelayPriority = impacts.some(impact => impact.severity === 'high') || overlappingFiles.length > 2
          ? 'critical'
          : sameBranch || sameWorktree || overlappingFiles.length > 0
            ? 'high'
            : 'normal'

        hints.push({
          participants: [a.id, b.id],
          sameBranch,
          sameWorktree,
          sharedChannels,
          overlappingFiles,
          impacts,
          priority,
          summary: `${a.name} and ${b.name} ${parts.join(', ')}`,
        })
      }
    }

    const order: Record<RelayPriority, number> = { critical: 0, high: 1, normal: 2, low: 3 }
    return hints.sort((a, b) => order[a.priority] - order[b.priority] || a.summary.localeCompare(b.summary))
  }

  async writeRelationshipsSnapshot(): Promise<void> {
    const hints = await this.analyzeRelationships()
    await writeJson(join(this.paths.relationships, 'latest.json'), { generatedAt: new Date().toISOString(), hints })
  }

  async waitForReady(ids: string[], options: RelayWaitOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 60_000
    const pending = new Set(ids)
    const current = await this.listParticipants()
    current.filter(participant => participant.status === 'ready').forEach(participant => pending.delete(participant.id))
    if (pending.size === 0) return

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timed out waiting for ready: ${Array.from(pending).join(', ')}`))
      }, timeoutMs)

      const listener = (event: RelayEvent) => {
        if (event.type !== 'ready') return
        pending.delete((event.payload as { participantId: string }).participantId)
        if (pending.size === 0) {
          clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      }

      const unsubscribe = this.on(listener)
    })
  }

  async waitForAny(ids: string[], options: RelayWaitOptions = {}): Promise<RelayParticipant> {
    const timeoutMs = options.timeoutMs ?? 5 * 60_000
    const doneStates = new Set<RelayParticipantStatus>(['done', 'error', 'stopped'])
    const current = await this.listParticipants()
    const immediate = current.find(participant => ids.includes(participant.id) && doneStates.has(participant.status))
    if (immediate) return immediate

    return new Promise<RelayParticipant>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timed out waiting for any of: ${ids.join(', ')}`))
      }, timeoutMs)

      const listener = async (event: RelayEvent) => {
        if (event.type !== 'participant_status') return
        const payload = event.payload as { participantId: string; status: RelayParticipantStatus }
        if (!ids.includes(payload.participantId)) return
        if (!doneStates.has(payload.status)) return
        clearTimeout(timer)
        unsubscribe()
        const participant = await this.getParticipant(payload.participantId)
        if (!participant) return reject(new Error(`Participant disappeared: ${payload.participantId}`))
        resolve(participant)
      }

      const unsubscribe = this.on(listener)
    })
  }

  async moveMessage(participantId: string, fromMailbox: Exclude<RelayMailbox, 'channel' | 'central'>, toMailbox: Exclude<RelayMailbox, 'channel' | 'central'>, filename: string): Promise<boolean> {
    try {
      await ensureDir(this.participantMailboxDir(participantId, toMailbox))
      await fs.rename(
        join(this.participantMailboxDir(participantId, fromMailbox), filename),
        join(this.participantMailboxDir(participantId, toMailbox), basename(filename)),
      )
      const participant = await this.getParticipant(participantId)
      if (participant?.tileId) {
        await ensureDir(this.tileMailboxDir(participant.tileId, toMailbox))
        await fs.rename(
          join(this.tileMailboxDir(participant.tileId, fromMailbox), filename),
          join(this.tileMailboxDir(participant.tileId, toMailbox), basename(filename)),
        ).catch(() => undefined)
      }
      return true
    } catch {
      return false
    }
  }
}
