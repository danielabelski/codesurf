/**
 * CodeSurf web / Native host API (Agensis-style fixed port).
 *
 * Electron keeps full IPC. Browser + Native WebView talk here:
 *  - Proxies `/d/*` → live codesurfd with auth injected from pid.json
 *  - Serves canvas/settings/workspace helpers under `/host/*`
 *  - CORS for Vite (5173) and same-origin production
 *
 * Port: CODESURF_WEB_HOST_PORT (default 4177)
 */
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  statSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve, basename, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, platform as osPlatform } from 'node:os'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const HOME = process.env.CODESURF_HOME?.trim() || join(homedir(), '.codesurf')
const PID_PATH = process.env.CODESURF_DAEMON_PID_PATH || join(HOME, 'daemon', 'pid.json')
const HOST_PORT = Number(process.env.CODESURF_WEB_HOST_PORT || 4177)
const HOST_BIND = process.env.CODESURF_WEB_HOST_BIND || '127.0.0.1'
const CORS_ORIGINS = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
  'http://127.0.0.1:4177',
  'http://localhost:4177',
  'null', // file / some WebView cases
])

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

function atomicWriteJson(path, value) {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

function safeId(id) {
  const s = String(id ?? '').trim()
  if (!s || /[\/\\]|\.\./.test(s)) throw new Error(`Unsafe id: ${id}`)
  return s
}

function canvasStatePath(workspaceId) {
  return join(HOME, 'workspaces', safeId(workspaceId), '.codesurf', 'canvas-state.json')
}

function tileStatePath(workspaceId, tileId) {
  return join(HOME, 'workspaces', safeId(workspaceId), '.codesurf', `tile-state-${safeId(tileId)}.json`)
}

function settingsPath() {
  return join(HOME, 'settings.json')
}

function readDaemonInfo() {
  const parsed = readJson(PID_PATH, null)
  if (
    !parsed
    || typeof parsed.port !== 'number'
    || typeof parsed.token !== 'string'
  ) {
    return null
  }
  return {
    pid: parsed.pid,
    port: parsed.port,
    token: parsed.token,
    startedAt: parsed.startedAt ?? null,
    protocolVersion: parsed.protocolVersion ?? parsed.version ?? null,
    appVersion: parsed.appVersion ?? null,
  }
}

async function daemonHealth(info) {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

async function ensureDaemon() {
  let info = readDaemonInfo()
  if (info && await daemonHealth(info)) return info

  const daemonScript = resolve(ROOT, 'packages/codesurf-daemon/bin/codesurfd.mjs')
  if (!existsSync(daemonScript)) {
    throw new Error(`codesurfd not found at ${daemonScript}`)
  }

  ensureDir(join(HOME, 'daemon'))
  const child = spawn(process.execPath, [daemonScript], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      CODESURF_HOME: HOME,
      CODESURF_APP_VERSION: process.env.CODESURF_APP_VERSION || '0.1.0-web',
    },
  })
  child.unref()

  const start = Date.now()
  while (Date.now() - start < 20_000) {
    info = readDaemonInfo()
    if (info && await daemonHealth(info)) return info
    await new Promise(r => setTimeout(r, 150))
  }
  throw new Error('Timed out waiting for codesurfd')
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  if (!origin || CORS_ORIGINS.has(origin) || origin.startsWith('http://127.0.0.1:') || origin.startsWith('http://localhost:')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*')
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Codesurf-Host')
  res.setHeader('Access-Control-Max-Age', '86400')
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return null
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function proxyDaemon(req, res, daemonPath) {
  const info = await ensureDaemon()
  const target = new URL(daemonPath + (req.url?.includes('?') ? '' : ''), `http://127.0.0.1:${info.port}`)
  // Preserve query from original URL if present
  const incoming = new URL(req.url || '/', `http://${HOST_BIND}:${HOST_PORT}`)
  for (const [k, v] of incoming.searchParams) target.searchParams.set(k, v)

  const method = req.method || 'GET'
  const headers = {
    Authorization: `Bearer ${info.token}`,
    Accept: req.headers.accept || '*/*',
  }
  let body
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    body = Buffer.concat(chunks)
    if (body.length > 0) {
      headers['Content-Type'] = req.headers['content-type'] || 'application/json'
      headers['Content-Length'] = String(body.length)
    }
  }

  const upstream = await fetch(target, {
    method,
    headers,
    body: body && body.length > 0 ? body : undefined,
    signal: AbortSignal.timeout(120_000),
  })

  const buf = Buffer.from(await upstream.arrayBuffer())
  const outHeaders = {
    'Content-Type': upstream.headers.get('content-type') || 'application/json',
    'Content-Length': String(buf.length),
  }
  if (upstream.headers.get('content-type')?.includes('text/event-stream')) {
    outHeaders['Cache-Control'] = 'no-cache'
    outHeaders['Connection'] = 'keep-alive'
  }
  res.writeHead(upstream.status, outHeaders)
  res.end(buf)
}

function listDirSafe(dirPath) {
  const entries = readdirSync(dirPath, { withFileTypes: true })
  return entries.map(entry => ({
    name: entry.name,
    path: join(dirPath, entry.name),
    isDir: entry.isDirectory(),
    ext: entry.isDirectory() ? '' : extname(entry.name).replace(/^\./, ''),
  }))
}

async function handleHost(req, res, url) {
  const method = req.method || 'GET'
  const path = url.pathname

  if (method === 'GET' && path === '/host/health') {
    const daemon = readDaemonInfo()
    const daemonOk = daemon ? await daemonHealth(daemon) : false
    return sendJson(res, 200, {
      ok: true,
      host: 'codesurf-web-host',
      port: HOST_PORT,
      home: HOME,
      platform: 'web-host',
      daemon: daemonOk
        ? { running: true, port: daemon.port, pid: daemon.pid, protocolVersion: daemon.protocolVersion }
        : { running: false },
    })
  }

  if (method === 'GET' && path === '/host/config') {
    const daemon = await ensureDaemon()
    return sendJson(res, 200, {
      hostBase: `http://${HOST_BIND}:${HOST_PORT}`,
      daemonPort: daemon.port,
      // Token is NOT sent to the browser; browser always uses /d/* proxy.
      protocolVersion: daemon.protocolVersion,
      home: HOME,
      capabilities: {
        workspace: true,
        canvas: true,
        settings: true,
        chatJobs: true,
        sessions: true,
        fs: true,
        terminal: false,
        extensions: false,
        nodePty: false,
      },
    })
  }

  if (method === 'GET' && path === '/host/settings') {
    return sendJson(res, 200, readJson(settingsPath(), {}))
  }

  if (method === 'POST' && path === '/host/settings') {
    const body = await readBody(req)
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'expected object' })
    atomicWriteJson(settingsPath(), body)
    return sendJson(res, 200, body)
  }

  if (method === 'GET' && path === '/host/canvas/load') {
    const workspaceId = url.searchParams.get('workspaceId')
    if (!workspaceId) return sendJson(res, 400, { error: 'workspaceId required' })
    const file = canvasStatePath(workspaceId)
    if (!existsSync(file)) return sendJson(res, 200, null)
    return sendJson(res, 200, readJson(file, null))
  }

  if (method === 'POST' && path === '/host/canvas/save') {
    const body = await readBody(req)
    const workspaceId = body?.workspaceId
    if (!workspaceId) return sendJson(res, 400, { error: 'workspaceId required' })
    atomicWriteJson(canvasStatePath(workspaceId), body.state ?? null)
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'GET' && path === '/host/canvas/tile') {
    const workspaceId = url.searchParams.get('workspaceId')
    const tileId = url.searchParams.get('tileId')
    if (!workspaceId || !tileId) return sendJson(res, 400, { error: 'workspaceId and tileId required' })
    const file = tileStatePath(workspaceId, tileId)
    if (!existsSync(file)) return sendJson(res, 200, null)
    return sendJson(res, 200, readJson(file, null))
  }

  if (method === 'POST' && path === '/host/canvas/tile') {
    const body = await readBody(req)
    if (!body?.workspaceId || !body?.tileId) return sendJson(res, 400, { error: 'workspaceId and tileId required' })
    atomicWriteJson(tileStatePath(body.workspaceId, body.tileId), body.state ?? null)
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'GET' && path === '/host/fs/readDir') {
    const dir = url.searchParams.get('path')
    if (!dir) return sendJson(res, 400, { error: 'path required' })
    try {
      return sendJson(res, 200, listDirSafe(resolve(dir)))
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'GET' && path === '/host/fs/readFile') {
    const filePath = url.searchParams.get('path')
    if (!filePath) return sendJson(res, 400, { error: 'path required' })
    try {
      const abs = resolve(filePath)
      if (!existsSync(abs)) {
        // Missing optional config files are normal (skills.json, etc.)
        return sendJson(res, 200, { content: null, missing: true })
      }
      const raw = readFileSync(abs, 'utf8')
      return sendJson(res, 200, { content: raw, missing: false })
    } catch (err) {
      const code = err?.code || ''
      if (code === 'ENOENT') return sendJson(res, 200, { content: null, missing: true })
      return sendJson(res, 400, { error: String(err?.message || err), code })
    }
  }

  if (method === 'POST' && path === '/host/fs/writeFile') {
    const body = await readBody(req)
    if (!body?.path || typeof body.content !== 'string') {
      return sendJson(res, 400, { error: 'path and content required' })
    }
    const filePath = resolve(body.path)
    ensureDir(dirname(filePath))
    writeFileSync(filePath, body.content, 'utf8')
    return sendJson(res, 200, { ok: true })
  }

  if (method === 'POST' && path === '/host/fs/mkdir') {
    const body = await readBody(req)
    if (!body?.path) return sendJson(res, 400, { error: 'path required' })
    try {
      ensureDir(resolve(body.path))
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/fs/remove') {
    const body = await readBody(req)
    if (!body?.path) return sendJson(res, 400, { error: 'path required' })
    try {
      rmSync(resolve(body.path), { recursive: true, force: true })
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'GET' && path === '/host/fs/stat') {
    const filePath = url.searchParams.get('path')
    if (!filePath) return sendJson(res, 400, { error: 'path required' })
    try {
      const st = statSync(resolve(filePath))
      return sendJson(res, 200, {
        size: st.size,
        mtimeMs: st.mtimeMs,
        isFile: st.isFile(),
        isDir: st.isDirectory(),
      })
    } catch {
      return sendJson(res, 200, null)
    }
  }

  if (method === 'GET' && path === '/host/fs/basename') {
    const filePath = url.searchParams.get('path') || ''
    return sendJson(res, 200, { name: basename(filePath) })
  }

  // ── Collab protocol (matches Electron tile dirs under .codesurf/{tileId}) ──
  function collabTileDir(workspacePath, tileId) {
    const safeTile = String(tileId || '').trim()
    if (!safeTile || /[\/\\]|\.\./.test(safeTile)) throw new Error(`Unsafe tileId: ${tileId}`)
    const root = resolve(String(workspacePath || ''))
    if (!root) throw new Error('workspacePath required')
    return join(root, '.codesurf', safeTile)
  }

  function collabFilePath(workspacePath, tileId, relativeFile) {
    const tileDir = collabTileDir(workspacePath, tileId)
    const rel = String(relativeFile || '').replace(/^\/+/, '')
    if (!rel || rel.includes('..')) throw new Error(`Unsafe file path: ${relativeFile}`)
    const abs = normalize(join(tileDir, rel))
    if (!abs.startsWith(tileDir)) throw new Error('Path escape blocked')
    return abs
  }

  if (method === 'POST' && path === '/host/collab/ensureDir') {
    const body = await readBody(req)
    try {
      const tileDir = collabTileDir(body?.workspacePath, body?.tileId)
      ensureDir(tileDir)
      ensureDir(join(tileDir, 'context'))
      for (const mailbox of ['inbox', 'sent', 'memory', 'bin']) {
        ensureDir(join(tileDir, 'messages', mailbox))
      }
      return sendJson(res, 200, { ok: true, path: tileDir })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/collab/write') {
    const body = await readBody(req)
    try {
      const filePath = collabFilePath(body?.workspacePath, body?.tileId, body?.file)
      ensureDir(dirname(filePath))
      writeFileSync(filePath, String(body?.content ?? ''), 'utf8')
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/collab/read') {
    const body = await readBody(req)
    try {
      const filePath = collabFilePath(body?.workspacePath, body?.tileId, body?.file)
      if (!existsSync(filePath)) return sendJson(res, 200, { content: null })
      return sendJson(res, 200, { content: readFileSync(filePath, 'utf8') })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/collab/list') {
    const body = await readBody(req)
    try {
      const dirPath = collabFilePath(body?.workspacePath, body?.tileId, body?.dir || '.')
      if (!existsSync(dirPath)) return sendJson(res, 200, { entries: [] })
      const entries = readdirSync(dirPath, { withFileTypes: true }).map(entry => ({
        name: entry.name,
        path: join(dirPath, entry.name),
        isDir: entry.isDirectory(),
      }))
      return sendJson(res, 200, { entries })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/collab/remove') {
    const body = await readBody(req)
    try {
      const filePath = collabFilePath(body?.workspacePath, body?.tileId, body?.file)
      rmSync(filePath, { force: true })
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  if (method === 'POST' && path === '/host/collab/removeDir') {
    const body = await readBody(req)
    try {
      const tileDir = collabTileDir(body?.workspacePath, body?.tileId)
      rmSync(tileDir, { recursive: true, force: true })
      return sendJson(res, 200, { ok: true })
    } catch (err) {
      return sendJson(res, 400, { error: String(err?.message || err) })
    }
  }

  // ── Native OS dialogs (local web-host only; never window.prompt) ─────────
  // Browser clients call these so the host machine shows a real folder picker
  // and returns an absolute path the daemon can use.
  if (method === 'POST' && path === '/host/dialog/openFolder') {
    try {
      const body = await readBody(req)
      const prompt = String(body?.prompt || 'Choose project folder').slice(0, 120)
      const picked = await openNativeFolderDialog(prompt)
      return sendJson(res, 200, { path: picked, cancelled: !picked })
    } catch (err) {
      return sendJson(res, 500, { error: String(err?.message || err), path: null })
    }
  }

  if (method === 'POST' && path === '/host/dialog/openFile') {
    try {
      const body = await readBody(req)
      const prompt = String(body?.prompt || 'Choose file').slice(0, 120)
      const picked = await openNativeFileDialog(prompt)
      return sendJson(res, 200, { path: picked, cancelled: !picked })
    } catch (err) {
      return sendJson(res, 500, { error: String(err?.message || err), path: null })
    }
  }

  return sendJson(res, 404, { error: `unknown host route ${path}` })
}

/**
 * Show a real OS folder picker on the machine running web-host.
 * Returns absolute path or null if cancelled.
 */
function openNativeFolderDialog(promptText) {
  return new Promise((resolvePromise, reject) => {
    const plat = osPlatform()
    let child
    let settled = false
    const done = (err, value) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolvePromise(value)
    }

    if (plat === 'darwin') {
      // AppleScript choose folder → POSIX path (trailing slash stripped)
      const script = [
        `try`,
        `  set theFolder to choose folder with prompt ${JSON.stringify(promptText)}`,
        `  return POSIX path of theFolder`,
        `on error`,
        `  return ""`,
        `end try`,
      ].join('\n')
      child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    } else if (plat === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
        `$d.Description = ${JSON.stringify(promptText)}`,
        '$d.ShowNewFolderButton = $true',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  [Console]::Out.Write($d.SelectedPath)',
        '}',
      ].join('; ')
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } else {
      // Linux: prefer zenity, then kdialog
      const zenity = spawnSync('which', ['zenity'], { encoding: 'utf8' })
      const kdialog = spawnSync('which', ['kdialog'], { encoding: 'utf8' })
      if (zenity.status === 0) {
        child = spawn('zenity', ['--file-selection', '--directory', `--title=${promptText}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } else if (kdialog.status === 0) {
        child = spawn('kdialog', ['--getexistingdirectory', homedir(), promptText], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } else {
        done(new Error('No folder dialog backend (install zenity or kdialog)'))
        return
      }
    }

    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (err) => done(err))
    child.on('close', (code) => {
      const raw = stdout.trim().replace(/\r/g, '')
      // Cancel → empty or non-zero without path
      if (!raw) {
        done(null, null)
        return
      }
      // macOS choose folder returns trailing slash
      const pathOut = raw.replace(/\/+$/, '') || raw
      if (existsSync(pathOut)) {
        done(null, pathOut)
        return
      }
      // Still return the path string if OS gave one (race/permissions)
      if (code === 0 && pathOut.length > 0) {
        done(null, pathOut)
        return
      }
      if (stderr && code !== 0 && code !== 1) {
        done(new Error(stderr.trim() || `folder dialog exited ${code}`))
        return
      }
      done(null, null)
    })
  })
}

function openNativeFileDialog(promptText) {
  return new Promise((resolvePromise, reject) => {
    const plat = osPlatform()
    let child
    let settled = false
    const done = (err, value) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolvePromise(value)
    }

    if (plat === 'darwin') {
      const script = [
        `try`,
        `  set theFile to choose file with prompt ${JSON.stringify(promptText)}`,
        `  return POSIX path of theFile`,
        `on error`,
        `  return ""`,
        `end try`,
      ].join('\n')
      child = spawn('osascript', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    } else if (plat === 'win32') {
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        `$d.Title = ${JSON.stringify(promptText)}`,
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
        '  [Console]::Out.Write($d.FileName)',
        '}',
      ].join('; ')
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } else {
      const zenity = spawnSync('which', ['zenity'], { encoding: 'utf8' })
      if (zenity.status === 0) {
        child = spawn('zenity', ['--file-selection', `--title=${promptText}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } else {
        done(new Error('No file dialog backend (install zenity)'))
        return
      }
    }

    let stdout = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.on('error', (err) => done(err))
    child.on('close', () => {
      const raw = stdout.trim().replace(/\r/g, '')
      done(null, raw || null)
    })
  })
}

async function main() {
  await ensureDaemon()

  const server = createServer(async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    try {
      const url = new URL(req.url || '/', `http://${HOST_BIND}:${HOST_PORT}`)

      if (url.pathname === '/' || url.pathname === '/health') {
        return sendJson(res, 200, { ok: true, service: 'codesurf-web-host', port: HOST_PORT })
      }

      if (url.pathname.startsWith('/host/')) {
        return await handleHost(req, res, url)
      }

      if (url.pathname.startsWith('/d/')) {
        const daemonPath = url.pathname.slice(2) // keep leading /
        // /d/workspace/list → /workspace/list
        const pathOnly = daemonPath.startsWith('/') ? daemonPath : `/${daemonPath}`
        // Reattach query: proxyDaemon reads req.url
        req.url = pathOnly + url.search
        return await proxyDaemon(req, res, pathOnly)
      }

      sendJson(res, 404, { error: 'not found', hint: 'use /host/* or /d/*' })
    } catch (err) {
      console.error('[web-host]', err)
      sendJson(res, 500, { error: String(err?.message || err) })
    }
  })

  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(HOST_PORT, HOST_BIND, () => resolveListen())
  })

  console.log(`[web-host] listening on http://${HOST_BIND}:${HOST_PORT}`)
  console.log(`[web-host] daemon proxy: /d/*  host APIs: /host/*  home=${HOME}`)
}

main().catch((err) => {
  console.error('[web-host] failed to start', err)
  process.exit(1)
})
