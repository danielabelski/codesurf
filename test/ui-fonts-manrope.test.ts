import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { expect } from './node-expect.ts'

const ROOT = process.cwd()

describe('Manrope UI font', () => {
  test('is available for primary and secondary font pickers and is bundled', () => {
    const controls = readFileSync(join(ROOT, 'src/renderer/src/components/settings/controls.tsx'), 'utf8')
    const css = readFileSync(join(ROOT, 'src/renderer/src/index.css'), 'utf8')
    expect(controls).toContain('"Manrope"')
    expect(css).toContain("font-family: 'Manrope'")
    expect(existsSync(join(ROOT, 'src/renderer/src/assets/fonts/Manrope-VariableFont_wght.ttf'))).toBe(true)
  })
})
