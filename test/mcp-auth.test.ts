import { register } from 'node:module'
import assert from 'node:assert/strict'
import { describe, test, before, after } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

// Redirect the app home to a throwaway dir BEFORE importing mcp-server:
// startMCPServer writes mcp-server.json into CODESURF_HOME and drops
// .mcp.json / CLAUDE.md into every workspace from config.json — without this
// override the test suite overwrites the live ~/.codesurf configuration.
const testCodesurfHome = mkdtempSync(join(tmpdir(), 'codesurf-mcp-auth-'))
process.env.CODESURF_HOME = testCodesurfHome
process.on('exit', () => {
  rmSync(testCodesurfHome, { recursive: true, force: true })
})

// Electron and extensionless relative imports are unavailable under plain
// node:test; register a tiny resolver before loading mcp-server.
const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return {
      shortCircuit: true,
      url: 'data:text/javascript,' + encodeURIComponent(\`
        export class BrowserWindow {
          static getAllWindows() { return [] }
          static getFocusedWindow() { return null }
          isDestroyed() { return false }
        }
        export const dialog = {
          showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
          showMessageBox: async () => ({ response: globalThis.__mcpAuthDialogResponse ?? 0, checkboxChecked: false }),
        }
      \`),
    }
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\\\\.(ts|js|json|node)$/.test(specifier)) {
    try {
      return await nextResolve(specifier + '.ts', context)
    } catch {}
  }
  return nextResolve(specifier, context)
}
`
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url)

const {
  requireMcpAuth,
  getMCPToken,
  buildContexHttpMcpServerEntry,
  startMCPServer,
  stopMCPServer,
} = await import('../src/main/mcp-server.ts')

function mockResponse(): ServerResponse & { status?: number, body?: string, headers: Record<string, string | string[] | undefined> } {
  const headers: Record<string, string | string[] | undefined> = {}
  const res = {
    headers,
    status: undefined as number | undefined,
    body: undefined as string | undefined,
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value
    },
    writeHead(status: number, hdrs?: Record<string, string>) {
      this.status = status
      if (hdrs) {
        for (const [name, value] of Object.entries(hdrs)) {
          this.setHeader(name, value)
        }
      }
    },
    end(payload?: string) {
      this.body = payload
    },
  }
  return res as ServerResponse & typeof res
}

async function request(
  port: number,
  options: {
    method: string
    path: string
    headers?: Record<string, string>
    body?: string
  },
): Promise<{ status: number, body: string }> {
  const headers = {
    host: `127.0.0.1:${port}`,
    ...options.headers,
  }
  if (options.body) {
    headers['content-length'] = String(Buffer.byteLength(options.body))
  }
  const res = await fetch(`http://127.0.0.1:${port}${options.path}`, {
    method: options.method,
    headers,
    body: options.body,
  })
  return { status: res.status, body: await res.text() }
}

describe('buildContexHttpMcpServerEntry', () => {
  test('includes bearer auth headers for HTTP MCP clients', () => {
    const entry = buildContexHttpMcpServerEntry('http://127.0.0.1:4242/mcp')
    assert.equal(entry.type, 'http')
    assert.equal(entry.url, 'http://127.0.0.1:4242/mcp')
    assert.deepEqual(entry.headers, { Authorization: `Bearer ${getMCPToken()}` })
  })
})

describe('requireMcpAuth', () => {
  test('rejects missing Authorization with 401 JSON', () => {
    const req = { headers: {} } as IncomingMessage
    const res = mockResponse()
    assert.equal(requireMcpAuth(req, res), null)
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body ?? ''), { error: 'Unauthorized' })
  })

  test('rejects invalid Bearer token', () => {
    const req = { headers: { authorization: 'Bearer wrong-token' } } as IncomingMessage
    const res = mockResponse()
    assert.equal(requireMcpAuth(req, res), null)
    assert.equal(res.status, 401)
  })

  test('accepts valid Bearer token and returns a global principal', () => {
    const token = getMCPToken()
    const req = { headers: { authorization: `Bearer ${token}` } } as IncomingMessage
    const res = mockResponse()
    assert.deepEqual(requireMcpAuth(req, res), { kind: 'global' })
    assert.equal(res.status, undefined)
  })
})

describe('MCP HTTP auth gates', () => {
  let port = 0

  before(async () => {
    port = await startMCPServer()
  })

  after(async () => {
    await stopMCPServer()
  })

  test('POST /mcp without Bearer is rejected', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' })
  })

  test('POST /mcp with valid Bearer succeeds', async () => {
    const token = getMCPToken()
    const res = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body) as { result?: { tools?: unknown[] } }
    assert.ok(Array.isArray(payload.result?.tools))
  })

  test('POST /push without Bearer is rejected', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/push',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card_id: 'card-1', event: 'card_update', data: { note: 'hi' } }),
    })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' })
  })

  test('POST /inject without Bearer is rejected', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/inject',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ card_id: 'card-1', message: 'hello' }),
    })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' })
  })

  test('GET /events without Bearer is rejected', async () => {
    const res = await request(port, { method: 'GET', path: '/events?card_id=global' })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' })
  })

  test('GET /events accepts token query param for EventSource clients', async () => {
    const token = getMCPToken()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_000)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/events?card_id=global&token=${encodeURIComponent(token)}`, {
        method: 'GET',
        headers: { host: `127.0.0.1:${port}` },
        signal: controller.signal,
      })
      assert.equal(res.status, 200)
      const reader = res.body?.getReader()
      assert.ok(reader)
      const first = await reader.read()
      const chunk = new TextDecoder().decode(first.value ?? new Uint8Array())
      assert.match(chunk, /:connected/)
      await reader.cancel()
    } finally {
      clearTimeout(timeout)
    }
  })

  test('POST /push with valid Bearer succeeds', async () => {
    const token = getMCPToken()
    const res = await request(port, {
      method: 'POST',
      path: '/push',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ card_id: 'card-1', event: 'card_update', data: { note: 'ok' } }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true })
  })

  test('POST /mcp tools/call without Bearer is rejected', async () => {
    const res = await request(port, {
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'canvas_list_tiles', arguments: {} },
      }),
    })
    assert.equal(res.status, 401)
    assert.deepEqual(JSON.parse(res.body), { error: 'Unauthorized' })
  })

  test('POST /inject with valid Bearer is denied when the user rejects the permission prompt', async () => {
    const token = getMCPToken()
    ;(globalThis as Record<string, unknown>).__mcpAuthDialogResponse = 0 // "Deny"
    try {
      const res = await request(port, {
        method: 'POST',
        path: '/inject',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ card_id: 'card-1', message: 'rm -rf ~' }),
      })
      assert.equal(res.status, 403)
    } finally {
      delete (globalThis as Record<string, unknown>).__mcpAuthDialogResponse
    }
  })

  test('POST /inject with valid Bearer succeeds when the user approves the permission prompt', async () => {
    const token = getMCPToken()
    ;(globalThis as Record<string, unknown>).__mcpAuthDialogResponse = 2 // "Allow Once"
    try {
      const res = await request(port, {
        method: 'POST',
        path: '/inject',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ card_id: 'card-1', message: 'hello from agent' }),
      })
      assert.equal(res.status, 200)
      const payload = JSON.parse(res.body) as { ok?: boolean }
      assert.equal(payload.ok, true)
    } finally {
      delete (globalThis as Record<string, unknown>).__mcpAuthDialogResponse
    }
  })
})