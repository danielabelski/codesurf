/**
 * Shared Streamdown rendering utilities used by ChatTile and KanbanCard.
 * Eliminates duplication of code-block patching, shimmer animations,
 * link-click handling, and plugin config.
 */
import React, { useEffect, useRef } from 'react'
import { Streamdown } from 'streamdown'
import { code } from '@streamdown/code'
import 'streamdown/styles.css'
import { useTheme } from '../../ThemeContext'
import { useAppFonts } from '../../FontContext'
import { useThemeTokens } from '../../theme-tokens'
import { dispatchOpenLink, findAnchorFromEventTarget } from '../../utils/links'

// --- Streamdown plugins (singleton) ------------------------------------------------
export const streamdownPlugins = { code }

// --- Shimmer / animation keyframes (injected once globally) -----------------------
const SHIMMER_STYLE_ID = 'shared-streamdown-shimmer'

export function ensureShimmerStyles(): void {
  if (document.getElementById(SHIMMER_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = SHIMMER_STYLE_ID
  style.textContent = `
    @keyframes chat-shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes chat-shimmer-text {
      0% { background-position: var(--shimmer-start, -100px) 0; }
      100% { background-position: var(--shimmer-end, 200px) 0; }
    }
    @keyframes chat-dot-bounce {
      0%, 80%, 100% { transform: translateY(0); }
      40% { transform: translateY(-4px); }
    }
    @keyframes chat-spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    @keyframes chat-pulse {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }
  `
  document.head.appendChild(style)
}

// --- Streamdown code-block layout fix (injected once globally) --------------------
// Streamdown only adds a block-level line class when lineNumbers is enabled. When
// lineNumbers is off, each code line is rendered as an inline <span>, which makes
// multiple source lines collapse onto a single visual row and overflow horizontally.
// We force line-spans to display:block and ensure the body scrolls horizontally so
// long lines don't clip. This is applied via CSS so it survives async Shiki
// highlighting (useEffect-based DOM patches can race with it).
// Bump this version suffix whenever the injected CSS below changes so that
// Vite HMR re-injects a fresh <style> tag instead of short-circuiting on the
// stale one left behind from a previous build.
const CODE_LAYOUT_STYLE_VERSION = 'v6'
const CODE_LAYOUT_STYLE_ID = `shared-streamdown-code-layout-${CODE_LAYOUT_STYLE_VERSION}`

export function ensureCodeBlockLayoutStyles(): void {
  if (document.getElementById(CODE_LAYOUT_STYLE_ID)) return
  // Tear down any older versions so their outdated rules stop applying.
  document.querySelectorAll('style[id^="shared-streamdown-code-layout"]').forEach(node => {
    if (node.id !== CODE_LAYOUT_STYLE_ID) node.remove()
  })
  const style = document.createElement('style')
  style.id = CODE_LAYOUT_STYLE_ID
  // Font size is CSS-based so it survives Shiki's async DOM replacement (which
  // happens after usePatchCodeBlocks' useEffect runs and wipes inline styles).
  style.textContent = `
    /* Outer code-block: kill streamdown's intrinsic-size placeholder that
       leaves a huge empty gap before async Shiki layout finishes. We use a
       plain block (NOT flex) because flex column layout was reserving empty
       space above the code body — likely a streamdown-default min-height on
       one of the children that participated in flex sizing. Block layout
       sidesteps the issue entirely. */
    [data-streamdown="code-block"] {
      display: block !important;
      content-visibility: visible !important;
      contain-intrinsic-size: auto !important;
      contain: none !important;
      min-height: 0 !important;
      height: auto !important;
      margin: 6px 0 !important;
      border-radius: 6px !important;
    }
    /* Inner body: flatten streamdown's default rounded border, tighten padding,
       and force a small monospace font so we don't get huge Shiki defaults. */
    [data-streamdown="code-block-body"] {
      display: block !important;
      overflow-x: auto !important;
      border: none !important;
      border-radius: 0 !important;
      min-width: 0;
      min-height: 0 !important;
      height: auto !important;
      padding: 6px 10px !important;
      font-size: 11px !important;
      line-height: 1.45 !important;
    }
    [data-streamdown="code-block-body"] pre {
      white-space: pre !important;
      overflow-x: visible !important;
      margin: 0 !important;
      min-width: 0;
      padding: 0 !important;
      font-size: inherit !important;
      line-height: inherit !important;
    }
    [data-streamdown="code-block-body"] pre > code {
      display: block;
      white-space: pre !important;
      font-size: inherit !important;
      line-height: inherit !important;
    }
    /* Force each line-span onto its own row. Streamdown only adds a block
       className when lineNumbers is enabled; without that, bare spans render
       inline and collapse lines onto a single row. */
    [data-streamdown="code-block-body"] pre > code > span {
      display: block;
      font-size: inherit !important;
      line-height: inherit !important;
    }
    /* Compact header — Shiki's default is oversized. */
    [data-streamdown="code-block-header"] {
      height: 22px !important;
      min-height: 22px !important;
      max-height: 22px !important;
      font-size: 10px !important;
      padding: 0 8px !important;
      line-height: 22px !important;
      display: flex !important;
      align-items: center !important;
      box-sizing: border-box !important;
    }
    /* Pin the copy/actions cluster to the top-right corner of the block so
       it shares the header row regardless of where streamdown places it in
       the sibling tree. The previous negative-margin overlay trick broke
       whenever the actions wrapper wasn't a direct sibling of the header,
       leaving a tall empty band above the code. */
    [data-streamdown="code-block"] {
      position: relative !important;
    }
    [data-streamdown="code-block-actions"] {
      position: absolute !important;
      top: 0 !important;
      right: 0 !important;
      height: 22px !important;
      display: flex !important;
      align-items: center !important;
      padding: 0 4px !important;
      margin: 0 !important;
      z-index: 5 !important;
      background: transparent !important;
    }
    [data-streamdown="code-block-actions"] button {
      width: 18px !important;
      height: 18px !important;
      padding: 1px !important;
      display: inline-flex !important;
      align-items: center !important;
      justify-content: center !important;
    }
    /* Kill any wrapper a future streamdown version might put around the
       actions cluster so it can't add extra vertical height of its own. */
    [data-streamdown="code-block"] > div:has(> [data-streamdown="code-block-actions"]) {
      position: static !important;
      height: 0 !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
    }
  `
  document.head.appendChild(style)
}

// --- ShimmerText component ---------------------------------------------------------
export function ShimmerText({ children, style, baseColor = '#888' }: {
  children: React.ReactNode
  style?: React.CSSProperties
  baseColor?: string
}): JSX.Element {
  return (
    <span style={{
      display: 'block',
      minWidth: 0,
      flexShrink: 1,
      color: 'transparent',
      backgroundImage: `linear-gradient(90deg, ${baseColor} 0%, ${baseColor} 35%, #fff 50%, ${baseColor} 65%, ${baseColor} 100%)`,
      backgroundSize: '200% 100%',
      backgroundClip: 'text',
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      animation: 'chat-shimmer 1.8s linear infinite',
      ...style,
    }}>
      {children}
    </span>
  )
}

// --- WorkingDots component ---------------------------------------------------------
export function WorkingDots({ color, size = 5 }: { color?: string; size?: number }): JSX.Element {
  const theme = useTheme()
  return (
    <span style={{ display: 'inline-flex', gap: 3, padding: '2px 0' }}>
      {[0, 1, 2].map(i => (
        <span
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: '50%',
            background: color ?? theme.accent.base,
          }}
        />
      ))}
    </span>
  )
}

// --- usePatchCodeBlocks hook -------------------------------------------------------
// Patches Streamdown-rendered code blocks and tables with theme-aware styles.
export function usePatchCodeBlocks(
  ref: React.RefObject<HTMLDivElement | null>,
  theme: ReturnType<typeof useTheme>,
  fonts: ReturnType<typeof useAppFonts>,
): void {
  const tokens = useThemeTokens()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const { shellBackground, bodyBackground, headerBackground, headerColor } = tokens.code
    const { shellBackground: tableShellBackground, innerBackground: tableInnerBackground, headerBackground: tableHeaderBackground } = tokens.table
    // Keep JS path matching the CSS rules in ensureCodeBlockLayoutStyles so
    // both paths converge on the same compact rendering.
    const fontSize = 11

    // Code blocks
    const blocks = el.querySelectorAll<HTMLElement>('[data-streamdown="code-block"]')
    blocks.forEach(block => {
      // `position:relative` is critical — the actions cluster is pinned
      // absolutely against this box, so we establish the containing block
      // here and keep `overflow:hidden` to clip to the rounded corners.
      block.style.cssText = `display:block!important;position:relative!important;padding:0!important;gap:0!important;margin:6px 0!important;border-radius:6px!important;overflow:hidden!important;border:1px solid ${theme.border.default}!important;max-width:100%!important;min-height:0!important;height:auto!important;contain:none!important;background:${shellBackground}!important;color:${theme.text.primary}!important`
      const header = block.querySelector<HTMLElement>('[data-streamdown="code-block-header"]')
      if (header) {
        // Reserve space on the right so the language label doesn't collide
        // with the absolutely-positioned actions cluster (~56px covers a
        // typical copy + expand button pair).
        header.style.cssText = `height:22px!important;min-height:22px!important;max-height:22px!important;font-size:10px!important;padding:0 60px 0 8px!important;background:${headerBackground}!important;color:${headerColor}!important;border-bottom:1px solid ${theme.border.subtle}!important;display:flex!important;align-items:center!important;box-sizing:border-box!important`
      }
      // Flatten any wrapper streamdown puts around the actions cluster so
      // it can't inject its own vertical height above the code body.
      const actionsWrapper = block.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]')?.parentElement
      if (actionsWrapper && actionsWrapper !== block) {
        actionsWrapper.style.cssText = 'position:static!important;height:0!important;min-height:0!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important'
      }
      const actions = block.querySelector<HTMLElement>('[data-streamdown="code-block-actions"]')
      if (actions) {
        // Pin to the top-right of the block so the copy button always
        // shares the header row with the language label.
        actions.style.cssText = 'position:absolute!important;top:0!important;right:0!important;height:22px!important;display:flex!important;align-items:center!important;padding:0 4px!important;margin:0!important;z-index:5;background:transparent!important;pointer-events:auto'
        actions.querySelectorAll<HTMLElement>('button').forEach(btn => {
          btn.style.cssText = 'width:18px!important;height:18px!important;padding:1px!important;display:inline-flex!important;align-items:center!important;justify-content:center!important'
        })
        actions.querySelectorAll<SVGElement>('svg').forEach(svg => {
          svg.setAttribute('width', '11')
          svg.setAttribute('height', '11')
        })
      }
      const body = block.querySelector<HTMLElement>('[data-streamdown="code-block-body"]')
      if (body) {
        body.style.cssText = `display:block!important;padding:6px 10px!important;font-size:${fontSize}px!important;line-height:1.45!important;border:none!important;border-radius:0!important;min-height:0!important;height:auto!important;background:${bodyBackground}!important;color:${theme.text.primary}!important`
      }
      block.querySelectorAll<HTMLElement>('pre').forEach(pre => {
        pre.style.cssText += `;font-size:${fontSize}px!important;line-height:1.45!important;margin:0!important;padding:0!important;border-radius:0!important;white-space:pre!important;background:${bodyBackground}!important;color:${theme.text.primary}!important`
      })
      block.querySelectorAll<HTMLElement>('pre > code').forEach(codeEl => {
        codeEl.style.cssText += `;font-size:${fontSize}px!important;line-height:1.45!important;color:${theme.text.primary}!important;background:transparent!important`
        codeEl.querySelectorAll<HTMLElement>(':scope > span').forEach(line => {
          line.style.display = 'block'
        })
      })
      block.querySelectorAll<HTMLElement>('button').forEach(button => {
        button.style.color = headerColor
      })
    })

    // Tables
    const tables = el.querySelectorAll<HTMLElement>('[data-streamdown="table-wrapper"]')
    tables.forEach(wrapper => {
      wrapper.style.cssText = `margin:8px 0!important;padding:0!important;gap:0!important;border-radius:8px!important;overflow:hidden!important;border:none!important;background:transparent!important;color:${theme.text.primary}!important`

      const scroller = wrapper.querySelector<HTMLElement>('[data-streamdown="table"]')?.parentElement
      if (scroller) {
        scroller.style.cssText = `border:1px solid ${theme.border.subtle}!important;border-radius:8px!important;overflow:auto!important;background:${tableInnerBackground}!important`
      }

      const table = wrapper.querySelector<HTMLElement>('[data-streamdown="table"]')
      if (table) {
        table.style.cssText = `width:100%!important;border-collapse:collapse!important;background:${tableInnerBackground}!important;color:${theme.text.primary}!important`
      }

      const thead = wrapper.querySelector<HTMLElement>('[data-streamdown="table-header"]')
      if (thead) {
        thead.style.cssText = `background:${tableHeaderBackground}!important;color:${theme.text.primary}!important`
      }

      wrapper.querySelectorAll<HTMLElement>('[data-streamdown="table-row"]').forEach(row => {
        row.style.borderColor = theme.border.subtle
      })
      wrapper.querySelectorAll<HTMLElement>('[data-streamdown="table-header-cell"]').forEach(cell => {
        cell.style.cssText = `background:${tableHeaderBackground}!important;color:${theme.text.primary}!important;border:1px solid ${theme.border.subtle}!important;padding:8px 10px!important`
      })
      wrapper.querySelectorAll<HTMLElement>('[data-streamdown="table-cell"]').forEach(cell => {
        cell.style.cssText = `background:${tableInnerBackground}!important;color:${theme.text.primary}!important;border:1px solid ${theme.border.subtle}!important;padding:8px 10px!important`
      })
    })
  }, [fonts.size, ref, theme.border.default, theme.border.subtle, theme.text.primary, tokens])
}

// --- useLinkClickHandler hook ------------------------------------------------------
// Intercepts anchor clicks inside a ref container and routes them through dispatchOpenLink.
export function useLinkClickHandler(ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current
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
  }, [ref])
}

// --- ChatMarkdown component -------------------------------------------------------
// Renders markdown content with Streamdown, applying theme patches for code blocks and tables.
function ChatStreamdown({ text, isStreaming, className }: {
  text: string
  isStreaming?: boolean
  className?: string
}): JSX.Element {
  const tokens = useThemeTokens()
  return (
    <Streamdown
      className={`chat-md ${className ?? ''}`}
      plugins={streamdownPlugins}
      mode={isStreaming ? 'streaming' : 'static'}
      shikiTheme={tokens.shikiTheme}
      controls={{ code: { copy: true, download: false }, table: false, mermaid: false }}
      lineNumbers={false}
    >
      {text}
    </Streamdown>
  )
}

export const ChatMarkdown = React.memo(({ text, isStreaming, className }: {
  text: string
  isStreaming?: boolean
  className?: string
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const theme = useTheme()
  const fonts = useAppFonts()
  useEffect(() => {
    ensureShimmerStyles()
    ensureCodeBlockLayoutStyles()
  }, [])
  usePatchCodeBlocks(ref, theme, fonts)
  useLinkClickHandler(ref)

  return (
    <div
      ref={ref}
      style={{
        minWidth: 0,
        maxWidth: '100%',
        width: '100%',
        overflow: 'hidden',
        ['--chat-link-color' as string]: theme.accent.base,
        ['--chat-link-hover-color' as string]: theme.accent.hover,
      }}
    >
      <ChatStreamdown text={text} isStreaming={isStreaming} className={className} />
    </div>
  )
})
