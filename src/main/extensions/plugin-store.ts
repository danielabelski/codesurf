/**
 * Plugin Store — durable, reactive, per-plugin state.
 *
 * Each plugin gets a JSON document at ~/.codesurf/plugin-state/<id>.json with an
 * in-memory cache. Writes persist immediately and broadcast on the event bus channel
 * `plugin:<id>:state`, so every renderer (host UI, the plugin's own iframe, peer
 * plugins that subscribe) sees changes live. This is the durable store extensions
 * lacked — it fixes the class of bug where iframe state (e.g. Builder history) was
 * lost on reload, and is the substrate for stateful plugins.
 *
 * Decision (docs/plugins/00-architecture.md §5): extend the existing file-based
 * persistence + event bus rather than adopt a heavy replicated DB.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { CODESURF_HOME } from '../paths'
import { bus } from '../event-bus'
import { assertSafePathSegment } from '../security/pathSegments'

const STORE_DIR = join(CODESURF_HOME, 'plugin-state')
const cache = new Map<string, Record<string, unknown>>()

function fileFor(extId: string): string {
  // extId comes from renderer IPC — validate before it becomes a filename so
  // '../mcp-server' can't read/overwrite files outside the store dir.
  return join(STORE_DIR, `${assertSafePathSegment(extId, 'extId')}.json`)
}

export function stateChannel(extId: string): string {
  return `plugin:${extId}:state`
}

/** Read a plugin's full state (cached; falls back to {} on first read / missing file). */
export function getPluginState(extId: string): Record<string, unknown> {
  const cached = cache.get(extId)
  if (cached) return cached
  let value: Record<string, unknown> = {}
  try {
    value = JSON.parse(readFileSync(fileFor(extId), 'utf8')) as Record<string, unknown>
  } catch {
    value = {}
  }
  cache.set(extId, value)
  return value
}

function persist(extId: string, value: Record<string, unknown>): void {
  cache.set(extId, value)
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(fileFor(extId), JSON.stringify(value, null, 2))
  } catch (err) {
    console.warn(`[plugin-store] write failed for ${extId}:`, err)
  }
  bus.publish({
    channel: stateChannel(extId),
    type: 'data',
    source: 'plugin-store',
    payload: { extId, state: value },
  })
}

/** Shallow-merge a patch into the plugin's state. Returns the new state. */
export function setPluginState(extId: string, patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...getPluginState(extId), ...patch }
  persist(extId, next)
  return next
}

/** Replace the plugin's entire state. Returns the new state. */
export function replacePluginState(extId: string, value: Record<string, unknown>): Record<string, unknown> {
  persist(extId, value)
  return value
}
