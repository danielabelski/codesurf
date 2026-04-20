import { net, protocol } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { isAbsolute, join, relative, extname } from 'path'
import { pathToFileURL } from 'url'
import type { ExtensionRegistry } from './registry'
import { getBridgeScript } from './bridge'

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

function serveFile(filePath: string): Promise<Response> {
  const ext = extname(filePath).toLowerCase()
  const mime = MIME_TYPES[ext] || 'application/octet-stream'
  return fs.readFile(filePath).then(
    buf => new Response(buf, {
      status: 200,
      headers: {
        'content-type': mime,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Access-Control-Allow-Origin': '*',
      },
    }),
    () => new Response('Not found', { status: 404 }),
  )
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'contex-ext',
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
  protocol.handle('contex-ext', async request => {
    try {
      const url = new URL(request.url)
      const segments = url.pathname
        .split('/')
        .filter(Boolean)
        .map(segment => decodeURIComponent(segment))

      const [firstSegment, ...restSegments] = segments

      // ── __runext_resource__ — serve absolute file paths from extension assets ──
      if (firstSegment === '__runext_resource__') {
        const absPath = '/' + restSegments.join('/')
        if (!existsSync(absPath)) {
          return new Response('Resource not found', { status: 404 })
        }
        return serveFile(absPath)
      }

      // ── __runext_codicons__ — serve @vscode/codicons from node_modules ──
      if (firstSegment === '__runext_codicons__') {
        const codiconBase = join(__dirname, '..', '..', 'node_modules', '@vscode', 'codicons')
        // Also check the runext extensions dir
        const candidates = [
          join(codiconBase, ...restSegments),
          join('/Users/jkneen/clawd/runext/node_modules/@vscode/codicons', ...restSegments),
        ]
        for (const candidate of candidates) {
          if (existsSync(candidate)) {
            return serveFile(candidate)
          }
        }
        return new Response('Codicon resource not found', { status: 404 })
      }

      const extId = firstSegment
      const fileSegments = restSegments
      if (!extId || fileSegments.length === 0) {
        return new Response('Invalid extension URL', { status: 400 })
      }

      const ext = registry.get(extId)
      const root = ext?.manifest._path
      if (!root || ext?.manifest._enabled === false) {
        return new Response('Extension not found', { status: 404 })
      }

      const filePath = join(root, ...fileSegments)
      const rel = relative(root, filePath)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
        return new Response('Forbidden', { status: 403 })
      }

      if (/\.html?$/i.test(filePath)) {
        const raw = await fs.readFile(filePath, 'utf8')
        // Chat surfaces route through the same bridge — use the surface instance
        // id as the bridge's tileId so host-side RPC routing stays uniform.
        const tileId = url.searchParams.get('tileId') || url.searchParams.get('surfaceId')
        const html = tileId ? injectBridge(raw, getBridgeScript(tileId, extId)) : raw
        return new Response(html, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store, no-cache, must-revalidate',
          },
        })
      }

      const resp = await net.fetch(pathToFileURL(filePath).toString())
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
