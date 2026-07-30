import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import {
  formatExtensionSidebarResponse,
  scanExtensionManifests,
  toExtensionListEntry,
} from '../src/main/extensions/light-scan.ts'

describe('extension light-scan', () => {
  test('defaults workspace power extensions off until enabled in catalog', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codesurf-light-scan-'))
    const workspace = join(home, 'project')
    const extDir = join(workspace, '.codesurf', 'extensions', 'power-loop')
    await mkdir(extDir, { recursive: true })
    await writeFile(join(extDir, 'extension.json'), JSON.stringify({
      id: 'power-loop',
      name: 'Power Loop',
      version: '0.0.1',
      tier: 'power',
      contributes: { tiles: [{ type: 'loop', label: 'Loop', entry: 'index.html' }] },
    }))

    const manifests = await scanExtensionManifests(workspace, { contexHome: home })
    assert.equal(manifests.length, 1)
    assert.equal(manifests[0]?.id, 'power-loop')
    assert.equal(manifests[0]?._enabled, false)
    assert.equal(toExtensionListEntry(manifests[0]!).enabled, false)
  })

  test('formatExtensionSidebarResponse omits disabled power-tier tiles', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codesurf-sidebar-'))
    const workspace = join(home, 'project')
    const extDir = join(workspace, '.codesurf', 'extensions', 'power-tile')
    await mkdir(extDir, { recursive: true })
    await writeFile(join(extDir, 'extension.json'), JSON.stringify({
      id: 'power-tile',
      name: 'Power Tile',
      version: '0.0.1',
      tier: 'power',
      contributes: { tiles: [{ type: 'loop', label: 'Loop', entry: 'index.html' }] },
    }))

    const manifests = await scanExtensionManifests(workspace, { contexHome: home })
    const sidebar = formatExtensionSidebarResponse(manifests)
    assert.equal(sidebar.entries.length, 1)
    assert.equal(sidebar.entries[0]?.enabled, false)
    assert.equal(sidebar.tiles.length, 0)
  })

  test('skips a lightweight manifest with a traversal-shaped extension id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'codesurf-light-scan-invalid-id-'))
    const workspace = join(home, 'project')
    const extDir = join(workspace, '.codesurf', 'extensions', 'malicious')
    await mkdir(extDir, { recursive: true })
    await writeFile(join(extDir, 'extension.json'), JSON.stringify({
      id: '../mcp-server',
      name: 'Traversal',
      version: '0.0.1',
      tier: 'safe',
      contributes: { tiles: [{ type: 'escape', label: 'Escape', entry: 'index.html' }] },
    }))

    const manifests = await scanExtensionManifests(workspace, { contexHome: home })
    assert.deepEqual(manifests, [])
  })
})
