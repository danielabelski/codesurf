import type { DaemonStatusInfo } from './manager'
import type {
  AggregatedSessionEntry,
  DaemonAppSettings,
  DaemonSkillEntry,
  DaemonSkillIndex,
  DaemonToolPermissionGrant,
  DaemonToolPermissionListResult,
  DaemonToolPermissionRequest,
  DaemonToolPermissionScope,
  DashboardDreamingSummary,
  DreamRunSummary,
  ExecutionHostRecord,
  ProjectRecord,
  Workspace,
} from './types'

export interface DaemonClientHooks {
  /**
   * Resolves the live daemon connection (port + token). Typically
   * `manager.ensureDaemonRunning`.
   */
  ensureRunning: (options?: { forceRestart?: boolean }) => Promise<DaemonStatusInfo>
  /**
   * Returns whether the daemon is currently healthy. Used to decide whether to
   * invalidate the cache after a transport failure. Typically
   * `manager.getDaemonStatus`.
   */
  getStatus: () => Promise<{ running: boolean; info: DaemonStatusInfo | null }>
  /** Drops the cached daemon connection so the next request re-discovers it. */
  invalidate: () => void
  /** Optional override for per-request timeout (ms). Defaults to 5000. */
  requestTimeoutMs?: number
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  /** Per-request override of the request timeout (ms). */
  timeoutMs?: number
}

export type DaemonClient = ReturnType<typeof createDaemonClient>

export function createDaemonClient(hooks: DaemonClientHooks) {
  const defaultTimeoutMs = hooks.requestTimeoutMs ?? 5_000

  async function request<T>(path: string, options?: RequestOptions): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const daemon = await hooks.ensureRunning()

      try {
        const response = await fetch(`http://127.0.0.1:${daemon.port}${path}`, {
          method: options?.method ?? (options?.body == null ? 'GET' : 'POST'),
          headers: {
            Authorization: `Bearer ${daemon.token}`,
            ...(options?.body == null ? {} : { 'Content-Type': 'application/json' }),
          },
          body: options?.body == null ? undefined : JSON.stringify(options.body),
          signal: AbortSignal.timeout(options?.timeoutMs ?? defaultTimeoutMs),
        })

        if (!response.ok) {
          const text = await response.text()
          const error = new Error(text || `Daemon request failed: ${response.status}`)
          lastError = error
          if (attempt === 0 && (response.status === 401 || response.status === 408 || response.status === 502 || response.status === 503 || response.status === 504)) {
            hooks.invalidate()
            continue
          }
          throw error
        }

        return await response.json() as T
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        if (attempt === 0) {
          const status = await hooks.getStatus().catch(() => ({ running: false as const, info: null }))
          if (!status.running) {
            hooks.invalidate()
          }
          continue
        }
        throw lastError
      }
    }

    throw (lastError ?? new Error('Daemon request failed'))
  }

  return {
    /** Escape hatch for routes the typed surface doesn't cover. */
    request,

    getJobDashboard(): Promise<{
      jobs: Array<{
        id: string
        taskLabel: string | null
        status: string
        runMode?: string | null
        workspaceId?: string | null
        cardId?: string | null
        provider: string | null
        model: string | null
        workspaceDir: string | null
        requestedAt: string | null
        updatedAt: string | null
        completedAt?: string | null
        lastSequence: number
        sessionId?: string | null
        initialPrompt?: string | null
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
      dreaming?: DashboardDreamingSummary | null
    }> {
      return request('/dashboard/api/jobs')
    },

    listHosts(): Promise<ExecutionHostRecord[]> {
      return request('/host/list')
    },
    upsertHost(host: ExecutionHostRecord): Promise<ExecutionHostRecord[]> {
      return request('/host/upsert', { body: { host } })
    },
    deleteHost(id: string): Promise<{ ok: true; hosts: ExecutionHostRecord[] }> {
      return request(`/host/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    listPermissions(): Promise<DaemonToolPermissionListResult> {
      return request('/permissions')
    },
    setPermissionGrant(args: DaemonToolPermissionRequest & {
      action?: 'allow' | 'deny'
      scope?: Exclude<DaemonToolPermissionScope, 'session'> | null
    }): Promise<DaemonToolPermissionListResult & { grant: DaemonToolPermissionGrant }> {
      return request('/permissions/grant', { body: args })
    },
    resolvePermission(args: DaemonToolPermissionRequest): Promise<{
      decision: 'allow' | 'deny' | null
      grant: DaemonToolPermissionGrant | null
    }> {
      return request('/permissions/resolve', { body: args })
    },
    clearPermissionGrant(id: string): Promise<DaemonToolPermissionListResult> {
      return request('/permissions/clear', { body: { id } })
    },
    clearAllPermissionGrants(): Promise<DaemonToolPermissionListResult> {
      return request('/permissions/clear', { body: { all: true } })
    },

    listWorkspaces(): Promise<Workspace[]> {
      return request('/workspace/list')
    },
    listProjects(): Promise<ProjectRecord[]> {
      return request('/workspace/projects')
    },
    getActiveWorkspace(): Promise<Workspace | null> {
      return request('/workspace/active')
    },
    createWorkspace(name: string): Promise<Workspace> {
      return request('/workspace/create', { body: { name } })
    },
    createWorkspaceWithPath(name: string, projectPath: string): Promise<Workspace> {
      return request('/workspace/create-with-path', { body: { name, projectPath } })
    },
    createWorkspaceFromFolder(folderPath: string): Promise<Workspace> {
      return request('/workspace/create-from-folder', { body: { folderPath } })
    },
    addProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
      return request('/workspace/add-project-folder', { body: { workspaceId, folderPath } })
    },
    removeProjectFolder(workspaceId: string, folderPath: string): Promise<Workspace | null> {
      return request('/workspace/remove-project-folder', { body: { workspaceId, folderPath } })
    },
    renameProject(args: { projectId?: string; projectPath?: string; name: string }): Promise<{ ok: boolean; error?: string; project?: ProjectRecord }> {
      return request('/workspace/project/rename', { body: args })
    },
    createProjectWorktree(args: { projectId?: string; projectPath?: string; name: string; branch?: string }): Promise<{ ok: boolean; error?: string; project?: ProjectRecord; path?: string; branch?: string }> {
      return request('/workspace/project/worktree', { body: args })
    },
    setActiveWorkspace(id: string): Promise<{ ok: true }> {
      return request('/workspace/set-active', { body: { id } })
    },
    deleteWorkspace(id: string): Promise<{ ok: true }> {
      return request(`/workspace/${encodeURIComponent(id)}`, { method: 'DELETE' })
    },

    listLocalSessions(workspaceId: string): Promise<AggregatedSessionEntry[]> {
      return request(`/session/local/list?workspaceId=${encodeURIComponent(workspaceId)}`)
    },
    upsertRuntimeSession(workspaceId: string, cardId: string, state: unknown): Promise<{ ok: boolean; summary?: unknown; error?: string }> {
      return request('/session/runtime/upsert', { body: { workspaceId, cardId, state } })
    },
    getLocalSessionState(workspaceId: string, sessionEntryId: string): Promise<unknown | null> {
      return request(`/session/local/state?workspaceId=${encodeURIComponent(workspaceId)}&sessionEntryId=${encodeURIComponent(sessionEntryId)}`)
    },
    deleteLocalSession(workspaceId: string, sessionEntryId: string): Promise<{ ok: boolean; error?: string }> {
      return request('/session/local/delete', { body: { workspaceId, sessionEntryId } })
    },
    renameLocalSession(workspaceId: string, sessionEntryId: string, title: string): Promise<{ ok: boolean; error?: string; title?: string }> {
      return request('/session/local/rename', { body: { workspaceId, sessionEntryId, title } })
    },

    listExternalSessions(workspacePath: string | null, force = false): Promise<AggregatedSessionEntry[]> {
      const normalizedPath = String(workspacePath ?? '').trim()
      const query = new URLSearchParams()
      if (normalizedPath) query.set('workspacePath', normalizedPath)
      if (force) query.set('force', '1')
      return request(`/session/external/list?${query.toString()}`)
    },
    invalidateExternalSessions(workspacePath: string | null): Promise<{ ok: boolean }> {
      return request('/session/external/invalidate', {
        body: { workspacePath: String(workspacePath ?? '').trim() || null },
      })
    },
    getExternalSessionState(workspacePath: string | null, sessionEntryId: string): Promise<unknown | null> {
      const normalizedPath = String(workspacePath ?? '').trim()
      const query = new URLSearchParams()
      if (normalizedPath) query.set('workspacePath', normalizedPath)
      query.set('sessionEntryId', sessionEntryId)
      return request(`/session/external/state?${query.toString()}`)
    },
    deleteExternalSession(workspacePath: string | null, sessionEntryId: string): Promise<{ ok: boolean; error?: string }> {
      return request('/session/external/delete', {
        body: {
          workspacePath: String(workspacePath ?? '').trim() || null,
          sessionEntryId,
        },
      })
    },
    renameExternalSession(workspacePath: string | null, sessionEntryId: string, title: string): Promise<{ ok: boolean; error?: string; title?: string }> {
      return request('/session/external/rename', {
        body: {
          workspacePath: String(workspacePath ?? '').trim() || null,
          sessionEntryId,
          title,
        },
      })
    },

    createCheckpoint(workspaceId: string, sessionEntryId: string, payload: {
      label?: string | null
      reason?: string | null
      files?: string[]
      metadata?: Record<string, unknown>
      source?: string | null
    }): Promise<{ ok: boolean; checkpoint?: { id: string }; error?: string }> {
      return request('/checkpoint/create', { body: { workspaceId, sessionEntryId, ...payload } })
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
      return request('/checkpoint/list', { body: { workspaceId, sessionEntryId } })
    },
    restoreCheckpoint(workspaceId: string, checkpointId: string, sessionEntryId?: string | null): Promise<{
      ok: boolean
      checkpoint?: { id: string }
      filesRestored?: number
      filesDeleted?: number
      error?: string
    }> {
      return request('/checkpoint/restore', {
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
      return request(`/memory/load?workspaceId=${encodeURIComponent(workspaceId)}&executionTarget=${encodeURIComponent(executionTarget)}`)
    },

    getDreamStatus(workspaceId: string): Promise<{
      workspaceId: string
      running: boolean
      activeRun: DreamRunSummary | null
      lastRun: DreamRunSummary | null
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
      return request(`/dreaming/status?workspaceId=${encodeURIComponent(workspaceId)}`)
    },
    listDreamRuns(workspaceId: string, limit = 20): Promise<{ workspaceId: string; runs: DreamRunSummary[] }> {
      return request(`/dreaming/runs?workspaceId=${encodeURIComponent(workspaceId)}&limit=${encodeURIComponent(String(limit))}`)
    },
    runDream(args: { workspaceId: string; provider?: string; model?: string; maxSessions?: number }): Promise<{ started: boolean; run: DreamRunSummary }> {
      return request('/dreaming/run', { body: args })
    },
    cancelDream(args: { workspaceId: string; runId?: string | null }): Promise<{ ok: boolean; error?: string }> {
      return request('/dreaming/cancel', { body: args })
    },

    listSkills(args: { workspaceId?: string | null; workspaceDir?: string | null; cardId?: string | null } = {}): Promise<DaemonSkillIndex> {
      const query = new URLSearchParams()
      const workspaceId = String(args.workspaceId ?? '').trim()
      const workspaceDir = String(args.workspaceDir ?? '').trim()
      const cardId = String(args.cardId ?? '').trim()
      if (workspaceId) query.set('workspaceId', workspaceId)
      if (workspaceDir) query.set('workspaceDir', workspaceDir)
      if (cardId) query.set('cardId', cardId)
      return request(`/skills/list${query.size > 0 ? `?${query.toString()}` : ''}`)
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
      return request(`/skills/get?${query.toString()}`)
    },
    installSkill(args: {
      zipPath: string
      scope?: 'global' | 'workspace'
      overwrite?: boolean
      workspaceId?: string | null
      workspaceDir?: string | null
      cardId?: string | null
    }): Promise<{ ok: boolean; scope: 'global' | 'workspace'; targetRoot: string; installedPath: string; skill: DaemonSkillEntry }> {
      return request('/skills/install', { body: args })
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
      return request('/file-references/expand', {
        body: {
          message: payload.message,
          workspaceId: String(payload.workspaceId ?? '').trim() || null,
          workspaceDir: String(payload.workspaceDir ?? '').trim() || null,
          executionTarget: payload.executionTarget === 'cloud' ? 'cloud' : 'local',
        },
      })
    },

    getSettings<T = DaemonAppSettings>(): Promise<T> {
      return request<T>('/settings')
    },
    setSettings<T = DaemonAppSettings>(settings: T): Promise<T> {
      return request<T>('/settings', { body: { settings } })
    },
    getRawSettingsJson(): Promise<{ path: string; content: string }> {
      return request('/settings/raw')
    },
    setRawSettingsJson<T = DaemonAppSettings>(json: string): Promise<{ ok: boolean; error?: string; settings?: T }> {
      return request('/settings/raw', { body: { json } })
    },
  }
}
