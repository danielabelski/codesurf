import { shiftLAway } from './colorMath'

export type ThemeMode = 'dark' | 'light'

export interface AppTheme {
  id: string
  label: string
  mode: ThemeMode
  description?: string
  canvas: {
    background: string
    backgroundEffect?: string
    gridSmall: string
    gridLarge: string
    gridGlowSmall: string
    gridGlowLarge: string
  }
  surface: {
    app: string
    sidebarOverlay: string
    sidebar: string
    panel: string
    panelMuted: string
    panelElevated: string
    titlebar: string
    input: string
    hover: string
    selection: string
    selectionBorder: string
    accentSoft: string
  }
  border: {
    subtle: string
    default: string
    strong: string
    accent: string
  }
  text: {
    primary: string
    secondary: string
    muted: string
    disabled: string
    inverse: string
  }
  accent: {
    base: string
    hover: string
    soft: string
  }
  status: {
    success: string
    warning: string
    danger: string
  }
  chat: {
    background: string
    placeholder: string
    input: string
    inputBorder: string
    text: string
    textSecondary: string
    muted: string
    subtle: string
    divider: string
    assistantBubble: string
    assistantBubbleBorder: string
    userBubble: string
    userBubbleBorder: string
    dropdownBackground: string
    dropdownBorder: string
    dropdownActiveBackground: string
    dropdownHoverBackground: string
  }
  terminal: {
    background: string
    foreground: string
    cursor: string
    cursorAccent: string
    selection: string
    black: string
    red: string
    green: string
    yellow: string
    blue: string
    magenta: string
    cyan: string
    white: string
    brightBlack: string
    brightRed: string
    brightGreen: string
    brightYellow: string
    brightBlue: string
    brightMagenta: string
    brightCyan: string
    brightWhite: string
  }
  editor: {
    monacoBase: 'vs-dark' | 'vs'
    background: string
  }
  extension: {
    background: string
    panel: string
    border: string
    text: string
    muted: string
    accent: string
  }
  shadow: {
    panel: string
    modal: string
  }
}

export type EdgeShadowTone = 'subtle' | 'default' | 'strong' | 'accent'

export function getEdgeShadow(theme: Pick<AppTheme, 'mode' | 'accent'>, tone: EdgeShadowTone = 'default'): string {
  if (tone === 'accent') {
    return theme.mode === 'light'
      ? `inset 0 0 0 0.5px color-mix(in srgb, ${theme.accent.base} 38%, white 18%, transparent), 0 0 0 0.5px rgba(0, 0, 0, 0.04)`
      // Dark-mode accent: drop the `white 4%` admixture — at low ambient
      // brightness it shows up as a hard white halo on every accented panel.
      // Anchor the inset purely on the accent so the highlight reads as
      // "this is the active accent" not "this is a glowing outline".
      : `inset 0 0 0 0.5px color-mix(in srgb, ${theme.accent.base} 28%, transparent), 0 0 0 0.5px rgba(0, 0, 0, 0.22)`
  }

  // Light mode keeps its high-alpha "paper edge" highlights — they read as
  // the natural top-of-page lighting on a paper canvas.
  // Dark mode used to mirror this with low-alpha white inset highlights, but
  // those produce a visible white halo around panels in true dark themes
  // (especially on the leftmost column of a mid-tone panel against a darker
  // canvas). Drop the white-inset to a near-imperceptible level and let the
  // outer dark shadow do the elevation work — that's how modern dark UIs
  // separate layers without the "glass on glass" Tahoe look.
  const whiteAlpha = theme.mode === 'light'
    ? tone === 'strong' ? 0.92 : tone === 'subtle' ? 0.68 : 0.82
    : tone === 'strong' ? 0.06 : tone === 'subtle' ? 0.02 : 0.035
  const blackAlpha = theme.mode === 'light'
    ? 0.04
    : tone === 'strong' ? 0.30 : tone === 'subtle' ? 0.16 : 0.22

  // 0.5px hairline reads cleaner on hidpi than a full pixel — at 1px the
  // inset highlight + outer line both grab a full device pixel and the
  // edge feels too declarative. 0.5px gives a sub-pixel rim that still
  // separates the panel from the canvas.
  return `inset 0 0 0 0.5px rgba(255, 255, 255, ${whiteAlpha}), 0 0 0 0.5px rgba(0, 0, 0, ${blackAlpha})`
}

export function stackEdgeShadow(theme: Pick<AppTheme, 'mode' | 'accent'>, shadow?: string, tone: EdgeShadowTone = 'default'): string {
  const edge = getEdgeShadow(theme, tone)
  if (!shadow || shadow === 'none') return edge
  if (shadow.includes('inset 0 0 0 1px rgba(255, 255, 255') || shadow.includes('color-mix(in srgb')) return shadow
  return `${edge}, ${shadow}`
}

/**
 * Apply a global contrast offset to a resolved theme. `factor` is in
 * `[-1, 1]`; positive values increase contrast (surfaces shift away from text,
 * text shifts away from surfaces), negative values compress everything toward
 * mid-grey.
 *
 * What we touch: surface/border/text/chat surface/extension/editor.background
 * lightness. Alpha overlays (e.g. the rgba surface.hover) keep their alpha
 * but shift their colour anchor in the same direction as the matching base
 * surface, so glass-style highlights remain visible at high-contrast
 * extremes.
 *
 * What we do *not* touch: accent.*, status.*, terminal ANSI palette,
 * editor.monacoBase (it's a mode hint, not a colour), shadow strings (they're
 * composed multi-value strings; their alpha-only black components don't
 * benefit from L shifts), shiki theme name. These are deliberately calibrated
 * and shifting them would break syntax-highlight semantics or accent
 * recognisability.
 */
export function applyContrast(theme: AppTheme, factor: number): AppTheme {
  const f = Math.max(-1, Math.min(1, factor || 0))
  if (f === 0) return theme
  const isDark = theme.mode === 'dark'
  // Surfaces push toward 0 in dark mode, toward 1 in light mode.
  // Text pushes the opposite way.
  const surfaceMode: 'darker' | 'lighter' = isDark ? 'darker' : 'lighter'
  const textMode: 'darker' | 'lighter' = isDark ? 'lighter' : 'darker'

  const S = (v: string) => shiftLAway(v, f, surfaceMode)
  const T = (v: string) => shiftLAway(v, f, textMode)
  // Borders sit between surfaces and content; they should track the surface
  // direction but with a stronger pull so they remain visible against
  // higher-contrast surfaces.
  const B = (v: string) => shiftLAway(v, f, textMode)

  return {
    ...theme,
    canvas: {
      ...theme.canvas,
      background: S(theme.canvas.background),
      gridSmall: B(theme.canvas.gridSmall),
      gridLarge: B(theme.canvas.gridLarge),
      // gridGlow* are alpha overlays; leave alpha alone, shift anchor toward text
      gridGlowSmall: T(theme.canvas.gridGlowSmall),
      gridGlowLarge: T(theme.canvas.gridGlowLarge),
    },
    surface: {
      ...theme.surface,
      app: S(theme.surface.app),
      sidebarOverlay: S(theme.surface.sidebarOverlay),
      sidebar: S(theme.surface.sidebar),
      panel: S(theme.surface.panel),
      panelMuted: S(theme.surface.panelMuted),
      panelElevated: S(theme.surface.panelElevated),
      titlebar: S(theme.surface.titlebar),
      input: S(theme.surface.input),
      // hover/selection/accentSoft are alpha-tinted; nudge their anchor but
      // they preserve alpha so glass highlights remain visible at extremes.
      hover: T(theme.surface.hover),
      selection: theme.surface.selection,
      selectionBorder: theme.surface.selectionBorder,
      accentSoft: theme.surface.accentSoft,
    },
    border: {
      ...theme.border,
      subtle: B(theme.border.subtle),
      default: B(theme.border.default),
      strong: B(theme.border.strong),
      // accent border stays anchored to accent.base — don't touch
      accent: theme.border.accent,
    },
    text: {
      ...theme.text,
      primary: T(theme.text.primary),
      secondary: T(theme.text.secondary),
      muted: T(theme.text.muted),
      disabled: T(theme.text.disabled),
      inverse: S(theme.text.inverse),
    },
    chat: {
      ...theme.chat,
      background: S(theme.chat.background),
      placeholder: T(theme.chat.placeholder),
      input: S(theme.chat.input),
      inputBorder: B(theme.chat.inputBorder),
      text: T(theme.chat.text),
      textSecondary: T(theme.chat.textSecondary),
      muted: T(theme.chat.muted),
      subtle: T(theme.chat.subtle),
      divider: B(theme.chat.divider),
      assistantBubble: S(theme.chat.assistantBubble),
      assistantBubbleBorder: B(theme.chat.assistantBubbleBorder),
      userBubble: S(theme.chat.userBubble),
      userBubbleBorder: B(theme.chat.userBubbleBorder),
      dropdownBackground: S(theme.chat.dropdownBackground),
      dropdownBorder: B(theme.chat.dropdownBorder),
      dropdownActiveBackground: S(theme.chat.dropdownActiveBackground),
      dropdownHoverBackground: S(theme.chat.dropdownHoverBackground),
    },
    terminal: {
      ...theme.terminal,
      // Only the surrounding chrome shifts; ANSI palette is sacrosanct.
      background: S(theme.terminal.background),
      foreground: T(theme.terminal.foreground),
      cursorAccent: S(theme.terminal.cursorAccent),
    },
    editor: {
      ...theme.editor,
      background: S(theme.editor.background),
    },
    extension: {
      ...theme.extension,
      background: S(theme.extension.background),
      panel: S(theme.extension.panel),
      border: B(theme.extension.border),
      text: T(theme.extension.text),
      muted: T(theme.extension.muted),
      // accent stays anchored
    },
    // shadows are mostly black with alpha — leave them; the L shift on
    // surfaces underneath them changes the perceived shadow weight naturally.
  }
}

/**
 * Default ANSI terminal palette for dark themes. Keeps cross-theme colour
 * recognition (red errors stay red, green diff-add stays green) while letting
 * the surrounding chrome shift per theme. Individual themes can override
 * any subset via `defineTheme({ terminal: {...} })`.
 */
const DEFAULT_DARK_ANSI: Pick<AppTheme['terminal'],
  'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' |
  'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' |
  'brightMagenta' | 'brightCyan' | 'brightWhite'
> = {
  red: '#ff7b72',
  green: '#56c288',
  yellow: '#d8b66a',
  blue: '#7aa2ff',
  magenta: '#c792ea',
  cyan: '#64d2ff',
  white: '#d8dde6',
  brightBlack: '#6e7682',
  brightRed: '#ff9b95',
  brightGreen: '#79d8a0',
  brightYellow: '#e5c47f',
  brightBlue: '#9cbcff',
  brightMagenta: '#d8abff',
  brightCyan: '#8adfff',
  brightWhite: '#ffffff',
}

const DEFAULT_LIGHT_ANSI: Pick<AppTheme['terminal'],
  'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' |
  'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' |
  'brightMagenta' | 'brightCyan' | 'brightWhite'
> = {
  red: '#c5302a',
  green: '#247c3f',
  yellow: '#9a6b00',
  blue: '#1c5fcc',
  magenta: '#9d3ea6',
  cyan: '#0e7c7b',
  white: '#1d2330',
  brightBlack: '#586374',
  brightRed: '#d83a32',
  brightGreen: '#2e9450',
  brightYellow: '#b88200',
  brightBlue: '#316fda',
  brightMagenta: '#b34ec0',
  brightCyan: '#1a8e8c',
  brightWhite: '#0d1117',
}

interface ThemeSpec {
  id: string
  label: string
  mode: ThemeMode
  description?: string
  /** Canvas + grid palette. */
  canvas: {
    background: string
    gridSmall: string
    gridLarge: string
  }
  /** Surface tiers, ordered from outermost to innermost. */
  surface: {
    app: string
    sidebar: string
    panel: string
    panelMuted: string
    panelElevated: string
    titlebar: string
    input: string
  }
  /** Text tiers. `inverse` defaults to opposite-mode neutral. */
  text: {
    primary: string
    secondary: string
    muted: string
    disabled: string
    inverse?: string
  }
  /** Accent colour (e.g. `#7aa2ff`) plus its `r,g,b` triple as a string. */
  accent: { base: string; hover: string; rgb: string }
  /** Status colours. Defaults match `default-dark` / `paper-light`. */
  status?: { success: string; warning: string; danger: string }
  /** Chat surfaces. */
  chat: {
    background: string
    placeholder: string
    input: string
    inputBorder: string
    assistantBubble: string
    userBubble: string
    userBubbleBorder: string
    dropdownBackground: string
    dropdownBorder: string
    dropdownHover: string
  }
  /** Optional ANSI overrides; defaults to mode-appropriate ANSI palette. */
  terminalAnsi?: Partial<typeof DEFAULT_DARK_ANSI>
  /** Border alphas. Defaults provided. */
  border?: { subtle: string; default: string; strong: string }
  /** Drop-shadow rgba for panel + modal. */
  shadow?: { panel: string; modal: string }
}

/**
 * Synthesize a full `AppTheme` from a tighter spec. Reduces the per-theme
 * boilerplate from ~110 lines to ~30 while still letting each theme tune
 * any field that needs hand-attention.
 *
 * Conventions:
 *   - `surface.hover/selection/selectionBorder/accentSoft` derive from accent.
 *   - `border.accent` derives from accent.
 *   - `text.inverse` defaults to a near-pure-opposite neutral.
 *   - Terminal ANSI defaults to a generic mode-appropriate palette unless
 *     overridden via `terminalAnsi`.
 *   - Editor monaco base derives from mode.
 */
function defineTheme(spec: ThemeSpec): AppTheme {
  const isDark = spec.mode === 'dark'
  const accentRgb = spec.accent.rgb
  const status = spec.status ?? (isDark
    ? { success: '#56c288', warning: '#ffbf5f', danger: '#ff7b72' }
    : { success: '#1f8f5f', warning: '#c07b12', danger: '#d14a4a' })
  const border = spec.border ?? (isDark
    ? { subtle: 'rgba(255,255,255,0.09)', default: 'rgba(255,255,255,0.20)', strong: 'rgba(255,255,255,0.30)' }
    : { subtle: 'rgba(15,23,42,0.06)', default: 'rgba(15,23,42,0.12)', strong: 'rgba(15,23,42,0.20)' })
  const shadow = spec.shadow ?? (isDark
    ? { panel: 'rgba(0,0,0,0.42)', modal: 'rgba(0,0,0,0.62)' }
    : { panel: 'rgba(20,30,50,0.10)', modal: 'rgba(20,30,50,0.16)' })
  const ansiBase = isDark ? DEFAULT_DARK_ANSI : DEFAULT_LIGHT_ANSI
  const ansi = { ...ansiBase, ...(spec.terminalAnsi ?? {}) }

  return {
    id: spec.id,
    label: spec.label,
    mode: spec.mode,
    description: spec.description,
    canvas: {
      background: spec.canvas.background,
      backgroundEffect: '',
      gridSmall: spec.canvas.gridSmall,
      gridLarge: spec.canvas.gridLarge,
      gridGlowSmall: isDark ? 'rgba(255,255,255,0.50)' : 'rgba(15,23,42,0.12)',
      gridGlowLarge: isDark ? 'rgba(255,255,255,0.65)' : 'rgba(15,23,42,0.18)',
    },
    surface: {
      app: spec.surface.app,
      sidebarOverlay: isDark
        ? `rgba(${hexToRgb(spec.surface.sidebar)},0.88)`
        : `rgba(${hexToRgb(spec.surface.sidebar)},0.92)`,
      sidebar: spec.surface.sidebar,
      panel: spec.surface.panel,
      panelMuted: spec.surface.panelMuted,
      panelElevated: spec.surface.panelElevated,
      titlebar: spec.surface.titlebar,
      input: spec.surface.input,
      hover: isDark ? `rgba(${accentRgb},0.06)` : `rgba(${accentRgb},0.10)`,
      selection: `rgba(${accentRgb},${isDark ? 0.14 : 0.18})`,
      selectionBorder: `rgba(${accentRgb},${isDark ? 0.28 : 0.34})`,
      accentSoft: `rgba(${accentRgb},${isDark ? 0.16 : 0.20})`,
    },
    border: {
      ...border,
      accent: `rgba(${accentRgb},0.5)`,
    },
    text: {
      primary: spec.text.primary,
      secondary: spec.text.secondary,
      muted: spec.text.muted,
      disabled: spec.text.disabled,
      inverse: spec.text.inverse ?? (isDark ? '#f5f7fa' : '#0f1116'),
    },
    accent: {
      base: spec.accent.base,
      hover: spec.accent.hover,
      soft: `rgba(${accentRgb},${isDark ? 0.16 : 0.20})`,
    },
    status,
    chat: {
      background: spec.chat.background,
      placeholder: spec.chat.placeholder,
      input: spec.chat.input,
      inputBorder: spec.chat.inputBorder,
      text: spec.text.primary,
      textSecondary: spec.text.secondary,
      muted: spec.text.muted,
      subtle: spec.text.disabled,
      divider: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.08)',
      assistantBubble: spec.chat.assistantBubble,
      assistantBubbleBorder: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.07)',
      userBubble: spec.chat.userBubble,
      userBubbleBorder: spec.chat.userBubbleBorder,
      dropdownBackground: spec.chat.dropdownBackground,
      dropdownBorder: spec.chat.dropdownBorder,
      dropdownActiveBackground: spec.chat.dropdownHover,
      dropdownHoverBackground: spec.chat.dropdownHover,
    },
    terminal: {
      background: spec.surface.panel,
      foreground: spec.text.primary,
      cursor: spec.text.secondary,
      cursorAccent: spec.surface.panel,
      selection: `rgba(${accentRgb},${isDark ? 0.25 : 0.22})`,
      black: isDark ? spec.canvas.background : spec.surface.app,
      ...ansi,
    },
    editor: {
      monacoBase: isDark ? 'vs-dark' : 'vs',
      background: spec.surface.panel,
    },
    extension: {
      background: spec.surface.panel,
      panel: spec.surface.panelElevated,
      border: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(15,23,42,0.14)',
      text: spec.text.primary,
      muted: spec.text.muted,
      accent: spec.accent.base,
    },
    shadow: {
      panel: `0 10px 36px ${shadow.panel}`,
      modal: `0 32px 80px ${shadow.modal}`,
    },
  }
}

/** Helper: convert `#rrggbb` → `r,g,b` triple string for `rgba()` composition.
 *  Falls back gracefully for shorthand or invalid input. */
function hexToRgb(hex: string): string {
  const m6 = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (m6) return `${parseInt(m6[1], 16)},${parseInt(m6[2], 16)},${parseInt(m6[3], 16)}`
  const m3 = hex.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (m3) return `${parseInt(m3[1] + m3[1], 16)},${parseInt(m3[2] + m3[2], 16)},${parseInt(m3[3] + m3[3], 16)}`
  return '0,0,0'
}

function normalizePanelSurfaceTheme(theme: AppTheme): AppTheme {
  const panelBackground = theme.surface.panel
  return {
    ...theme,
    terminal: {
      ...theme.terminal,
      background: panelBackground,
      cursorAccent: panelBackground,
    },
    editor: {
      ...theme.editor,
      background: panelBackground,
    },
    extension: {
      ...theme.extension,
      background: panelBackground,
    },
    chat: {
      ...theme.chat,
      userBubble: theme.chat.assistantBubble,
      userBubbleBorder: theme.chat.assistantBubbleBorder,
    },
    shadow: {
      ...theme.shadow,
      panel: stackEdgeShadow(theme, theme.shadow.panel),
      modal: stackEdgeShadow(theme, theme.shadow.modal, 'strong'),
    },
  }
}

const THEMES: Record<string, AppTheme> = {
  'default-dark': {
    id: 'default-dark',
    label: 'Default Dark',
    mode: 'dark',
    description: 'Matches the darker Settings + Chat baseline.',
    canvas: {
      background: '#15171a',
      backgroundEffect: '',
      gridSmall: '#2a2e35',
      gridLarge: '#3a3f48',
      gridGlowSmall: 'rgba(255,255,255,0.58)',
      gridGlowLarge: 'rgba(255,255,255,0.72)',
    },
    surface: {
      app: '#101114',
      sidebarOverlay: 'rgba(14,15,18,0.88)',
      sidebar: '#101216',
      panel: '#111317',
      panelMuted: '#171a1f',
      panelElevated: '#1a1d23',
      titlebar: '#1b1e24',
      input: '#15181d',
      hover: 'rgba(255,255,255,0.05)',
      selection: 'rgba(122,162,255,0.12)',
      selectionBorder: 'rgba(122,162,255,0.24)',
      accentSoft: 'rgba(122,162,255,0.16)',
    },
    border: {
      subtle: 'rgba(255,255,255,0.09)',
      default: 'rgba(255,255,255,0.20)',
      strong: 'rgba(255,255,255,0.30)',
      accent: 'rgba(122,162,255,0.5)',
    },
    text: {
      primary: '#e7eaf0',
      secondary: '#c3cad6',
      muted: '#88909c',
      disabled: '#5b626e',
      inverse: '#0f1012',
    },
    accent: {
      base: '#7aa2ff',
      hover: '#94b6ff',
      soft: 'rgba(122,162,255,0.16)',
    },
    status: {
      success: '#56c288',
      warning: '#ffbf5f',
      danger: '#ff7b72',
    },
    chat: {
      background: '#0d0f12',
      placeholder: '#626a77',
      input: '#1a1d22',
      inputBorder: '#2a2d33',
      text: '#e7eaf0',
      textSecondary: '#c3cad6',
      muted: '#88909c',
      subtle: '#5b626e',
      divider: 'rgba(255,255,255,0.08)',
      assistantBubble: '#171a1f',
      assistantBubbleBorder: 'rgba(255,255,255,0.07)',
      userBubble: '#152638',
      userBubbleBorder: '#22405f',
      dropdownBackground: '#17171b',
      dropdownBorder: '#2f2f37',
      dropdownActiveBackground: '#26262c',
      dropdownHoverBackground: '#202026',
    },
    terminal: {
      background: '#0d0f12',
      foreground: '#d8dde6',
      cursor: '#d4d9e2',
      cursorAccent: '#0d0f12',
      selection: 'rgba(122,162,255,0.25)',
      black: '#0d0f12',
      red: '#ff7b72',
      green: '#56c288',
      yellow: '#d8b66a',
      blue: '#7aa2ff',
      magenta: '#c792ea',
      cyan: '#64d2ff',
      white: '#d8dde6',
      brightBlack: '#6e7682',
      brightRed: '#ff9b95',
      brightGreen: '#79d8a0',
      brightYellow: '#e5c47f',
      brightBlue: '#9cbcff',
      brightMagenta: '#d8abff',
      brightCyan: '#8adfff',
      brightWhite: '#ffffff',
    },
    editor: {
      monacoBase: 'vs-dark',
      background: '#111317',
    },
    extension: {
      background: '#111317',
      panel: '#1b1e24',
      border: 'rgba(255,255,255,0.18)',
      text: '#e7eaf0',
      muted: '#88909c',
      accent: '#7aa2ff',
    },
    shadow: {
      panel: '0 10px 36px rgba(0,0,0,0.42)',
      modal: '0 32px 80px rgba(0,0,0,0.62)',
    },
  },
  // ─────────────────────────────────────────────────────────────
  // New theme — sampled from user-supplied reference screenshot.
  // Palette is warm monochrome (R=G, B slightly lower) and INVERTS the
  // usual hierarchy: sidebar is the darkest layer, content floats above it.
  // Four decisions below are marked TODO(YOU) — they shape the theme's identity.
  // ─────────────────────────────────────────────────────────────
  'warm-graphite': {
    // TODO(YOU) #1 — Naming. Rename `id` + `label` to something that matches
    // your mental model. Must be lowercase-kebab for id. Examples:
    //   'basalt' / 'Basalt',  'ember-dark' / 'Ember Dark',  'kiln' / 'Kiln'
    id: 'warm-graphite',
    label: 'Warm Graphite',
    mode: 'dark',
    description: 'Warm monochrome — compressed luma range, no true black.',
    canvas: {
      // Ref image: 99% of pixels L=32..56. Floor at the observed darkest (#262625).
      background: '#262625',
      backgroundEffect: '',
      gridSmall: '#2d2d2b',
      gridLarge: '#373735',
      gridGlowSmall: 'rgba(255,250,240,0.40)',
      gridGlowLarge: 'rgba(255,250,240,0.55)',
    },
    surface: {
      // Flush with canvas — preserves the no-black aesthetic with no resize flash.
      app: '#262625',
      sidebarOverlay: 'rgba(20,20,19,0.88)',
      sidebar: '#262625',       // sampled: darkest chrome
      panel: '#2d2d2b',         // sampled: base panel / bubbles
      panelMuted: '#262625',
      panelElevated: '#373735', // sampled: lifted surface
      titlebar: '#262625',
      input: '#3d3d3b',         // sampled: input bar
      hover: 'rgba(255,250,240,0.05)',
      selection: 'rgba(255,250,240,0.085)',
      selectionBorder: 'rgba(255,250,240,0.14)',
      accentSoft: 'rgba(212,165,116,0.16)',
    },
    border: {
      subtle: 'rgba(255,250,240,0.06)',
      default: 'rgba(255,250,240,0.12)',
      strong: 'rgba(255,250,240,0.22)',
      accent: 'rgba(212,165,116,0.5)',
    },
    text: {
      // TODO(YOU) #2 — Text tint. Pick ONE line (delete the others):
      //   primary: '#e8e6e1',  // warm off-white — matches the palette warmth
      //   primary: '#e7eaf0',  // neutral-cool — sharper, more "IDE"
      //   primary: '#ede6d8',  // strongly warm — almost parchment
      primary: '#f4f2ec',
      secondary: '#ddd9cf',
      muted: '#a6a095',
      disabled: '#736d63',
      inverse: '#1a1a19',
    },
    accent: {
      // TODO(YOU) #3 — Accent. Screenshot doesn't reveal one; this is
      // a pure design call. Pick ONE trio (delete the others):
      //   amber:  base '#d4a574', hover '#e6b988', soft 'rgba(212,165,116,0.16)'
      //   sage:   base '#9bb68a', hover '#b0ca9f', soft 'rgba(155,182,138,0.16)'
      //   rose:   base '#c78e8e', hover '#dba4a4', soft 'rgba(199,142,142,0.16)'
      //   blue:   base '#7aa2ff', hover '#94b6ff', soft 'rgba(122,162,255,0.16)'
      base: '#d4a574',
      hover: '#e6b988',
      soft: 'rgba(212,165,116,0.16)',
    },
    status: {
      success: '#8fb57a',
      warning: '#e6b85f',
      danger: '#e68a7a',
    },
    chat: {
      background: '#373735', // sampled: chat column background
      placeholder: '#6f6a60',
      input: '#3d3d3b',
      inputBorder: 'rgba(255,250,240,0.08)',
      text: '#f4f2ec',
      textSecondary: '#ddd9cf',
      muted: '#a6a095',
      subtle: '#736d63',
      divider: 'rgba(255,250,240,0.07)',
      // TODO(YOU) #4 — Bubble differentiation. The screenshot shows bubbles
      // at the SAME shade (flat, role shown by alignment only). If you prefer
      // the classic differentiated look, swap the commented values:
      //   assistantBubble: '#2d2d2b',  userBubble: '#3d3d3b'  // flat (screenshot-accurate)
      //   assistantBubble: '#2d2d2b',  userBubble: '#4a3d2c'  // warm-tinted user bubble
      assistantBubble: '#2d2d2b',
      assistantBubbleBorder: 'rgba(255,250,240,0.06)',
      userBubble: '#2d2d2b',
      userBubbleBorder: 'rgba(255,250,240,0.08)',
      dropdownBackground: '#262625',
      dropdownBorder: 'rgba(255,250,240,0.10)',
      dropdownActiveBackground: '#373735',
      dropdownHoverBackground: '#2d2d2b',
    },
    terminal: {
      background: '#2d2d2b',
      foreground: '#f4f2ec',
      cursor: '#d4a574',
      cursorAccent: '#2d2d2b',
      selection: 'rgba(212,165,116,0.25)',
      black: '#262625',
      red: '#e68a7a',
      green: '#8fb57a',
      yellow: '#e6b85f',
      blue: '#7aa2ff',
      magenta: '#c78e8e',
      cyan: '#7fb8b0',
      white: '#ddd9cf',
      brightBlack: '#736d63',
      brightRed: '#ff9b8a',
      brightGreen: '#a3c98e',
      brightYellow: '#ffcc73',
      brightBlue: '#94b6ff',
      brightMagenta: '#dba4a4',
      brightCyan: '#9bd0c6',
      brightWhite: '#f4f2ec',
    },
    editor: {
      monacoBase: 'vs-dark',
      background: '#2d2d2b',
    },
    extension: {
      background: '#2d2d2b',
      panel: '#373735',
      border: 'rgba(255,250,240,0.10)',
      text: '#f4f2ec',
      muted: '#a6a095',
      accent: '#d4a574',
    },
    shadow: {
      panel: '0 10px 36px rgba(0,0,0,0.45)',
      modal: '0 32px 80px rgba(0,0,0,0.65)',
    },
  },
  'graphite-dark': {
    id: 'graphite-dark',
    label: 'Graphite Dark',
    mode: 'dark',
    description: 'Neutral greys with slightly softer contrast.',
    canvas: {
      background: '#171717',
      backgroundEffect: '',
      gridSmall: '#2d2d2d',
      gridLarge: '#3f3f3f',
      gridGlowSmall: 'rgba(255,255,255,0.52)',
      gridGlowLarge: 'rgba(255,255,255,0.64)',
    },
    surface: {
      app: '#121212',
      sidebarOverlay: 'rgba(18,18,18,0.9)',
      sidebar: '#141414',
      panel: '#151515',
      panelMuted: '#1c1c1c',
      panelElevated: '#202020',
      titlebar: '#222222',
      input: '#1a1a1a',
      hover: 'rgba(255,255,255,0.045)',
      selection: 'rgba(143,151,165,0.13)',
      selectionBorder: 'rgba(143,151,165,0.24)',
      accentSoft: 'rgba(143,151,165,0.18)',
    },
    border: {
      subtle: 'rgba(255,255,255,0.09)',
      default: 'rgba(255,255,255,0.20)',
      strong: 'rgba(255,255,255,0.30)',
      accent: 'rgba(143,151,165,0.45)',
    },
    text: {
      primary: '#ededed',
      secondary: '#d5d5d5',
      muted: '#9a9a9a',
      disabled: '#686868',
      inverse: '#121212',
    },
    accent: {
      base: '#8f96a0',
      hover: '#bcc3cc',
      soft: 'rgba(143,151,165,0.18)',
    },
    status: {
      success: '#73c991',
      warning: '#f0d28a',
      danger: '#ff9080',
    },
    chat: {
      background: '#111111',
      placeholder: '#6f6f6f',
      input: '#171717',
      inputBorder: 'rgba(255,255,255,0.08)',
      text: '#ededed',
      textSecondary: '#d5d5d5',
      muted: '#9a9a9a',
      subtle: '#686868',
      divider: 'rgba(255,255,255,0.08)',
      assistantBubble: '#1a1a1a',
      assistantBubbleBorder: 'rgba(255,255,255,0.06)',
      userBubble: '#252a30',
      userBubbleBorder: '#353c44',
      dropdownBackground: '#151515',
      dropdownBorder: 'rgba(255,255,255,0.08)',
      dropdownActiveBackground: '#202020',
      dropdownHoverBackground: 'rgba(255,255,255,0.045)',
    },
    terminal: {
      background: '#101010',
      foreground: '#dfdfdf',
      cursor: '#f0f0f0',
      cursorAccent: '#101010',
      selection: 'rgba(143,151,165,0.22)',
      black: '#101010',
      red: '#ff9080',
      green: '#73c991',
      yellow: '#f0d28a',
      blue: '#9bb4d1',
      magenta: '#d1a0ff',
      cyan: '#8ad8f2',
      white: '#dfdfdf',
      brightBlack: '#7d7d7d',
      brightRed: '#ffaea2',
      brightGreen: '#8fdb9a',
      brightYellow: '#f7df9f',
      brightBlue: '#b7d9ff',
      brightMagenta: '#e1b6ff',
      brightCyan: '#a8e6f9',
      brightWhite: '#ffffff',
    },
    editor: {
      monacoBase: 'vs-dark',
      background: '#151515',
    },
    extension: {
      background: '#151515',
      panel: '#202020',
      border: 'rgba(255,255,255,0.18)',
      text: '#ededed',
      muted: '#9a9a9a',
      accent: '#8f96a0',
    },
    shadow: {
      panel: '0 10px 32px rgba(0,0,0,0.42)',
      modal: '0 28px 72px rgba(0,0,0,0.6)',
    },
  },
  'onecode-midnight': {
    id: 'onecode-midnight',
    label: '1Code Midnight',
    mode: 'dark',
    description: 'An imported-style dark preset with cooler indigo chrome.',
    canvas: {
      background: '#12131a',
      backgroundEffect: '',
      gridSmall: '#272a39',
      gridLarge: '#383d52',
      gridGlowSmall: 'rgba(199,207,255,0.56)',
      gridGlowLarge: 'rgba(199,207,255,0.72)',
    },
    surface: {
      app: '#0f1118',
      sidebarOverlay: 'rgba(13,14,21,0.9)',
      sidebar: '#10131c',
      panel: '#111521',
      panelMuted: '#181d2b',
      panelElevated: '#1d2332',
      titlebar: '#202638',
      input: '#151a27',
      hover: 'rgba(199,207,255,0.06)',
      selection: 'rgba(131,139,255,0.16)',
      selectionBorder: 'rgba(131,139,255,0.3)',
      accentSoft: 'rgba(131,139,255,0.18)',
    },
    border: {
      subtle: 'rgba(199,207,255,0.10)',
      default: 'rgba(199,207,255,0.24)',
      strong: 'rgba(199,207,255,0.34)',
      accent: 'rgba(131,139,255,0.5)',
    },
    text: {
      primary: '#edf1ff',
      secondary: '#d4daef',
      muted: '#8a93b3',
      disabled: '#5f6680',
      inverse: '#0f1118',
    },
    accent: {
      base: '#838bff',
      hover: '#a4abff',
      soft: 'rgba(131,139,255,0.18)',
    },
    status: {
      success: '#66d9a3',
      warning: '#f5c97a',
      danger: '#ff8a8a',
    },
    chat: {
      background: '#0d1017',
      placeholder: '#6e7899',
      input: '#131824',
      inputBorder: 'rgba(199,207,255,0.1)',
      text: '#edf1ff',
      textSecondary: '#d4daef',
      muted: '#8a93b3',
      subtle: '#5f6680',
      divider: 'rgba(199,207,255,0.1)',
      assistantBubble: '#171c28',
      assistantBubbleBorder: 'rgba(199,207,255,0.08)',
      userBubble: '#25245a',
      userBubbleBorder: '#3c4191',
      dropdownBackground: '#111521',
      dropdownBorder: 'rgba(199,207,255,0.1)',
      dropdownActiveBackground: '#1d2332',
      dropdownHoverBackground: 'rgba(199,207,255,0.06)',
    },
    terminal: {
      background: '#0d111b',
      foreground: '#dce3ff',
      cursor: '#c9d0ff',
      cursorAccent: '#0d111b',
      selection: 'rgba(131,139,255,0.24)',
      black: '#0d111b',
      red: '#ff8a8a',
      green: '#66d9a3',
      yellow: '#f5c97a',
      blue: '#8ba4ff',
      magenta: '#d8a8ff',
      cyan: '#7adcf0',
      white: '#dce3ff',
      brightBlack: '#6e7899',
      brightRed: '#ffaaa5',
      brightGreen: '#86e9ba',
      brightYellow: '#ffd694',
      brightBlue: '#a7bbff',
      brightMagenta: '#e6c0ff',
      brightCyan: '#9ae8ff',
      brightWhite: '#ffffff',
    },
    editor: {
      monacoBase: 'vs-dark',
      background: '#111521',
    },
    extension: {
      background: '#111521',
      panel: '#202638',
      border: 'rgba(199,207,255,0.22)',
      text: '#edf1ff',
      muted: '#8a93b3',
      accent: '#838bff',
    },
    shadow: {
      panel: '0 10px 36px rgba(4,6,12,0.48)',
      modal: '0 30px 80px rgba(4,6,12,0.68)',
    },
  },
  'runext-shell': {
    id: 'runext-shell',
    label: 'Runext Shell',
    mode: 'dark',
    description: 'Matches the runext app chrome with the warm amber accent, glass panels, and vignette backdrop.',
    canvas: {
      background: '#111111',
      backgroundEffect:
        'radial-gradient(circle at top right, rgba(184, 119, 79, 0.16), transparent 28%), radial-gradient(circle at top left, rgba(255, 255, 255, 0.05), transparent 22%), linear-gradient(180deg, #131313 0%, #0f0f0f 100%)',
      gridSmall: 'rgba(243,241,234,0.06)',
      gridLarge: 'rgba(184,119,79,0.12)',
      gridGlowSmall: 'rgba(243,241,234,0.3)',
      gridGlowLarge: 'rgba(184,119,79,0.28)',
    },
    surface: {
      app: 'radial-gradient(circle at top right, rgba(184, 119, 79, 0.16), transparent 28%), radial-gradient(circle at top left, rgba(255, 255, 255, 0.05), transparent 22%), linear-gradient(180deg, #131313 0%, #0f0f0f 100%)',
      sidebarOverlay: 'rgba(25,25,25,0.92)',
      sidebar: '#1d1d1d',
      panel: '#1d1d1d',
      panelMuted: '#232323',
      panelElevated: '#2b2b2b',
      titlebar: 'rgba(24,24,24,0.88)',
      input: '#1f1f1f',
      hover: 'rgba(255,255,255,0.06)',
      selection: 'rgba(184,119,79,0.18)',
      selectionBorder: 'rgba(209,145,101,0.28)',
      accentSoft: 'rgba(184,119,79,0.18)',
    },
    border: {
      subtle: 'rgba(255,255,255,0.09)',
      default: 'rgba(255,255,255,0.20)',
      strong: 'rgba(255,255,255,0.30)',
      accent: 'rgba(209,145,101,0.55)',
    },
    text: {
      primary: '#f3f1ea',
      secondary: 'rgba(243,241,234,0.68)',
      muted: 'rgba(243,241,234,0.42)',
      disabled: 'rgba(243,241,234,0.3)',
      inverse: '#17120f',
    },
    accent: {
      base: '#b8774f',
      hover: '#d19165',
      soft: 'rgba(184,119,79,0.18)',
    },
    status: {
      success: '#8fcf9a',
      warning: '#d19165',
      danger: '#df7a72',
    },
    chat: {
      background: '#141414',
      placeholder: '#7f7970',
      input: '#1f1f1f',
      inputBorder: '#343434',
      text: '#f3f1ea',
      textSecondary: '#b4aea5',
      muted: '#7f7970',
      subtle: 'rgba(243,241,234,0.42)',
      divider: '#353535',
      assistantBubble: '#1d1d1d',
      assistantBubbleBorder: '#353535',
      userBubble: 'rgba(184,119,79,0.18)',
      userBubbleBorder: 'rgba(209,145,101,0.4)',
      dropdownBackground: 'rgba(25,25,25,0.92)',
      dropdownBorder: '#353535',
      dropdownActiveBackground: '#2b2b2b',
      dropdownHoverBackground: '#222222',
    },
    terminal: {
      background: '#141414',
      foreground: '#f3f1ea',
      cursor: '#f3f1ea',
      cursorAccent: '#141414',
      selection: 'rgba(184,119,79,0.18)',
      black: '#111111',
      red: '#df7a72',
      green: '#8fcf9a',
      yellow: '#d8b06b',
      blue: '#8fb6d8',
      magenta: '#c79ad9',
      cyan: '#87cfc8',
      white: '#f3f1ea',
      brightBlack: '#7f7970',
      brightRed: '#e79a93',
      brightGreen: '#a9d9b1',
      brightYellow: '#e5c490',
      brightBlue: '#abcbe6',
      brightMagenta: '#d7b3e4',
      brightCyan: '#a6ddd7',
      brightWhite: '#ffffff',
    },
    editor: {
      monacoBase: 'vs-dark',
      background: '#141414',
    },
    extension: {
      background: '#141414',
      panel: '#1d1d1d',
      border: '#4a4a4a',
      text: '#f3f1ea',
      muted: '#b4aea5',
      accent: '#b8774f',
    },
    shadow: {
      panel: '0 24px 80px rgba(0,0,0,0.45)',
      modal: '0 28px 96px rgba(0,0,0,0.5)',
    },
  },
  'paper-light': {
    id: 'paper-light',
    label: 'Paper Light',
    mode: 'light',
    description: 'A bright workspace with subtle chrome and cooler borders.',
    canvas: {
      background: '#f3f5f8',
      backgroundEffect: '',
      gridSmall: '#d8dde6',
      gridLarge: '#c5ccd8',
      gridGlowSmall: 'rgba(40,49,66,0.18)',
      gridGlowLarge: 'rgba(40,49,66,0.24)',
    },
    surface: {
      app: '#eef2f7',
      sidebarOverlay: 'rgba(250,252,255,0.92)',
      sidebar: '#fbfcfe',
      panel: '#ffffff',
      panelMuted: '#f5f7fb',
      panelElevated: '#eef2f7',
      titlebar: '#f3f6fb',
      input: '#ffffff',
      hover: 'rgba(31,41,55,0.05)',
      selection: 'rgba(53,104,255,0.1)',
      selectionBorder: 'rgba(53,104,255,0.22)',
      accentSoft: 'rgba(53,104,255,0.12)',
    },
    border: {
      subtle: 'rgba(15,23,42,0.06)',
      default: 'rgba(15,23,42,0.12)',
      strong: 'rgba(15,23,42,0.18)',
      accent: 'rgba(53,104,255,0.3)',
    },
    text: {
      primary: '#1b2430',
      secondary: '#2d3748',
      muted: '#586676',
      disabled: '#7a8594',
      inverse: '#ffffff',
    },
    accent: {
      base: '#3568ff',
      hover: '#4b79ff',
      soft: 'rgba(53,104,255,0.12)',
    },
    status: {
      success: '#1f8f5f',
      warning: '#c07b12',
      danger: '#d14a4a',
    },
    chat: {
      background: '#ffffff',
      placeholder: '#778395',
      input: '#ffffff',
      inputBorder: 'rgba(15,23,42,0.12)',
      text: '#1b2430',
      textSecondary: '#2d3748',
      muted: '#6f7a8a',
      subtle: '#9aa3b2',
      divider: 'rgba(15,23,42,0.12)',
      assistantBubble: '#f4f6fa',
      assistantBubbleBorder: 'rgba(15,23,42,0.08)',
      userBubble: '#e8f0ff',
      userBubbleBorder: '#bfd0ff',
      dropdownBackground: '#ffffff',
      dropdownBorder: 'rgba(15,23,42,0.12)',
      dropdownActiveBackground: '#eef2f7',
      dropdownHoverBackground: 'rgba(31,41,55,0.05)',
    },
    terminal: {
      background: '#f9fafb',
      foreground: '#1f232a',
      cursor: '#1f232a',
      cursorAccent: '#f9fafb',
      selection: 'rgba(53,104,255,0.18)',
      black: '#1f232a',
      red: '#cf222e',
      green: '#1f883d',
      yellow: '#9a6700',
      blue: '#0969da',
      magenta: '#8250df',
      cyan: '#1b7c83',
      white: '#57606a',
      brightBlack: '#6e7781',
      brightRed: '#e85c63',
      brightGreen: '#2da56b',
      brightYellow: '#b8841b',
      brightBlue: '#3a82f7',
      brightMagenta: '#9c6bff',
      brightCyan: '#2a9aa4',
      brightWhite: '#24292f',
    },
    editor: {
      monacoBase: 'vs',
      background: '#ffffff',
    },
    extension: {
      background: '#ffffff',
      panel: '#f3f6fb',
      border: 'rgba(15,23,42,0.12)',
      text: '#1b2430',
      muted: '#6f7a8a',
      accent: '#3568ff',
    },
    shadow: {
      panel: '0 10px 26px rgba(15,23,42,0.12)',
      modal: '0 28px 64px rgba(15,23,42,0.16)',
    },
  },
  'morph-dark': {
    id: 'morph-dark',
    label: 'Morph',
    mode: 'dark',
    description: 'Deep charcoal with olive-green accents — inspired by morph.so.',
    canvas: {
      background: '#18181c',
      backgroundEffect: '',
      gridSmall: '#26262c',
      gridLarge: '#32323a',
      gridGlowSmall: 'rgba(200,214,78,0.22)',
      gridGlowLarge: 'rgba(200,214,78,0.32)',
    },
    surface: {
      app: '#131316',
      sidebarOverlay: 'rgba(19,19,22,0.92)',
      sidebar: '#151518',
      panel: '#1a1a1e',
      panelMuted: '#1f1f24',
      panelElevated: '#24242a',
      titlebar: '#1e1e23',
      input: '#18181c',
      hover: 'rgba(200,214,78,0.06)',
      selection: 'rgba(200,214,78,0.10)',
      selectionBorder: 'rgba(200,214,78,0.22)',
      accentSoft: 'rgba(200,214,78,0.12)',
    },
    border: {
      subtle: 'rgba(200,214,78,0.10)',
      default: 'rgba(200,214,78,0.24)',
      strong: 'rgba(200,214,78,0.36)',
      accent: 'rgba(200,214,78,0.48)',
    },
    text: {
      primary: '#e8e6e0',
      secondary: '#d4d0c8',
      muted: '#aaa69c',
      disabled: '#6a6760',
      inverse: '#131316',
    },
    accent: {
      base: '#c8d64e',
      hover: '#d8e65e',
      soft: 'rgba(200,214,78,0.12)',
    },
    status: {
      success: '#a0c850',
      warning: '#e8a838',
      danger: '#f06868',
    },
    chat: {
      background: '#151518',
      placeholder: '#6a675e',
      input: '#1e1e23',
      inputBorder: 'rgba(200,214,78,0.12)',
      text: '#e8e6e0',
      textSecondary: '#c4c0b6',
      muted: '#8a877e',
      subtle: '#5e5c56',
      divider: 'rgba(200,214,78,0.08)',
      assistantBubble: '#1f1f24',
      assistantBubbleBorder: 'rgba(200,214,78,0.08)',
      userBubble: '#2a2a1e',
      userBubbleBorder: 'rgba(200,214,78,0.18)',
      dropdownBackground: '#1a1a1e',
      dropdownBorder: 'rgba(200,214,78,0.10)',
      dropdownActiveBackground: '#24242a',
      dropdownHoverBackground: 'rgba(200,214,78,0.06)',
    },
    terminal: {
      background: '#141417',
      foreground: '#dddbd4',
      cursor: '#c8d64e',
      cursorAccent: '#141417',
      selection: 'rgba(200,214,78,0.18)',
      black: '#141417',
      red: '#f06868',
      green: '#a0c850',
      yellow: '#e8a838',
      blue: '#6898d0',
      magenta: '#c080d8',
      cyan: '#58b8b0',
      white: '#dddbd4',
      brightBlack: '#6a675e',
      brightRed: '#f88888',
      brightGreen: '#b8e060',
      brightYellow: '#f0c048',
      brightBlue: '#88b8e8',
      brightMagenta: '#d8a0f0',
      brightCyan: '#78d8d0',
      brightWhite: '#f0eee8',
    },
    editor: {
      monacoBase: 'vs-dark',
      background: '#1a1a1e',
    },
    extension: {
      background: '#1a1a1e',
      panel: '#24242a',
      border: 'rgba(200,214,78,0.24)',
      text: '#e8e6e0',
      muted: '#8a877e',
      accent: '#c8d64e',
    },
    shadow: {
      panel: '0 10px 36px rgba(0,0,0,0.48)',
      modal: '0 32px 80px rgba(0,0,0,0.6)',
    },
  },
  'warm-light': {
    id: 'warm-light',
    label: 'Warm Light',
    mode: 'light',
    description: 'Soft cream tones with warm amber accents — easy on the eyes.',
    canvas: {
      background: '#f5f0ea',
      backgroundEffect: '',
      gridSmall: '#e2dbd2',
      gridLarge: '#d0c8bd',
      gridGlowSmall: 'rgba(162,100,28,0.14)',
      gridGlowLarge: 'rgba(162,100,28,0.20)',
    },
    surface: {
      app: '#f0ebe4',
      sidebarOverlay: 'rgba(245,240,234,0.94)',
      sidebar: '#faf7f2',
      panel: '#fffdf8',
      panelMuted: '#f5f0ea',
      panelElevated: '#eee8e0',
      titlebar: '#f5f0ea',
      input: '#fffdf8',
      hover: 'rgba(120,80,20,0.05)',
      selection: 'rgba(186,120,40,0.10)',
      selectionBorder: 'rgba(186,120,40,0.22)',
      accentSoft: 'rgba(186,120,40,0.10)',
    },
    border: {
      subtle: 'rgba(120,80,20,0.06)',
      default: 'rgba(120,80,20,0.12)',
      strong: 'rgba(120,80,20,0.20)',
      accent: 'rgba(186,120,40,0.30)',
    },
    text: {
      primary: '#2c2418',
      secondary: '#4a3e30',
      muted: '#7a6e5e',
      disabled: '#9a8e7e',
      inverse: '#fffdf8',
    },
    accent: {
      base: '#ba7828',
      hover: '#d08830',
      soft: 'rgba(186,120,40,0.10)',
    },
    status: {
      success: '#3d8c50',
      warning: '#c07b12',
      danger: '#c44040',
    },
    chat: {
      background: '#fffdf8',
      placeholder: '#9a8e7e',
      input: '#fffdf8',
      inputBorder: 'rgba(120,80,20,0.12)',
      text: '#2c2418',
      textSecondary: '#4a3e30',
      muted: '#7a6e5e',
      subtle: '#9a8e7e',
      divider: 'rgba(120,80,20,0.10)',
      assistantBubble: '#f5f0ea',
      assistantBubbleBorder: 'rgba(120,80,20,0.08)',
      userBubble: '#f0e4d0',
      userBubbleBorder: '#dcc8a8',
      dropdownBackground: '#fffdf8',
      dropdownBorder: 'rgba(120,80,20,0.12)',
      dropdownActiveBackground: '#eee8e0',
      dropdownHoverBackground: 'rgba(120,80,20,0.05)',
    },
    terminal: {
      background: '#faf6f0',
      foreground: '#2c2418',
      cursor: '#2c2418',
      cursorAccent: '#faf6f0',
      selection: 'rgba(186,120,40,0.18)',
      black: '#2c2418',
      red: '#c44040',
      green: '#3d8c50',
      yellow: '#a06800',
      blue: '#3568c0',
      magenta: '#8848a0',
      cyan: '#287878',
      white: '#7a6e5e',
      brightBlack: '#9a8e7e',
      brightRed: '#d85050',
      brightGreen: '#4ca860',
      brightYellow: '#b88018',
      brightBlue: '#4878d0',
      brightMagenta: '#a060b8',
      brightCyan: '#389090',
      brightWhite: '#2c2418',
    },
    editor: {
      monacoBase: 'vs',
      background: '#fffdf8',
    },
    extension: {
      background: '#fffdf8',
      panel: '#f5f0ea',
      border: 'rgba(120,80,20,0.12)',
      text: '#2c2418',
      muted: '#7a6e5e',
      accent: '#ba7828',
    },
    shadow: {
      panel: '0 8px 24px rgba(80,50,10,0.08)',
      modal: '0 24px 56px rgba(80,50,10,0.12)',
    },
  },
  'linear-light': {
    id: 'linear-light',
    label: 'Linear Light',
    mode: 'light',
    description: 'Cool blue-grey workspace inspired by modern productivity tools.',
    canvas: {
      background: '#f2f4f8',
      backgroundEffect: '',
      gridSmall: '#d8dce6',
      gridLarge: '#c4cad8',
      gridGlowSmall: 'rgba(80,100,200,0.14)',
      gridGlowLarge: 'rgba(80,100,200,0.20)',
    },
    surface: {
      app: '#edf0f6',
      sidebarOverlay: 'rgba(242,244,248,0.94)',
      sidebar: '#f8f9fc',
      panel: '#ffffff',
      panelMuted: '#f2f4f8',
      panelElevated: '#eaecf2',
      titlebar: '#f2f4f8',
      input: '#ffffff',
      hover: 'rgba(60,80,160,0.04)',
      selection: 'rgba(80,100,200,0.08)',
      selectionBorder: 'rgba(80,100,200,0.20)',
      accentSoft: 'rgba(80,100,200,0.08)',
    },
    border: {
      subtle: 'rgba(20,30,60,0.05)',
      default: 'rgba(20,30,60,0.10)',
      strong: 'rgba(20,30,60,0.16)',
      accent: 'rgba(80,100,200,0.28)',
    },
    text: {
      primary: '#1a1e2e',
      secondary: '#363c50',
      muted: '#6a7088',
      disabled: '#8a90a4',
      inverse: '#ffffff',
    },
    accent: {
      base: '#5064c8',
      hover: '#6478e0',
      soft: 'rgba(80,100,200,0.08)',
    },
    status: {
      success: '#28845c',
      warning: '#c07b12',
      danger: '#d04848',
    },
    chat: {
      background: '#ffffff',
      placeholder: '#8a90a4',
      input: '#ffffff',
      inputBorder: 'rgba(20,30,60,0.10)',
      text: '#1a1e2e',
      textSecondary: '#363c50',
      muted: '#6a7088',
      subtle: '#8a90a4',
      divider: 'rgba(20,30,60,0.08)',
      assistantBubble: '#f2f4f8',
      assistantBubbleBorder: 'rgba(20,30,60,0.06)',
      userBubble: '#e8ecff',
      userBubbleBorder: '#c0c8f0',
      dropdownBackground: '#ffffff',
      dropdownBorder: 'rgba(20,30,60,0.10)',
      dropdownActiveBackground: '#eaecf2',
      dropdownHoverBackground: 'rgba(60,80,160,0.04)',
    },
    terminal: {
      background: '#f8f9fc',
      foreground: '#1a1e2e',
      cursor: '#1a1e2e',
      cursorAccent: '#f8f9fc',
      selection: 'rgba(80,100,200,0.16)',
      black: '#1a1e2e',
      red: '#d04848',
      green: '#28845c',
      yellow: '#9a6800',
      blue: '#3058c0',
      magenta: '#7c40b0',
      cyan: '#1a7888',
      white: '#6a7088',
      brightBlack: '#8a90a4',
      brightRed: '#e06060',
      brightGreen: '#38a070',
      brightYellow: '#b88018',
      brightBlue: '#4070d8',
      brightMagenta: '#9458c8',
      brightCyan: '#2a90a0',
      brightWhite: '#1a1e2e',
    },
    editor: {
      monacoBase: 'vs',
      background: '#ffffff',
    },
    extension: {
      background: '#ffffff',
      panel: '#f2f4f8',
      border: 'rgba(20,30,60,0.10)',
      text: '#1a1e2e',
      muted: '#6a7088',
      accent: '#5064c8',
    },
    shadow: {
      panel: '0 8px 24px rgba(20,30,60,0.08)',
      modal: '0 24px 56px rgba(20,30,60,0.12)',
    },
  },
  'garden-light': {
    id: 'garden-light',
    label: 'Garden',
    mode: 'light',
    description: 'Natural green tones for a calm, focused workspace.',
    canvas: {
      background: '#f0f4f0',
      backgroundEffect: '',
      gridSmall: '#d4dcd4',
      gridLarge: '#bec8be',
      gridGlowSmall: 'rgba(48,96,56,0.14)',
      gridGlowLarge: 'rgba(48,96,56,0.20)',
    },
    surface: {
      app: '#eaf0ea',
      sidebarOverlay: 'rgba(240,244,240,0.94)',
      sidebar: '#f6faf6',
      panel: '#fcfefc',
      panelMuted: '#f0f4f0',
      panelElevated: '#e6ece6',
      titlebar: '#f0f4f0',
      input: '#fcfefc',
      hover: 'rgba(40,80,48,0.04)',
      selection: 'rgba(48,96,56,0.08)',
      selectionBorder: 'rgba(48,96,56,0.20)',
      accentSoft: 'rgba(48,96,56,0.08)',
    },
    border: {
      subtle: 'rgba(20,50,20,0.05)',
      default: 'rgba(20,50,20,0.10)',
      strong: 'rgba(20,50,20,0.16)',
      accent: 'rgba(48,96,56,0.28)',
    },
    text: {
      primary: '#1a2e1c',
      secondary: '#2e4430',
      muted: '#5a7060',
      disabled: '#7e9480',
      inverse: '#fcfefc',
    },
    accent: {
      base: '#306038',
      hover: '#408048',
      soft: 'rgba(48,96,56,0.08)',
    },
    status: {
      success: '#2a7840',
      warning: '#b87818',
      danger: '#c84040',
    },
    chat: {
      background: '#fcfefc',
      placeholder: '#7e9480',
      input: '#fcfefc',
      inputBorder: 'rgba(20,50,20,0.10)',
      text: '#1a2e1c',
      textSecondary: '#2e4430',
      muted: '#5a7060',
      subtle: '#7e9480',
      divider: 'rgba(20,50,20,0.08)',
      assistantBubble: '#f0f4f0',
      assistantBubbleBorder: 'rgba(20,50,20,0.06)',
      userBubble: '#e0f0e4',
      userBubbleBorder: '#b8d4bc',
      dropdownBackground: '#fcfefc',
      dropdownBorder: 'rgba(20,50,20,0.10)',
      dropdownActiveBackground: '#e6ece6',
      dropdownHoverBackground: 'rgba(40,80,48,0.04)',
    },
    terminal: {
      background: '#f6faf6',
      foreground: '#1a2e1c',
      cursor: '#1a2e1c',
      cursorAccent: '#f6faf6',
      selection: 'rgba(48,96,56,0.16)',
      black: '#1a2e1c',
      red: '#c84040',
      green: '#2a7840',
      yellow: '#907000',
      blue: '#2860b0',
      magenta: '#7040a0',
      cyan: '#187068',
      white: '#5a7060',
      brightBlack: '#7e9480',
      brightRed: '#d85858',
      brightGreen: '#389050',
      brightYellow: '#a88818',
      brightBlue: '#3878c8',
      brightMagenta: '#8858b8',
      brightCyan: '#289080',
      brightWhite: '#1a2e1c',
    },
    editor: {
      monacoBase: 'vs',
      background: '#fcfefc',
    },
    extension: {
      background: '#fcfefc',
      panel: '#f0f4f0',
      border: 'rgba(20,50,20,0.10)',
      text: '#1a2e1c',
      muted: '#5a7060',
      accent: '#306038',
    },
    shadow: {
      panel: '0 8px 24px rgba(20,40,20,0.08)',
      modal: '0 24px 56px rgba(20,40,20,0.10)',
    },
  },
  'slate-light': {
    id: 'slate-light',
    label: 'Slate',
    mode: 'light',
    description: 'Neutral grays with a sophisticated, no-nonsense feel.',
    canvas: {
      background: '#eeeeee',
      backgroundEffect: '',
      gridSmall: '#d6d6d6',
      gridLarge: '#c2c2c2',
      gridGlowSmall: 'rgba(60,60,60,0.14)',
      gridGlowLarge: 'rgba(60,60,60,0.20)',
    },
    surface: {
      app: '#e8e8e8',
      sidebarOverlay: 'rgba(238,238,238,0.94)',
      sidebar: '#f5f5f5',
      panel: '#fafafa',
      panelMuted: '#f0f0f0',
      panelElevated: '#e4e4e4',
      titlebar: '#eeeeee',
      input: '#fafafa',
      hover: 'rgba(0,0,0,0.04)',
      selection: 'rgba(90,90,90,0.10)',
      selectionBorder: 'rgba(90,90,90,0.22)',
      accentSoft: 'rgba(90,90,90,0.08)',
    },
    border: {
      subtle: 'rgba(0,0,0,0.06)',
      default: 'rgba(0,0,0,0.12)',
      strong: 'rgba(0,0,0,0.20)',
      accent: 'rgba(90,90,90,0.30)',
    },
    text: {
      primary: '#1a1a1a',
      secondary: '#3a3a3a',
      muted: '#6a6a6a',
      disabled: '#9a9a9a',
      inverse: '#fafafa',
    },
    accent: {
      base: '#505050',
      hover: '#686868',
      soft: 'rgba(90,90,90,0.08)',
    },
    status: {
      success: '#2d8a4e',
      warning: '#b07818',
      danger: '#c44040',
    },
    chat: {
      background: '#fafafa',
      placeholder: '#9a9a9a',
      input: '#fafafa',
      inputBorder: 'rgba(0,0,0,0.12)',
      text: '#1a1a1a',
      textSecondary: '#3a3a3a',
      muted: '#6a6a6a',
      subtle: '#9a9a9a',
      divider: 'rgba(0,0,0,0.08)',
      assistantBubble: '#f0f0f0',
      assistantBubbleBorder: 'rgba(0,0,0,0.06)',
      userBubble: '#e2e2e2',
      userBubbleBorder: '#c8c8c8',
      dropdownBackground: '#fafafa',
      dropdownBorder: 'rgba(0,0,0,0.12)',
      dropdownActiveBackground: '#e4e4e4',
      dropdownHoverBackground: 'rgba(0,0,0,0.04)',
    },
    terminal: {
      background: '#f5f5f5',
      foreground: '#1a1a1a',
      cursor: '#1a1a1a',
      cursorAccent: '#f5f5f5',
      selection: 'rgba(90,90,90,0.18)',
      black: '#1a1a1a',
      red: '#c44040',
      green: '#2d8a4e',
      yellow: '#907000',
      blue: '#2860b0',
      magenta: '#7840a0',
      cyan: '#187878',
      white: '#6a6a6a',
      brightBlack: '#9a9a9a',
      brightRed: '#d85858',
      brightGreen: '#38a060',
      brightYellow: '#a88818',
      brightBlue: '#3878c8',
      brightMagenta: '#9058b8',
      brightCyan: '#289090',
      brightWhite: '#1a1a1a',
    },
    editor: {
      monacoBase: 'vs',
      background: '#fafafa',
    },
    extension: {
      background: '#fafafa',
      panel: '#f0f0f0',
      border: 'rgba(0,0,0,0.12)',
      text: '#1a1a1a',
      muted: '#6a6a6a',
      accent: '#505050',
    },
    shadow: {
      panel: '0 8px 24px rgba(0,0,0,0.08)',
      modal: '0 24px 56px rgba(0,0,0,0.12)',
    },
  },
  'charcoal-light': {
    id: 'charcoal-light',
    label: 'Charcoal',
    mode: 'light',
    description: 'Deeper gray tones with dark accents for a bold light theme.',
    canvas: {
      background: '#e4e4e8',
      backgroundEffect: '',
      gridSmall: '#ccccd2',
      gridLarge: '#b8b8c0',
      gridGlowSmall: 'rgba(40,40,50,0.16)',
      gridGlowLarge: 'rgba(40,40,50,0.22)',
    },
    surface: {
      app: '#dddde2',
      sidebarOverlay: 'rgba(228,228,232,0.94)',
      sidebar: '#ededf0',
      panel: '#f4f4f6',
      panelMuted: '#e8e8ec',
      panelElevated: '#dddde2',
      titlebar: '#e4e4e8',
      input: '#f4f4f6',
      hover: 'rgba(30,30,40,0.05)',
      selection: 'rgba(50,50,60,0.10)',
      selectionBorder: 'rgba(50,50,60,0.20)',
      accentSoft: 'rgba(50,50,60,0.08)',
    },
    border: {
      subtle: 'rgba(20,20,30,0.07)',
      default: 'rgba(20,20,30,0.14)',
      strong: 'rgba(20,20,30,0.22)',
      accent: 'rgba(50,50,60,0.32)',
    },
    text: {
      primary: '#18181c',
      secondary: '#2e2e36',
      muted: '#5c5c68',
      disabled: '#888898',
      inverse: '#f4f4f6',
    },
    accent: {
      base: '#3a3a44',
      hover: '#50505c',
      soft: 'rgba(50,50,60,0.08)',
    },
    status: {
      success: '#2a7a44',
      warning: '#b07818',
      danger: '#c03838',
    },
    chat: {
      background: '#f4f4f6',
      placeholder: '#88889a',
      input: '#f4f4f6',
      inputBorder: 'rgba(20,20,30,0.14)',
      text: '#18181c',
      textSecondary: '#2e2e36',
      muted: '#5c5c68',
      subtle: '#88889a',
      divider: 'rgba(20,20,30,0.10)',
      assistantBubble: '#e8e8ec',
      assistantBubbleBorder: 'rgba(20,20,30,0.07)',
      userBubble: '#d8d8e0',
      userBubbleBorder: '#c0c0cc',
      dropdownBackground: '#f4f4f6',
      dropdownBorder: 'rgba(20,20,30,0.14)',
      dropdownActiveBackground: '#dddde2',
      dropdownHoverBackground: 'rgba(30,30,40,0.05)',
    },
    terminal: {
      background: '#ededf0',
      foreground: '#18181c',
      cursor: '#18181c',
      cursorAccent: '#ededf0',
      selection: 'rgba(50,50,60,0.18)',
      black: '#18181c',
      red: '#c03838',
      green: '#2a7a44',
      yellow: '#8a6800',
      blue: '#2850a0',
      magenta: '#703898',
      cyan: '#187070',
      white: '#5c5c68',
      brightBlack: '#88889a',
      brightRed: '#d85050',
      brightGreen: '#389058',
      brightYellow: '#a08018',
      brightBlue: '#3868b8',
      brightMagenta: '#8850b0',
      brightCyan: '#288888',
      brightWhite: '#18181c',
    },
    editor: {
      monacoBase: 'vs',
      background: '#f4f4f6',
    },
    extension: {
      background: '#f4f4f6',
      panel: '#e8e8ec',
      border: 'rgba(20,20,30,0.14)',
      text: '#18181c',
      muted: '#5c5c68',
      accent: '#3a3a44',
    },
    shadow: {
      panel: '0 8px 24px rgba(20,20,30,0.10)',
      modal: '0 24px 56px rgba(20,20,30,0.14)',
    },
  },
  'ocean-light': {
    id: 'ocean-light',
    label: 'Ocean',
    mode: 'light',
    description: 'Deep blue accents with a crisp, aquatic feel.',
    canvas: {
      background: '#edf3f8',
      backgroundEffect: '',
      gridSmall: '#d0dce8',
      gridLarge: '#b8cad8',
      gridGlowSmall: 'rgba(20,70,140,0.14)',
      gridGlowLarge: 'rgba(20,70,140,0.20)',
    },
    surface: {
      app: '#e6eef6',
      sidebarOverlay: 'rgba(237,243,248,0.94)',
      sidebar: '#f4f8fc',
      panel: '#fafcfe',
      panelMuted: '#edf3f8',
      panelElevated: '#e0eaf4',
      titlebar: '#edf3f8',
      input: '#fafcfe',
      hover: 'rgba(20,70,140,0.04)',
      selection: 'rgba(20,90,180,0.10)',
      selectionBorder: 'rgba(20,90,180,0.22)',
      accentSoft: 'rgba(20,90,180,0.08)',
    },
    border: {
      subtle: 'rgba(10,40,80,0.06)',
      default: 'rgba(10,40,80,0.12)',
      strong: 'rgba(10,40,80,0.18)',
      accent: 'rgba(20,90,180,0.30)',
    },
    text: {
      primary: '#0c2340',
      secondary: '#1a3858',
      muted: '#4a6a88',
      disabled: '#7a98b0',
      inverse: '#fafcfe',
    },
    accent: {
      base: '#145ab4',
      hover: '#1a6ed0',
      soft: 'rgba(20,90,180,0.08)',
    },
    status: {
      success: '#1a7a48',
      warning: '#b07818',
      danger: '#c04040',
    },
    chat: {
      background: '#fafcfe',
      placeholder: '#7a98b0',
      input: '#fafcfe',
      inputBorder: 'rgba(10,40,80,0.12)',
      text: '#0c2340',
      textSecondary: '#1a3858',
      muted: '#4a6a88',
      subtle: '#7a98b0',
      divider: 'rgba(10,40,80,0.08)',
      assistantBubble: '#edf3f8',
      assistantBubbleBorder: 'rgba(10,40,80,0.06)',
      userBubble: '#d8e8f8',
      userBubbleBorder: '#b0cce8',
      dropdownBackground: '#fafcfe',
      dropdownBorder: 'rgba(10,40,80,0.12)',
      dropdownActiveBackground: '#e0eaf4',
      dropdownHoverBackground: 'rgba(20,70,140,0.04)',
    },
    terminal: {
      background: '#f4f8fc',
      foreground: '#0c2340',
      cursor: '#0c2340',
      cursorAccent: '#f4f8fc',
      selection: 'rgba(20,90,180,0.18)',
      black: '#0c2340',
      red: '#c04040',
      green: '#1a7a48',
      yellow: '#8a6800',
      blue: '#145ab4',
      magenta: '#6840a0',
      cyan: '#0c6878',
      white: '#4a6a88',
      brightBlack: '#7a98b0',
      brightRed: '#d85858',
      brightGreen: '#28905c',
      brightYellow: '#a08018',
      brightBlue: '#2870d0',
      brightMagenta: '#8058b8',
      brightCyan: '#1a8898',
      brightWhite: '#0c2340',
    },
    editor: {
      monacoBase: 'vs',
      background: '#fafcfe',
    },
    extension: {
      background: '#fafcfe',
      panel: '#edf3f8',
      border: 'rgba(10,40,80,0.12)',
      text: '#0c2340',
      muted: '#4a6a88',
      accent: '#145ab4',
    },
    shadow: {
      panel: '0 8px 24px rgba(10,30,70,0.08)',
      modal: '0 24px 56px rgba(10,30,70,0.12)',
    },
  },
  'lavender-light': {
    id: 'lavender-light',
    label: 'Lavender',
    mode: 'light',
    description: 'Soft purple tints for a gentle, creative workspace.',
    canvas: {
      background: '#f0eef6',
      backgroundEffect: '',
      gridSmall: '#d8d4e4',
      gridLarge: '#c4bed6',
      gridGlowSmall: 'rgba(88,60,140,0.14)',
      gridGlowLarge: 'rgba(88,60,140,0.20)',
    },
    surface: {
      app: '#eae6f2',
      sidebarOverlay: 'rgba(240,238,246,0.94)',
      sidebar: '#f6f4fa',
      panel: '#fcfbfe',
      panelMuted: '#f0eef6',
      panelElevated: '#e6e2f0',
      titlebar: '#f0eef6',
      input: '#fcfbfe',
      hover: 'rgba(80,50,130,0.04)',
      selection: 'rgba(100,60,180,0.08)',
      selectionBorder: 'rgba(100,60,180,0.20)',
      accentSoft: 'rgba(100,60,180,0.08)',
    },
    border: {
      subtle: 'rgba(50,30,80,0.06)',
      default: 'rgba(50,30,80,0.11)',
      strong: 'rgba(50,30,80,0.18)',
      accent: 'rgba(100,60,180,0.28)',
    },
    text: {
      primary: '#1e1430',
      secondary: '#342848',
      muted: '#645878',
      disabled: '#8a7ea0',
      inverse: '#fcfbfe',
    },
    accent: {
      base: '#6838b0',
      hover: '#7c48c8',
      soft: 'rgba(100,60,180,0.08)',
    },
    status: {
      success: '#2a7a48',
      warning: '#b07818',
      danger: '#c44040',
    },
    chat: {
      background: '#fcfbfe',
      placeholder: '#8a7ea0',
      input: '#fcfbfe',
      inputBorder: 'rgba(50,30,80,0.11)',
      text: '#1e1430',
      textSecondary: '#342848',
      muted: '#645878',
      subtle: '#8a7ea0',
      divider: 'rgba(50,30,80,0.08)',
      assistantBubble: '#f0eef6',
      assistantBubbleBorder: 'rgba(50,30,80,0.06)',
      userBubble: '#e8e0f8',
      userBubbleBorder: '#c8b8e8',
      dropdownBackground: '#fcfbfe',
      dropdownBorder: 'rgba(50,30,80,0.11)',
      dropdownActiveBackground: '#e6e2f0',
      dropdownHoverBackground: 'rgba(80,50,130,0.04)',
    },
    terminal: {
      background: '#f6f4fa',
      foreground: '#1e1430',
      cursor: '#1e1430',
      cursorAccent: '#f6f4fa',
      selection: 'rgba(100,60,180,0.16)',
      black: '#1e1430',
      red: '#c44040',
      green: '#2a7a48',
      yellow: '#907000',
      blue: '#3058c0',
      magenta: '#6838b0',
      cyan: '#1a7078',
      white: '#645878',
      brightBlack: '#8a7ea0',
      brightRed: '#d85858',
      brightGreen: '#38905c',
      brightYellow: '#a88818',
      brightBlue: '#4070d8',
      brightMagenta: '#8050c8',
      brightCyan: '#289088',
      brightWhite: '#1e1430',
    },
    editor: {
      monacoBase: 'vs',
      background: '#fcfbfe',
    },
    extension: {
      background: '#fcfbfe',
      panel: '#f0eef6',
      border: 'rgba(50,30,80,0.11)',
      text: '#1e1430',
      muted: '#645878',
      accent: '#6838b0',
    },
    shadow: {
      panel: '0 8px 24px rgba(40,20,70,0.08)',
      modal: '0 24px 56px rgba(40,20,70,0.12)',
    },
  },
  'rose-light': {
    id: 'rose-light',
    label: 'Rose',
    mode: 'light',
    description: 'Warm pink-rose tones for a soft, inviting workspace.',
    canvas: {
      background: '#f6eff2',
      backgroundEffect: '',
      gridSmall: '#e4d8dc',
      gridLarge: '#d2c4ca',
      gridGlowSmall: 'rgba(140,50,70,0.14)',
      gridGlowLarge: 'rgba(140,50,70,0.20)',
    },
    surface: {
      app: '#f2eaee',
      sidebarOverlay: 'rgba(246,239,242,0.94)',
      sidebar: '#faf6f8',
      panel: '#fefcfd',
      panelMuted: '#f6eff2',
      panelElevated: '#ece4e8',
      titlebar: '#f6eff2',
      input: '#fefcfd',
      hover: 'rgba(130,40,60,0.04)',
      selection: 'rgba(180,50,80,0.08)',
      selectionBorder: 'rgba(180,50,80,0.20)',
      accentSoft: 'rgba(180,50,80,0.08)',
    },
    border: {
      subtle: 'rgba(80,20,40,0.06)',
      default: 'rgba(80,20,40,0.11)',
      strong: 'rgba(80,20,40,0.18)',
      accent: 'rgba(180,50,80,0.28)',
    },
    text: {
      primary: '#2c161c',
      secondary: '#4a2a34',
      muted: '#7a5a64',
      disabled: '#a08890',
      inverse: '#fefcfd',
    },
    accent: {
      base: '#b83250',
      hover: '#d04068',
      soft: 'rgba(180,50,80,0.08)',
    },
    status: {
      success: '#2a7a48',
      warning: '#b07818',
      danger: '#c44040',
    },
    chat: {
      background: '#fefcfd',
      placeholder: '#a08890',
      input: '#fefcfd',
      inputBorder: 'rgba(80,20,40,0.11)',
      text: '#2c161c',
      textSecondary: '#4a2a34',
      muted: '#7a5a64',
      subtle: '#a08890',
      divider: 'rgba(80,20,40,0.08)',
      assistantBubble: '#f6eff2',
      assistantBubbleBorder: 'rgba(80,20,40,0.06)',
      userBubble: '#f4e0e8',
      userBubbleBorder: '#e0b8c8',
      dropdownBackground: '#fefcfd',
      dropdownBorder: 'rgba(80,20,40,0.11)',
      dropdownActiveBackground: '#ece4e8',
      dropdownHoverBackground: 'rgba(130,40,60,0.04)',
    },
    terminal: {
      background: '#faf6f8',
      foreground: '#2c161c',
      cursor: '#2c161c',
      cursorAccent: '#faf6f8',
      selection: 'rgba(180,50,80,0.16)',
      black: '#2c161c',
      red: '#c44040',
      green: '#2a7a48',
      yellow: '#907000',
      blue: '#2860b0',
      magenta: '#9838a8',
      cyan: '#187878',
      white: '#7a5a64',
      brightBlack: '#a08890',
      brightRed: '#d85858',
      brightGreen: '#38905c',
      brightYellow: '#a88818',
      brightBlue: '#3878c8',
      brightMagenta: '#b050c0',
      brightCyan: '#289090',
      brightWhite: '#2c161c',
    },
    editor: {
      monacoBase: 'vs',
      background: '#fefcfd',
    },
    extension: {
      background: '#fefcfd',
      panel: '#f6eff2',
      border: 'rgba(80,20,40,0.11)',
      text: '#2c161c',
      muted: '#7a5a64',
      accent: '#b83250',
    },
    shadow: {
      panel: '0 8px 24px rgba(70,20,40,0.08)',
      modal: '0 24px 56px rgba(70,20,40,0.12)',
    },
  },
  'frost-light': {
    id: 'frost-light',
    label: 'Frost',
    mode: 'light',
    description: 'Cool ice-blue tones with a crisp, wintry clarity.',
    canvas: {
      background: '#edf2f8',
      backgroundEffect: '',
      gridSmall: '#d4dee8',
      gridLarge: '#bccad8',
      gridGlowSmall: 'rgba(40,80,140,0.14)',
      gridGlowLarge: 'rgba(40,80,140,0.20)',
    },
    surface: {
      app: '#e6ecf4',
      sidebarOverlay: 'rgba(237,242,248,0.94)',
      sidebar: '#f2f6fc',
      panel: '#f8fafd',
      panelMuted: '#edf2f8',
      panelElevated: '#e0e8f2',
      titlebar: '#edf2f8',
      input: '#f8fafd',
      hover: 'rgba(40,80,140,0.04)',
      selection: 'rgba(50,100,180,0.08)',
      selectionBorder: 'rgba(50,100,180,0.20)',
      accentSoft: 'rgba(50,100,180,0.08)',
    },
    border: {
      subtle: 'rgba(20,40,80,0.06)',
      default: 'rgba(20,40,80,0.11)',
      strong: 'rgba(20,40,80,0.18)',
      accent: 'rgba(50,100,180,0.28)',
    },
    text: {
      primary: '#142030',
      secondary: '#283848',
      muted: '#506878',
      disabled: '#7890a0',
      inverse: '#f8fafd',
    },
    accent: {
      base: '#3870b8',
      hover: '#4884d0',
      soft: 'rgba(50,100,180,0.08)',
    },
    status: {
      success: '#1a7a48',
      warning: '#b07818',
      danger: '#c04040',
    },
    chat: {
      background: '#f8fafd',
      placeholder: '#7890a0',
      input: '#f8fafd',
      inputBorder: 'rgba(20,40,80,0.11)',
      text: '#142030',
      textSecondary: '#283848',
      muted: '#506878',
      subtle: '#7890a0',
      divider: 'rgba(20,40,80,0.08)',
      assistantBubble: '#edf2f8',
      assistantBubbleBorder: 'rgba(20,40,80,0.06)',
      userBubble: '#dce8f6',
      userBubbleBorder: '#b4cce8',
      dropdownBackground: '#f8fafd',
      dropdownBorder: 'rgba(20,40,80,0.11)',
      dropdownActiveBackground: '#e0e8f2',
      dropdownHoverBackground: 'rgba(40,80,140,0.04)',
    },
    terminal: {
      background: '#f2f6fc',
      foreground: '#142030',
      cursor: '#142030',
      cursorAccent: '#f2f6fc',
      selection: 'rgba(50,100,180,0.16)',
      black: '#142030',
      red: '#c04040',
      green: '#1a7a48',
      yellow: '#8a6800',
      blue: '#3870b8',
      magenta: '#6848a8',
      cyan: '#107080',
      white: '#506878',
      brightBlack: '#7890a0',
      brightRed: '#d85858',
      brightGreen: '#28905c',
      brightYellow: '#a08018',
      brightBlue: '#4888d0',
      brightMagenta: '#8060c0',
      brightCyan: '#209098',
      brightWhite: '#142030',
    },
    editor: {
      monacoBase: 'vs',
      background: '#f8fafd',
    },
    extension: {
      background: '#f8fafd',
      panel: '#edf2f8',
      border: 'rgba(20,40,80,0.11)',
      text: '#142030',
      muted: '#506878',
      accent: '#3870b8',
    },
    shadow: {
      panel: '0 8px 24px rgba(20,40,80,0.08)',
      modal: '0 24px 56px rgba(20,40,80,0.12)',
    },
  },
  'sand-light': {
    id: 'sand-light',
    label: 'Sand',
    mode: 'light',
    description: 'Warm sandy neutrals with earthy undertones.',
    canvas: {
      background: '#f2ede6',
      backgroundEffect: '',
      gridSmall: '#ddd6cc',
      gridLarge: '#cac0b4',
      gridGlowSmall: 'rgba(100,70,30,0.14)',
      gridGlowLarge: 'rgba(100,70,30,0.20)',
    },
    surface: {
      app: '#ece6de',
      sidebarOverlay: 'rgba(242,237,230,0.94)',
      sidebar: '#f8f4ee',
      panel: '#fdfaf4',
      panelMuted: '#f2ede6',
      panelElevated: '#e6e0d8',
      titlebar: '#f2ede6',
      input: '#fdfaf4',
      hover: 'rgba(90,60,20,0.04)',
      selection: 'rgba(140,90,30,0.08)',
      selectionBorder: 'rgba(140,90,30,0.20)',
      accentSoft: 'rgba(140,90,30,0.08)',
    },
    border: {
      subtle: 'rgba(60,40,10,0.06)',
      default: 'rgba(60,40,10,0.12)',
      strong: 'rgba(60,40,10,0.18)',
      accent: 'rgba(140,90,30,0.28)',
    },
    text: {
      primary: '#2a2218',
      secondary: '#44382a',
      muted: '#706050',
      disabled: '#968878',
      inverse: '#fdfaf4',
    },
    accent: {
      base: '#8c5a1e',
      hover: '#a46c28',
      soft: 'rgba(140,90,30,0.08)',
    },
    status: {
      success: '#2a7a44',
      warning: '#a06800',
      danger: '#c04040',
    },
    chat: {
      background: '#fdfaf4',
      placeholder: '#968878',
      input: '#fdfaf4',
      inputBorder: 'rgba(60,40,10,0.12)',
      text: '#2a2218',
      textSecondary: '#44382a',
      muted: '#706050',
      subtle: '#968878',
      divider: 'rgba(60,40,10,0.08)',
      assistantBubble: '#f2ede6',
      assistantBubbleBorder: 'rgba(60,40,10,0.06)',
      userBubble: '#ece0cc',
      userBubbleBorder: '#d4c4a8',
      dropdownBackground: '#fdfaf4',
      dropdownBorder: 'rgba(60,40,10,0.12)',
      dropdownActiveBackground: '#e6e0d8',
      dropdownHoverBackground: 'rgba(90,60,20,0.04)',
    },
    terminal: {
      background: '#f8f4ee',
      foreground: '#2a2218',
      cursor: '#2a2218',
      cursorAccent: '#f8f4ee',
      selection: 'rgba(140,90,30,0.16)',
      black: '#2a2218',
      red: '#c04040',
      green: '#2a7a44',
      yellow: '#8a6400',
      blue: '#2858a8',
      magenta: '#784098',
      cyan: '#187070',
      white: '#706050',
      brightBlack: '#968878',
      brightRed: '#d85858',
      brightGreen: '#389058',
      brightYellow: '#a07c18',
      brightBlue: '#3870c0',
      brightMagenta: '#9058b0',
      brightCyan: '#288888',
      brightWhite: '#2a2218',
    },
    editor: {
      monacoBase: 'vs',
      background: '#fdfaf4',
    },
    extension: {
      background: '#fdfaf4',
      panel: '#f2ede6',
      border: 'rgba(60,40,10,0.12)',
      text: '#2a2218',
      muted: '#706050',
      accent: '#8c5a1e',
    },
    shadow: {
      panel: '0 8px 24px rgba(60,40,10,0.08)',
      modal: '0 24px 56px rgba(60,40,10,0.10)',
    },
  },
  'steel-light': {
    id: 'steel-light',
    label: 'Steel',
    mode: 'light',
    description: 'Blue-gray steel tones with a professional, industrial edge.',
    canvas: {
      background: '#e8ecf0',
      backgroundEffect: '',
      gridSmall: '#d0d6de',
      gridLarge: '#bcc4ce',
      gridGlowSmall: 'rgba(40,56,80,0.16)',
      gridGlowLarge: 'rgba(40,56,80,0.22)',
    },
    surface: {
      app: '#e0e6ec',
      sidebarOverlay: 'rgba(232,236,240,0.94)',
      sidebar: '#f0f2f6',
      panel: '#f6f8fa',
      panelMuted: '#e8ecf0',
      panelElevated: '#dce2e8',
      titlebar: '#e8ecf0',
      input: '#f6f8fa',
      hover: 'rgba(30,50,70,0.04)',
      selection: 'rgba(60,80,120,0.10)',
      selectionBorder: 'rgba(60,80,120,0.22)',
      accentSoft: 'rgba(60,80,120,0.08)',
    },
    border: {
      subtle: 'rgba(20,36,60,0.06)',
      default: 'rgba(20,36,60,0.12)',
      strong: 'rgba(20,36,60,0.20)',
      accent: 'rgba(60,80,120,0.30)',
    },
    text: {
      primary: '#161e28',
      secondary: '#2c3848',
      muted: '#566878',
      disabled: '#7c8c9c',
      inverse: '#f6f8fa',
    },
    accent: {
      base: '#3c5078',
      hover: '#506890',
      soft: 'rgba(60,80,120,0.08)',
    },
    status: {
      success: '#247848',
      warning: '#b07818',
      danger: '#c04040',
    },
    chat: {
      background: '#f6f8fa',
      placeholder: '#7c8c9c',
      input: '#f6f8fa',
      inputBorder: 'rgba(20,36,60,0.12)',
      text: '#161e28',
      textSecondary: '#2c3848',
      muted: '#566878',
      subtle: '#7c8c9c',
      divider: 'rgba(20,36,60,0.08)',
      assistantBubble: '#e8ecf0',
      assistantBubbleBorder: 'rgba(20,36,60,0.06)',
      userBubble: '#dae2ec',
      userBubbleBorder: '#bcc8d8',
      dropdownBackground: '#f6f8fa',
      dropdownBorder: 'rgba(20,36,60,0.12)',
      dropdownActiveBackground: '#dce2e8',
      dropdownHoverBackground: 'rgba(30,50,70,0.04)',
    },
    terminal: {
      background: '#f0f2f6',
      foreground: '#161e28',
      cursor: '#161e28',
      cursorAccent: '#f0f2f6',
      selection: 'rgba(60,80,120,0.18)',
      black: '#161e28',
      red: '#c04040',
      green: '#247848',
      yellow: '#8a6800',
      blue: '#2858a8',
      magenta: '#6c40a0',
      cyan: '#107078',
      white: '#566878',
      brightBlack: '#7c8c9c',
      brightRed: '#d85858',
      brightGreen: '#349060',
      brightYellow: '#a08018',
      brightBlue: '#3870c0',
      brightMagenta: '#8458b8',
      brightCyan: '#209090',
      brightWhite: '#161e28',
    },
    editor: {
      monacoBase: 'vs',
      background: '#f6f8fa',
    },
    extension: {
      background: '#f6f8fa',
      panel: '#e8ecf0',
      border: 'rgba(20,36,60,0.12)',
      text: '#161e28',
      muted: '#566878',
      accent: '#3c5078',
    },
    shadow: {
      panel: '0 8px 24px rgba(20,36,60,0.10)',
      modal: '0 24px 56px rgba(20,36,60,0.14)',
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // Wave 3 themes (defineTheme-built). Each preset focuses on a single
  // dominant identity: a hue family + a paired accent. Light variants use
  // a wider luminance ladder ("more shade") so panels and surfaces read as
  // distinct tiers rather than collapsing into near-white sameness.
  // ─────────────────────────────────────────────────────────────────────

  // ── DARK: Forest. Deep evergreen with warm-sage accent. ──────────────
  'forest-dark': defineTheme({
    id: 'forest-dark',
    label: 'Forest Dark',
    mode: 'dark',
    description: 'Evergreen forest floor — deep teals, warm sage accent.',
    canvas: { background: '#0d1411', gridSmall: '#1c2a24', gridLarge: '#2a3d35' },
    surface: {
      app: '#0a1210',
      sidebar: '#0c1512',
      panel: '#0e1815',
      panelMuted: '#13201c',
      panelElevated: '#172722',
      titlebar: '#152420',
      input: '#101a17',
    },
    text: {
      primary: '#e0eae3',
      secondary: '#b6c3bb',
      muted: '#7d8b83',
      disabled: '#525f59',
    },
    accent: { base: '#8fcaa3', hover: '#a8d8b9', rgb: '143,202,163' },
    chat: {
      background: '#0a1310',
      placeholder: '#5b6b64',
      input: '#13201c',
      inputBorder: '#1d2e29',
      assistantBubble: '#13201c',
      userBubble: '#152826',
      userBubbleBorder: '#284540',
      dropdownBackground: '#13201c',
      dropdownBorder: '#243530',
      dropdownHover: '#1c2c27',
    },
    terminalAnsi: { green: '#8fcaa3', cyan: '#7dc7c0', yellow: '#dfc777' },
  }),

  // ── DARK: Ember. Warm coal with copper accent. ──────────────────────
  'ember-dark': defineTheme({
    id: 'ember-dark',
    label: 'Ember Dark',
    mode: 'dark',
    description: 'Warm coal — copper accent over deep umber chrome.',
    canvas: { background: '#15110d', gridSmall: '#2a221b', gridLarge: '#3d3128' },
    surface: {
      app: '#100c08',
      sidebar: '#13100c',
      panel: '#1a1510',
      panelMuted: '#1f1913',
      panelElevated: '#251e17',
      titlebar: '#221c15',
      input: '#1a140e',
    },
    text: {
      primary: '#f0e4d6',
      secondary: '#cebda7',
      muted: '#928274',
      disabled: '#5e544a',
    },
    accent: { base: '#e8985a', hover: '#f3aa72', rgb: '232,152,90' },
    chat: {
      background: '#0e0a06',
      placeholder: '#6f6356',
      input: '#1f1913',
      inputBorder: '#2c241c',
      assistantBubble: '#1f1913',
      userBubble: '#2a2018',
      userBubbleBorder: '#4a3a2a',
      dropdownBackground: '#1c1610',
      dropdownBorder: '#33291f',
      dropdownHover: '#261d15',
    },
    terminalAnsi: { yellow: '#e8985a', red: '#e87a52' },
  }),

  // ── DARK: Obsidian. Pure cool black, electric blue accent. ──────────
  'obsidian-dark': defineTheme({
    id: 'obsidian-dark',
    label: 'Obsidian',
    mode: 'dark',
    description: 'Pure cool blacks with an electric cobalt accent.',
    canvas: { background: '#08090c', gridSmall: '#1a1c22', gridLarge: '#2a2d36' },
    surface: {
      app: '#05060a',
      sidebar: '#07080c',
      panel: '#0a0c11',
      panelMuted: '#0f1218',
      panelElevated: '#161a23',
      titlebar: '#11141b',
      input: '#0c0f15',
    },
    text: {
      primary: '#e8ecf5',
      secondary: '#b8bfd0',
      muted: '#7c849a',
      disabled: '#4f5668',
    },
    accent: { base: '#5a8eff', hover: '#7aa7ff', rgb: '90,142,255' },
    chat: {
      background: '#04050a',
      placeholder: '#5a6378',
      input: '#0f1218',
      inputBorder: '#1c2030',
      assistantBubble: '#0f1218',
      userBubble: '#0e1830',
      userBubbleBorder: '#1f3260',
      dropdownBackground: '#0d0f17',
      dropdownBorder: '#1f2330',
      dropdownHover: '#171b27',
    },
    terminalAnsi: { blue: '#5a8eff', cyan: '#48cfff' },
  }),

  // ── DARK: Mocha. Coffee browns with caramel accent. ─────────────────
  'mocha-dark': defineTheme({
    id: 'mocha-dark',
    label: 'Mocha',
    mode: 'dark',
    description: 'Coffee browns and caramel — soft, warm, low-glare.',
    canvas: { background: '#1a1410', gridSmall: '#2c2520', gridLarge: '#3d3530' },
    surface: {
      app: '#15100c',
      sidebar: '#19140f',
      panel: '#1f1813',
      panelMuted: '#241d18',
      panelElevated: '#2a221c',
      titlebar: '#262019',
      input: '#1d1812',
    },
    text: {
      primary: '#ede1d2',
      secondary: '#cab9a4',
      muted: '#8d7e6c',
      disabled: '#5f5444',
    },
    accent: { base: '#d4a574', hover: '#e2b78a', rgb: '212,165,116' },
    chat: {
      background: '#120e0a',
      placeholder: '#6c5f51',
      input: '#241d18',
      inputBorder: '#332a23',
      assistantBubble: '#241d18',
      userBubble: '#2e251c',
      userBubbleBorder: '#4a3c2c',
      dropdownBackground: '#211a14',
      dropdownBorder: '#382e25',
      dropdownHover: '#2a2218',
    },
    terminalAnsi: { yellow: '#d4a574', red: '#d77a6a' },
  }),

  // ── LIGHT: Linen. Cream/oatmeal with strong panel separation. ───────
  'linen-light': defineTheme({
    id: 'linen-light',
    label: 'Linen Light',
    mode: 'light',
    description: 'Warm linen paper with deeper panel tiers — readable, not flat.',
    canvas: { background: '#f1ebdf', gridSmall: '#dfd5c0', gridLarge: '#cfc2a8' },
    surface: {
      // "More shade" — surfaces step ~3 L points apart so panels and inputs
      // read as distinct tiers, not as the same beige blur.
      app: '#f7f1e4',
      sidebar: '#ebe2cf',
      panel: '#f9f3e7',
      panelMuted: '#ece4d2',
      panelElevated: '#f5edd9',
      titlebar: '#e8dfc8',
      input: '#fdf8ec',
    },
    text: {
      primary: '#2b2620',
      secondary: '#544838',
      muted: '#8a7a5e',
      disabled: '#b09e80',
      inverse: '#fbf6e8',
    },
    accent: { base: '#a86b3c', hover: '#c08350', rgb: '168,107,60' },
    status: { success: '#3f7d3a', warning: '#a86b3c', danger: '#b8362a' },
    chat: {
      background: '#fcf6e8',
      placeholder: '#a89878',
      input: '#f5edd9',
      inputBorder: '#d8c9aa',
      assistantBubble: '#f5edd9',
      userBubble: '#ece4d0',
      userBubbleBorder: '#cdb98e',
      dropdownBackground: '#fdf9ef',
      dropdownBorder: '#dcccaa',
      dropdownHover: '#f0e8d3',
    },
    border: { subtle: 'rgba(58,40,18,0.10)', default: 'rgba(58,40,18,0.18)', strong: 'rgba(58,40,18,0.28)' },
    shadow: { panel: 'rgba(58,40,18,0.10)', modal: 'rgba(58,40,18,0.16)' },
    terminalAnsi: { yellow: '#a86b3c', red: '#b8362a', green: '#3f7d3a' },
  }),

  // ── LIGHT: Tide. Coastal blue-grey with marked depth. ───────────────
  'tide-light': defineTheme({
    id: 'tide-light',
    label: 'Tide Light',
    mode: 'light',
    description: 'Coastal blue-grey — measurable surface tiers, no flat washout.',
    canvas: { background: '#dde6ee', gridSmall: '#c5d3e0', gridLarge: '#aabccd' },
    surface: {
      app: '#e6edf4',
      sidebar: '#d4dee8',
      panel: '#eef3f9',
      panelMuted: '#dde5ee',
      panelElevated: '#e6edf4',
      titlebar: '#d0dae6',
      input: '#f5f8fc',
    },
    text: {
      primary: '#1a2735',
      secondary: '#3d4f63',
      muted: '#6c7e91',
      disabled: '#9aa9b9',
      inverse: '#f5f8fc',
    },
    accent: { base: '#1f72c4', hover: '#3084d8', rgb: '31,114,196' },
    status: { success: '#1f8d5e', warning: '#b27308', danger: '#c2342a' },
    chat: {
      background: '#f4f8fc',
      placeholder: '#8b9caf',
      input: '#e6edf4',
      inputBorder: '#bccbdb',
      assistantBubble: '#e6edf4',
      userBubble: '#dae6f3',
      userBubbleBorder: '#a4bfdf',
      dropdownBackground: '#f7fafd',
      dropdownBorder: '#bccbdb',
      dropdownHover: '#dde7f1',
    },
    border: { subtle: 'rgba(20,40,60,0.08)', default: 'rgba(20,40,60,0.16)', strong: 'rgba(20,40,60,0.26)' },
    shadow: { panel: 'rgba(20,40,60,0.10)', modal: 'rgba(20,40,60,0.18)' },
    terminalAnsi: { blue: '#1f72c4', cyan: '#0e7c7b' },
  }),

  // ── LIGHT: Clay. Peachy terracotta with warm shaded panels. ─────────
  'clay-light': defineTheme({
    id: 'clay-light',
    label: 'Clay Light',
    mode: 'light',
    description: 'Peachy terracotta — earthen shades, visible panel hierarchy.',
    canvas: { background: '#f3dfd1', gridSmall: '#dfc4b0', gridLarge: '#caa48a' },
    surface: {
      app: '#f7e6da',
      sidebar: '#ecd4c2',
      panel: '#fbecdf',
      panelMuted: '#f0dcca',
      panelElevated: '#f6e3d2',
      titlebar: '#e7cdba',
      input: '#fdf2e8',
    },
    text: {
      primary: '#2f1f17',
      secondary: '#5b3e2c',
      muted: '#8e6a52',
      disabled: '#b89880',
      inverse: '#fdf2e8',
    },
    accent: { base: '#b54a2a', hover: '#cb5e3c', rgb: '181,74,42' },
    status: { success: '#2f7036', warning: '#a85f12', danger: '#a52a1d' },
    chat: {
      background: '#fcefe2',
      placeholder: '#a78068',
      input: '#f6e3d2',
      inputBorder: '#d8b59c',
      assistantBubble: '#f6e3d2',
      userBubble: '#f0d4be',
      userBubbleBorder: '#cb9678',
      dropdownBackground: '#fcf3ea',
      dropdownBorder: '#d8b59c',
      dropdownHover: '#f0dcca',
    },
    border: { subtle: 'rgba(60,30,18,0.10)', default: 'rgba(60,30,18,0.18)', strong: 'rgba(60,30,18,0.28)' },
    shadow: { panel: 'rgba(60,30,18,0.12)', modal: 'rgba(60,30,18,0.18)' },
    terminalAnsi: { red: '#b54a2a', yellow: '#a85f12' },
  }),

  // ── LIGHT: Meadow. Sage green with structured surface separation. ───
  'meadow-light': defineTheme({
    id: 'meadow-light',
    label: 'Meadow Light',
    mode: 'light',
    description: 'Soft sage with deeper green-tinted panels — calm but legible.',
    canvas: { background: '#dee8de', gridSmall: '#c4d4c4', gridLarge: '#a9bdaa' },
    surface: {
      app: '#e7efe6',
      sidebar: '#d6e1d5',
      panel: '#eef4ed',
      panelMuted: '#dde7dc',
      panelElevated: '#e6eee5',
      titlebar: '#d2dcd0',
      input: '#f4f8f3',
    },
    text: {
      primary: '#1d2a1f',
      secondary: '#3e503f',
      muted: '#6d8170',
      disabled: '#9aac9c',
      inverse: '#f4f8f3',
    },
    accent: { base: '#2f7a4a', hover: '#3e8c5a', rgb: '47,122,74' },
    status: { success: '#2f7a4a', warning: '#a36d10', danger: '#b53a2c' },
    chat: {
      background: '#f3f8f2',
      placeholder: '#8a9e8d',
      input: '#e6eee5',
      inputBorder: '#bdcdbe',
      assistantBubble: '#e6eee5',
      userBubble: '#dae8db',
      userBubbleBorder: '#a4c1a8',
      dropdownBackground: '#f5f9f4',
      dropdownBorder: '#bdcdbe',
      dropdownHover: '#dde7dc',
    },
    border: { subtle: 'rgba(20,40,25,0.08)', default: 'rgba(20,40,25,0.16)', strong: 'rgba(20,40,25,0.26)' },
    shadow: { panel: 'rgba(20,40,25,0.10)', modal: 'rgba(20,40,25,0.16)' },
    terminalAnsi: { green: '#2f7a4a', cyan: '#0e7c7b' },
  }),

  // ── DARK: Nebula. Deep violet/magenta with neon-cyan accent. ────────
  'nebula-dark': defineTheme({
    id: 'nebula-dark',
    label: 'Nebula',
    mode: 'dark',
    description: 'Deep nebular violet — magenta dust, cyan stars.',
    canvas: { background: '#100b1a', gridSmall: '#1f1832', gridLarge: '#2c224a' },
    surface: {
      app: '#0c0817',
      sidebar: '#100c1d',
      panel: '#15102a',
      panelMuted: '#1a1430',
      panelElevated: '#211940',
      titlebar: '#1c1538',
      input: '#13102a',
    },
    text: {
      primary: '#ece2ff',
      secondary: '#bdb0d8',
      muted: '#7e7299',
      disabled: '#534a68',
    },
    accent: { base: '#c97aff', hover: '#d895ff', rgb: '201,122,255' },
    chat: {
      background: '#0a0717',
      placeholder: '#5e5378',
      input: '#1a1430',
      inputBorder: '#2a2148',
      assistantBubble: '#1a1430',
      userBubble: '#221842',
      userBubbleBorder: '#3d2a6a',
      dropdownBackground: '#181230',
      dropdownBorder: '#2c2348',
      dropdownHover: '#221a3d',
    },
    terminalAnsi: { magenta: '#c97aff', cyan: '#5fe2ff', blue: '#7aa2ff' },
  }),

  // ── LIGHT: Pearl. Cool bluish-white paper with deep grey panels. ────
  'pearl-light': defineTheme({
    id: 'pearl-light',
    label: 'Pearl Light',
    mode: 'light',
    description: 'Cool bluish whites — strong panel hierarchy without colour cast.',
    canvas: { background: '#dde2ea', gridSmall: '#c4cdd9', gridLarge: '#a5b3c4' },
    surface: {
      app: '#e7ecf3',
      sidebar: '#d2dae5',
      panel: '#eff3f9',
      panelMuted: '#dee5ee',
      panelElevated: '#e7ecf3',
      titlebar: '#cdd6e0',
      input: '#f5f8fc',
    },
    text: {
      primary: '#10141c',
      secondary: '#363f4e',
      muted: '#6a7585',
      disabled: '#98a3b3',
      inverse: '#f5f8fc',
    },
    accent: { base: '#3056b8', hover: '#4267cb', rgb: '48,86,184' },
    status: { success: '#1d7a4a', warning: '#a86200', danger: '#bd2e25' },
    chat: {
      background: '#f3f6fb',
      placeholder: '#8a96a8',
      input: '#e7ecf3',
      inputBorder: '#bcc8d8',
      assistantBubble: '#e7ecf3',
      userBubble: '#dae3f0',
      userBubbleBorder: '#a4b6d4',
      dropdownBackground: '#f5f8fc',
      dropdownBorder: '#bcc8d8',
      dropdownHover: '#dde5f0',
    },
    border: { subtle: 'rgba(15,25,45,0.08)', default: 'rgba(15,25,45,0.16)', strong: 'rgba(15,25,45,0.26)' },
    shadow: { panel: 'rgba(15,25,45,0.10)', modal: 'rgba(15,25,45,0.16)' },
  }),

  // ── LIGHT: Bronze. Warm copper-amber paper with depth. ──────────────
  'bronze-light': defineTheme({
    id: 'bronze-light',
    label: 'Bronze Light',
    mode: 'light',
    description: 'Aged bronze paper — copper accent, real surface depth.',
    canvas: { background: '#ece0c4', gridSmall: '#d6c7a2', gridLarge: '#bba980' },
    surface: {
      app: '#f1e7cf',
      sidebar: '#e5d7b6',
      panel: '#f4ecd6',
      panelMuted: '#e8dcc0',
      panelElevated: '#f0e6cb',
      titlebar: '#dfd0a8',
      input: '#f9f3df',
    },
    text: {
      primary: '#2a2110',
      secondary: '#544428',
      muted: '#857452',
      disabled: '#b09f78',
      inverse: '#f9f3df',
    },
    accent: { base: '#9b6520', hover: '#b27933', rgb: '155,101,32' },
    status: { success: '#3d6f2c', warning: '#9b6520', danger: '#a82a1f' },
    chat: {
      background: '#faf3df',
      placeholder: '#a09072',
      input: '#f0e6cb',
      inputBorder: '#d1bd8e',
      assistantBubble: '#f0e6cb',
      userBubble: '#e8dcc0',
      userBubbleBorder: '#c2a878',
      dropdownBackground: '#fbf5e3',
      dropdownBorder: '#d1bd8e',
      dropdownHover: '#ece0c4',
    },
    border: { subtle: 'rgba(58,40,8,0.10)', default: 'rgba(58,40,8,0.18)', strong: 'rgba(58,40,8,0.28)' },
    shadow: { panel: 'rgba(58,40,8,0.10)', modal: 'rgba(58,40,8,0.16)' },
    terminalAnsi: { yellow: '#9b6520', red: '#a82a1f' },
  }),
}

for (const [themeId, theme] of Object.entries(THEMES)) {
  THEMES[themeId] = normalizePanelSurfaceTheme(theme)
}

export type AppearanceMode = 'dark' | 'light' | 'system'

/** Which theme id to apply given appearance mode, saved dark preset, and OS dark preference. */
export function resolveEffectiveThemeId(
  appearance: AppearanceMode | undefined,
  themeId: string,
  systemPrefersDark: boolean,
): string {
  const a = appearance ?? 'dark'
  const theme = THEMES[themeId]
  if (a === 'light') {
    // Use the selected theme if it's a light theme, otherwise fall back to paper-light
    return theme?.mode === 'light' ? themeId : 'paper-light'
  }
  if (a === 'system') {
    if (systemPrefersDark) {
      return theme?.mode === 'dark' ? themeId : DEFAULT_THEME_ID
    }
    return theme?.mode === 'light' ? themeId : 'paper-light'
  }
  // Dark mode — use selected if dark, otherwise default
  return theme?.mode === 'dark' ? themeId : (THEMES[themeId] ? themeId : DEFAULT_THEME_ID)
}

export const DEFAULT_THEME_ID = 'default-dark'
const BUILTIN_THEME_IDS = new Set(Object.keys(THEMES))
export const THEME_PRESETS = Object.values(THEMES)
export const THEME_OPTIONS = THEME_PRESETS.map(({ id, label, mode, description }) => ({ id, label, mode, description }))

/** Register or update a custom (extension-provided) theme at runtime. Builtins are immutable. */
export function registerCustomTheme(theme: AppTheme): void {
  if (BUILTIN_THEME_IDS.has(theme.id)) return
  const normalizedTheme = normalizePanelSurfaceTheme(theme)
  THEMES[theme.id] = normalizedTheme
  const presetIndex = THEME_PRESETS.findIndex(t => t.id === theme.id)
  if (presetIndex >= 0) THEME_PRESETS[presetIndex] = normalizedTheme
  else THEME_PRESETS.push(normalizedTheme)

  const option = { id: normalizedTheme.id, label: normalizedTheme.label, mode: normalizedTheme.mode, description: normalizedTheme.description }
  const optionIndex = THEME_OPTIONS.findIndex(t => t.id === theme.id)
  if (optionIndex >= 0) THEME_OPTIONS[optionIndex] = option
  else THEME_OPTIONS.push(option)
}

/** Remove a custom theme registered at runtime. Builtins are immutable. */
export function unregisterCustomTheme(themeId: string): void {
  if (!themeId || BUILTIN_THEME_IDS.has(themeId)) return
  delete THEMES[themeId]
  const presetIndex = THEME_PRESETS.findIndex(t => t.id === themeId)
  if (presetIndex >= 0) THEME_PRESETS.splice(presetIndex, 1)
  const optionIndex = THEME_OPTIONS.findIndex(t => t.id === themeId)
  if (optionIndex >= 0) THEME_OPTIONS.splice(optionIndex, 1)
}

export function getThemeById(id?: string | null): AppTheme {
  if (!id) return THEMES[DEFAULT_THEME_ID]
  return THEMES[id] ?? THEMES[DEFAULT_THEME_ID]
}

export function getThemeCanvasDefaults(id?: string | null): Pick<AppTheme['canvas'], 'background' | 'gridSmall' | 'gridLarge'> {
  const theme = getThemeById(id)
  return {
    background: theme.canvas.background,
    gridSmall: theme.canvas.gridSmall,
    gridLarge: theme.canvas.gridLarge,
  }
}
