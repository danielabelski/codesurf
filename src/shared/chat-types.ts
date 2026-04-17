/** Shared chat message types used by ChatTile, KanbanCard, and main-process IPC. */

export interface FileChange {
  path: string
  previousPath?: string
  changeType: 'add' | 'update' | 'delete' | 'move'
  additions: number
  deletions: number
  diff: string
}

export interface CommandEntry {
  label: string
  command?: string
  output?: string
  kind?: 'search' | 'read' | 'command'
}

export interface ToolBlock {
  id: string
  name: string
  input: string
  summary?: string
  elapsed?: number
  status: 'running' | 'done' | 'error'
  fileChanges?: FileChange[]
  commandEntries?: CommandEntry[]
  /** User-written margin note "stuck" to this tool-call block. */
  note?: BlockNote
}

export interface ThinkingBlock {
  content: string
  done: boolean
  id?: string
  /** User-written margin note "stuck" to this thinking block. */
  note?: BlockNote
}

/**
 * A free-form user note attached to a specific chat record (message, tool
 * call, or thinking block). One note per block by design — editing replaces
 * the previous text. Stored inline on the record so it travels with the
 * conversation wherever the record goes.
 */
export interface BlockNote {
  text: string
  createdAt: number
  updatedAt?: number
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; toolId: string }
  | { type: 'thinking'; thinkingId: string }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  isStreaming?: boolean
  thinking?: ThinkingBlock
  thinkingBlocks?: ThinkingBlock[]
  toolBlocks?: ToolBlock[]
  contentBlocks?: ContentBlock[]
  cost?: number
  turns?: number
  /** User-written margin note "stuck" to this whole message. */
  note?: BlockNote
}
