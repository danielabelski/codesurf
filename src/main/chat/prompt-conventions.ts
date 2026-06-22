/**
 * CodeSurf prompt conventions, injected into every chat provider (Claude,
 * Codex, OpenCode, OpenClaw, Hermes).
 *
 * Extracted out of `src/main/ipc/chat.ts` (which pulls in Electron main APIs
 * and cannot be unit-tested) so these pure strings/helpers can be imported and
 * asserted on directly. See `test/chat-convention-prompts.test.ts`.
 */

export function joinPromptSections(...sections: Array<string | undefined | null>): string | undefined {
  const normalized = sections
    .map(section => String(section ?? '').trim())
    .filter(Boolean)
  return normalized.length > 0 ? normalized.join('\n\n') : undefined
}

// CodeSurf-wide completion-reporting convention. Injected into EVERY provider
// (Claude, Codex, OpenCode, OpenClaw, Hermes) so substantial agent runs produce
// a consistent handoff without turning tiny edits into noisy reports.
//
// Keep this short. It costs tokens on every turn (Claude/Codex) and on every
// first user message (OpenCode/OpenClaw/Hermes). If you want to tune the tone
// or required sections, edit the string below — the plumbing stays the same.
export const CODESURF_OUTPUT_CONVENTION = [
  '## CodeSurf Task-Completion Convention',
  '',
  'Default to a short natural-language completion. For simple edits, one sentence plus any verification result is enough.',
  '',
  'Only use the structured completion card for substantial work: multi-file changes, long-running tasks, risky edits, migrations, debugging sessions, or work where the user needs a durable handoff. When you do use it, use this exact format (literal uppercase section headers inside a fenced code block):',
  '',
  '```',
  'CHANGES MADE:',
  '  <path>: <one-line what + why>',
  '  <path>: <one-line what + why>',
  '',
  'DIDN\'T TOUCH:',
  '  <path or area>: <one-line why you left it alone>',
  '',
  'CONCERNS:',
  '  - <risk, assumption, or follow-up the user should verify>',
  '```',
  '',
  'Rules:',
  '- Do NOT use the structured card for trivial changes such as copy tweaks, captions, one-line edits, formatting, or small visual adjustments.',
  '- For simple tasks, say what changed and whether verification passed, then stop.',
  '- Include CHANGES MADE only when the structured card is warranted. Skip the block entirely for pure Q&A turns.',
  '- DIDN\'T TOUCH is only useful when there were adjacent risky areas you deliberately left alone.',
  '- CONCERNS is never empty if you had to make a judgment call, guess a value, or skip verification. If there are truly no concerns, write "CONCERNS: none".',
  '- One line per entry. No prose paragraphs inside the block.',
  '- Put the block inside a single fenced code block so the host UI can render it as a structured card.',
].join('\n')

export function buildCodeSurfOutputConvention(): string {
  return CODESURF_OUTPUT_CONVENTION
}

// CodeSurf-wide "Insight" convention. Injected into provider prompts so every
// model can produce the renderer-recognized star-framed callout when it has a
// genuinely useful, non-obvious observation.
export const CODESURF_INSIGHT_CONVENTION = [
  '## CodeSurf Insight Convention',
  '',
  'Use an Insight block when you notice a non-obvious constraint, risk, hidden dependency, or design implication that the user should understand before trusting the answer.',
  'Do not emit an Insight block for routine summaries, obvious statements, or tiny mechanical edits.',
  '',
  'When you emit one, use this exact wrapper:',
  '`★ Insight ─────────────────────────────────────`',
  '- [point 1]',
  '- [point 2]',
  '`─────────────────────────────────────────────────`',
  '',
  'Keep it to 1–2 bullets. It must explain non-obvious reasoning, not summarize the work.',
].join('\n')

export function buildCodeSurfInsightConvention(): string {
  return CODESURF_INSIGHT_CONVENTION
}

export const CODESURF_ACTIVITY_CONVENTION = [
  '## CodeSurf Activity Convention',
  '',
  'Keep your native agent instructions, tools, and strengths. This convention only standardizes what CodeSurf can show to the user.',
  '',
  'For non-trivial multi-step work, keep a visible task plan current using your native todo/plan tool when one is available.',
  'If the native environment does not expose a todo/plan tool, use concise natural-language progress updates instead of inventing unavailable tools.',
  '',
  'Use neutral tool/action language. Avoid provider-specific status phrasing when a plain action name is enough.',
  'Prefer short completion wording unless the task needs a structured handoff.',
].join('\n')

export function buildCodeSurfActivityConvention(): string {
  return CODESURF_ACTIVITY_CONVENTION
}
