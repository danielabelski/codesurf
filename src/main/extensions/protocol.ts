import { protocol } from 'electron'
import { join, extname, resolve } from 'path'
import type { ExtensionRegistry, LoadedExtension } from './registry'
import { getBridgeScript } from './bridge'
import { getSandboxProxyHtml } from './sandbox-proxy'
import { isValidExtensionId } from './identity'
import {
  MAX_EXTENSION_TEXT_RESOURCE_BYTES,
  openCanonicalResource,
  readOpenedCanonicalResourceText,
  streamOpenedCanonicalResource,
  type CanonicalResourceOpen,
} from './resource-path'
import {
  extensionMediaResourceKey,
  extensionMediaResourcePathExists,
  readAttestedExtensionResource,
} from './media-resource-attestation.ts'
import { getDeclaredSensitiveMediaCapabilities } from '../../shared/extension-sensitive-media.ts'

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
function serveResource(resource: Extract<CanonicalResourceOpen, { ok: true }>): Response {
  try {
    const ext = extname(resource.path).toLowerCase()
    const mime = MIME_TYPES[ext] || 'application/octet-stream'
    return new Response(streamOpenedCanonicalResource(resource), {
      status: 200,
      headers: {
        'content-type': mime,
        'content-length': String(resource.size),
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      },
    })
  } catch (error) {
    void resource.handle.close().catch(() => {})
    throw error
  }
}

function serveBufferedResource(path: string, bytes: Buffer): Response {
  const ext = extname(path).toLowerCase()
  const mime = MIME_TYPES[ext] || 'application/octet-stream'
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': mime,
      'content-length': String(bytes.byteLength),
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  })
}

type ProtocolExtensionResource =
  | {
      readonly ok: true
      readonly path: string
      readonly bytes?: Buffer
      readonly resource?: Extract<CanonicalResourceOpen, { ok: true }>
    }
  | { readonly ok: false; readonly status: 403 | 404 | 409 | 413 }

async function openProtocolExtensionResource(
  registry: ExtensionRegistry,
  extensionId: string,
  extension: LoadedExtension,
  candidatePath: string,
  maxBytes?: number,
): Promise<ProtocolExtensionResource> {
  const requiresAttestation = getDeclaredSensitiveMediaCapabilities(
    extension.manifest.capabilities,
  ).length > 0
  const attestation = extension.mediaAttestation
  if (requiresAttestation && !attestation) return { ok: false, status: 409 }

  const resourceKey = attestation
    ? extensionMediaResourceKey(extension.installRootBinding, candidatePath)
    : undefined
  const expected = resourceKey
    ? attestation?.resources.get(resourceKey)
    : undefined
  const opened = await openCanonicalResource(
    extension.manifest._path ?? '',
    candidatePath,
  )
  if (!opened.ok) {
    const unattestedPathExists = attestation
      && !expected
      && resourceKey
      && await extensionMediaResourcePathExists(
        extension.installRootBinding,
        candidatePath,
      ).catch(() => true)
    if (attestation && (expected || unattestedPathExists)) {
      await registry.invalidateExtensionMediaAttestation(extensionId, attestation)
      return { ok: false, status: 409 }
    }
    return opened
  }
  if (!attestation) {
    return { ok: true, path: opened.path, resource: opened }
  }
  if (!resourceKey || !expected) {
    await opened.handle.close().catch(() => undefined)
    await registry.invalidateExtensionMediaAttestation(extensionId, attestation)
    return { ok: false, status: 409 }
  }
  if (maxBytes !== undefined && expected.size > maxBytes) {
    await opened.handle.close().catch(() => undefined)
    return { ok: false, status: 413 }
  }
  const verified = await readAttestedExtensionResource(
    opened,
    extension.installRootBinding,
    resourceKey,
    expected,
  )
  if (!verified.ok) {
    await registry.invalidateExtensionMediaAttestation(extensionId, attestation)
    return { ok: false, status: 409 }
  }
  if (!registry.isExtensionMediaAttestationCurrent(extensionId, attestation)) {
    return { ok: false, status: 409 }
  }
  return { ok: true, path: opened.path, bytes: verified.bytes }
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
        const resolvedResource = await openCanonicalResource(codiconBase, candidate)
        if (!resolvedResource.ok) {
          return resolvedResource.status === 403
            ? new Response('Forbidden', { status: 403 })
            : new Response('Codicon resource not found', { status: 404 })
        }
        return serveResource(resolvedResource)
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
        const resolvedResource = await openProtocolExtensionResource(
          registry,
          resourceExtId,
          ext,
          absPath,
        )
        if (!resolvedResource.ok) {
          if (resolvedResource.status === 409) {
            return new Response('Extension changed; rescan required', { status: 409 })
          }
          return resolvedResource.status === 403
            ? new Response('Forbidden', { status: 403 })
            : new Response('Resource not found', { status: 404 })
        }
        return resolvedResource.bytes !== undefined
          ? serveBufferedResource(resolvedResource.path, resolvedResource.bytes)
          : serveResource(resolvedResource.resource!)
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
      const htmlResource = /\.html?$/i.test(filePath)
      const resolvedResource = await openProtocolExtensionResource(
        registry,
        extId,
        ext,
        filePath,
        htmlResource ? MAX_EXTENSION_TEXT_RESOURCE_BYTES : undefined,
      )
      if (!resolvedResource.ok) {
        if (resolvedResource.status === 409) {
          return new Response('Extension changed; rescan required', { status: 409 })
        }
        if (resolvedResource.status === 413) {
          return new Response('Extension HTML resource is too large', { status: 413 })
        }
        return resolvedResource.status === 403
          ? new Response('Forbidden', { status: 403 })
          : new Response('Extension resource not found', { status: 404 })
      }
      const canonicalFilePath = resolvedResource.path

      if (/\.html?$/i.test(canonicalFilePath)) {
        let raw: string
        if (resolvedResource.bytes !== undefined) {
          raw = resolvedResource.bytes.toString('utf8')
        } else {
          const textResource = await readOpenedCanonicalResourceText(
            resolvedResource.resource!,
          )
          if (!textResource.ok) {
            return textResource.status === 413
              ? new Response('Extension HTML resource is too large', { status: 413 })
              : new Response('Extension resource not found', { status: 404 })
          }
          raw = textResource.text
        }
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

      return resolvedResource.bytes !== undefined
        ? serveBufferedResource(resolvedResource.path, resolvedResource.bytes)
        : serveResource(resolvedResource.resource!)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return new Response(`Extension load failed: ${message}`, { status: 500 })
    }
  })
}
