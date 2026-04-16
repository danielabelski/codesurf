import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import Editor from '@monaco-editor/react'
import { Type } from 'lucide-react'
import { useAppFonts } from '../FontContext'
import { useTheme } from '../ThemeContext'
import { useTileColor } from '../TileColorContext'
import { ensureMonacoConfigured } from '../monaco'
import { dispatchOpenLink, findAnchorFromEventTarget } from '../utils/links'

interface Props {
  tileId?: string
  filePath?: string
  initialContent?: string
  workspacePath?: string
}

/*
 * Minimal markdown-to-HTML renderer used only for LOCAL, USER-AUTHORED content
 * (the user's own note files). This is NOT used for untrusted external input.
 * HTML entities are escaped first to prevent injection from the source text.
 */
export function renderMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/^---+$/gm, '<hr/>')
    .replace(/^\s*[-*+] (.+)$/gm, '<li>$1</li>')
    .replace(/^\s*\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/\n\n([^<])/g, '\n\n<p>$1')
    .replace(/\n/g, '<br/>')
  html = html.replace(/(<li>.*?<\/li>)(\s*<br\/>)*/g, (m) => `<ul>${m.replace(/<br\/>/g, '')}</ul>`)
  return html
}

ensureMonacoConfigured()

// Sticky note colours
const STICKY_COLOURS = [
  { id: 'yellow',  bg: '#fff9c4', border: '#f9e547', text: '#5d4e00' },
  { id: 'green',   bg: '#c8f7c5', border: '#69d662', text: '#1b4d16' },
  { id: 'blue',    bg: '#bbdefb', border: '#5fa8e8', text: '#0d3b66' },
  { id: 'pink',    bg: '#f8bbd0', border: '#e57399', text: '#6b1a3a' },
  { id: 'purple',  bg: '#e1bee7', border: '#b368c9', text: '#3e1650' },
  { id: 'orange',  bg: '#ffe0b2', border: '#f5a623', text: '#5e3a00' },
  { id: 'white',   bg: '#ffffff', border: '#d0d0d0', text: '#333333' },
  { id: 'dark',    bg: '#2a2a2a', border: '#444444', text: '#e0e0e0' },
] as const

const STICKY_FONTS = [
  {
    id: 'sans',
    label: 'System Sans',
    family: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  {
    id: 'rounded',
    label: 'Rounded',
    family: '"SF Pro Rounded", "Avenir Next Rounded", "Segoe UI", sans-serif',
  },
  {
    id: 'serif',
    label: 'Book Serif',
    family: '"Iowan Old Style", "Palatino Linotype", Georgia, serif',
  },
  {
    id: 'marker',
    label: 'Marker',
    family: '"Marker Felt", "Comic Sans MS", "Segoe Print", cursive',
  },
  {
    id: 'hand',
    label: 'Handwritten',
    family: '"Bradley Hand", "Segoe Print", "Comic Sans MS", cursive',
  },
] as const

function StickyNote({ initialContent, tileId, workspacePath }: { initialContent: string; tileId?: string; workspacePath?: string }): JSX.Element {
  const fonts = useAppFonts()
  const [content, setContent] = useState(initialContent || '')
  const { colorId, setColor, setColorId, fontId, setFontId } = useTileColor()
  const colour = STICKY_COLOURS.find(c => c.id === colorId) ?? STICKY_COLOURS[0]
  const noteFont = STICKY_FONTS.find(f => f.id === fontId) ?? STICKY_FONTS[0]
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const settingsSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loaded = useRef(false)

  // Push colour to titlebar via context
  useEffect(() => {
    setColor(colour.bg)
    return () => setColor(null)
  }, [colour.bg, setColor])

  // Persist note content + appearance to tile context directory so agents can read via get_context
  const contextDir = tileId && workspacePath ? `${workspacePath}/.contex/${tileId}/context` : null
  const contextFile = contextDir ? `${contextDir}/note.txt` : null
  const settingsFile = contextDir ? `${contextDir}/note-settings.json` : null

  // Load saved content and appearance on mount.
  // Check existence first to avoid noisy ENOENT logs from the main-process fs IPC.
  useEffect(() => {
    let cancelled = false
    loaded.current = false
    if (!contextDir || !contextFile || !settingsFile) {
      loaded.current = true
      return
    }

    ;(async () => {
      try {
        const [contentStat, settingsStat] = await Promise.all([
          window.electron.fs.stat(contextFile).catch(() => null),
          window.electron.fs.stat(settingsFile).catch(() => null),
        ])

        if (cancelled) return

        if (contentStat?.isFile) {
          const text = await window.electron.fs.readFile(contextFile).catch(() => '')
          if (!cancelled && text && text.trim()) setContent(text)
        }

        if (settingsStat?.isFile) {
          const raw = await window.electron.fs.readFile(settingsFile).catch(() => '')
          if (!cancelled && raw) {
            try {
              const parsed = JSON.parse(raw)
              if (typeof parsed?.colorId === 'string' && STICKY_COLOURS.some(c => c.id === parsed.colorId)) {
                setColorId(parsed.colorId)
              }
              if (typeof parsed?.fontId === 'string' && STICKY_FONTS.some(f => f.id === parsed.fontId)) {
                setFontId(parsed.fontId)
              }
            } catch {
              // Ignore invalid appearance settings
            }
          }
        }
      } finally {
        if (!cancelled) loaded.current = true
      }
    })()

    return () => { cancelled = true }
  }, [contextDir, contextFile, settingsFile, setColorId, setFontId])

  // Auto-save content to context dir
  const persistContent = useCallback((value: string) => {
    if (!contextDir || !contextFile || !loaded.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.electron.fs.createDir(contextDir).catch(() => {}).then(() => {
        window.electron.fs.writeFile(contextFile, value)
      })
    }, 500)
  }, [contextDir, contextFile])

  const handleChange = useCallback((value: string) => {
    setContent(value)
    persistContent(value)
  }, [persistContent])

  useEffect(() => {
    if (!contextDir || !settingsFile || !loaded.current) return
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current)
    settingsSaveTimer.current = setTimeout(() => {
      window.electron.fs.createDir(contextDir).catch(() => {}).then(() => {
        window.electron.fs.writeFile(settingsFile, JSON.stringify({ colorId, fontId }, null, 2))
      })
    }, 200)
  }, [contextDir, settingsFile, colorId, fontId])

  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (settingsSaveTimer.current) clearTimeout(settingsSaveTimer.current)
  }, [])

  // Listen for MCP note_append_context commands via bus
  useEffect(() => {
    if (!tileId) return
    const channel = `tile:${tileId}`
    const subscriberId = `note-${tileId}`
    const unsub = window.electron?.bus?.subscribe(channel, subscriberId, (event: { payload?: { command?: string; content?: string } }) => {
      if (event.payload?.command === 'note_append_context' && event.payload.content) {
        setContent(prev => {
          const next = prev ? `${prev}\n${event.payload!.content}` : event.payload!.content!
          persistContent(next)
          return next
        })
      }
      if (event.payload?.command === 'note_write_content' && typeof event.payload.content === 'string') {
        setContent(event.payload.content)
        persistContent(event.payload.content)
      }
    })
    return () => unsub?.()
  }, [persistContent, tileId])

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      background: colour.bg,
      position: 'relative',
      overflow: 'hidden',
    }}>
      <textarea
        value={content}
        onChange={e => handleChange(e.target.value)}
        placeholder="Type a note..."
        style={{
          flex: 1, resize: 'none', border: 'none', outline: 'none',
          background: 'transparent',
          color: colour.text,
          fontSize: fonts.size, lineHeight: fonts.lineHeight, fontWeight: fonts.weight,
          padding: '8px 14px 14px',
          fontFamily: noteFont.family,
          letterSpacing: 0.1,
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
    </div>
  )
}

function StickyPopover({ anchorRef, children }: { anchorRef: React.RefObject<HTMLElement | null>; children: React.ReactNode }): JSX.Element | null {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  useLayoutEffect(() => {
    const el = anchorRef.current
    if (!el) return

    const update = () => {
      const rect = el.getBoundingClientRect()
      setPos({
        top: rect.bottom + 6,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }

    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [anchorRef])

  if (!pos) return null
  return createPortal(
    <div
      data-sticky-note-popover="true"
      style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 99999 }}
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}

// Exported for use as titlebarExtra in TileChrome — reads/writes colour via TileColorContext
export function StickyColorPicker(): JSX.Element {
  const { colorId, setColorId, fontId, setFontId } = useTileColor()
  const theme = useTheme()
  const fonts = useAppFonts()
  const [showColourPicker, setShowColourPicker] = useState(false)
  const [showFontPicker, setShowFontPicker] = useState(false)
  const popoverRef = useRef<HTMLDivElement>(null)
  const colourButtonRef = useRef<HTMLButtonElement>(null)
  const fontButtonRef = useRef<HTMLButtonElement>(null)
  const colour = STICKY_COLOURS.find(c => c.id === colorId) ?? STICKY_COLOURS[0]
  const activeFont = STICKY_FONTS.find(f => f.id === fontId) ?? STICKY_FONTS[0]
  const chromeColor = colour.text

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node
      const targetEl = e.target instanceof Element ? e.target : null
      if (!popoverRef.current?.contains(target) && !targetEl?.closest('[data-sticky-note-popover="true"]')) {
        setShowColourPicker(false)
        setShowFontPicker(false)
      }
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [])

  return (
    <div ref={popoverRef} data-no-drag style={{ display: 'flex', gap: 6, alignItems: 'center', marginRight: 4, position: 'relative' }}>
      <button
        ref={colourButtonRef}
        data-no-drag
        onClick={() => { setShowColourPicker(v => !v); setShowFontPicker(false) }}
        title="Change note colour"
        style={{
          width: 14, height: 14, borderRadius: 7,
          background: colour.bg, border: `1.5px solid ${colour.border}`,
          cursor: 'pointer', padding: 0,
          flexShrink: 0,
        }}
      />

      <button
        ref={fontButtonRef}
        data-no-drag
        onClick={() => { setShowFontPicker(v => !v); setShowColourPicker(false) }}
        title="Change note font"
        style={{
          width: 18, height: 18,
          borderRadius: 5,
          border: `1px solid ${showFontPicker ? chromeColor : `${chromeColor}55`}`,
          background: showFontPicker ? `${chromeColor}14` : 'transparent',
          color: showFontPicker ? chromeColor : `${chromeColor}cc`,
          cursor: 'pointer', padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <Type size={11} strokeWidth={2.2} />
      </button>

      {showColourPicker && (
        <StickyPopover anchorRef={colourButtonRef}>
          <div
            data-no-drag
            style={{
              display: 'flex',
              gap: 5,
              padding: '6px 7px',
              borderRadius: 999,
              background: theme.surface.panelElevated,
              border: `1px solid ${theme.border.default}`,
              boxShadow: theme.shadow.panel,
              backdropFilter: 'blur(10px)',
            }}
          >
            {STICKY_COLOURS.map(c => (
              <button
                key={c.id}
                data-no-drag
                onClick={() => { setColorId(c.id); setShowColourPicker(false) }}
                title={c.id}
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 7,
                  background: c.bg,
                  border: `1.5px solid ${c.id === colorId ? c.text : c.border}`,
                  cursor: 'pointer',
                  padding: 0,
                  transform: c.id === colorId ? 'scale(1.15)' : 'scale(1)',
                  transition: 'transform 0.12s ease',
                }}
              />
            ))}
          </div>
        </StickyPopover>
      )}

      {showFontPicker && (
        <StickyPopover anchorRef={fontButtonRef}>
          <div
            data-no-drag
            style={{
              width: 196,
              maxHeight: 220,
              overflowY: 'auto',
              padding: 4,
              borderRadius: 10,
              background: theme.surface.panelElevated,
              border: `1px solid ${theme.border.default}`,
              boxShadow: theme.shadow.panel,
              backdropFilter: 'blur(10px)',
            }}
          >
            {STICKY_FONTS.map(font => {
              const active = font.id === activeFont.id
              return (
                <button
                  key={font.id}
                  data-no-drag
                  onClick={() => { setFontId(font.id); setShowFontPicker(false) }}
                  style={{
                    width: '100%',
                    border: 'none',
                    background: active ? theme.accent.soft : 'transparent',
                    color: active ? theme.accent.base : theme.text.primary,
                    cursor: 'pointer',
                    borderRadius: 8,
                    padding: '8px 10px',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span style={{ fontSize: 11, fontFamily: fonts.secondary, color: active ? theme.accent.base : theme.text.secondary }}>
                    {font.label}
                  </span>
                  <span style={{ fontSize: 15, fontFamily: font.family, color: theme.text.primary, lineHeight: 1.25 }}>
                    Sticky note preview
                  </span>
                </button>
              )
            })}
          </div>
        </StickyPopover>
      )}
    </div>
  )
}

function FileNote({ tileId, filePath, initialContent }: { tileId?: string; filePath?: string; initialContent: string }): JSX.Element {
  const [content, setContent] = useState<string | undefined>(undefined)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loaded = useRef(false)
  const fonts = useAppFonts()
  const theme = useTheme()
  const previewRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loaded.current = false
    if (!filePath) {
      setContent(initialContent || '# Untitled\n\nStart writing...')
      loaded.current = true
      return
    }
    window.electron.fs.readFile(filePath).then(text => {
      setContent(text)
      loaded.current = true
    }).catch(() => {
      setContent('')
      loaded.current = true
    })
  }, [filePath, initialContent])

  const persistContent = useCallback((value: string) => {
    if (!filePath) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.electron.fs.writeFile(filePath, value)
    }, 500)
  }, [filePath])

  const handleChange = useCallback((value: string | undefined) => {
    if (!loaded.current || value === undefined) return
    setContent(value)
    persistContent(value)
  }, [persistContent])

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  useEffect(() => {
    if (!tileId) return
    const channel = `tile:${tileId}`
    const subscriberId = `note-${tileId}`
    const unsub = window.electron?.bus?.subscribe(channel, subscriberId, (event: { payload?: { command?: string; content?: string } }) => {
      if (event.payload?.command === 'note_append_context' && event.payload.content) {
        setContent(prev => {
          const next = prev ? `${prev}\n${event.payload!.content}` : event.payload!.content!
          persistContent(next)
          return next
        })
      }
      if (event.payload?.command === 'note_write_content' && typeof event.payload.content === 'string') {
        setContent(event.payload.content)
        persistContent(event.payload.content)
      }
    })
    return () => unsub?.()
  }, [persistContent, tileId])

  // Safe preview: render user-authored markdown (HTML-escaped first in renderMarkdown)
  useEffect(() => {
    if (mode !== 'preview' || !previewRef.current) return
    const rendered = renderMarkdown(content ?? '')
    previewRef.current.textContent = ''
    const wrapper = document.createElement('div')
    wrapper.innerHTML = rendered // eslint-disable-line -- content is HTML-escaped by renderMarkdown
    while (wrapper.firstChild) previewRef.current.appendChild(wrapper.firstChild)
  }, [mode, content])

  useEffect(() => {
    const root = previewRef.current
    if (!root) return

    const handleClick = (event: MouseEvent) => {
      const anchor = findAnchorFromEventTarget(event)
      if (!anchor) return

      const href = anchor.getAttribute('href') ?? ''
      if (!dispatchOpenLink(href)) return

      event.preventDefault()
      event.stopPropagation()
    }

    root.addEventListener('click', handleClick, true)
    return () => root.removeEventListener('click', handleClick, true)
  }, [])

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: theme.editor.background, position: 'relative' }}>
      <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 10, display: 'flex', gap: 2 }}>
        <button
          onClick={() => setMode('edit')}
          title="Edit"
          style={{
            width: 24, height: 24, borderRadius: 4, border: 'none', cursor: 'pointer', padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: mode === 'edit' ? theme.accent.soft : theme.surface.panelMuted,
            color: mode === 'edit' ? theme.accent.base : theme.text.disabled,
          }}
          onMouseEnter={e => { if (mode !== 'edit') { e.currentTarget.style.background = theme.surface.hover; e.currentTarget.style.color = theme.text.muted } }}
          onMouseLeave={e => { if (mode !== 'edit') { e.currentTarget.style.background = theme.surface.panelMuted; e.currentTarget.style.color = theme.text.disabled } }}
        >
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M9 1.5L11.5 4L4.5 11H2V8.5L9 1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <button
          onClick={() => setMode('preview')}
          title="Preview"
          style={{
            width: 24, height: 24, borderRadius: 4, border: 'none', cursor: 'pointer', padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: mode === 'preview' ? theme.accent.soft : theme.surface.panelMuted,
            color: mode === 'preview' ? theme.accent.base : theme.text.disabled,
          }}
          onMouseEnter={e => { if (mode !== 'preview') { e.currentTarget.style.background = theme.surface.hover; e.currentTarget.style.color = theme.text.muted } }}
          onMouseLeave={e => { if (mode !== 'preview') { e.currentTarget.style.background = theme.surface.panelMuted; e.currentTarget.style.color = theme.text.disabled } }}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 7C1 7 3 3 7 3C11 3 13 7 13 7C13 7 11 11 7 11C3 11 1 7 1 7Z" stroke="currentColor" strokeWidth="1.3"/>
            <circle cx="7" cy="7" r="1.5" stroke="currentColor" strokeWidth="1.3"/>
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {mode === 'edit' ? (
          <Editor
            height="100%"
            language="markdown"
            value={content}
            onChange={handleChange}
            theme={theme.editor.monacoBase}
            loading={<div style={{ height: '100%', background: theme.editor.background }} />}
            options={{
              minimap: { enabled: false },
              fontSize: fonts.monoSize,
              lineHeight: fonts.monoLineHeight,
              wordWrap: 'on',
              automaticLayout: true,
              padding: { top: 12 },
              scrollBeyondLastLine: false,
              fontFamily: fonts.mono,
              lineNumbers: 'off',
              folding: false,
              renderLineHighlight: 'none',
              overviewRulerBorder: false,
              scrollbar: { verticalScrollbarSize: 4 }
            }}
          />
        ) : (
          <div
            ref={previewRef}
            className="note-preview"
            style={{ height: '100%', overflowY: 'auto', padding: '16px 20px' }}
          />
        )}
      </div>

      <style>{`
        .note-preview h1 { font-size: 1.6em; font-weight: 700; color: ${theme.text.primary}; margin: 0 0 12px; }
        .note-preview h2 { font-size: 1.3em; font-weight: 600; color: ${theme.text.secondary}; margin: 16px 0 8px; }
        .note-preview h3 { font-size: 1.1em; font-weight: 600; color: ${theme.text.secondary}; margin: 12px 0 6px; }
        .note-preview p  { color: ${theme.text.secondary}; line-height: 1.7; margin: 0 0 10px; }
        .note-preview code { background: ${theme.surface.panelMuted}; color: ${theme.accent.base}; padding: 1px 5px; border-radius: 3px; font-size: 12px; font-family: "JetBrains Mono", monospace; }
        .note-preview pre { background: ${theme.surface.panelMuted}; border: 1px solid ${theme.border.default}; border-radius: 4px; padding: 12px; overflow-x: auto; margin: 10px 0; }
        .note-preview pre code { background: none; padding: 0; }
        .note-preview ul, .note-preview ol { color: ${theme.text.secondary}; padding-left: 20px; margin: 6px 0; }
        .note-preview li { line-height: 1.7; }
        .note-preview a { color: ${theme.accent.base}; text-decoration: none; }
        .note-preview a:hover { text-decoration: underline; }
        .note-preview blockquote { border-left: 3px solid ${theme.border.strong}; padding-left: 12px; color: ${theme.text.muted}; margin: 8px 0; }
        .note-preview hr { border: none; border-top: 1px solid ${theme.border.default}; margin: 16px 0; }
        .note-preview strong { color: ${theme.text.primary}; }
      `}</style>
    </div>
  )
}

export function NoteTile({ tileId, filePath, initialContent = '', workspacePath }: Props): JSX.Element {
  if (filePath) {
    return <FileNote tileId={tileId} filePath={filePath} initialContent={initialContent} />
  }
  return <StickyNote initialContent={initialContent} tileId={tileId} workspacePath={workspacePath} />
}
