import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Persona } from '../../shared/types'
import { DEFAULT_PERSONAS, overlayPersonas, findPersonaById } from '../../shared/agentModes.ts'

// ─── Authoritative server-side Persona resolution (ROOT FIX) ──────────────────
// The renderer resolves a selected `agentId` → an `agentMode` (carrying the
// persona + tools allow-list + permission posture) and ships BOTH on chat:send.
// Every prior guard only REJECTED a NULL agentMode — it never verified that a
// NON-null mode is the CORRECT mode for that agentId. So any renderer race or a
// compromised/buggy renderer could send a non-null but LOOSER mode (e.g. the
// unrestricted built-in `agent`) that passes all guards while a STRICTER override
// sits in agents.json. This module re-resolves the agentId AUTHORITATIVELY in the
// trusted Electron main process, from the TRUSTED workspace root's agents.json,
// and the caller OVERRIDES whatever the renderer sent. Whatever main writes is
// what the daemon later enforces, so this covers runtime, local-daemon, and
// remote/cloud-daemon backends from one chokepoint.
//
// FAIL-CLOSED contract (a failure must NEVER widen permissions):
//   - No agentId selected               → ok, agentMode null (unrestricted by
//                                          design; matches "no agent" UI state).
//   - agents.json genuinely ABSENT      → built-ins are authoritative (there is
//     (ENOENT)                            no override on disk to bypass; the
//                                          built-ins are a compile-time constant,
//                                          not spoofable). Resolve the id from
//                                          the built-ins; a custom id is absent →
//                                          fail closed.
//   - agents.json PRESENT but unreadable→ FAIL CLOSED. A present-but-unreadable
//     / corrupt / non-array               or corrupt file could be HIDING a
//                                          stricter override of a built-in, so the
//                                          built-ins can no longer be trusted.
//   - id not found in the resolved set  → FAIL CLOSED (dangling/spoofed agentId).
//
// Why ABSENT ≠ a fail: `ensureCodeSurfStructure` does NOT seed agents.json, so a
// fresh workspace has no file and the built-in Agent/Ask/Plan modes are the
// genuine, authoritative defaults. Failing closed on absence would break the
// default offering for every un-customised workspace. The security hole is the
// PARSE-ERROR / UNREADABLE case (where a looser default would mask a stricter
// override) — that is what fails closed.

// NOTE: the result field is still named `agentMode` — it is the cross-process
// wire/contract name read by chat-jobs.mjs (`authoritative.agentMode`) and the
// providers. It is retained unchanged across the Persona rename for the same
// reason the on-disk `agents.json` and IPC channels are: renaming it would break
// the renderer↔main↔daemon contract. Its TYPE is now `Persona`.
export type AgentModeResolution =
  | { ok: true; agentMode: Persona | null }
  | { ok: false; error: string }

export const AGENT_MODE_RESOLUTION_DENIED_ERROR =
  'The selected agent could not be verified against the workspace agent definitions ' +
  '(its agents.json is unreadable/corrupt, or the agent is not defined there). ' +
  'Refusing to launch rather than fall back to looser default permissions — ' +
  'fix the agent definition or clear the selected agent.'

// BACK-COMPAT: the persisted store is, and MUST remain, agents.json (NOT renamed
// to personas.json) — this Persona rename is in-code + UI only. Existing user
// workspaces depend on this filename; renaming it would orphan their definitions.
function agentsJsonPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.codesurf', 'customisation', 'agents.json')
}

/**
 * Resolve the authoritative AgentMode for a turn. `resolveWorkspaceRoot` returns
 * the TRUSTED workspace root (from the main-side workspaceId→root registry); it
 * is intentionally the ONLY source of the path — `req.workspaceDir` (renderer
 * supplied) is never consulted, closing the workspaceDir spoof vector.
 */
export async function resolveAuthoritativeAgentMode(opts: {
  agentId: string | null | undefined
  resolveWorkspaceRoot: () => Promise<string | null> | string | null
}): Promise<AgentModeResolution> {
  const agentId = typeof opts.agentId === 'string' ? opts.agentId.trim() : ''
  // No agent selected → unrestricted-by-design (provider default toolset). No
  // disk read, no workspace lookup.
  if (!agentId) return { ok: true, agentMode: null }

  let root: string | null = null
  try {
    root = await opts.resolveWorkspaceRoot()
  } catch {
    root = null
  }
  // A selected agent with no trusted root cannot be confirmed → fail closed.
  if (!root) return { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR }

  let raw: string
  try {
    raw = await fs.readFile(agentsJsonPath(root), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // Genuinely absent → built-ins are authoritative (no override to bypass).
      const resolved = findPersonaById(DEFAULT_PERSONAS, agentId)
      return resolved
        ? { ok: true, agentMode: resolved }
        : { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR }
    }
    // Present but unreadable (EACCES/EISDIR/…) → could hide a stricter override.
    return { ok: false, error: AGENT_MODE_RESOLUTION_DENIED_ERROR }
  }

  // File present and read: it MUST parse to a valid array; otherwise it could be
  // masking a stricter override → fail closed (never fall back to built-ins).
  let parsed: unknown
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
