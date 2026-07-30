import { net, protocol } from 'electron'
import { promises as fs } from 'fs'
import { join, extname, resolve } from 'path'
import { pathToFileURL } from 'url'
import type { ExtensionRegistry } from './registry'
import { getBridgeScript } from './bridge'
import { getSandboxProxyHtml } from './sandbox-proxy'
import { isValidExtensionId } from './identity'
import { resolveCanonicalResourcePath } from './resource-path'

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

// ── Security: no wildcard CORS on extension assets ─────────────────────────
// Each extension is served on its own origin (codesurf-ext://<extId>), so the
// browser's same-origin policy already prevents cross-extension fetches.
// We do NOT set Access-Control-Allow-Origin at all; if a future use-case needs
// CORS within an extension's own assets, add it narrowly there.
function serveFile(filePath: string): Promise<Response> {
  const ext = extname(filePath).toLowerCase()
  const mime = MIME_TYPES[ext] || 'application/octet-stream'
  return fs.readFile(filePath).then(
    buf => new Response(buf, {
      status: 200,
      headers: {
        'content-type': mime,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    }),
    () => new Response('Not found', { status: 404 }),
  )
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'codesurf-ext',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
])

function injectBridge(html: string, bridgeScript: string): string {
  const tag = `<script>${bridgeScript}</script>`

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, match => `${match}\n${tag}`)
  }

  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/<body[^>]*>/i, match => `${match}\n${tag}`)
  }

  return `${tag}\n${html}`
}

export function registerExtensionProtocol(registry: ExtensionRegistry): void {
  protocol.handle('codesurf-ext', async request => {
    try {
      const url = new URL(request.url)
      // Under the new per-extension origin scheme the URL authority IS the routing key:
      //   codesurf-ext://<extId>/<file>          — extension assets
      //   codesurf-ext://__runext_sandbox__/...   — MCP-UI double-iframe proxy (trusted host)
      //   codesurf-ext://__runext_codicons__/...  — @vscode/codicons from node_modules
      //   codesurf-ext://__runext_resource__/...  — absolute-path asset for extensions
      //
      // This gives every extension its own browser origin so the browser's built-in
      // same-origin policy prevents plugin A from fetching plugin B's assets.
      const host = url.hostname

      // ── __runext_sandbox__ — serve the MCP-UI double-iframe sandbox proxy ──
      // Served on its own dedicated host, distinct from every extension origin.
      // The proxy's postMessage relay uses targetOrigin:"*" on both sides, so
      // moving it off the shared "extension" host does not break the handshake.
      if (host === '__runext_sandbox__') {
        return new Response(getSandboxProxyHtml(), {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store, no-cache, must-revalidate',
          },
        })
      }

      // ── __runext_codicons__ — serve @vscode/codicons from node_modules ──
      if (host === '__runext_codicons__') {
        const segments = url.pathname.split('/').filter(Boolean).map(s => decodeURIComponent(s))
        const codiconBase = join(__dirname, '..', '..', 'node_modules', '@vscode', 'codicons')
        const candidate = join(codiconBase, ...segments)
        const resolvedResource = await resolveCanonicalResourcePath(codiconBase, candidate)
        if (!resolvedResource.ok) {
          return resolvedResource.status === 403
            ? new Response('Forbidden', { status: 403 })
            : new Response('Codicon resource not found', { status: 404 })
        }
        return serveFile(resolvedResource.path)
      }

      // ── __runext_resource__ — serve absolute file paths scoped to one extension ──
      // URL format: codesurf-ext://__runext_resource__/<extId>/<abs-path-segments>
      // The extId in the first path segment scopes the read to that extension's root,
      // preventing one extension from using this route to read another extension's files.
      if (host === '__runext_resource__') {
        const encodedSegments = url.pathname.split('/').filter(Boolean)
        if (encodedSegments[0]?.includes('%')) {
          return new Response('Forbidden', { status: 403 })
        }
        const segments = encodedSegments.map(s => decodeURIComponent(s))
        const [resourceExtId, ...pathSegments] = segments
        if (!resourceExtId || pathSegments.length === 0) {
          return new Response('Invalid resource URL', { status: 400 })
        }
        if (!isValidExtensionId(resourceExtId)) {
          return new Response('Forbidden', { status: 403 })
        }
        const ext = registry.get(resourceExtId)
        const root = ext?.manifest._path
        if (!root || ext?.manifest._enabled === false) {
          return new Response('Forbidden', { status: 403 })
        }
        const absPath = resolve('/' + pathSegments.join('/'))
        const resolvedResource = await resolveCanonicalResourcePath(root, absPath)
        if (!resolvedResource.ok) {
          return resolvedResource.status === 403
            ? new Response('Forbidden', { status: 403 })
            : new Response('Resource not found', { status: 404 })
        }
        return serveFile(resolvedResource.path)
      }

      // ── Extension assets ──────────────────────────────────────────────────
      // host IS the extId. Valid ids never need percent encoding, so reject it
      // rather than allowing multiple encoded authorities to alias one origin.
      const extId = host
      const fileSegments = url.pathname
        .split('/')
        .filter(Boolean)
        .map(segment => decodeURIComponent(segment))

      if (host.includes('%') || !isValidExtensionId(extId) || fileSegments.length === 0) {
        return new Response('Invalid extension URL', { status: 400 })
      }

      const ext = registry.get(extId)
      const root = ext?.manifest._path
      if (!root || ext?.manifest._enabled === false) {
        return new Response('Extension not found', { status: 404 })
      }

      const filePath = join(root, ...fileSegments)
      const resolvedResource = await resolveCanonicalResourcePath(root, filePath)
      if (!resolvedResource.ok) {
        return resolvedResource.status === 403
          ? new Response('Forbidden', { status: 403 })
          : new Response('Extension resource not found', { status: 404 })
      }
      const canonicalFilePath = resolvedResource.path

      if (/\.html?$/i.test(canonicalFilePath)) {
        const raw = await fs.readFile(canonicalFilePath, 'utf8')
        // Chat surfaces route through the same bridge — use the surface instance
        // id as the bridge's tileId so host-side RPC routing stays uniform.
        const tileId = url.searchParams.get('tileId') || url.searchParams.get('surfaceId')
        const html = tileId ? injectBridge(raw, getBridgeScript(tileId, extId, registry.getCapabilityGate(extId))) : raw
        return new Response(html, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store, no-cache, must-revalidate',
          },
        })
      }

      const resp = await net.fetch(pathToFileURL(canonicalFilePath).toString())
      // Prevent Chromium from caching extension assets so edits take effect immediately
      const headers = new Headers(resp.headers)
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate')
      return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return new Response(`Extension load failed: ${message}`, { status: 500 })
    }
  })
}
