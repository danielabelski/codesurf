const INVALID_ID_PATTERN = /\.\.|\/|\\|^\.|\0/

export const MAX_RELAY_STORAGE_ID_LENGTH = 128

function validateStorageId(
  id: string,
  kind: 'Participant' | 'Channel' | 'Tile',
): void {
  if (!id || typeof id !== 'string') {
    throw new Error(`${kind} ID is required`)
  }
  if (INVALID_ID_PATTERN.test(id)) {
    throw new Error(`Invalid ${kind.toLowerCase()} ID: ${id}`)
  }
  if (id.length > MAX_RELAY_STORAGE_ID_LENGTH) {
    throw new Error(
      `${kind} ID too long (max ${MAX_RELAY_STORAGE_ID_LENGTH} chars)`,
    )
  }
}

export function validateParticipantId(id: string): void {
  validateStorageId(id, 'Participant')
}

export function validateChannelId(id: string): void {
  validateStorageId(id, 'Channel')
}

export function validateTileId(id: string): void {
  validateStorageId(id, 'Tile')
}

// Mailbox filenames are joined into mailbox dirs and are renderer-supplied
// through relay:* IPC. They must stay plain basenames, otherwise
// moveMessage/readMessage become arbitrary file primitives.
export function validateMessageFilename(filename: string): void {
  if (!filename || typeof filename !== 'string') {
    throw new Error('Message filename is required')
  }
  if (INVALID_ID_PATTERN.test(filename)) {
    throw new Error(`Invalid message filename: ${filename}`)
  }
}

export function safeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'message'
}

export function sanitizeForPrompt(
  text: string,
  maxLength = 4000,
): string {
  return text
    .replace(/```/g, '\\`\\`\\`')
    .replace(/<\|/g, '\\<\\|')
    .replace(/\|>/g, '\\|\\>')
    .slice(0, maxLength)
}
