import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import type { AppTheme } from './theme'

let configured = false

export function ensureMonacoConfigured(): void {
  if (configured) return
  loader.config({ monaco })
  configured = true
}

export function getMonacoThemeName(theme: AppTheme): string {
  ensureMonacoConfigured()
  const monacoThemeName = `contex-${theme.id}`
  monaco.editor.defineTheme(monacoThemeName, {
    base: theme.editor.monacoBase,
    inherit: true,
    rules: [],
    colors: {
      'editor.background': theme.editor.background,
      'editorGutter.background': theme.editor.background,
      'minimap.background': theme.editor.background,
      'editorLineNumber.foreground': theme.text.disabled,
      'editorLineNumber.activeForeground': theme.text.secondary,
      'editorStickyScroll.background': theme.editor.background,
      'editorWidget.background': theme.surface.panelElevated,
      'editorWidget.border': theme.border.default,
      'dropdown.background': theme.surface.panelElevated,
      'dropdown.border': theme.border.default,
      'list.hoverBackground': theme.surface.hover,
      'list.activeSelectionBackground': theme.surface.selection,
      'list.activeSelectionForeground': theme.text.primary,
      'list.inactiveSelectionBackground': theme.surface.selection,
      'list.inactiveSelectionForeground': theme.text.primary,
      'scrollbar.shadow': 'transparent',
    },
  })
  return monacoThemeName
}
