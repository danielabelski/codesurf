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
  return {
    code: {
      shellBackground: isLight ? theme.surface.panel : theme.surface.panelMuted,
      bodyBackground: isLight ? theme.surface.panelMuted : '#0f131d',
      headerBackground: isLight ? theme.surface.panel : '#171c28',
      headerColor: theme.text.muted,
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
