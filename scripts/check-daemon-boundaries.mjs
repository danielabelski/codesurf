import { readFile, readdir } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PRODUCTION_ROOTS = ['src', 'scripts', 'electrobun']
const TOP_LEVEL_FILES = ['electrobun.config.ts', 'electron.vite.config.ts']
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.tsx'])
const violations = []

async function walk(current) {
  const entries = await readdir(current, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return []
    throw error
  })
  const files = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    const path = join(current, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

function importSpecifiers(source) {
  return [
    ...source.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g),
    ...source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map(match => match[1])
}

const files = [
  ...(await Promise.all(PRODUCTION_ROOTS.map(root => walk(join(ROOT, root))))).flat(),
  ...TOP_LEVEL_FILES.map(file => join(ROOT, file)),
]

for (const file of files) {
  const source = await readFile(file, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return ''
    throw error
  })
  for (const specifier of importSpecifiers(source)) {
    const deepBinImport = specifier.includes('packages/codesurf-daemon/bin/')
      || specifier.startsWith('@codesurf/daemon/bin/')
    const privatePackageImport = /packages\/codesurf-daemon\/(?:dist|scripts|src|test|vendor)\//.test(specifier)
    if (deepBinImport || privatePackageImport) {
      violations.push(`${relative(ROOT, file)}: imports private daemon path ${specifier}`)
    }
  }
}

if (violations.length > 0) {
  console.error(`Daemon consumer boundary violations:\n${violations.sort().map(item => `- ${item}`).join('\n')}`)
  process.exitCode = 1
} else {
  console.log(`Daemon consumer boundaries OK (${files.length} production files checked)`)
}
