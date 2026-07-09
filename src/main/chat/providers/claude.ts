/**
 * Claude provider — uses @anthropic-ai/claude-agent-sdk for agent sessions.
 * No API keys needed — the SDK uses the Claude CLI's own auth.
 */

import { query, type Query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import { resolve } from 'path'
import { getAgentPath } from '../../agent-paths'
import { getMCPPort, getMCPToken, getContexMcpToolNames } from '../../mcp-server'
import { formatClaudeSdkError } from '../output-sanitizers'
import { buildAsyncExecutionPrompt, buildPeerSystemPrompt } from '../prompt-builders'
import { buildCodeSurfActivityConvention, buildCodeSurfInsightConvention, buildCodeSurfOutputConvention, joinPromptSections } from '../prompt-conventions'
import { buildClaudeAgentModeOptions } from './agent-mode-payloads'
import { daemonClient } from '../../daemon/client'
import { getDisconnectedPeerBridgeMcpToolNames } from '../../../shared/nodeTools'
import { type ToolPermissionRequest } from '../../permissions'
import { resolveInlineToolPermission } from '../permission-flow'
import type {
  ChatImageAttachment,
  ChatRequest,
  RuntimeChatSessionState,
} from '../types'
import {
  activeQueries,
  clearActiveQuery,
  cloneChatMessages,
  getPreparedMessages,
  isActiveQuery,
  log,
  getCardSessionId,
  sendStream,
  setCardSessionId,
  upsertRuntimeSessionState,
} from '../runtime'

// Live permission mode per card, so mid-thread mode switches (e.g. Default -> Bypass)
// propagate into the running canUseTool closure. Keyed by cardId.
export const cardPermissionModes = new Map<string, string>()

// Per-card AbortController so chat:stop can cancel the SDK request alongside q.close()
export const cardAbortControllers = new Map<string, AbortController>()

function clearActiveClaudeQuery(cardId: string, q: Query): void {
  clearActiveQuery(cardId, q)
  cardAbortControllers.delete(cardId)
}

const intentionallyClosedQueries = new WeakSet<Query>()

export function markClaudeQueryIntentionallyClosed(query: Query): void {
  intentionallyClosedQueries.add(query)
}

function wasClaudeQueryIntentionallyClosed(query: Query): boolean {
  return intentionallyClosedQueries.has(query)
}

// ---- AskUserQuestion interactive-form handling ----------------------------
interface AskUserQuestionOption {
  label: string
  description?: string
  preview?: string
}
interface AskUserQuestionItem {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskUserQuestionOption[]
}
interface AskUserQuestionAnswer {
  answers: Record<string, string>
  annotations?: Record<string, { notes?: string; preview?: string }>
}
interface PendingAskUserQuestion {
  resolve: (value: AskUserQuestionAnswer) => void
  reject: (err: Error) => void
}
// Keyed by `${cardId}::${toolUseID}` so we can address the exact tool_use.
const pendingAskUserQuestions = new Map<string, PendingAskUserQuestion>()

function askUserQuestionKey(cardId: string, toolUseID: string | null | undefined): string {
  return `${cardId}::${toolUseID ?? ''}`
}

function awaitAskUserQuestionAnswer(
  cardId: string,
  toolUseID: string | null,
  questions: AskUserQuestionItem[],
): Promise<AskUserQuestionAnswer> {
  const key = askUserQuestionKey(cardId, toolUseID)
  // Reject any prior pending prompt at the same key (shouldn't happen, but be safe).
  const prior = pendingAskUserQuestions.get(key)
  if (prior) {
    try { prior.reject(new Error('AskUserQuestion superseded')) } catch { /* noop */ }
    pendingAskUserQuestions.delete(key)
  }
  return new Promise<AskUserQuestionAnswer>((resolve, reject) => {
    pendingAskUserQuestions.set(key, { resolve, reject })
    // Notify the renderer that a form is awaiting user input.
    sendStream(cardId, {
      type: 'ask_user_question',
      toolId: toolUseID,
      questions,
    })
  })
}

export function resolvePendingAskUserQuestion(
  cardId: string,
  toolUseID: string | null | undefined,
  payload: AskUserQuestionAnswer,
): boolean {
  const key = askUserQuestionKey(cardId, toolUseID)
  const pending = pendingAskUserQuestions.get(key)
  if (!pending) return false
  pendingAskUserQuestions.delete(key)
  pending.resolve(payload)
  return true
}

export function cancelPendingAskUserQuestionsForCard(cardId: string, reason: string = 'Cancelled'): void {
  const prefix = `${cardId}::`
  for (const [key, pending] of pendingAskUserQuestions.entries()) {
    if (key.startsWith(prefix)) {
      pendingAskUserQuestions.delete(key)
      try { pending.reject(new Error(reason)) } catch { /* noop */ }
    }
  }
}

// --- Runtime checkpoints (Anthropic Edit/Write tools) ---------------------------

function buildRuntimeSessionEntryId(req: ChatRequest): string {
  return `codesurf-runtime:${req.cardId}`
}

function displayPathForWorkspace(absPath: string, workspaceDir: string | null | undefined): string {
  if (!absPath) return ''
  if (!workspaceDir) return absPath
  const ws = workspaceDir.replace(/\/$/, '')
  if (absPath === ws) return ''
  if (absPath.startsWith(ws + '/')) return absPath.slice(ws.length + 1)
  return absPath
}

function resolveAnthropicFilePath(filePath: string, workspaceDir?: string): string {
  if (workspaceDir && !filePath.startsWith('/')) return resolve(workspaceDir, filePath)
  return resolve(filePath)
}

function buildCheckpointLabel(toolName: string, filePaths: string[], workspaceDir?: string): string {
  if (filePaths.length === 0) return `Before ${toolName}`
  if (filePaths.length === 1) return `Before ${toolName} ${displayPathForWorkspace(filePaths[0], workspaceDir)}`
  return `Before ${toolName} (${filePaths.length} files)`
}

function extractAnthropicCheckpointPaths(toolName: string, input: Record<string, unknown>, workspaceDir?: string): string[] {
  const resolveFile = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim()) return null
    return resolveAnthropicFilePath(value, workspaceDir)
  }

  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Write') {
    const filePath = resolveFile(input.file_path)
    return filePath ? [filePath] : []
  }

  if (toolName === 'NotebookEdit') {
    const filePath = resolveFile(input.notebook_path) ?? resolveFile(input.file_path)
    return filePath ? [filePath] : []
  }

  return []
}

function emitCheckpointSaved(
  req: ChatRequest,
  toolName: string,
  filePaths: string[],
  checkpointId: string,
): void {
  const displayPaths = filePaths.slice(0, 2).map(filePath => displayPathForWorkspace(filePath, req.workspaceDir))
  const suffix = filePaths.length > 2 ? ` +${filePaths.length - 2} more` : ''
  const summary = `Saved checkpoint before ${toolName}${displayPaths.length > 0 ? ` for ${displayPaths.join(', ')}${suffix}` : ''}`
  const toolId = `codesurf-checkpoint-${checkpointId}`
  sendStream(req.cardId, { type: 'tool_start', toolId, toolName: 'Checkpoint saved' })
  sendStream(req.cardId, { type: 'tool_summary', toolId, toolName: 'Checkpoint saved', text: summary })
}

async function createRuntimeCheckpoint(
  req: ChatRequest,
  toolName: string,
  filePaths: string[],
  metadata: Record<string, unknown> = {},
): Promise<{ ok: boolean; checkpointId?: string; skipped?: boolean; error?: string }> {
  if (filePaths.length === 0) return { ok: true, skipped: true }
  if (!req.workspaceId) return { ok: true, skipped: true }

  try {
    const response = await daemonClient.createCheckpoint(req.workspaceId, buildRuntimeSessionEntryId(req), {
      label: buildCheckpointLabel(toolName, filePaths, req.workspaceDir),
      reason: `tool:${toolName}`,
      files: filePaths,
      metadata: {
        provider: req.provider,
        model: req.model,
        toolName,
        cardId: req.cardId,
        ...metadata,
      },
      source: 'main-ipc-chat',
    })
    if (!response.ok) {
      return { ok: false, error: response.error ?? `Failed to create checkpoint for ${toolName}` }
    }
    if (response.checkpoint?.id) {
      emitCheckpointSaved(req, toolName, filePaths, response.checkpoint.id)
    }
    return { ok: true, checkpointId: response.checkpoint?.id }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log('createRuntimeCheckpoint error', req.cardId, toolName, message)
    return { ok: false, error: message }
  }
}

type ToolCheckpointPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown>; toolUseID?: string }
  | { behavior: 'deny'; message: string; toolUseID?: string }

async function allowToolWithCheckpoint(
  req: ChatRequest,
  toolName: string,
  input: Record<string, unknown>,
  toolOptions: any,
): Promise<ToolCheckpointPermissionResult> {
  const checkpoint = await createRuntimeCheckpoint(req, toolName, extractAnthropicCheckpointPaths(toolName, input, req.workspaceDir), {
    toolUseID: typeof toolOptions?.toolUseID === 'string' ? toolOptions.toolUseID : null,
  })
  if (!checkpoint.ok) {
    return {
      behavior: 'deny',
      message: `Checkpoint creation failed before ${toolName}: ${checkpoint.error ?? 'unknown error'}`,
      toolUseID: toolOptions?.toolUseID,
    }
  }
  // The Claude Code control protocol requires an `allow` result to echo back
  // `updatedInput` (the possibly-modified tool input). Omitting it makes the
  // CLI's Zod validation reject the response — the tool then fails even though
  // the user approved it. Echo the input unchanged.
  return { behavior: 'allow', updatedInput: input, toolUseID: toolOptions?.toolUseID }
}

// --- Prompt / multimodal helpers ---------------------------------------------

// Anthropic limits: ~5 MB per image; keep a conservative per-request total so
// we don't blow past context-window or HTTP payload limits on big screenshots.
const MAX_IMAGE_BYTES_PER_FILE = 5 * 1024 * 1024
const MAX_IMAGE_BYTES_PER_REQUEST = 20 * 1024 * 1024

function buildClaudePromptWithImages(
  text: string,
  imageAttachments: ChatImageAttachment[] | undefined,
): AsyncIterable<SDKUserMessage> {
  // Read images off disk synchronously-at-start-of-async-gen so any read
  // failure surfaces before we yield the message. We stream one user message
  // containing text + image blocks, then close the input stream so the query
  // proceeds to assistant generation.
  async function* generator(): AsyncGenerator<any, void, unknown> {
    const contentBlocks: Array<Record<string, unknown>> = []
    const normalizedText = String(text ?? '').trim()
    if (normalizedText) {
      contentBlocks.push({ type: 'text', text: normalizedText })
    }

    let totalBytes = 0
    for (const attachment of imageAttachments!) {
      try {
        if (attachment.byteCount > MAX_IMAGE_BYTES_PER_FILE) {
          log(`skipping oversize image attachment (${attachment.byteCount} B > ${MAX_IMAGE_BYTES_PER_FILE}):`, attachment.displayPath)
          continue
        }
        if (totalBytes + attachment.byteCount > MAX_IMAGE_BYTES_PER_REQUEST) {
          log('per-request image byte limit reached; dropping remaining attachments')
          break
        }
        const buffer = await fs.readFile(attachment.path)
        totalBytes += buffer.byteLength
        contentBlocks.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: attachment.mediaType,
            data: buffer.toString('base64'),
          },
        })
      } catch (err) {
        log('failed to load image attachment', attachment.path, (err as Error).message)
      }
    }

    // Fallback: if every image failed and there was no text, send a minimal
    // text block so the SDK has something to work with.
    if (contentBlocks.length === 0) {
      contentBlocks.push({ type: 'text', text: normalizedText || '(empty message)' })
    }

    yield {
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks,
      },
      parent_tool_use_id: null,
    }
  }

  return generator()
}

export function buildClaudeTextInput(text: string, priority: SDKUserMessage['priority'] = 'now'): AsyncIterable<SDKUserMessage> {
  async function* generator(): AsyncGenerator<SDKUserMessage, void, unknown> {
    yield {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
      parent_tool_use_id: null,
      priority,
      timestamp: new Date().toISOString(),
    }
  }
  return generator()
}

function buildClaudeAgentPrompt(
  basePrompt: string | undefined,
  memoryPrompt: string | undefined,
  skillsPrompt: string | undefined,
  asyncExecution: ChatRequest['asyncExecution'],
  agentPersona?: string | undefined,
): string | undefined {
  const asyncPrompt = buildAsyncExecutionPrompt(asyncExecution)
  const outputConvention = buildCodeSurfOutputConvention()
  const insightConvention = buildCodeSurfInsightConvention()
  const activityConvention = buildCodeSurfActivityConvention()
  // Persona (AgentMode.systemPrompt) leads ahead of memory/skills, matching the
  // daemon Claude path so the agent definition frames the turn the same way.
  return joinPromptSections(basePrompt, agentPersona, memoryPrompt, skillsPrompt, asyncPrompt, outputConvention, insightConvention, activityConvention)
}

// --- Anthropic file-change summaries -----------------------------------------

interface AnthropicFileChange {
  path: string
  previousPath?: string
  changeType: 'add' | 'update' | 'delete' | 'move'
  additions: number
  deletions: number
  diff: string
}

function countLines(s: string): number {
  if (!s) return 0
  // Trailing-newline-insensitive count so "a\nb" and "a\nb\n" both report 2.
  const trimmed = s.replace(/\n$/, '')
  if (trimmed === '') return 0
  return trimmed.split('\n').length
}

function makeEditDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  const chunks: string[] = []
  for (const line of oldLines) chunks.push('-' + line)
  for (const line of newLines) chunks.push('+' + line)
  return chunks.join('\n')
}

function makeWholeFileDiff(content: string, kind: 'add' | 'del'): string {
  const marker = kind === 'add' ? '+' : '-'
  return content.split('\n').map(line => marker + line).join('\n')
}

function buildAnthropicFileChanges(
  toolName: string,
  rawInput: string,
  workspaceDir: string | null | undefined,
): AnthropicFileChange[] {
  let parsed: unknown
  try { parsed = JSON.parse(rawInput) } catch { return [] }
  if (!parsed || typeof parsed !== 'object') return []
  const obj = parsed as Record<string, unknown>

  const getStr = (k: string): string | null => typeof obj[k] === 'string' ? (obj[k] as string) : null

  if (toolName === 'Edit') {
    const filePath = getStr('file_path') ?? ''
    if (!filePath) return []
    const oldStr = getStr('old_string') ?? ''
    const newStr = getStr('new_string') ?? ''
    const diff = makeEditDiff(oldStr, newStr)
    return [{
      path: displayPathForWorkspace(filePath, workspaceDir),
      changeType: 'update',
      additions: countLines(newStr),
      deletions: countLines(oldStr),
      diff,
    }]
  }

  if (toolName === 'MultiEdit') {
    const filePath = getStr('file_path') ?? ''
    if (!filePath) return []
    const edits = Array.isArray(obj.edits) ? obj.edits as unknown[] : []
    let additions = 0
    let deletions = 0
    const diffChunks: string[] = []
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue
      const e = edit as Record<string, unknown>
      const oldStr = typeof e.old_string === 'string' ? e.old_string : ''
      const newStr = typeof e.new_string === 'string' ? e.new_string : ''
      additions += countLines(newStr)
      deletions += countLines(oldStr)
      diffChunks.push(makeEditDiff(oldStr, newStr))
    }
    if (additions === 0 && deletions === 0) return []
    return [{
      path: displayPathForWorkspace(filePath, workspaceDir),
      changeType: 'update',
      additions,
      deletions,
      diff: diffChunks.join('\n'),
    }]
  }

  if (toolName === 'Write') {
    const filePath = getStr('file_path') ?? ''
    if (!filePath) return []
    const content = getStr('content') ?? ''
    const priorExisted = (() => {
      try { return existsSync(filePath) } catch { return true }
    })()
    return [{
      path: displayPathForWorkspace(filePath, workspaceDir),
      changeType: priorExisted ? 'update' : 'add',
      additions: countLines(content),
      deletions: 0,
      diff: makeWholeFileDiff(content, 'add'),
    }]
  }

  if (toolName === 'NotebookEdit') {
    const filePath = getStr('notebook_path') ?? getStr('file_path') ?? ''
    if (!filePath) return []
    const newSource = getStr('new_source') ?? ''
    if (!newSource) return []
    return [{
      path: displayPathForWorkspace(filePath, workspaceDir),
      changeType: 'update',
      additions: countLines(newSource),
      deletions: 0,
      diff: makeWholeFileDiff(newSource, 'add'),
    }]
  }

  return []
}

// --- Claude via Agent SDK ----------------------------------------------------

export function chatClaude(req: ChatRequest): void {
  const lastUserMsg = [...getPreparedMessages(req)].reverse().find(m => m.role === 'user')
  if (!lastUserMsg) {
    sendStream(req.cardId, { type: 'error', error: 'No user message' })
    return
  }

  // Restore sessionId from frontend (survives app restart via tile state)
  if (req.sessionId && !getCardSessionId(req.cardId, req.provider)) {
    setCardSessionId(req.cardId, req.provider, req.sessionId)
  }

  const existingSessionId = getCardSessionId(req.cardId, req.provider) ?? req.sessionId ?? null
  const runtimeMessages = cloneChatMessages(req.messages)
  const runtimeSession: RuntimeChatSessionState = {
    provider: req.provider,
    model: req.model,
    sessionId: existingSessionId ?? req.sessionId ?? null,
    jobId: req.jobId ?? null,
    jobSequence: typeof req.jobSequence === 'number' ? req.jobSequence : 0,
    executionTarget: req.executionTarget === 'cloud' ? 'cloud' : 'local',
    cloudHostId: req.cloudHostId ?? null,
    isStreaming: true,
    messages: runtimeMessages,
  }
  void upsertRuntimeSessionState(req, runtimeSession)
  log('chatClaude starting', {
    model: req.model,
    prompt: lastUserMsg.content.slice(0, 100),
    resuming: !!existingSessionId,
    sessionId: existingSessionId?.slice(0, 8),
  })

  const abortController = new AbortController()
  cardAbortControllers.set(req.cardId, abortController)
  let claudeStderr = ''

  // Map mode from UI to SDK permission mode
  const modeMap: Record<string, string> = {
    default: 'default',
    acceptEdits: 'acceptEdits',
    plan: 'plan',
    bypassPermissions: 'bypassPermissions',
  }
  const permMode = modeMap[req.mode ?? ''] ?? 'default'
  // Seed live mode map so mid-thread switches can override it without waiting
  // for the next turn.
  cardPermissionModes.set(req.cardId, permMode)

  // Map thinking option from UI to SDK thinking config
  const thinkingMap: Record<string, { type: string; budget_tokens?: number }> = {
    adaptive: { type: 'adaptive' },
    none: { type: 'disabled' },
    low: { type: 'enabled', budget_tokens: 2048 },
    medium: { type: 'enabled', budget_tokens: 8192 },
    high: { type: 'enabled', budget_tokens: 32768 },
    max: { type: 'enabled', budget_tokens: 131072 },
  }
  const thinkingConfig = thinkingMap[req.thinking ?? ''] ?? { type: 'adaptive' }

  // Wire up the codesurf MCP server (Bearer auth matches mcp-server HTTP checks)
  const mcpPort = getMCPPort()
  const mcpServers: Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> = {}
  if (req.mcpEnabled !== false && mcpPort) {
    mcpServers.codesurf = {
      type: 'http',
      url: `http://127.0.0.1:${mcpPort}/mcp`,
      headers: { Authorization: `Bearer ${getMCPToken()}` },
    }
    log('MCP server attached at port', mcpPort)
  }

  const contexToolNames = getContexMcpToolNames()
  const disallowedPeerBridgeTools = req.mcpEnabled === false
    ? []
    : getDisconnectedPeerBridgeMcpToolNames(req.negotiatedTools ?? req.peers?.flatMap(peer => peer.tools) ?? [])

  // Build system prompt context about connected peer blocks and their tools
  if (req.peers && req.peers.length > 0) {
    log('Peer data:', JSON.stringify(req.peers.map(p => ({ id: p.peerId, type: p.peerType, tools: p.tools.length, actions: p.actions?.length ?? 0 }))))
  }
  let systemPrompt = buildPeerSystemPrompt(req.peers)
  if (req.roomContext?.trim()) {
    systemPrompt = systemPrompt
      ? `${systemPrompt}\n\n${req.roomContext.trim()}`
      : req.roomContext.trim()
  }
  if (systemPrompt) {
    log('systemPrompt built for', req.peers?.length ?? 0, 'peers, codesurf tools:', contexToolNames.length, 'room=', Boolean(req.roomContext))
  }
  // Resolved AgentMode (selected agent definition): persona → system prompt,
  // tools allow-list → SDK tool restriction. The shared builder FAILS CLOSED
  // (throws) if a selected agent's definition has not resolved (A-PR1
  // BLOCKING-1) — surface it instead of launching unrestricted. Mirrors the
  // daemon Claude path.
  let agentTools: string[] | undefined
  let agentPersona: string | undefined
  try {
    ({ tools: agentTools, persona: agentPersona } = buildClaudeAgentModeOptions(req))
  } catch (err) {
    sendStream(req.cardId, { type: 'error', error: err instanceof Error ? err.message : String(err) })
    sendStream(req.cardId, { type: 'done' })
    cardAbortControllers.delete(req.cardId)
    return
  }
  systemPrompt = buildClaudeAgentPrompt(systemPrompt, req.memoryPrompt, req.skillsPrompt, req.asyncExecution, agentPersona)

  // Resolve claude binary from startup detection
  const claudePath = getAgentPath('claude')

  const options: Options = {
    model: req.model,
    abortController,
    persistSession: true,
    includePartialMessages: true,
    permissionMode: permMode as any,
    ...(permMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    thinking: thinkingConfig as any,
    // AskUserQuestion must be intercepted regardless of permission mode so the
    // agent's question actually reaches the user. Everything else honours permMode.
    canUseTool: async (toolName: string, input: Record<string, unknown>, toolOptions: any) => {
      if (toolName === 'AskUserQuestion') {
        try {
          const rawQuestions = (input as { questions?: unknown })?.questions
          const questions: AskUserQuestionItem[] = Array.isArray(rawQuestions)
            ? (rawQuestions as AskUserQuestionItem[]).filter(q => q && typeof q.question === 'string' && Array.isArray(q.options))
            : []
          if (questions.length > 0) {
            const toolUseID = typeof toolOptions?.toolUseID === 'string' ? toolOptions.toolUseID : null
            const { answers, annotations } = await awaitAskUserQuestionAnswer(req.cardId, toolUseID, questions)
            return {
              behavior: 'allow',
              updatedInput: {
                ...(input as Record<string, unknown>),
                answers,
                ...(annotations && Object.keys(annotations).length > 0 ? { annotations } : {}),
              },
              toolUseID: toolOptions?.toolUseID,
            }
          }
        } catch (err) {
          log('AskUserQuestion interception error:', (err as Error).message)
        }
        // No questions or error — just allow the tool through unchanged.
        return { behavior: 'allow', updatedInput: input, toolUseID: toolOptions?.toolUseID }
      }

      // Read the live mode so mid-thread switches take effect immediately.
      const currentMode = cardPermissionModes.get(req.cardId) ?? permMode
      if (currentMode === 'bypassPermissions') {
        return await allowToolWithCheckpoint(req, toolName, input, toolOptions)
      }

      const permissionRequest: ToolPermissionRequest = {
        provider: 'claude',
        toolName,
        title: typeof toolOptions?.title === 'string' ? toolOptions.title : null,
        description: typeof toolOptions?.description === 'string' ? toolOptions.description : null,
        blockedPath: typeof toolOptions?.blockedPath === 'string' ? toolOptions.blockedPath : null,
        workspaceDir: req.workspaceDir,
      }

      const sdkToolUseID = typeof toolOptions?.toolUseID === 'string' ? toolOptions.toolUseID : null
      const result = await resolveInlineToolPermission(req.cardId, permissionRequest, sdkToolUseID)

      if ('error' in result) {
        return {
          behavior: 'deny',
          message: result.error,
          toolUseID: result.toolUseID ?? toolOptions?.toolUseID,
        }
      }

      const { decision } = result
      if (decision === 'deny' || decision === 'never') {
        return {
          behavior: 'deny',
          message: decision === 'never'
            ? 'Tool permission permanently denied. Future calls will be auto-rejected.'
            : 'Tool permission denied by the user.',
          toolUseID: sdkToolUseID ?? toolOptions?.toolUseID,
        }
      }

      return await allowToolWithCheckpoint(req, toolName, input, toolOptions)
    },
    ...(Object.keys(mcpServers).length > 0 && { mcpServers }),
    ...(disallowedPeerBridgeTools.length > 0 && { disallowedTools: disallowedPeerBridgeTools }),
    // Use detected system binary, not the SDK's bundled cli.js
    ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
    stderr: (data: string) => {
      claudeStderr += data
      if (claudeStderr.length > 64 * 1024) claudeStderr = claudeStderr.slice(-64 * 1024)
    },
  }

  // Resume existing session for multi-turn
  if (existingSessionId) {
    options.resume = existingSessionId
  }

  // AgentMode.tools allow-list → restrict the built-in tools the model may use
  // (null/absent = all defaults; [] = deny-all per the SDK). Set BOTH the
  // top-level option (governs when no custom agent is active) AND the custom
  // agent definition below, since the active agent's own `tools` field governs
  // its toolset when `options.agent` is set.
  if (agentTools !== undefined) {
    options.tools = agentTools
  }

  try {
    log('calling query()...')
    // Inject system prompt via named agent definition if we have peer context
    if (systemPrompt) {
      options.agent = 'codesurf'
      options.agents = {
        codesurf: {
          description: 'CodeSurf canvas AI agent with peer block awareness',
          prompt: systemPrompt,
          ...(agentTools !== undefined ? { tools: agentTools } : {}),
        }
      }
    }
    const promptForQuery = buildClaudePromptWithImages(lastUserMsg.content, req.imageAttachments)
    const q = query({ prompt: promptForQuery, options })
    log('query() returned, consuming generator...', req.imageAttachments?.length
      ? `(with ${req.imageAttachments.length} image attachment${req.imageAttachments.length === 1 ? '' : 's'})`
      : '')
    activeQueries.set(req.cardId, q)

    // Consume the async generator in the background
    ;(async () => {
      let capturedSessionId = false
      let assistantText = ''
      let sawAssistantOutput = false
      // Track streamed text per content_block index so we can fall back to the
      // assembled `assistant` message for any text the partial stream missed.
      // Key format: `${turn}:${index}` — we bump `turn` on each assistant message.
      const streamedTextByIndex = new Map<string, string>()
      let streamTurn = 0
      let currentThinkingId: string | null = null
      try {
        for await (const msg of q) {
          if (!isActiveQuery(req.cardId, q)) {
            return
          }

          // Capture session_id from the first message we receive
          if (!capturedSessionId) {
            const sid = (msg as any).session_id
            if (sid) {
              log('captured session_id:', sid.slice(0, 8))
              setCardSessionId(req.cardId, req.provider, sid)
              runtimeSession.sessionId = sid
              void upsertRuntimeSessionState(req, runtimeSession)
              sendStream(req.cardId, { type: 'session', sessionId: sid })
              capturedSessionId = true
            }
          }

          log('msg received:', msg.type, msg.type === 'stream_event' ? (msg as any).event?.type : '')
          if (msg.type === 'stream_event') {
            const evt = msg.event as any
            if (evt.type === 'content_block_delta') {
              if (evt.delta?.type === 'text_delta' && evt.delta.text) {
                const key = `${streamTurn}:${evt.index ?? 0}`
                streamedTextByIndex.set(key, (streamedTextByIndex.get(key) ?? '') + evt.delta.text)
                assistantText += evt.delta.text
                sawAssistantOutput = true
                sendStream(req.cardId, { type: 'text', text: evt.delta.text })
              } else if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
                sawAssistantOutput = true
                sendStream(req.cardId, { type: 'thinking', text: evt.delta.thinking, thinkingId: currentThinkingId })
              } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
                sendStream(req.cardId, { type: 'tool_input', text: evt.delta.partial_json })
              }
            } else if (evt.type === 'content_block_start') {
              if (evt.content_block?.type === 'tool_use') {
                sawAssistantOutput = true
                sendStream(req.cardId, {
                  type: 'tool_start',
                  toolName: evt.content_block.name,
                  toolId: evt.content_block.id,
                })
              } else if (evt.content_block?.type === 'thinking') {
                const thinkingId = `think-${streamTurn}-${evt.index ?? 0}`
                currentThinkingId = thinkingId
                sendStream(req.cardId, { type: 'thinking_start', thinkingId })
              }
            } else if (evt.type === 'content_block_stop') {
              sendStream(req.cardId, { type: 'block_stop', index: evt.index, thinkingId: currentThinkingId })
              currentThinkingId = null
            }
          } else if (msg.type === 'assistant') {
            // Full assembled message -- forward tool_use blocks AND any text
            // that the partial stream missed (dropping text here is what caused
            // "lost chatter between tool uses").
            const message = (msg as any).message
            if (message?.content) {
              for (let idx = 0; idx < message.content.length; idx++) {
                const block = message.content[idx]
                if (block.type === 'tool_use') {
                  sawAssistantOutput = true
                  const toolInputStr = JSON.stringify(block.input, null, 2)
                  sendStream(req.cardId, {
                    type: 'tool_use',
                    toolName: block.name,
                    toolId: block.id,
                    toolInput: toolInputStr,
                  })
                  const fileChanges = buildAnthropicFileChanges(
                    block.name,
                    toolInputStr,
                    req.workspaceDir,
                  )
                  if (fileChanges.length > 0) {
                    sendStream(req.cardId, {
                      type: 'tool_summary',
                      toolId: block.id,
                      toolName: block.name,
                      fileChanges,
                    })
                  }
                } else if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
                  const key = `${streamTurn}:${idx}`
                  const alreadyStreamed = streamedTextByIndex.get(key) ?? ''
                  if (block.text === alreadyStreamed) continue
                  const tail = block.text.startsWith(alreadyStreamed)
                    ? block.text.slice(alreadyStreamed.length)
                    : block.text
                  if (tail.length > 0) {
                    assistantText += tail
                    sawAssistantOutput = true
                    sendStream(req.cardId, { type: 'text', text: tail })
                    streamedTextByIndex.set(key, block.text)
                  }
                }
              }
            }
            // Advance turn so the next assistant message gets fresh indices.
            streamTurn += 1
          } else if (msg.type === 'tool_use_summary') {
            sendStream(req.cardId, {
              type: 'tool_summary',
              text: (msg as any).summary,
            })
            if (typeof (msg as any).summary === 'string' && (msg as any).summary.trim()) sawAssistantOutput = true
          } else if (msg.type === 'tool_progress') {
            sawAssistantOutput = true
            sendStream(req.cardId, {
              type: 'tool_progress',
              toolName: (msg as any).tool_name,
              elapsed: (msg as any).elapsed_time_seconds,
            })
          } else if (msg.type === 'result') {
            if (!isActiveQuery(req.cardId, q)) {
              return
            }
            const result = msg as any
            const resultText = typeof result.result === 'string' ? result.result.trim() : ''
            if (!assistantText.trim() && resultText) {
              assistantText = resultText
              sawAssistantOutput = true
              sendStream(req.cardId, { type: 'text', text: resultText })
            }
            if (!sawAssistantOutput && !resultText) {
              runtimeSession.sessionId = result.session_id ?? runtimeSession.sessionId
              runtimeSession.isStreaming = false
              void upsertRuntimeSessionState(req, runtimeSession)
              sendStream(req.cardId, {
                type: 'error',
                error: 'Claude finished without assistant output. Only preflight/context events were emitted, so the turn was not saved as a blank reply. Please resend the message.',
              })
              clearActiveClaudeQuery(req.cardId, q)
              return
            }
            if (assistantText.trim()) {
              runtimeSession.messages = [
                ...runtimeMessages,
                { role: 'assistant', content: assistantText },
              ]
            }
            runtimeSession.sessionId = result.session_id ?? runtimeSession.sessionId
            runtimeSession.isStreaming = false
            void upsertRuntimeSessionState(req, runtimeSession)
            sendStream(req.cardId, {
              type: 'done',
              cost: result.total_cost_usd,
              turns: result.num_turns,
              resultText: result.result,
              sessionId: result.session_id,
            })
            clearActiveClaudeQuery(req.cardId, q)
            // Also capture from result if we missed earlier
            if (result.session_id && !getCardSessionId(req.cardId, req.provider)) {
              setCardSessionId(req.cardId, req.provider, result.session_id)
            }
          }
        }

        // Generator finished -- ensure done is sent
        if (isActiveQuery(req.cardId, q)) {
          if (!sawAssistantOutput && !assistantText.trim()) {
            runtimeSession.isStreaming = false
            void upsertRuntimeSessionState(req, runtimeSession)
            sendStream(req.cardId, {
              type: 'error',
              error: 'Claude stream ended before producing assistant output. Only preflight/context events were emitted, so the turn was not saved as a blank reply. Please resend the message.',
            })
            clearActiveQuery(req.cardId, q)
            return
          }
          if (assistantText.trim()) {
            runtimeSession.messages = [
              ...runtimeMessages,
              { role: 'assistant', content: assistantText },
            ]
          }
          runtimeSession.isStreaming = false
          void upsertRuntimeSessionState(req, runtimeSession)
          sendStream(req.cardId, { type: 'done', sessionId: runtimeSession.sessionId ?? undefined })
          clearActiveQuery(req.cardId, q)
        }
      } catch (err) {
        if (wasClaudeQueryIntentionallyClosed(q) || !isActiveQuery(req.cardId, q)) {
          log('generator closed for inactive Claude query:', err instanceof Error ? err.message : String(err))
          clearActiveQuery(req.cardId, q)
          return
        }
        const errorMessage = formatClaudeSdkError(err, claudeStderr)
        log('generator error:', errorMessage)
        if (assistantText.trim()) {
          runtimeSession.messages = [
            ...runtimeMessages,
            { role: 'assistant', content: assistantText },
          ]
        }
        runtimeSession.isStreaming = false
        void upsertRuntimeSessionState(req, runtimeSession)
        sendStream(req.cardId, { type: 'error', error: errorMessage })
        clearActiveQuery(req.cardId, q)
      }
    })()
  } catch (err) {
    const errorMessage = formatClaudeSdkError(err, claudeStderr)
    log('query() threw:', errorMessage)
    sendStream(req.cardId, { type: 'error', error: errorMessage })
  }
}
