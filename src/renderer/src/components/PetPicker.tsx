// PetPicker — modal for browsing, installing, and selecting pets.
//
// Mirrors the Codex Pets / petdex gallery UI: a dark modal with a search
// field, two-column pet list with pixel-art thumbnails, and a size slider.
// Fetches the gallery from petdex.dev (falls back to local-only list on
// network failure), installs pets on click, and sets the active pet.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Search, X, Download, Trash2, Loader2 } from 'lucide-react'
import {
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  type PetGalleryEntry,
  type PetManifest,
} from '../../../shared/pet-types'
import { useTheme } from '../ThemeContext'

const SCHEME = 'contex-file'

function toFileUrl(absPath: string): string {
  return `${SCHEME}://${absPath}`
}

interface PetPickerProps {
  onClose: () => void
  currentSlug: string
  scale: number
  onSelect: (slug: string) => void
  onScaleChange: (scale: number) => void
}

interface PetEntry extends PetGalleryEntry {
  thumbnailUrl?: string
  installing?: boolean
  error?: string
}

export function PetPicker({
  onClose,
  currentSlug,
  scale,
  onSelect,
  onScaleChange,
}: PetPickerProps): JSX.Element {
  const theme = useTheme()
  const [search, setSearch] = useState('')
  const [entries, setEntries] = useState<PetEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedSlug, setSelectedSlug] = useState<string>(currentSlug)
  const searchRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Gallery+installed merge: fetch gallery entries, then fetch installed pets
  // and their thumbnails. Merge by id (installed entries take precedence for
  // thumbnail display since we have their spritesheets locally).
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [gallery, installed] = await Promise.all([
        window.electron.pets.gallery(),
        window.electron.pets.list(),
      ])

      // Merge: start with gallery entries, add installed pets not in gallery
      const galleryMap = new Map<string, PetEntry>()
      for (const g of gallery) {
        galleryMap.set(g.id, { ...g })
      }
      for (const pet of installed as PetManifest[]) {
        const existing = galleryMap.get(pet.id)
        if (existing) {
          galleryMap.set(pet.id, { ...existing, installed: true })
        } else {
          galleryMap.set(pet.id, {
            id: pet.id,
            displayName: pet.displayName,
            description: pet.description,
            category: pet.category,
            installed: true,
          })
        }
      }

      // Fetch thumbnails for installed pets
      const withThumbs = await Promise.all(
        Array.from(galleryMap.values()).map(async (entry) => {
          if (!entry.installed) return entry
          const thumbPath = await window.electron.pets.thumbnail(entry.id)
          return thumbPath ? { ...entry, thumbnailUrl: toFileUrl(thumbPath) } : entry
        }),
      )

      setEntries(withThumbs)
    } catch {
      // Fall back to local-only list
      const local = await window.electron.pets.galleryLocal()
      setEntries(local)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Listen for gallery changes (install/remove from main)
  useEffect(() => {
    const unsub = window.electron.pets.onGalleryChanged(() => {
      void refresh()
    })
    return unsub
  }, [refresh])

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Esc to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Filtered entries
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return entries
    return entries.filter(
      (e) =>
        e.displayName.toLowerCase().includes(q) ||
        e.id.toLowerCase().includes(q) ||
        (e.description ?? '').toLowerCase().includes(q),
    )
  }, [entries, search])

  const handleInstall = useCallback(
    async (slug: string) => {
      setEntries((prev) =>
        prev.map((e) => (e.id === slug ? { ...e, installing: true, error: undefined } : e)),
      )
      const result = await window.electron.pets.install(slug)
      if (!result.ok) {
        setEntries((prev) =>
          prev.map((e) =>
            e.id === slug ? { ...e, installing: false, error: result.error } : e,
          ),
        )
      } else {
        // Refresh will be triggered by gallery-changed event
        setEntries((prev) =>
          prev.map((e) => (e.id === slug ? { ...e, installing: false } : e)),
        )
      }
    },
    [],
  )

  const handleRemove = useCallback(async (slug: string) => {
    await window.electron.pets.remove(slug)
    // Refresh will be triggered by gallery-changed event
  }, [])

  const handleSelect = useCallback(
    (slug: string) => {
      setSelectedSlug(slug)
      onSelect(slug)
    },
    [onSelect],
  )

  // Colors from theme
  const bg = theme.surface.panel ?? '#1e1e1e'
  const bgDarker = '#161616'
  const text = theme.text.primary ?? '#e0e0e0'
  const textMuted = theme.text.muted ?? '#888'
  const accent = theme.accent.base ?? '#4a9eff'
  const border = theme.border.default ?? '#333'

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: 'min(720px, 90vw)',
          maxHeight: '80vh',
          backgroundColor: bgDarker,
          border: `1px solid ${border}`,
          borderRadius: 12,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px 12px',
            borderBottom: `1px solid ${border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: text }}>
              Choose a pet
            </h2>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                borderRadius: 4,
                color: textMuted,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <X size={16} />
            </button>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: textMuted }}>
            Picking one installs it (if needed) and makes it active.
          </p>
          {/* Search */}
          <div
            style={{
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Search
              size={14}
              style={{
                position: 'absolute',
                left: 10,
                color: textMuted,
                pointerEvents: 'none',
              }}
            />
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search pets…"
              style={{
                width: '100%',
                padding: '8px 12px 8px 32px',
                fontSize: 13,
                backgroundColor: bg,
                border: `1px solid ${border}`,
                borderRadius: 6,
                color: text,
                outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Pet list — two columns */}
        <div
          ref={scrollRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '8px 12px',
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '4px 8px',
            alignContent: 'start',
          }}
        >
          {loading && (
            <div
              style={{
                gridColumn: '1 / -1',
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                padding: 40,
                color: textMuted,
              }}
            >
              <Loader2 size={20} className="animate-spin" />
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div
              style={{
                gridColumn: '1 / -1',
                textAlign: 'center',
                padding: 40,
                color: textMuted,
                fontSize: 13,
              }}
            >
              No pets found{search ? ` for "${search}"` : ''}.
            </div>
          )}
          {!loading &&
            filtered.map((entry) => {
              const isSelected = entry.id === selectedSlug
              return (
                <PetRow
                  key={entry.id}
                  entry={entry}
                  selected={isSelected}
                  onSelect={() => handleSelect(entry.id)}
                  onInstall={() => handleInstall(entry.id)}
                  onRemove={() => handleRemove(entry.id)}
                  theme={theme}
                />
              )
            })}
        </div>

        {/* Footer — count + size slider */}
        <div
          style={{
            padding: '12px 20px 16px',
            borderTop: `1px solid ${border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <div style={{ fontSize: 11, color: textMuted }}>
            Showing {filtered.length} of {entries.length}
            {search ? ' — type to narrow it down.' : '.'}
          </div>
          {/* Size slider */}
          <div>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: text,
                marginBottom: 4,
              }}
            >
              Size
            </div>
            <p style={{ margin: '0 0 8px', fontSize: 11, color: textMuted }}>
              Resize the floating mascot. Applies everywhere instantly.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="range"
                min={PET_SCALE_MIN}
                max={PET_SCALE_MAX}
                step={0.01}
                value={scale}
                onChange={(e) => onScaleChange(parseFloat(e.target.value))}
                style={{
                  flex: 1,
                  accentColor: accent,
                  cursor: 'pointer',
                }}
              />
              <span style={{ fontSize: 11, color: textMuted, minWidth: 36, textAlign: 'right' }}>
                {Math.round(scale * 100)}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Pet row ──────────────────────────────────────────────────────────────────

interface PetRowProps {
  entry: PetEntry
  selected: boolean
  onSelect: () => void
  onInstall: () => void
  onRemove: () => void
  theme: ReturnType<typeof useTheme>
}

function PetRow({
  entry,
  selected,
  onSelect,
  onInstall,
  onRemove,
  theme,
}: PetRowProps): JSX.Element {
  const bgHover = theme.surface.hover ?? '#252525'
  const bg = selected ? bgHover : 'transparent'
  const text = theme.text.primary ?? '#e0e0e0'
  const textMuted = theme.text.muted ?? '#888'
  const accent = theme.accent.base ?? '#4a9eff'
  const border = theme.border.default ?? '#333'

  return (
    <div
      onClick={entry.installed ? onSelect : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 8px',
        borderRadius: 6,
        backgroundColor: bg,
        border: selected ? `1px solid ${accent}` : `1px solid transparent`,
        cursor: entry.installed ? 'pointer' : 'default',
        transition: 'background-color 0.1s',
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = bgHover
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.backgroundColor = 'transparent'
      }}
    >
      {/* Thumbnail */}
      <div
        style={{
          width: 32,
          height: 32,
          flexShrink: 0,
          borderRadius: 4,
          backgroundColor: '#0d0d0d',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {entry.thumbnailUrl ? (
          <img
            src={entry.thumbnailUrl}
            alt={entry.displayName}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              imageRendering: 'pixelated',
            }}
          />
        ) : (
          <div
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              backgroundColor: '#333',
            }}
          />
        )}
      </div>
      {/* Name + slug */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span
          style={{
            fontSize: 13,
            color: text,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.displayName}
        </span>
        <span
          style={{
            fontSize: 11,
            color: textMuted,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {entry.id}
          {entry.installed ? ' · installed' : ''}
        </span>
        {entry.error && (
          <span style={{ fontSize: 10, color: '#ff6b6b' }}>{entry.error}</span>
        )}
      </div>
      {/* Action button */}
      {entry.installing ? (
        <Loader2 size={14} style={{ color: textMuted, animation: 'spin 1s linear infinite' }} />
      ) : !entry.installed ? (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onInstall()
          }}
          style={{
            background: 'none',
            border: `1px solid ${border}`,
            borderRadius: 4,
            padding: '2px 6px',
            cursor: 'pointer',
            color: textMuted,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
          }}
          title="Install"
        >
          <Download size={12} />
          Install
        </button>
      ) : (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 2,
            color: textMuted,
            display: 'flex',
            alignItems: 'center',
            opacity: 0.5,
          }}
          title="Remove"
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '1'
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '0.5'
          }}
        >
          <Trash2 size={12} />
        </button>
      )}
    </div>
  )
}
