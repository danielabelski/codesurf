import React from 'react'
import { FileText, Trash2 } from 'lucide-react'
import { useTheme } from '../../ThemeContext'
import { basename } from '../../utils/dnd'
import type { TtsPlayerState } from '../../utils/ttsPlayer'

export interface ChatComposerAutocompleteItem {
  key: string
  value: string
  description: string
  attachPath?: string
  priority?: number
}

export interface ChatComposerAttachment {
  path: string
  kind: 'image' | 'file'
}

export interface ChatComposerSurface {
  extId: string
  surfaceId: string
  label: string
  icon?: string
  instanceId: string
  entryUrl: string
  height: number
}

export function ChatComposerWrap({
  style,
  children,
}: {
  style?: React.CSSProperties
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="cs-chat-composer-wrap" style={style}>
      {children}
    </div>
  )
}

export function ChatComposerCard({
  style,
  children,
}: {
  style?: React.CSSProperties
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="cs-chat-composer-card" style={style}>
      {children}
    </div>
  )
}

export function ChatComposerPrimaryToolbar({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="cs-chat-composer-primary-toolbar" style={{
      display: 'flex',
      alignItems: 'center',
      padding: '4px 8px 4px 8px',
      gap: 2,
    }}>
      {children}
    </div>
  )
}

export function ChatComposerSecondaryToolbar({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="cs-chat-composer-secondary-toolbar" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10,
      padding: '0 8px',
    }}>
      {children}
    </div>
  )
}

export function ChatComposerAutocompletePopup({
  popupRef,
  autocompleteType,
  query,
  items,
  activeIndex,
  fontSans,
  fontMono,
  onHoverIndex,
  onSelect,
}: {
  popupRef: React.RefObject<HTMLDivElement>
  autocompleteType: 'slash' | 'mention' | null
  query: string
  items: ChatComposerAutocompleteItem[]
  activeIndex: number
  fontSans: string
  fontMono: string
  onHoverIndex: (index: number) => void
  onSelect: (item: ChatComposerAutocompleteItem) => void
}): JSX.Element | null {
  const theme = useTheme()

  if (!autocompleteType || items.length === 0) return null

  return (
    <div
      ref={popupRef}
      style={{
        position: 'absolute', bottom: '100%', left: 0, right: 0,
        marginBottom: 4,
        background: theme.chat.dropdownBackground, border: `1px solid ${theme.chat.dropdownBorder}`,
        borderRadius: 8, padding: 4,
        boxShadow: theme.shadow.panel,
        zIndex: 9999,
        maxHeight: 6 * 36, overflowY: 'auto',
      }}
    >
      {autocompleteType === 'mention' && !query && (
        <div style={{
          padding: '6px 10px', fontSize: 11, color: theme.chat.muted,
          fontFamily: fontMono,
        }}>
          Connected files appear first. Type to search files...
        </div>
      )}
      {items.map((item, index) => (
        <div
          key={item.key}
          onMouseDown={(event) => { event.preventDefault(); onSelect(item) }}
          onMouseEnter={() => onHoverIndex(index)}
          style={{
            padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            background: index === activeIndex ? theme.chat.dropdownActiveBackground : 'transparent',
            transition: 'background 0.1s',
          }}
        >
          <span style={{
            fontSize: 12, color: index === activeIndex ? theme.accent.base : theme.chat.text,
            fontFamily: fontMono, fontWeight: 500,
          }}>
            {item.value}
          </span>
          <span style={{
            fontSize: 11, color: theme.chat.muted, fontFamily: fontSans,
            marginLeft: 'auto',
          }}>
            {item.description}
          </span>
        </div>
      ))}
    </div>
  )
}

export function ChatComposerSurfaceHost({
  surfaces,
  activeSurface,
  fontMono,
  showBuilderEnhance,
  renderSurfaceIcon,
  onActivateSurface,
  onCloseSurface,
  onOpenBuilderFromSketch,
  onSetSurfaceIframeRef,
}: {
  surfaces: ChatComposerSurface[]
  activeSurface: ChatComposerSurface | null
  fontMono: string
  showBuilderEnhance: boolean
  renderSurfaceIcon: (icon: string | undefined, size?: number) => React.ReactNode
  onActivateSurface: (instanceId: string) => void
  onCloseSurface: (instanceId: string) => void
  onOpenBuilderFromSketch: () => void
  onSetSurfaceIframeRef: (instanceId: string, node: HTMLIFrameElement | null) => void
}): JSX.Element | null {
  const theme = useTheme()

  if (surfaces.length === 0 || !activeSurface) return null

  return (
    <div style={{
      padding: '8px 14px 0 14px',
    }}>
      <div style={{
        position: 'relative',
        width: '100%',
        height: activeSurface.height,
        borderRadius: 12,
        border: `1px solid ${theme.chat.dropdownBorder}`,
        background: theme.surface.panelElevated,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 8px',
          borderBottom: `1px solid ${theme.border.subtle}`,
          background: theme.surface.overlay,
          fontSize: 11,
          fontFamily: fontMono,
          color: theme.chat.muted,
          overflowX: 'auto',
        }}>
          {surfaces.map(surface => {
            const isActive = surface.instanceId === activeSurface.instanceId
            return (
              <div
                key={surface.instanceId}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 8px',
                  borderRadius: 8,
                  border: `1px solid ${isActive ? theme.border.strong : theme.border.subtle}`,
                  background: isActive ? theme.chat.dropdownHoverBackground : 'transparent',
                  color: isActive ? theme.chat.text : theme.chat.muted,
                  flexShrink: 0,
                }}
              >
                <button
                  onClick={() => onActivateSurface(surface.instanceId)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    padding: 0,
                    fontSize: 11,
                    fontFamily: fontMono,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                    {renderSurfaceIcon(surface.icon ?? surface.surfaceId, 13)}
                  </span>
                  <span>{surface.label}</span>
                </button>
                <button
                  onClick={() => onCloseSurface(surface.instanceId)}
                  aria-label={`Close ${surface.label}`}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 4,
                    border: `1px solid ${theme.border.default}`,
                    background: 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    fontSize: 10,
                    lineHeight: 1,
                  }}
                >×</button>
              </div>
            )
          })}
          {showBuilderEnhance && (
            <button
              onClick={onOpenBuilderFromSketch}
              style={{
                border: `1px solid ${theme.border.default}`,
                background: theme.chat.dropdownHoverBackground,
                color: theme.chat.text,
                borderRadius: 8,
                padding: '4px 8px',
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: fontMono,
                flexShrink: 0,
              }}
            >
              Enhance → Builder
            </button>
          )}
        </div>
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {surfaces.map(surface => (
            <iframe
              key={surface.instanceId}
              ref={node => onSetSurfaceIframeRef(surface.instanceId, node)}
              src={surface.entryUrl}
              title={surface.label}
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                border: 'none',
                background: 'transparent',
                display: surface.instanceId === activeSurface.instanceId ? 'block' : 'none',
              }}
              sandbox="allow-scripts allow-same-origin"
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function ChatComposerVoiceStatus({
  isDictating,
  dictationText,
  dictationError,
  ttsState,
  onStopVoicePlayback,
}: {
  isDictating: boolean
  dictationText: string
  dictationError: string | null
  ttsState: TtsPlayerState
  onStopVoicePlayback: () => void
}): JSX.Element | null {
  const theme = useTheme()
  const showDictationStatus = isDictating || Boolean(dictationError)

  if (!showDictationStatus && !ttsState.isPlaying) return null

  return (
    <>
      {showDictationStatus && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 14px 0 14px', fontSize: 11,
          color: dictationError ? theme.status.warning : theme.status.danger,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: dictationError ? theme.status.warning : theme.status.danger,
            animation: isDictating ? 'chat-pulse 1s ease-in-out infinite' : 'none',
          }} />
          {dictationError ? (
            <span style={{ color: theme.chat.muted }}>
              Voice: <span style={{ color: theme.status.warning }}>{dictationError}</span>
            </span>
          ) : (
            <>
              <span>Recording{dictationText ? ': ' : ''}</span>
              {dictationText && <span style={{ color: theme.chat.muted, fontStyle: 'italic' }}>{dictationText}</span>}
            </>
          )}
        </div>
      )}

      {ttsState.isPlaying && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '4px 14px 0 14px', fontSize: 11, color: theme.accent.base,
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: theme.accent.base,
            animation: 'chat-pulse 1.4s ease-in-out infinite',
          }} />
          <span>Speaking…</span>
          {ttsState.queueLength > 0 && (
            <span style={{ color: theme.chat.muted, marginLeft: 4 }}>+{ttsState.queueLength} queued</span>
          )}
          <button
            onClick={onStopVoicePlayback}
            onMouseDown={e => e.preventDefault()}
            style={{
              marginLeft: 'auto', background: 'transparent', border: 'none',
              color: theme.chat.muted, cursor: 'pointer', fontSize: 11, padding: '2px 6px',
            }}
            title="Stop voice playback"
          >
            stop
          </button>
        </div>
      )}
    </>
  )
}

export function ChatComposerAttachments({
  attachments,
  fontMono,
  onRemoveAttachment,
}: {
  attachments: ChatComposerAttachment[]
  fontMono: string
  onRemoveAttachment: (path: string) => void
}): JSX.Element | null {
  const theme = useTheme()

  if (attachments.length === 0) return null

  return (
    <div style={{
      display: 'block', gap: 8, padding: '8px 14px 4px 14px',
      overflowX: 'auto',
    }}>
      {attachments.map(item => (
        <div
          key={item.path}
          title={item.path}
          style={{
            flexShrink: 0,
            maxWidth: item.kind === 'image' ? 140 : 180,
            height: 54,
            borderRadius: 12,
            border: `1px solid ${theme.chat.dropdownBorder}`,
            background: theme.surface.panelElevated,
            overflow: 'hidden',
            position: 'relative',
            display: 'flex',
            alignItems: 'stretch',
          }}
        >
          {item.kind === 'image' ? (
            <img
              src={item.path}
              alt={basename(item.path)}
              style={{ width: 54, height: 54, objectFit: 'cover', display: 'block', background: theme.chat.background, flexShrink: 0 }}
            />
          ) : (
            <div style={{
              width: 36, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: theme.chat.muted, borderRight: `1px solid ${theme.border.subtle}`, fontSize: 15,
            }}>
              <FileText size={13} />
            </div>
          )}
          <div style={{
            minWidth: 0,
            padding: '8px 26px 8px 10px',
            display: 'flex', flexDirection: 'column', justifyContent: 'center',
          }}>
            <div style={{ fontSize: 11, color: theme.chat.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{basename(item.path)}</div>
            <div style={{ fontSize: 9, color: theme.chat.muted, fontFamily: fontMono, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.kind === 'image' ? 'image' : 'file'}</div>
          </div>
          <button
            onClick={() => onRemoveAttachment(item.path)}
            style={{
              position: 'absolute', top: 6, right: 6,
              width: 16, height: 16, borderRadius: 8,
              border: `1px solid ${theme.border.default}`, background: theme.surface.overlay,
              color: theme.chat.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 0,
            }}
            title="Remove attachment"
          >
            <Trash2 size={9} />
          </button>
        </div>
      ))}
    </div>
  )
}
