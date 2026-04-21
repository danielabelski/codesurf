export const SESSION_ACTION_BUTTON_SIZE = 24
export const SESSION_ACTION_ICON_SIZE = 14
export const SESSION_ROW_EXTRA_WIDTH = 72

export function getSessionArchiveActionLabel(isArchived: boolean): string {
  return isArchived ? 'Unarchive conversation' : 'Archive conversation'
}
