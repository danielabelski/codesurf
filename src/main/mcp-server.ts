/**
 * Local MCP server for Contex kanban integration.
 * Agents call these tools to signal completion, update status, add notes.
 *
 * Exposes an HTTP server on a random port. Port is written to:
 *   ~/.contex/mcp-server.json
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
import { getAllNodeTools } from '../shared/nodeTools'
import { CONTEX_HOME } from './paths'
import { assertSafePathSegment } from './security/pathSegments'
import { dispatchTool, getAllStaticTools } from './mcp/registry'
import { executeImageEditTool as executeImageEditToolImpl } from './mcp/tools/generation'
import type { McpToolContext, McpToolSchema } from './mcp/types'

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

const getContexDir = (): string => CONTEX_HOME

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
    const fallbackUrl = name === 'contex' ? contexUrl : undefined
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
    description: 'Read all context files dropped into a block\'s .contex context folder. Returns concatenated content of all notes and reference files.',
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

function buildMcpToolContext(): McpToolContext {
  return {
    sendToRenderer,
    pushSSE,
    getExtensionRegistry: () => extensionRegistryProvider?.() ?? null,
  }
}

export async function executeImageEditTool(
  tileId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  return executeImageEditToolImpl(tileId, name, args, buildMcpToolContext())
}

async function handleLocalTool(name: string, args: Record<string, unknown>): Promise<string | null> {
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
    try {
      const workspaces = await readWorkspaceRefsFromUserConfig()
      for (const ws of workspaces) {
        const objPath = join(ws.path, '.contex', tileId, 'objective.md')
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
    try {
      const workspaces = await readWorkspaceRefsFromUserConfig()
      for (const ws of workspaces) {
        const ctxDir = join(ws.path, '.contex', tileId, 'context')
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

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  const ctx = buildMcpToolContext()
  const dispatched = await dispatchTool(name, args, ctx)
  if (dispatched !== null) return dispatched

  const local = await handleLocalTool(name, args)
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

async function handleMCP(req: MCPRequest): Promise<unknown> {
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0', id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'contex', version: '1.0.0' },
        instructions: [
          'You are connected to the CodeSurf canvas collaboration server.',
          'Your block ID is in the CARD_ID environment variable.',
          '',
          'IMMEDIATELY call peer_set_state with your tile_id, tile_type, and status="idle" to register yourself.',
          'Then call peer_get_state to see linked peers.',
          '',
          'Before editing any file, call peer_get_state to check if a peer is already working on it.',
          'When you see [contex] notifications, call peer_read_messages to read incoming messages.',
          'Always call peer_set_state when changing tasks or files.',
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
    const result = await handleTool(name, args)
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

export function requireMcpAuth(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { allowQueryToken?: boolean, url?: URL },
): boolean {
  const bearer = readBearerToken(req)
  const queryToken = options?.allowQueryToken && options.url
    ? readQueryToken(options.url)
    : null
  const token = bearer ?? queryToken

  // Check against global token first, then per-tile tokens
  if (token === MCP_TOKEN) return true
  if (token && tileTokens.has(token)) return true

  setCorsHeaders(res, req)
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Unauthorized' }))
  return false
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

      if (
        isSensitiveMcpRoute(req.method, isEvents)
        && !requireMcpAuth(req, res, { allowQueryToken: isEvents, url })
      ) {
        return
      }

      // SSE: GET /events?card_id=xxx  — agent streams status to canvas
      if (isEvents) {
        const cardId = url.searchParams.get('card_id') ?? 'global'
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
        req.on('end', () => {
          try {
            const { card_id, message, append_newline = true } = JSON.parse(body)
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
          const response = await handleMCP(mcpReq)
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
      normalizedServers['contex'] = {
        ...(normalizeMcpServer(existingConfig.mcpServers && typeof existingConfig.mcpServers === 'object' ? (existingConfig.mcpServers as Record<string, unknown>)['contex'] : undefined, contexUrl) as Record<string, unknown>),
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
      // sessions in terminal tiles auto-discover the contex MCP server
      try {
        const workspaceRefs = await readWorkspaceRefsFromUserConfig()
        for (const ws of workspaceRefs) {
          writeMCPConfigToWorkspace(ws.path).catch(() => {})
        }
      } catch { /* no workspaces yet */ }

      console.log(`[MCP] Kanban server running on port ${serverPort}`)
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
 * in terminal tiles auto-discover the contex MCP server.
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

  existingServers['contex'] = buildContexHttpMcpServerEntry(contexUrl)

  const config = {
    ...existing,
    mcpServers: existingServers,
  }

  await fs.writeFile(mcpJsonPath, JSON.stringify(config, null, 2), { mode: 0o600 })
  await fs.chmod(mcpJsonPath, 0o600).catch(() => {})
  console.log(`[MCP] Wrote .mcp.json to ${workspacePath}`)

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
 *                                 `.claude/contex.md` instead and append a
 *                                 single one-line `@contex.md` import to their
 *                                 CLAUDE.md (Claude Code's native include syntax).
 *                                 The import line is idempotent and reversible.
 */
async function writeContexClaudeMd(workspacePath: string): Promise<void> {
  const claudeDir = join(workspacePath, '.claude')
  const claudeMdPath = join(claudeDir, 'CLAUDE.md')
  const sidecarPath = join(claudeDir, 'contex.md')
  const IMPORT_LINE = '@contex.md'

  let existing = ''
  let exists = false
  try {
    existing = await fs.readFile(claudeMdPath, 'utf8')
    exists = true
  } catch { /* doesn't exist yet */ }

  // Case 2: already managed by us.
  if (exists && existing.includes('<!-- contex-managed -->')) return

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
    console.log(`[MCP] Added @contex.md import to existing ${claudeMdPath}`)
    return
  }

  // Case 1: no file — write the full managed document.
  await fs.writeFile(claudeMdPath, buildContexClaudeMdContent(), 'utf8')
  console.log(`[MCP] Wrote .claude/CLAUDE.md to ${workspacePath}`)
}

function buildContexClaudeMdContent(): string {
  return `<!-- contex-managed -->
# CodeSurf Canvas Agent

You are running inside CodeSurf, an infinite canvas workspace where multiple AI agents collaborate.
Your block ID is available as the environment variable \`CARD_ID\`.

## MANDATORY: First Action on Every Session

Before doing ANYTHING else, you MUST run these two commands:

\`\`\`
1. mcp__contex__peer_set_state(tile_id=$CARD_ID, tile_type="terminal", status="idle", task="Ready")
2. mcp__contex__peer_get_state(tile_id=$CARD_ID)
\`\`\`

This registers you with the collaboration system and shows you who else is working.

## Peer Collaboration Protocol

**When you receive a task:**
1. Call \`peer_set_state\` with status "working" and describe your task
2. Call \`peer_get_state\` to check what linked peers are doing
3. If a peer lists the same files in their state, call \`peer_send_message\` to coordinate BEFORE editing

**During work:**
- Call \`peer_set_state\` whenever you switch files or tasks
- Call \`peer_read_messages\` to check for incoming messages from peers
- Use \`peer_add_todo\` for work you need a peer to handle
- When you see a \`[contex]\` notification, call \`peer_read_messages\` immediately

**On completion:**
- Call \`peer_set_state\` with status "done" and a summary
- Call \`peer_complete_todo\` for any todos you finished

**File conflict rule:**
NEVER edit a file that a linked peer lists in their \`files\` array. Send them a \`peer_send_message\` first and wait for coordination.

## Available Tool Prefixes

All contex tools use the prefix \`mcp__contex__\`. Examples:
- \`mcp__contex__peer_set_state\` — declare your state
- \`mcp__contex__peer_get_state\` — read peer states
- \`mcp__contex__peer_send_message\` — message a peer
- \`mcp__contex__peer_read_messages\` — read your messages
- \`mcp__contex__peer_add_todo\` / \`peer_complete_todo\` — shared todos
- \`mcp__contex__canvas_create_tile\` — create blocks on the canvas
- \`mcp__contex__terminal_send_input\` — type into a peer terminal block
- \`mcp__contex__chat_send_message\` — message a peer chat block
`
}
