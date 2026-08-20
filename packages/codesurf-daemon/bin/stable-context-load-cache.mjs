export function createStableContextLoadCache(maxEntries = 64) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new Error('Stable context load cache size must be a positive integer')
  }
  const entries = new Map()

  return {
    get(key) {
      if (!entries.has(key)) return { hit: false }
      const value = entries.get(key)
      entries.delete(key)
      entries.set(key, value)
      return { hit: true, value }
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, value)
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) return
        entries.delete(oldest)
      }
    },
    key(kind, request = {}) {
      return JSON.stringify([
        String(kind ?? ''),
        String(request.workspaceId ?? '').trim(),
        String(request.cardId ?? '').trim(),
        String(request.executionTarget === 'cloud' ? 'cloud' : 'local'),
      ])
    },
  }
}
