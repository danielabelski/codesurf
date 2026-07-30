export const MAX_CONTEXT_FILE_BYTES: number
export const MAX_INSTRUCTION_SECTIONS: number
export const MAX_IMPORT_DEPTH: number
export const MAX_AGGREGATE_INSTRUCTION_BYTES: number
export const MAX_SELECTED_SKILLS: number
export const MAX_SKILL_DESCRIPTION_BYTES: number
export const MAX_PERSONA_PROMPT_BYTES: number
export const MAX_TRANSCRIPT_CONTEXT_PREVIEW_BYTES: number
export const MAX_SKILLS_PROMPT_BYTES: number
export const MAX_SKILLS_SUMMARY_BYTES: number

export interface TruncatedUtf8 {
  text: string
  originalBytes: number
  includedBytes: number
  truncated: boolean
  truncationReason: string | null
  omittedBytes: number
}

export function utf8ByteLength(value: unknown): number
export function truncationMarker(reason: string, originalBytes: number, maxBytes: number): string
export function truncateUtf8(
  value: unknown,
  maxBytes: number,
  options?: { reason?: string, originalBytes?: number },
): TruncatedUtf8
export function previewContextToolInput(value: unknown): TruncatedUtf8
