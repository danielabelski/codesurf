/**
 * Computed theme tokens — derived from AppTheme, eliminating
 * `theme.mode === 'light' ? X : Y` ternaries scattered across components.
 *
 * Use via `useThemeTokens()`.
 */
import { useMemo } from 'react'
import type { AppTheme } from './theme'
import { useTheme } from './ThemeContext'

export interface CodeBlockTokens {
  shellBackground: string
  bodyBackground: string
  headerBackground: string
  headerColor: string
  borderColor: string
  inlineBackground: string
  inlineColor: string
  inlineBorderColor: string
}

export interface TableTokens {
  shellBackground: string
  innerBackground: string
  headerBackground: string
}

export interface ComputedTokens {
  code: CodeBlockTokens
  table: TableTokens
  /** github-dark / github-light shiki theme pair. */
  shikiTheme: [string, string]
}

export function computeTokens(theme: AppTheme): ComputedTokens {
  const isLight = theme.mode === 'light'
  // Light-mode code blocks use fixed, GitHub-inspired values so every light
  // palette gets a clean, high-contrast slab regardless of how muddy the
  // theme's panelMuted happens to be. Previously we mapped shell/body/header
  // onto overlapping surface tokens (panel ≈ panelMuted in some themes),
  // which produced a washed-out, borderless grey rectangle with no visible
  // header separator and an inline-code pill colour that didn't match the
  // block. Nailing a dedicated light code palette fixes all of that.
  return {
    code: {
      // Outer frame: paper white, same as the chat background — the body is
      // what carries the visible surface, shell just hosts the border.
      shellBackground: isLight ? '#ffffff' : theme.surface.panelMuted,
      // Body: subtle cool-white plate (#f6f8fa is GitHub's canonical value).
      bodyBackground: isLight ? '#f6f8fa' : '#0f131d',
      // Header: a shade darker than body so the language label strip reads
      // as a distinct row instead of blending into the slab.
      headerBackground: isLight ? '#eaeef3' : '#171c28',
      headerColor: isLight ? '#4b5563' : theme.text.muted,
      borderColor: isLight ? '#d7dde4' : 'transparent',
      // Inline code pills — keep them visually consistent with block code
      // but slightly higher contrast so they pop inside prose.
      inlineBackground: isLight ? '#eef1f5' : theme.surface.panelMuted,
      inlineColor: isLight ? '#1f2430' : theme.text.primary,
      inlineBorderColor: isLight ? '#d7dde4' : 'transparent',
    },
    table: {
      shellBackground: isLight ? theme.surface.panelMuted : theme.surface.panel,
      innerBackground: isLight ? theme.chat.background : '#11161f',
      headerBackground: isLight ? theme.surface.panelElevated : '#1a2230',
    },
    shikiTheme: isLight ? ['github-light', 'github-light'] : ['github-dark', 'github-dark'],
  }
}

export function useThemeTokens(): ComputedTokens {
  const theme = useTheme()
  return useMemo(() => computeTokens(theme), [theme])
}
