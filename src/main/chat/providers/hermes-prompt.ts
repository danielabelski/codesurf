// Pure Hermes turn-prompt builder, extracted from chatHermes so it can be
// unit-tested directly (chatHermes itself spawns a subprocess).
//
// This module is intentionally DEPENDENCY-FREE (no relative imports) so the
// `node --test` daemon suite can load it under type-stripping — the same
// constraint src/main/chat/agent-mode-tools.ts follows. The caller supplies the
// already-built output convention string rather than this module importing it.
//
// Hermes has NO system-prompt flag, so both the CodeSurf output convention and
// the AgentMode persona (systemPrompt) must ride along inside the user message.
//
// A-PR1 #1a — persona on resume: previously the persona was only injected on the
// FIRST turn (the comment assumed Hermes session history carried it forward).
// That dropped the agent definition on every resumed turn, so a persona-bound
// agent silently reverted to default behavior mid-conversation. We now RE-INJECT
// the persona on resumed turns too, keeping the agent definition enforced for the
// whole session. The (larger) output convention stays first-turn-only — history
// reliably carries the formatting expectation, and re-sending it every turn is
// pure token cost.
export interface HermesTurnPromptOpts {
  userContent: string
  agentPersona?: string
  peerPrompt?: string
  isFirstTurn: boolean
  /** CodeSurf output convention, injected on the first turn only. Caller-supplied
   *  (from prompt-conventions) so this module stays dependency-free. */
  outputConvention?: string
}

export function buildHermesTurnPrompt(opts: HermesTurnPromptOpts): string {
  const { userContent, agentPersona, peerPrompt, isFirstTurn, outputConvention } = opts
  const persona = agentPersona?.trim() || undefined
  const peers = peerPrompt?.trim() || undefined

  if (isFirstTurn) {
    // Mirror joinPromptSections: trim, drop empties, join with a blank line.
    const sections = [persona, outputConvention?.trim() || undefined, peers].filter(Boolean) as string[]
    const preamble = sections.length > 0 ? sections.join('\n\n') : undefined
    return preamble ? `${preamble}\n\n---\n\n${userContent}` : userContent
  }

  // Resumed turn: re-assert the persona so the agent definition stays in force.
  const sections = [persona, peers].filter(Boolean) as string[]
  const preamble = sections.length > 0 ? sections.join('\n\n') : undefined
  return preamble ? `${preamble}\n\n---\n\n${userContent}` : userContent
}
