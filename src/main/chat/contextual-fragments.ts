import { utf8Bytes, utf8Prefix } from './peer-context-serialization.ts'

/**
 * Central contract for volatile context injected into provider prompts.
 *
 * A fragment owns its content and carries its enforced byte ceiling with it;
 * callers may unwrap `text`, but must not concatenate additional volatile
 * context into the fragment before provider dispatch.
 */
export interface ContextualPromptFragment<Owner extends string = string> {
  owner: Owner
  volatility: 'per-turn'
  maxUtf8Bytes: number
  text: string
}

export function createContextualPromptFragment<Owner extends string>(
  owner: Owner,
  text: string,
  maxUtf8Bytes: number,
): ContextualPromptFragment<Owner> {
  const boundedText = utf8Bytes(text) <= maxUtf8Bytes
    ? text
    : utf8Prefix(text, maxUtf8Bytes)
  return Object.freeze({
    owner,
    volatility: 'per-turn' as const,
    maxUtf8Bytes,
    text: boundedText,
  })
}
