import type { AppSettings, ExecutionHostRecord, ProjectRecord, Workspace } from '../../shared/types'
import type { AggregatedSessionEntry } from '../../shared/session-types'
import { ensureDaemonRunning, getDaemonStatus, invalidateDaemonCache } from './manager'

type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
}

type DaemonSkillEntry = {
  id: string
  name: string
  description: string
  scope: 'global' | 'workspace' | 'command'
  kind: 'skill' | 'command'
  rootKind: string
  path: string
  displayPath: string
  sourcePath: string
  content?: string
}

type DaemonSkillRoot = {
  id: string
  path: string
  displayPath: string
  scope: 'global' | 'workspace'
  kind: string
  label: string
  exists: boolean
  sourceType: 'directory' | 'file'
}

type DaemonSkillSelection = {
  enabledIds: string[]
  disabledIds: string[]
  resolved: DaemonSkillEntry[]
  unresolvedIds: string[]
  summary?: string
  prompt?: string
}

type DaemonSkillIndex = {
  workspaceDir: string | null
  roots: DaemonSkillRoot[]
  skills: DaemonSkillEntry[]
  selection: DaemonSkillSelection
}

async function daemonRequest<T>(path: string, options?: RequestOptions): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const daemon = await ensureDaemonRunning()

    try {
      const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
        method: options?.method ?? (options?.body == null ? 'GET' : 'POST'),
        headers: {
          Authorization: `Bearer ${daemon.token}`,
          ...(options?.body == null ? {} : { 'Content-Type': 'application/json' }),
        },
        body: options?.body == null ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(5_000),
      })

      if (!response.ok) {
        const text = await response.text()
        const error = new Error(text || `Daemon request failed: ${response.status}`)
        lastError = error
        if (attempt === 0 && (response.status === 401 || response.status === 408 || response.status === 502 || response.status === 503 || response.status === 504)) {
          invalidateDaemonCache()
          continue
        }
        throw error
      }

      return await response.json() as T
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (attempt === 0) {
        const daemonStatus = await getDaemonStatus().catch(() => ({ running: false as const, info: null }))
        if (!daemonStatus.running) {
          invalidateDaemonCache()
        }
        continue
      }
      throw lastError
    }
  }

  throw (lastError ?? new Error('Daemon request failed'))
}

export const daemonClient = {
  getJobDashboard(): Promise<{
    jobs: Array<{
      id: string
      taskLabel: string | null
      status: string
      runMode?: string | null
      provider: string | null
      model: string | null
      workspaceDir: string | null
      requestedAt: string | null
      updatedAt: string | null
      completedAt?: string | null
      lastSequence: number
      sessionId?: string | null
      error: string | null
    }>
    summary: {
      total: number
      active: number
      backgroundActive: number
      completed: number
      failed: number
      cancelled: number
      other: number
    }
    daemon: {
      pid: number
      startedAt: string
      appVersion: string | null
    }
  }> {
    return daemonRequest('/dashboard/api/jobs')
  },
  listHosts(): Promise<ExecutionHostRecord[]> {
    return daemonRequest('/host/list')
  },
  upsertHost(host: ExecutionHostRecord): Promise<ExecutionHostRecord[]> {
    return daemonRequest('/host/upsert', { body: { host } })
  },
  deleteHost(id: string): Promise<{ ok: true; hosts: ExecutionHostRecord[] }> {
    return daemonRequest(`/host/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  listWorkspaces(): Promise<Workspace[]> {
    return daemonRequest('/workspace/list')
  },
  listProjects(): Promise<ProjectRecord[]> {
    return daemonRequest('/workspace/projects')
  },
  getActiveWorkspace(): Promise<Workspace | null> {
    return daemonRequest('/workspace/active')
  },
  createWorkspace(name: string): Promise<Workspace> {
    return daemonRequest('/workspace/create', { body: { name } })
  },
  createWorkspaceWithPath(name: string, projectPath: string): Promise<Workspace> {
    return daemonRequest('/workspace/create-with-path', { body: { name, projectPath } })
  },
  createWorkspaceFromFolder(folderPath: string): Promise<Workspace> {
    return daemonRequest('/workspace/create-from-folder', { body: { folderPath } })
  },
  addProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
    return daemonRequest('/workspace/add-project-folder', { body: { workspaceId, folderPath } })
  },
  removeProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
    return daemonRequest('/workspace/remove-project-folder', { body: { workspaceId, folderPath } })
  },
  setActiveWorkspace(id: string): Promise<{ ok: true }> {
    return daemonRequest('/workspace/set-active', { body: { id } })
  },
  deleteWorkspace(id: string): Promise<{ ok: true }> {
    return daemonRequest(`/workspace/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
  listLocalSessions(workspaceId: string): Promise<AggregatedSessionEntry[]> {
    return daemonRequest(`/session/local/list?workspaceId=${encodeURIComponent(workspaceId)}`)
  },
  upsertRuntimeSession(workspaceId: string, cardId: string, state: unknown): Promise<{ ok: boolean; summary?: unknown; error?: string }> {
    return daemonRequest('/session/runtime/upsert', {
      body: { workspaceId, cardId, state },
    })
  },
  createCheckpoint(workspaceId: string, sessionEntryId: string, payload: {
    label?: string | null
    reason?: string | null
    files?: string[]
    metadata?: Record<string, unknown>
    source?: string | null
  }): Promise<{ ok: boolean; checkpoint?: { id: string }; error?: string }> {
    return daemonRequest('/checkpoint/create', {
      body: {
        workspaceId,
        sessionEntryId,
        ...payload,
      },
    })
  },
  listCheckpoints(workspaceId: string, sessionEntryId: string): Promise<Array<{
    id: string
    sessionEntryId: string
    createdAt: string
    restoredAt?: string | null
    label: string
    reason?: string | null
    fileCount: number
    files: string[]
  }>> {
    return daemonRequest('/checkpoint/list', {
      body: { workspaceId, sessionEntryId },
    })
  },
  restoreCheckpoint(workspaceId: string, checkpointId: string, sessionEntryId?: string | null): Promise<{
    ok: boolean
    checkpoint?: { id: string }
    filesRestored?: number
    filesDeleted?: number
    error?: string
  }> {
    return daemonRequest('/checkpoint/restore', {
      body: { workspaceId, checkpointId, sessionEntryId: sessionEntryId ?? null },
    })
  },
  loadMemoryContext(workspaceId: string, executionTarget: 'local' | 'cloud' = 'local'): Promise<{
    executionTarget: 'local' | 'cloud'
    includedBuckets: string[]
    sections: Array<{
      scope: string
      bucket: string
      displayPath: string
      path: string
      importedFrom?: string | null
      content: string
    }>
    prompt?: string
    contextBuckets?: {
      version: number
      includedBuckets: string[]
      buckets: Array<{
        bucket: string
        included: boolean
        sectionCount: number
        sections: Array<{
          scope: string
          displayPath: string
          importedFrom?: string | null
        }>
      }>
      inspect?: {
        summary?: string
        input?: string
      }
    }
  }> {
    return daemonRequest(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=${encodeURIComponent(executionTarget)}`)
  },
  getDreamStatus(workspaceId: string): Promise<{
    workspaceId: string
    running: boolean
    activeRun: {
      id: string
      workspaceId: string
      workspaceName: string | null
      workspaceDir: string
      provider: string
      model: string
      status: string
      requestedAt: string
      startedAt: string
      completedAt: string | null
      sessionsReviewed: number
      reviewedSessionIds: string[]
      latestSessionUpdatedAt: string | null
      outputPath: string | null
      artifactPath: string | null
      summary: string | null
      promptPreview: string | null
      error: string | null
    } | null
    lastRun: {
      id: string
      workspaceId: string
      workspaceName: string | null
      workspaceDir: string
      provider: string
      model: string
      status: string
      requestedAt: string
      startedAt: string
      completedAt: string | null
      sessionsReviewed: number
      reviewedSessionIds: string[]
      latestSessionUpdatedAt: string | null
      outputPath: string | null
      artifactPath: string | null
      summary: string | null
      promptPreview: string | null
      error: string | null
    } | null
    state: {
      workspaceId: string
      lastRunId: string | null
      lastCompletedAt: string | null
      lastSuccessfulRunId: string | null
      lastSuccessfulCompletedAt: string | null
      lastReviewedAt: string | null
      latestMemoryPath: string | null
    }
  }> {
    return daemonRequest(`/dreaming/status?workspaceId=${encodeURIComponent(workspaceId)}`)
  },
  listDreamRuns(workspaceId: string, limit = 20): Promise<{
    workspaceId: string
    runs: Array<{
      id: string
      workspaceId: string
      workspaceName: string | null
      workspaceDir: string
      provider: string
      model: string
      status: string
      requestedAt: string
      startedAt: string
      completedAt: string | null
      sessionsReviewed: number
      reviewedSessionIds: string[]
      latestSessionUpdatedAt: string | null
      outputPath: string | null
      artifactPath: string | null
      summary: string | null
      promptPreview: string | null
      error: string | null
    }>
  }> {
    return daemonRequest(`/dreaming/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${encodeURIComponent(String(limit))}`)
  },
  runDream(args: { workspaceId: string; provider?: string; model?: string; maxSessions?: number }): Promise<{
    started: boolean
    run: {
      id: string
      workspaceId: string
      workspaceName: string | null
      workspaceDir: string
      provider: string
      model: string
      status: string
      requestedAt: string
      startedAt: string
      completedAt: string | null
      sessionsReviewed: number
      reviewedSessionIds: string[]
      latestSessionUpdatedAt: string | null
      outputPath: string | null
      artifactPath: string | null
      summary: string | null
      promptPreview: string | null
      error: string | null
    }
  }> {
    return daemonRequest('/dreaming/run', { body: args })
  },
  cancelDream(args: { workspaceId: string; runId?: string | null }): Promise<{ ok: boolean; error?: string }> {
    return daemonRequest('/dreaming/cancel', { body: args })
  },
  listSkills(args: { workspaceId?: string | null; workspaceDir?: string | null; cardId?: string | null } = {}): Promise<DaemonSkillIndex> {
    const query = new URLSearchParams()
    const workspaceId = String(args.workspaceId ?? '').trim()
    const workspaceDir = String(args.workspaceDir ?? '').trim()
    const cardId = String(args.cardId ?? '').trim()
    if (workspaceId) query.set('workspaceId', workspaceId)
    if (workspaceDir) query.set('workspaceDir', workspaceDir)
    if (cardId) query.set('cardId', cardId)
    return daemonRequest(`/skills/list${query.size > 0 ? `?${query.toString()}` : ''}`)
  },
  getSkill(args: { skillId: string; workspaceId?: string | null; workspaceDir?: string | null; cardId?: string | null }): Promise<DaemonSkillEntry | null> {
    const query = new URLSearchParams()
    query.set('skillId', String(args.skillId ?? '').trim())
    const workspaceId = String(args.workspaceId ?? '').trim()
    const workspaceDir = String(args.workspaceDir ?? '').trim()
    const cardId = String(args.cardId ?? '').trim()
    if (workspaceId) query.set('workspaceId', workspaceId)
    if (workspaceDir) query.set('workspaceDir', workspaceDir)
    if (cardId) query.set('cardId', cardId)
    return daemonRequest(`/skills/get?${query.toString()}`)
  },
  installSkill(args: {
    zipPath: string
    scope?: 'global' | 'workspace'
    overwrite?: boolean
    workspaceId?: string | null
    workspaceDir?: string | null
    cardId?: string | null
  }): Promise<{ ok: boolean; scope: 'global' | 'workspace'; targetRoot: string; installedPath: string; skill: DaemonSkillEntry }> {
    return daemonRequest('/skills/install', { body: args })
  },
  expandFileReferences(payload: {
    message: string
    workspaceId?: string | null
    workspaceDir?: string | null
    executionTarget?: 'local' | 'cloud'
  }): Promise<{
    changed: boolean
    message: string
    references: Array<{
      source: string
      displayPath: string
      byteCount: number
      truncated: boolean
      binary?: boolean
      mediaType?: string
      resolvedPath?: string
    }>
    summaryText?: string
    inputText?: string
  }> {
    return daemonRequest('/file-references/expand', {
      body: {
        message: payload.message,
        workspaceId: String(payload.workspaceId ?? '').trim() || null,
        workspaceDir: String(payload.workspaceDir ?? '').trim() || null,
        executionTarget: payload.executionTarget === 'cloud' ? 'cloud' : 'local',
      },
    })
  },
  listExternalSessions(workspacePath: string | null, force = false): Promise<AggregatedSessionEntry[]> {
    const normalizedPath = String(workspacePath ?? '').trim()
    const query = new URLSearchParams()
    if (normalizedPath) query.set('workspacePath', normalizedPath)
    if (force) query.set('force', '1')
    return daemonRequest(`/session/external/list?${query.toString()}`)
  },
  invalidateExternalSessions(workspacePath: string | null): Promise<{ ok: boolean }> {
    return daemonRequest('/session/external/invalidate', {
      body: { workspacePath: String(workspacePath ?? '').trim() || null },
    })
  },
  getExternalSessionState(workspacePath: string | null, sessionEntryId: string): Promise<unknown | null> {
    const normalizedPath = String(workspacePath ?? '').trim()
    const query = new URLSearchParams()
    if (normalizedPath) query.set('workspacePath', normalizedPath)
    query.set('sessionEntryId', sessionEntryId)
    return daemonRequest(`/session/external/state?${query.toString()}`)
  },
  deleteExternalSession(workspacePath: string | null, sessionEntryId: string): Promise<{ ok: boolean; error?: string }> {
    return daemonRequest('/session/external/delete', {
      body: {
        workspacePath: String(workspacePath ?? '').trim() || null,
        sessionEntryId,
      },
    })
  },
  renameExternalSession(workspacePath: string | null, sessionEntryId: string, title: string): Promise<{ ok: boolean; error?: string; title?: string }> {
    return daemonRequest('/session/external/rename', {
      body: {
        workspacePath: String(workspacePath ?? '').trim() || null,
        sessionEntryId,
        title,
      },
    })
  },
  getLocalSessionState(workspaceId: string, sessionEntryId: string): Promise<unknown | null> {
    return daemonRequest(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent(sessionEntryId)}`)
  },
  deleteLocalSession(workspaceId: string, sessionEntryId: string): Promise<{ ok: boolean; error?: string }> {
    return daemonRequest('/session/local/delete', { body: { workspaceId, sessionEntryId } })
  },
  renameLocalSession(workspaceId: string, sessionEntryId: string, title: string): Promise<{ ok: boolean; error?: string; title?: string }> {
    return daemonRequest('/session/local/rename', { body: { workspaceId, sessionEntryId, title } })
  },
  getSettings(): Promise<AppSettings> {
    return daemonRequest('/settings')
  },
  setSettings(settings: AppSettings): Promise<AppSettings> {
    return daemonRequest('/settings', { body: { settings } })
  },
  getRawSettingsJson(): Promise<{ path: string; content: string }> {
    return daemonRequest('/settings/raw')
  },
  setRawSettingsJson(json: string): Promise<{ ok: boolean; error?: string; settings?: AppSettings }> {
    return daemonRequest('/settings/raw', { body: { json } })
  },
}
