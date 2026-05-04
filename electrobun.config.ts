import type { ElectrobunConfig } from 'electrobun'

export default {
  app: {
    name: 'CodeSurf',
    identifier: 'com.huggiapps.codesurf.electrobun',
    version: '0.1.0',
    description: 'Infinite canvas workspace for AI agents',
  },
  build: {
    bun: {
      entrypoint: 'electrobun/bun/index.ts',
      external: ['node-pty'],
    },
    views: {
      'codesurf-electrobun': {
        entrypoint: 'electrobun/browser/index.ts',
      },
    },
    copy: {
      'dist-electron/renderer': 'views/mainview',
      'electrobun/helpers': 'helpers',
      'bin': 'bin',
      'packages/codesurf-dreaming': 'packages/codesurf-dreaming',
      'packages/codesurf-daemon': 'packages/codesurf-daemon',
      'resources/icon.png': 'resources/icon.png',
    },
    buildFolder: 'build-electrobun',
    artifactFolder: 'artifacts-electrobun',
    mac: {
      bundleCEF: false,
      codesign: false,
      notarize: false,
      defaultRenderer: 'native',
      icons: 'resources/icon.iconset',
    },
    win: {
      bundleCEF: false,
      defaultRenderer: 'native',
      icon: 'resources/icon.ico',
    },
    linux: {
      bundleCEF: false,
      defaultRenderer: 'native',
      icon: 'resources/icon.png',
    },
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  release: {
    generatePatch: false,
  },
} satisfies ElectrobunConfig
