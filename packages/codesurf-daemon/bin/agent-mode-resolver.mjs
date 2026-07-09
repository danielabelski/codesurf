import { promises as fs } from 'node:fs'
import { join } from 'node:path'

// ─── Authoritative Persona resolution — daemon mirror ─────────────────────────
// Daemon-side mirror of src/shared/agentModes.ts + src/main/chat/agent-mode-resolver.ts.
// Kept separate because the daemon is a self-contained Node ESM process bundled
// apart from the renderer/main build. The test/daemon suite imports BOTH this
// module and the shared .ts and asserts the built-in data + overlay + resolution
// agree (cross-consistency drift guard). The daemon now uses this for
// defense-in-depth: the LOCAL daemon shares the filesystem with main, so when a
// real agents.json is present it RE-RESOLVES and overrides request.agentMode. The
// remote/cloud daemon has no `.codesurf` (the gitignored dir is excluded from the
// clone) → no file → it trusts the agentMode main already resolved and shipped.
//
// See agent-mode-resolver.ts for the full fail-closed rationale. The built-in
// personas here MUST stay byte-for-byte consistent with DEFAULT_PERSONAS in
// src/shared/agentModes.ts — the daemon's copy is security-load-bearing.
//
// BACK-COMPAT: the on-disk store is, and MUST remain, agents.json (NOT renamed to
// personas.json) — this is an in-code rename only; existing workspaces depend on
// the filename. The request/wire field is likewise still `agentMode`.

// Finalized persona souls below — mirror of DEFAULT_PERSONAS; keep in
// sync with src/shared/agentModes.ts (the drift guard asserts deepEqual).
export const DEFAULT_PERSONAS = [
  { id: 'agent', name: 'Agent', description: 'Full autonomous access to all tools', systemPrompt: '', tools: null, icon: 'robot', color: '#3568ff', isBuiltin: true },
  { id: 'ask', name: 'Ask', description: 'Read-only Q&A mode — no file modifications', systemPrompt: 'You are in read-only mode. Do not modify files or run destructive commands.', tools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'], icon: 'help', color: '#56c288', isBuiltin: true },
  { id: 'plan', name: 'Plan', description: 'Plan without execution — outline steps before acting', systemPrompt: 'Create a detailed plan. Do not execute changes until the user approves.', tools: ['Read', 'Glob', 'Grep', 'WebSearch'], icon: 'map', color: '#f5a623', isBuiltin: true },
  { id: 'polly', name: 'Polly', description: 'Orchestrator — coordinates work and delegates to other personas', systemPrompt: "You are Polly, CodeSurf's orchestrator. You are a tech lead, not a solo coder: break the request into clear subtasks, decide which persona, engine, or tool should handle each, sequence the work, and keep the user informed at every step. Prefer delegating and verifying over doing everything yourself — and never let a single unchecked pass stand in for real verification; when something is built, get it independently confirmed. Work from evidence, not memory: ground claims in files, line numbers, and command output. Be terse and direct — surface assumptions and blockers early, and push back when something looks wrong. When you say you'll do something, do it now rather than narrating intent. You prepare and stage work for the human to review and decide; you don't ship or merge on their behalf.", tools: null, icon: 'star', color: '#b368c9', isBuiltin: true },
  { id: 'gemma', name: 'Gemma', description: 'General-purpose assistant for everyday tasks', systemPrompt: "You are Gemma, CodeSurf's general-purpose assistant — and the embodiment of its 'omni' principle: the user gets the same clear, consistent, well-structured Gemma no matter which underlying model or engine is running beneath you. Lead with the answer, then the detail. Use whatever tools and skills are available to carry a task through end to end rather than stopping at advice. When a request is genuinely ambiguous, ask one sharp clarifying question; otherwise make a reasonable assumption, state it, and proceed. Be warm, plain-spoken, and concise, scaling depth to the task. You leverage the full capability of whatever engine runs you, while always presenting it in one consistent voice.", tools: null, icon: 'bolt', color: '#00acd7', isBuiltin: true },
]

/** @deprecated Renamed to DEFAULT_PERSONAS; retained as an alias. */
export const DEFAULT_AGENT_MODES = DEFAULT_PERSONAS

// Resolve a persona's `extends` inheritance — MIRROR of resolvePersonaExtends in
// src/shared/agentModes.ts (keep logically byte-identical). FAIL-CLOSED TOOL RULE:
//   - child DEFINES tools (incl. [] or null) → child wins.
//   - child OMITS tools AND base chain resolves cleanly → inherit base.
//   - child OMITS tools AND inheritance UNRESOLVABLE (missing/self/cyclic) → DENY-ALL ([]).
// Leaving tools undefined for a broken extends would fail OPEN (undefined = unrestricted
// in agent-mode-tools.mjs). A persona with NO extends is untouched by this rule.
function resolvePersonaExtends(persona, byId) {
  const chain = []
  const seen = new Set()
  let cur = persona
  let broken = false
  for (;;) {
    chain.push(cur)
    seen.add(cur.id)
    const baseId = typeof cur.extends === 'string' ? cur.extends.trim() : ''
    if (!baseId) break
    const base = byId.get(baseId)
    if (!base || base.id === cur.id || seen.has(base.id)) { broken = true; break }
    cur = base
  }
  let merged = {}
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i]
    merged = { ...merged, ...node }
    if (Object.prototype.hasOwnProperty.call(node, 'tools')) merged.tools = node.tools
  }
  merged.id = persona.id
  if (broken && !Object.prototype.hasOwnProperty.call(persona, 'tools')) merged.tools = []
  return merged
}

function resolveAllExtends(list) {
  const byId = new Map(list.map(p => [p.id, p]))
  return list.map(p => resolvePersonaExtends(p, byId))
}

// Pure overlay + inheritance: built-ins first, overlay persisted entries by id,
// drop ephemeral `discovered-*` scan results, then resolve `extends`. Non-array →
// built-ins unchanged.
export function overlayPersonas(loaded) {
  const merged = [...DEFAULT_PERSONAS]
  if (!Array.isArray(loaded)) return resolveAllExtends(merged)
  for (const item of loaded) {
    if (!item || typeof item.id !== 'string' || item.id.startsWith('discovered-')) continue
    const idx = merged.findIndex(m => m.id === item.id)
    if (idx >= 0) merged[idx] = { ...merged[idx], ...item }
    else merged.push(item)
  }
  return resolveAllExtends(merged)
}

/** @deprecated Renamed to overlayPersonas; retained as an alias. */
export const overlayAgentModes = overlayPersonas

export function findPersonaById(personas, personaId) {
  return personas.find(p => p.id === personaId) ?? null
}

/** @deprecated Renamed to findPersonaById; retained as an alias. */
export const findAgentModeById = findPersonaById

export const AGENT_MODE_RESOLUTION_DENIED_ERROR =
  'The selected agent could not be verified against the workspace agent definitions ' +
  '(its agents.json is unreadable/corrupt, or the agent is not defined there). ' +
  'Refusing to launch rather than fall back to looser default permissions — ' +
  'fix the agent definition or clear the selected agent.'

// BACK-COMPAT: on-disk path retained as `.codesurf/customisation/agents.json`.
function agentsJsonPath(workspaceRoot) {
  return join(workspaceRoot, '.codesurf', 'customisation', 'agents.json')
}

// Mirror of resolveAuthoritativeAgentMode in agent-mode-resolver.ts. Same
// fail-closed contract: ENOENT → built-ins authoritative; present-but-unreadable/
// corrupt/non-array → fail closed; id-not-found → fail closed. The result field is
// still `agentMode` (wire/contract name retained across the Persona rename).
export async function resolveAuthoritativeAgentMode(opts) {
  const agentId = typeof opts?.agentId === 'string' ? opts.agentId.trim() : ''
  if (!agentId) return { ok: true, agentMode: null }

  let root = null
  try {
    root = await opts.resolveWorkspaceRoot()
  } catch {
    root = null
  }
  if (!root) return { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR }

  let raw
  try {
    raw = await fs.readFile(agentsJsonPath(root), 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      const resolved = findPersonaById(DEFAULT_PERSONAS, agentId)
      return resolved
        ? { ok: true, agentMode: resolved }
        : { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR }
    }
    return { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR }
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR }
  }
  if (!Array.isArray(parsed)) return { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR }

  const resolved = findPersonaById(overlayPersonas(parsed), agentId)
  if (!resolved) return { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR }
  return { ok: true, agentMode: resolved }
}

// READ-ONLY persona listing for the `/personas/list` route + the `codesurf chat
// --list-personas` CLI. Reuses overlayPersonas (built-ins + agents.json overlay,
// `discovered-*` scan results dropped) so the listed set CANNOT drift from what
// resolveAuthoritativeAgentMode applies.
//
// DELIBERATE list-vs-resolution divergence: this listing falls back to BUILT-INS
// when agents.json is missing/unreadable/corrupt, whereas resolveAuthoritativeAgentMode
// FAILS CLOSED for a present-but-corrupt file (a corrupt file could mask a stricter
// override). The list is advisory UX; resolution at start is the authoritative,
// fail-closed gate. So a user may see a built-in here, select it, and still have
// the launch refused if the on-disk file is corrupt — that is intended.
export async function listPersonas(opts) {
  let root = null
  try {
    root = await opts.resolveWorkspaceRoot()
  } catch {
    root = null
  }
  if (!root) return overlayPersonas(null)

  let raw
  try {
    raw = await fs.readFile(agentsJsonPath(root), 'utf8')
  } catch {
    return overlayPersonas(null)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return overlayPersonas(null)
  }
  // overlayPersonas treats a non-array as "built-ins unchanged".
  return overlayPersonas(parsed)
}
