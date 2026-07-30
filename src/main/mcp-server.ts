/**
 * Local MCP server for CodeSurf kanban integration.
 * Agents call these tools to signal completion, update status, add notes.
 *
 * Exposes an HTTP server on a random port. Port is written to:
 *   ~/.codesurf/mcp-server.json
 *
 * MCP config for agents:
 *   { "mcpServers": { "kanban": { "type": "http", "url": "http://localhost:<port>/mcp" } } }
 */

import { bus } from './event-bus'
import { createServer, type Server, IncomingMessage, ServerResponse } from 'http'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'node:crypto'
import type { ExtensionRegistry } from './extensions/registry'
import { broadcastToRenderer } from './utils/broadcast'
import { log } from './utils/logger.ts'

const mcpLog = log.scope('MCP')
import { getAllNodeTools } from '../shared/nodeTools'
import { CODESURF_HOME } from './paths'
import { assertSafePathSegment } from './security/pathSegments'
import { dispatchTool, getAllStaticTools } from './mcp/registry'
import { executeImageEditTool as executeImageEditToolImpl } from './mcp/tools/generation'
import { resolveTileWorkspaceDir } from './mcp/tools/peer-bridge'
import { requestToolPermission } from './permissions'
import type { McpToolContext, McpToolSchema } from './mcp/types'
import { resolvePrincipal, assertTileScope, type McpPrincipal } from './mcp/auth'

const MCP_TOKEN = randomUUID()
const MAX_BODY = 1024 * 1024 // 1MB

// Per-tile token registry — limits blast radius if a tile's token leaks.
// The global MCP_TOKEN remains for server discovery and renderer IPC.
const tileTokens = new Map<string, string>()

/** Generate a per-tile token for scoped MCP auth. */
export function generateTileToken(tileId: string): string {
  const existing = tileTokens.get(tileId)
  if (existing) return existing
  const token = randomUUID()
  tileTokens.set(tileId, token)
  return token
}

/** Revoke a tile's MCP token (call on tile deletion). */
export function revokeTileToken(tileId: string): void {
  tileTokens.delete(tileId)
}

/** Get a tile-specific token, generating one if needed. */
export function getTileToken(tileId: string): string {
  return generateTileToken(tileId)
}

// SSE client registry: cardId → response streams
const sseClients = new Map<string, Set<ServerResponse>>()

const getContexDir = (): string => CODESURF_HOME

interface MCPRequest {
  jsonrpc: string
  id: number | string
  method: string
  params?: {
    name?: string
    arguments?: Record<string, unknown>
  }
}

type UserConfigWorkspaceRef = {
  id: string
  path: string
}

async function readWorkspaceRefsFromUserConfig(): Promise<UserConfigWorkspaceRef[]> {
  try {
    const userConfigPath = join(getContexDir(), 'config.json')
    const raw = await fs.readFile(userConfigPath, 'utf8')
    const parsed = JSON.parse(raw) as {
      projects?: Array<{ id?: string; path?: string }>
      workspaces?: Array<{ id?: string; path?: string; projectIds?: string[]; primaryProjectId?: string | null }>
    }

    if (Array.isArray(parsed.projects) && Array.isArray(parsed.workspaces)) {
      const projectsById = new Map(
        parsed.projects
          .filter(project => typeof project?.id === 'string' && typeof project?.path === 'string' && project.path.trim())
          .map(project => [String(project.id), String(project.path).trim()] as const),
      )

      return parsed.workspaces.flatMap(workspace => {
        const workspaceId = typeof workspace?.id === 'string' ? workspace.id : ''
        if (!workspaceId) return []

        const directPath = typeof workspace?.path === 'string' ? workspace.path.trim() : ''
        if (directPath) return [{ id: workspaceId, path: directPath }]

        const primaryProjectId = typeof workspace?.primaryProjectId === 'string' ? workspace.primaryProjectId : null
        const projectIds = Array.isArray(workspace?.projectIds) ? workspace.projectIds : []
        const projectPath = (primaryProjectId && projectsById.get(primaryProjectId))
          || projectIds.map(projectId => projectsById.get(String(projectId))).find(Boolean)
          || ''
        return projectPath ? [{ id: workspaceId, path: projectPath }] : []
      })
    }

    if (Array.isArray(parsed.workspaces)) {
      return parsed.workspaces.flatMap(workspace => {
        const workspaceId = typeof workspace?.id === 'string' ? workspace.id : ''
        const workspacePath = typeof workspace?.path === 'string' ? workspace.path.trim() : ''
        return workspaceId && workspacePath ? [{ id: workspaceId, path: workspacePath }] : []
      })
    }
  } catch {
    // ignore missing or invalid config
  }

  return []
}

function normalizeMcpServer(entry: unknown, fallbackUrl?: string): Record<string, unknown> {
  if (!entry || typeof entry !== 'object') return fallbackUrl ? { type: 'http', url: fallbackUrl } : {}

  const server = { ...(entry as Record<string, unknown>) }

  if (server.url && typeof server.url === 'string') {
    server.url = server.url.replace(/\/$/, '')
  }

  if (!server.command && server.cmd && typeof server.cmd === 'string') {
    const parts = String(server.cmd).trim().split(/\s+/)
    if (parts.length > 0 && parts[0]) {
      server.command = parts[0]
      if (parts.length > 1) server.args = parts.slice(1)
    }
  }

  if (!server.type) {
    if (server.command) {
      server.type = 'stdio'
    } else if (server.url || fallbackUrl) {
      server.type = 'http'
    }
  }

  if (!server.url && fallbackUrl) {
    server.url = fallbackUrl
  }

  if (server.enabled === undefined) {
    server.enabled = true
  }

  return server
}

function normalizeMcpServers(servers: Record<string, unknown>, contexUrl?: string): Record<string, Record<string, unknown>> {
  const normalized: Record<string, Record<string, unknown>> = {}
  for (const [name, server] of Object.entries(servers ?? {})) {
    const fallbackUrl = name === 'codesurf' || name === 'contex' ? contexUrl : undefined
    normalized[name] = normalizeMcpServer(server, fallbackUrl)
  }
  return normalized
}

let extensionRegistryProvider: (() => ExtensionRegistry | null) | null = null

export function setExtensionRegistryProvider(provider: () => ExtensionRegistry | null): void {
  extensionRegistryProvider = provider
}

function getExtensionTools() {
  return extensionRegistryProvider?.()?.getMCPTools() ?? []
}

/** Tools not yet extracted into mcp/tools modules (bus ask + collab helpers). */
const LOCAL_TOOLS: McpToolSchema[] = [
  {
    name: 'ask',
    description: 'Ask the canvas operator a question. Returns when they respond.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional choices' }
      },
      required: ['channel', 'question']
    }
  },
  {
    name: 'reload_objective',
    description: 'Read the latest objective.md for a block. Call this when you receive a reload signal or need to refresh your instructions.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The block ID whose objective to read' }
      },
      required: ['tile_id']
    }
  },
  {
    name: 'pause_task',
    description: 'Pause a task. The drawer UI will show it as paused and the operator can resume it.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to publish to (e.g. tile:abc123)' },
        task_id: { type: 'string' },
        reason: { type: 'string', description: 'Why the task is being paused' }
      },
      required: ['channel', 'task_id']
    }
  },
  {
    name: 'get_context',
    description: 'Read all context files dropped into a block\'s .codesurf context folder. Returns concatenated content of all notes and reference files.',
    inputSchema: {
      type: 'object',
      properties: {
        tile_id: { type: 'string', description: 'The block ID whose context to read' }
      },
      required: ['tile_id']
    }
  },
]

function getAllTools() {
  const tools = [
    ...getAllStaticTools(),
    ...LOCAL_TOOLS,
    ...getAllNodeTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    ...getExtensionTools().map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  ]
  const seen = new Set<string>()
  return tools.filter(tool => {
    if (seen.has(tool.name)) return false
    seen.add(tool.name)
    return true
  })
}

export function getMCPToken(): string {
  return MCP_TOKEN
}

export function buildContexHttpMcpServerEntry(contexUrl: string, tileId?: string): Record<string, unknown> {
  const token = tileId ? getTileToken(tileId) : MCP_TOKEN
  return {
    type: 'http',
    url: contexUrl.replace(/\/$/, ''),
    headers: { Authorization: `Bearer ${token}` },
  }
}

/**
 * Path for a per-tile MCP config that embeds the tile-scoped bearer token.
 * Spawned agents (terminal CLI, Codex, etc.) should point at this file instead
 * of the global `~/.codesurf/mcp-server.json` so plan-010 tile scope guards
 * actually fire (SEC-05).
 */
export function tileMcpConfigPath(tileId: string): string {
  return join(getContexDir(), 'tiles', assertSafePathSegment(tileId, 'tileId'), 'mcp-server.json')
}

/**
 * Write (or refresh) a tile-scoped MCP config. Returns the absolute path, or
 * null when the server is not yet listening / tileId is invalid.
 */
export async function writeTileMcpConfig(tileId: string): Promise<string | null> {
  if (!serverPort || !tileId) return null
  let safeTileId: string
  try {
    safeTileId = assertSafePathSegment(tileId, 'tileId')
  } catch {
    return null
  }

  const configPath = join(getContexDir(), 'tiles', safeTileId, 'mcp-server.json')
  const baseUrl = `http://127.0.0.1:${serverPort}`
  const contexUrl = `${baseUrl}/mcp`
  const config = {
    port: serverPort,
    url: baseUrl,
    // tile token only — not the global MCP_TOKEN
    token: getTileToken(safeTileId),
    tileId: safeTileId,
    updatedAt: new Date().toISOString(),
    mcpServers: {
      codesurf: buildContexHttpMcpServerEntry(contexUrl, safeTileId),
    },
  }
  await fs.mkdir(join(getContexDir(), 'tiles', safeTileId), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  await fs.chmod(configPath, 0o600).catch(() => {})
  return configPath
}

/** Names of all tools returned by tools/list (static + node bridge + extensions). */
export function getContexMcpToolNames(): string[] {
  return Array.from(new Set([
    ...getAllStaticTools().map(t => t.name),
    ...LOCAL_TOOLS.map(t => t.name),
    ...getAllNodeTools().map(t => t.name),
    ...getExtensionTools().map(t => t.name),
  ]))
}

function pushSSE(cardId: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  sseClients.get(cardId)?.forEach(res => {
    try { res.write(payload) } catch { /* client disconnected */ }
  })
  sseClients.get('global')?.forEach(res => {
    try { res.write(payload) } catch { /* client disconnected */ }
  })
}

function sendToRenderer(event: string, data: unknown): void {
  broadcastToRenderer('mcp:kanban', { event, data })
}

function buildMcpToolContext(principal: McpPrincipal): McpToolContext {
  return {
    sendToRenderer,
    pushSSE,
    getExtensionRegistry: () => extensionRegistryProvider?.() ?? null,
    principal,
  }
}

export async function executeImageEditTool(
  tileId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  // Called from ipc/image.ts — a direct main-process call triggered by the
  // renderer UI, not an external MCP client. Treat as fully trusted.
  return executeImageEditToolImpl(tileId, name, args, buildMcpToolContext({ kind: 'global' }))
}

async function handleLocalTool(name: string, args: Record<string, unknown>, principal: McpPrincipal): Promise<string | null> {
  if (name === 'ask') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'ask',
      source: 'mcp',
      payload: { question: args.question, options: args.options ?? [] }
    })
    sendToRenderer('bus:event', evt)
    return `Question asked on ${args.channel}: "${args.question}"`
  }

  if (name === 'reload_objective') {
    let tileId: string
    try { tileId = assertSafePathSegment(args.tile_id as string, 'tile_id') }
    catch { return 'Invalid tile_id' }
    const scopeError = assertTileScope(principal, tileId)
    if (scopeError) return scopeError
    try {
      const workspaces = await readWorkspaceRefsFromUserConfig()
      for (const ws of workspaces) {
        const objPath = join(ws.path, '.codesurf', tileId, 'objective.md')
        try {
          return await fs.readFile(objPath, 'utf8')
        } catch { /* not in this workspace */ }
      }
    } catch { /**/ }
    return `No objective.md found for block ${tileId}`
  }

  if (name === 'pause_task') {
    const evt = bus.publish({
      channel: args.channel as string,
      type: 'task',
      source: 'mcp',
      payload: { task_id: args.task_id, status: 'paused', action: 'update', reason: args.reason }
    })
    sendToRenderer('bus:event', evt)
    return `Task ${args.task_id} paused${args.reason ? `: ${args.reason}` : ''}`
  }

  if (name === 'get_context') {
    let tileId: string
    try { tileId = assertSafePathSegment(args.tile_id as string, 'tile_id') }
    catch { return 'Invalid tile_id' }
    const scopeError = assertTileScope(principal, tileId)
    if (scopeError) return scopeError
    try {
      const workspaces = await readWorkspaceRefsFromUserConfig()
      for (const ws of workspaces) {
        const ctxDir = join(ws.path, '.codesurf', tileId, 'context')
        try {
          const entries = await fs.readdir(ctxDir)
          const parts: string[] = []
          for (const entry of entries) {
            if (entry.startsWith('.')) continue
            try {
              const content = await fs.readFile(join(ctxDir, entry), 'utf8')
              parts.push(`--- ${entry} ---\n${content}`)
            } catch { /**/ }
          }
          if (parts.length > 0) return parts.join('\n\n')
        } catch { /* not in this workspace */ }
      }
    } catch { /**/ }
    return `No context files found for block ${tileId}`
  }

  return null
}

async function handleTool(name: string, args: Record<string, unknown>, principal: McpPrincipal): Promise<string> {
  const ctx = buildMcpToolContext(principal)
  const dispatched = await dispatchTool(name, args, ctx)
  if (dispatched !== null) return dispatched

  const local = await handleLocalTool(name, args, principal)
  if (local !== null) return local

  const extensionTool = getExtensionTools().find(tool => tool.name === name)
  if (extensionTool) {
    if (!extensionTool.handler) {
      return `Extension tool ${name} is declared but has no handler`
    }
    return extensionTool.handler(args)
  }

  return 'Unknown tool'
}

async function handleMCP(req: MCPRequest, principal: McpPrincipal): Promise<unknown> {
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0', id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'codesurf', version: '1.0.0' },
        instructions: [
          'You are connected to the CodeSurf agent-room collaboration server.',
          'Your block ID is in the CARD_ID environment variable.',
          'Canvas wires place you in a shared agent room with other blocks.',
          '',
          'IMMEDIATELY call room_status(tile_id=$CARD_ID) to see your room and members.',
          'Then call peer_set_state to announce idle/working status.',
          'Use room_post for handoffs/tasks; room_consume for unread room traffic.',
          'Chat agents auto-receive room traffic each turn; terminals should room_consume when needed.',
        ].join('\n'),
      }
    }
  }

  if (req.method === 'tools/list') {
    return { jsonrpc: '2.0', id: req.id, result: { tools: getAllTools() } }
  }

  if (req.method === 'tools/call') {
    const name = req.params?.name ?? ''
    const args = (req.params?.arguments ?? {}) as Record<string, unknown>
    const result = await handleTool(name, args, principal)
    return {
      jsonrpc: '2.0', id: req.id,
      result: { content: [{ type: 'text', text: result }] }
    }
  }

  return {
    jsonrpc: '2.0', id: req.id,
    error: { code: -32601, message: 'Method not found' }
  }
}

let serverPort: number | null = null
let mcpHttpServer: Server | null = null

function setCorsHeaders(res: ServerResponse, req?: IncomingMessage): void {
  // Restrictive CORS: allow only known Electron origins. DNS-rebinding defense
  // is isLoopbackHost() below — every request that reaches a handler has a
  // loopback Host. CORS restricts which browser origins can read responses.
  // Non-browser clients (agents/MCP transport) don't send Origin and work fine.
  const origin = req?.headers.origin
  const isAllowedOrigin = !origin ||
    origin === 'null' ||                              // file:// in production
    origin.startsWith('http://localhost:') ||          // dev server
    origin === 'http://localhost' ||
    origin.startsWith('app://') ||                    // custom Electron schemes
    origin === 'app://codesurf'
  if (isAllowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
    if (origin) res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Cache-Control, Authorization')
}

// Reject requests whose Host header is not loopback. This defeats DNS-rebinding:
// a malicious site that resolves its hostname to 127.0.0.1 still sends its own
// hostname in the Host header, which we refuse. Legitimate local clients always
// address 127.0.0.1/localhost, so they are unaffected.
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase().trim()
  if (!host) return false
  const name = host.replace(/:\d+$/, '')
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]' || name === '::1'
}

// Every non-OPTIONS request requires auth. This is a blanket fail-closed policy:
// adding a new route never accidentally becomes unauthenticated.
function isSensitiveMcpRoute(_method: string | undefined, _isEvents: boolean): boolean {
  return true
}

function readBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? ''
  if (!auth.startsWith('Bearer ')) return null
  return auth.slice('Bearer '.length)
}

function readQueryToken(url: URL): string | null {
  return url.searchParams.get('token') ?? url.searchParams.get('access_token')
}

/**
 * Authenticate a request and return the principal that authenticated it.
 * Returns null when auth fails — the 401 response has already been written.
 */
export function requireMcpAuth(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { allowQueryToken?: boolean, url?: URL },
): McpPrincipal | null {
  const bearer = readBearerToken(req)
  const queryToken = options?.allowQueryToken && options.url
    ? readQueryToken(options.url)
    : null
  const token = bearer ?? queryToken

  const principal = resolvePrincipal(token, MCP_TOKEN, tileTokens)
  if (principal) return principal

  setCorsHeaders(res, req)
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Unauthorized' }))
  return null
}

export function stopMCPServer(): Promise<void> {
  return new Promise(resolve => {
    const server = mcpHttpServer
    if (!server) {
      resolve()
      return
    }
    server.close(() => {
      mcpHttpServer = null
      serverPort = null
      resolve()
    })
  })
}

export async function startMCPServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1`)
      const pathname = url.pathname.replace(/\/+$/, '') || '/'
      const normalizedEventsPath = pathname.endsWith('/events') ? '/events' : pathname
      const isEvents = req.method === 'GET' && normalizedEventsPath === '/events'

      // Reject non-loopback Host headers (DNS-rebinding defense) before doing
      // any work. Applies to every method including OPTIONS preflight.
      if (!isLoopbackHost(req)) {
        setCorsHeaders(res, req)
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Forbidden: non-loopback Host header' }))
        return
      }

      // CORS preflight
      if (req.method === 'OPTIONS') {
        setCorsHeaders(res, req)
        res.writeHead(200)
        res.end()
        return
      }

      // isSensitiveMcpRoute is a blanket fail-closed policy — it always
      // returns true today, so every route below goes through requireMcpAuth
      // and `principal` is always populated. The { kind: 'global' } fallback
      // only matters if a future route is ever marked non-sensitive.
      // `principal` is assigned once (const) below so its non-null type is
      // preserved inside the request-body closures further down.
      let resolvedPrincipal: McpPrincipal = { kind: 'global' }
      if (isSensitiveMcpRoute(req.method, isEvents)) {
        const authedPrincipal = requireMcpAuth(req, res, { allowQueryToken: isEvents, url })
        if (!authedPrincipal) return
        resolvedPrincipal = authedPrincipal
      }
      const principal = resolvedPrincipal

      // SSE: GET /events?card_id=xxx  — agent streams status to canvas
      if (isEvents) {
        const cardId = url.searchParams.get('card_id') ?? 'global'
        // A tile-scoped token may only subscribe to its own card's stream;
        // 'global'/absent card subscriptions require the global token.
        const scopeError = assertTileScope(principal, cardId)
        if (scopeError) {
          setCorsHeaders(res, req)
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: scopeError }))
          return
        }
        setCorsHeaders(res, req)
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        })
        res.write(':connected\n\n')

        if (!sseClients.has(cardId)) sseClients.set(cardId, new Set())
        sseClients.get(cardId)!.add(res)

        // Keepalive ping every 15s
        const ping = setInterval(() => {
          try { res.write(':ping\n\n') } catch { clearInterval(ping) }
        }, 15000)

        req.on('close', () => {
          clearInterval(ping)
          const set = sseClients.get(cardId)
          if (set) {
            set.delete(res)
            if (set.size === 0) sseClients.delete(cardId)
          }
        })
        return
      }

      // SSE push: POST /push — agent sends an event to the canvas
      if (req.method === 'POST' && url.pathname === '/push') {
        let body = ''
        let bodySize = 0
        req.on('data', (chunk: Buffer | string) => {
          bodySize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
          if (bodySize > MAX_BODY) {
            setCorsHeaders(res, req)
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Request body too large' }))
            req.destroy()
            return
          }
          body += chunk
        })
        req.on('end', () => {
          try {
            const { card_id, event, data } = JSON.parse(body)
            const scopeError = assertTileScope(principal, card_id)
            if (scopeError) {
              setCorsHeaders(res, req)
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: scopeError }))
              return
            }
            pushSSE(card_id, event, data)
            sendToRenderer(event, { cardId: card_id, ...data })
            setCorsHeaders(res, req)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          } catch {
            setCorsHeaders(res, req)
            res.writeHead(400); res.end()
          }
        })
        return
      }

      // Canvas → Agent: POST /inject — write a message into agent's terminal
      if (req.method === 'POST' && url.pathname === '/inject') {
        let body = ''
        let bodySize = 0
        req.on('data', (chunk: Buffer | string) => {
          bodySize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
          if (bodySize > MAX_BODY) {
            setCorsHeaders(res, req)
            res.writeHead(413, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'Request body too large' }))
            req.destroy()
            return
          }
          body += chunk
        })
        req.on('end', async () => {
          try {
            const { card_id, message, append_newline = true } = JSON.parse(body)
            const scopeError = assertTileScope(principal, card_id)
            if (scopeError) {
              setCorsHeaders(res, req)
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: scopeError }))
              return
            }
            // /inject writes into a live terminal — the same capability class
            // as terminal_send_input, so gate it behind the same permission
            // prompt instead of leaving it as an ungated bypass route.
            const workspaceDir = await resolveTileWorkspaceDir(String(card_id ?? ''))
            const allowed = await requestToolPermission({
              provider: 'mcp',
              toolName: 'terminal_send_input',
              workspaceDir: workspaceDir ?? undefined,
              title: 'Terminal input via /inject',
              description: `An MCP agent wants to write into terminal tile "${card_id}" via /inject:\n${String(message ?? '').slice(0, 200)}${String(message ?? '').length > 200 ? '...' : ''}`,
            }, /* interactive */ true)
            if (!allowed) {
              setCorsHeaders(res, req)
              res.writeHead(403, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Permission denied: /inject was not approved' }))
              return
            }
            // Tell renderer to write to the terminal
            broadcastToRenderer('mcp:inject', { cardId: card_id, message, appendNewline: append_newline })
            // Also push SSE so other agents/subscribers know
            pushSSE(card_id, 'canvas_message', { message })
            setCorsHeaders(res, req)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end('{"ok":true}')
          } catch {
            setCorsHeaders(res, req)
            res.writeHead(400); res.end()
          }
        })
        return
      }

      // MCP: POST /  or POST /mcp
      if (req.method !== 'POST') {
        setCorsHeaders(res, req)
        res.writeHead(405); res.end(); return
      }

      let body = ''
      let bodySize = 0
      req.on('data', (chunk: Buffer | string) => {
        bodySize += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        if (bodySize > MAX_BODY) {
          setCorsHeaders(res, req)
          res.writeHead(413, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Request body too large' }))
          req.destroy()
          return
        }
        body += chunk
      })
      req.on('end', async () => {
        try {
          const mcpReq: MCPRequest = JSON.parse(body)
          const response = await handleMCP(mcpReq, principal)
          setCorsHeaders(res, req)
          res.writeHead(200, {
            'Content-Type': 'application/json'
          })
          res.end(JSON.stringify(response))
        } catch (e) {
          setCorsHeaders(res, req)
          res.writeHead(400); res.end()
        }
      })
    })

    mcpHttpServer = server
    server.listen(0, '127.0.0.1', async () => {
      const addr = server.address() as { port: number }
      serverPort = addr.port

      const baseUrl = `http://127.0.0.1:${serverPort}`
      const contexUrl = `${baseUrl}/mcp`
      const configPath = join(getContexDir(), 'mcp-server.json')

      const COLLAB_DIR = getContexDir()
      await fs.mkdir(COLLAB_DIR, { recursive: true })

      let existingConfig: Record<string, unknown> = {}
      try {
        const existingRaw = await fs.readFile(configPath, 'utf8')
        const parsed = JSON.parse(existingRaw)
        if (parsed && typeof parsed === 'object') existingConfig = parsed as Record<string, unknown>
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[mcp] Failed to read existing config for merge:', err)
        }
      }

      const existingServers = typeof existingConfig.mcpServers === 'object' && existingConfig.mcpServers !== null
        ? existingConfig.mcpServers as Record<string, unknown>
        : {}
      const normalizedServers = normalizeMcpServers(existingServers, contexUrl)
      normalizedServers['codesurf'] = {
        ...(normalizeMcpServer(existingConfig.mcpServers && typeof existingConfig.mcpServers === 'object' ? (existingConfig.mcpServers as Record<string, unknown>)['codesurf'] : undefined, contexUrl) as Record<string, unknown>),
        ...buildContexHttpMcpServerEntry(contexUrl),
      }

      const mcpConfig = {
        ...(existingConfig ?? {}),
        port: serverPort,
        url: baseUrl,
        token: MCP_TOKEN,
        updatedAt: new Date().toISOString(),
        mcpServers: normalizedServers,
        tools: getAllTools().map(t => ({ name: t.name, description: t.description })),
        endpoints: {
          mcp: baseUrl,
          events: `${baseUrl}/events`,
          push: `${baseUrl}/push`,
          inject: `${baseUrl}/inject`
        }
      }
      // 0o600: this file holds the server port and bearer token; keep it
      // readable only by the owning user (matches secrets.json). chmod covers
      // files that already existed at the default 0o644.
      await fs.writeFile(configPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 })
      await fs.chmod(configPath, 0o600).catch(() => {})

      // Write .mcp.json to all known workspace directories so Claude Code
      // sessions in terminal tiles auto-discover the codesurf MCP server
      try {
        const workspaceRefs = await readWorkspaceRefsFromUserConfig()
        for (const ws of workspaceRefs) {
          writeMCPConfigToWorkspace(ws.path).catch(() => {})
        }
      } catch { /* no workspaces yet */ }

      mcpLog.info(`Kanban server running on port ${serverPort}`)
      resolve(serverPort)
    })

    server.on('error', reject)
  })
}

export function getMCPPort(): number | null {
  return serverPort
}

/**
 * Write a .mcp.json to a workspace directory so Claude Code sessions
 * in terminal tiles auto-discover the codesurf MCP server.
 * Also adds tool permissions so MCP tools don't need manual approval.
 */
export async function writeMCPConfigToWorkspace(workspacePath: string): Promise<void> {
  if (!serverPort) return

  // Ensure .mcp.json (which embeds the bearer token) is gitignored BEFORE we
  // write it. If the gitignore append fails we bail out: a leaked token in a
  // committed .mcp.json is worse than missing auto-discovery (L3).
  const { ensureWorkspaceSecretsGitignored } = await import('./security/workspaceSecrets.ts')
  try {
    await ensureWorkspaceSecretsGitignored(workspacePath)
  } catch (err) {
    console.warn(`[MCP] Skipping .mcp.json write to ${workspacePath}: could not update .gitignore — ${(err as Error).message}`)
    return
  }

  const mcpJsonPath = join(workspacePath, '.mcp.json')
  const contexUrl = `http://127.0.0.1:${serverPort}/mcp`

  // Read existing .mcp.json to preserve user-added servers
  let existing: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(mcpJsonPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[mcp] Failed to read existing .mcp.json for merge:', err)
    }
  }

  const existingServers = typeof existing.mcpServers === 'object' && existing.mcpServers !== null
    ? existing.mcpServers as Record<string, unknown>
    : {}

  existingServers['codesurf'] = buildContexHttpMcpServerEntry(contexUrl)

  const config = {
    ...existing,
    mcpServers: existingServers,
  }

  await fs.writeFile(mcpJsonPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  await fs.chmod(mcpJsonPath, 0o600).catch(() => {})
  mcpLog.info(`Wrote .mcp.json to ${workspacePath}`)

  // Write .claude/CLAUDE.md with peer collaboration instructions
  // Claude Code reads this automatically on every session
  await writeContexClaudeMd(workspacePath)
}

/**
 * Drop the CodeSurf peer-collaboration instructions into a workspace so Claude
 * Code sessions pick them up automatically.
 *
 * Data-safety: NEVER overwrite a hand-written CLAUDE.md. Three cases:
 *  1. File absent                → write the managed file.
 *  2. File present, has marker   → already ours, no-op.
 *  3. File present, no marker    → user-owned. Write a sidecar
 *                                 `.claude/codesurf.md` instead and append a
 *                                 single one-line `@codesurf.md` import to their
 *                                 CLAUDE.md (Claude Code's native include syntax).
 *                                 The import line is idempotent and reversible.
 */
async function writeContexClaudeMd(workspacePath: string): Promise<void> {
  const claudeDir = join(workspacePath, '.claude')
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')
  const sidecarPath = join(claudeDir, 'codesurf.md')
  const IMPORT_LINE = '@codesurf.md'

  let existing = ''
  let exists = false
  try {
    existing = await fs.readFile(claudeMdPath, 'utf8')
    exists = true
  } catch { /* doesn't exist yet */ }

  // Case 2: already managed by us.
  if (exists && existing.includes('<!-- codesurf-managed -->')) return

  await fs.mkdir(claudeDir, { recursive: true })

  // Case 3: user-owned file — don't touch it beyond a single reversible import line.
  if (exists) {
    if (existing.split(/\r?\n/).includes(IMPORT_LINE)) {
      // Import already wired; make sure the sidecar body is current.
      await fs.writeFile(sidecarPath, buildContexClaudeMdContent(), 'utf8')
      return
    }
    const next = `${existing.replace(/\s*$/, '')}\n\n${IMPORT_LINE}\n`
    await fs.writeFile(claudeMdPath, next, 'utf8')
    await fs.writeFile(sidecarPath, buildContexClaudeMdContent(), 'utf8')
    mcpLog.info(`Added @codesurf.md import to existing ${claudeMdPath}`)
    return
  }

  // Case 1: no file — write the full managed document.
  await fs.writeFile(claudeMdPath, buildContexClaudeMdContent(), 'utf8')
  mcpLog.info(`Wrote .claude/CLAUDE.md to ${workspacePath}`)
}

function buildContexClaudeMdContent(): string {
  return `<!-- codesurf-managed -->
# CodeSurf Canvas Agent

You are running inside CodeSurf, an infinite canvas workspace where multiple AI agents share agent rooms.
Your block ID is the environment variable \`CARD_ID\`. Wires on the canvas put you in a room with other blocks.

## MANDATORY: First Action on Every Session

\`\`\`
1. mcp__codesurf__room_status(tile_id=$CARD_ID)
2. mcp__codesurf__peer_set_state(tile_id=$CARD_ID, tile_type="terminal", status="idle", task="Ready")
3. mcp__codesurf__room_consume(tile_id=$CARD_ID)   # if unconsumed > 0
\`\`\`

Also read \`~/.codesurf/room-inboxes/$CARD_ID/ROOM.md\` for a live inbox dump.

## Agent Room Protocol

**When you receive a task:**
1. \`peer_set_state\` status=working with a short task description
2. \`room_status\` / \`peer_get_state\` to see room members
3. \`room_post\` kind=task|handoff when another block should act
4. Prefer room traffic over guessing what peers are doing

**During work:**
- \`room_consume\` when you need pending peer traffic
- \`room_post\` for findings, blockers, questions
- \`peer_set_state\` when files/tasks change

**On completion:**
- \`peer_set_state\` status=done
- \`room_post\` kind=summary with what you finished

**File conflict rule:**
NEVER edit a file another room member lists in their files without \`room_post\` / \`peer_send_message\` coordination first.

## Tool prefix

All tools: \`mcp__codesurf__*\`
- room_status / room_post / room_consume
- peer_set_state / peer_get_state / peer_send_message
- canvas_* / terminal_send_input / chat_send_message
`
}
