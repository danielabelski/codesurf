import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { DisplayMediaRequest } from '../src/main/security/permissionBoundaryCore.ts'
import {
  createHarness,
  FakeFrame,
  mainFrameDetails,
  requestDisplay,
  requestPermission,
} from './helpers/permission-boundary-harness.ts'

describe('permission boundary display capture', () => {
  test('supports a direct declared codesurf-ext child only after consent preflight', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('sharing-extension', {
      name: 'Sharing Extension',
      declaredMedia: ['display-capture'],
    })
    const extensionUrl = 'codesurf-ext://sharing-extension'
    const securityOrigin = `${extensionUrl}/`
    const child = new FakeFrame(`${extensionUrl}/index.html`, extensionUrl, 44)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)
    const displayRequest: DisplayMediaRequest = {
      frame: child,
      securityOrigin,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    }

    assert.deepEqual(await requestDisplay(trusted.session, displayRequest), {})
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        isMainFrame: false,
        mediaTypes: [],
        requestingUrl: child.url,
        securityOrigin,
      }),
      true,
    )
    assert.deepEqual(
      harness.extensionConsentPrompts,
      ['sharing-extension:display-capture'],
    )
    assert.deepEqual(
      await requestDisplay(trusted.session, { ...displayRequest, userGesture: false }),
      {},
      'preflight alone must not return a stream',
    )
    assert.equal(harness.selectionCount(), 0)
    assert.deepEqual(
      await requestDisplay(trusted.session, displayRequest),
      { video: harness.sources[1] },
    )
  })

  test('denies invalid extension display identity and revokes grants on navigation or disable', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    harness.setExtension('sharing-extension', {
      declaredMedia: ['display-capture'],
    })
    harness.setExtensionConsent('sharing-extension', ['display-capture'])
    const extensionUrl = 'codesurf-ext://sharing-extension'
    const securityOrigin = `${extensionUrl}/`
    const child = new FakeFrame(`${extensionUrl}/index.html`, extensionUrl, 45)
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, child)
    const request: DisplayMediaRequest = {
      frame: child,
      securityOrigin,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    }
    const preflight = () => requestPermission(
      trusted.session,
      trusted.contents,
      'media',
      {
        isMainFrame: false,
        mediaTypes: [],
        requestingUrl: child.url,
        securityOrigin,
      },
    )

    assert.equal(await preflight(), true)
    assert.deepEqual(
      await requestDisplay(trusted.session, {
        ...request,
        securityOrigin: 'codesurf-ext://other-extension/',
      }),
      {},
    )
    const nested = new FakeFrame(child.url, extensionUrl, 46)
    nested.parent = child
    nested.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, nested)
    assert.deepEqual(await requestDisplay(trusted.session, { ...request, frame: nested }), {})
    const internal = new FakeFrame(
      'codesurf-ext://__runext_internal/index.html',
      'codesurf-ext://__runext_internal',
      47,
    )
    internal.parent = trusted.contents.mainFrame
    internal.top = trusted.contents.mainFrame
    harness.attachFrame(trusted.contents, internal)
    assert.deepEqual(await requestDisplay(trusted.session, { ...request, frame: internal }), {})

    harness.navigate(trusted.contents)
    assert.deepEqual(await requestDisplay(trusted.session, request), {})
    assert.equal(await preflight(), true)
    harness.setExtension('sharing-extension', {
      enabled: false,
      declaredMedia: ['display-capture'],
    })
    assert.deepEqual(await requestDisplay(trusted.session, request), {})
  })

  test('requires a trusted top frame, exact origin, and user gesture', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const validRequest: DisplayMediaRequest = {
      frame: trusted.contents.mainFrame,
      securityOrigin: new URL(harness.appUrl).origin,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    }
    assert.deepEqual(
      await requestDisplay(trusted.session, validRequest),
      {},
      'display capture must not bypass its permission preflight',
    )
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'display-capture',
        new URL(harness.appUrl).origin,
        mainFrameDetails(harness.appUrl),
      ),
      false,
    )
    assert.equal(
      await requestPermission(
        trusted.session,
        trusted.contents,
        'display-capture',
        mainFrameDetails(harness.appUrl),
      ),
      true,
    )
    assert.equal(
      await requestPermission(
        trusted.session,
        trusted.contents,
        'media',
        {
          ...mainFrameDetails(harness.appUrl),
          mediaTypes: [],
        },
      ),
      true,
    )
    assert.equal(
      trusted.session.checkHandler?.(
        trusted.contents,
        'display-capture',
        new URL(harness.appUrl).origin,
        mainFrameDetails(harness.appUrl),
      ),
      true,
    )

    assert.deepEqual(
      await requestDisplay(trusted.session, { ...validRequest, frame: null }),
      {},
    )
    assert.deepEqual(
      await requestDisplay(trusted.session, { ...validRequest, userGesture: false }),
      {},
    )
    assert.deepEqual(
      await requestDisplay(trusted.session, {
        ...validRequest,
        securityOrigin: 'https://attacker.example',
      }),
      {},
    )
    assert.equal(harness.selectionCount(), 0)

    const child = new FakeFrame(
      harness.appUrl,
      new URL(harness.appUrl).origin,
      44,
    )
    child.parent = trusted.contents.mainFrame
    child.top = trusted.contents.mainFrame
    assert.deepEqual(
      await requestDisplay(trusted.session, { ...validRequest, frame: child }),
      {},
    )
  })

  test('requires explicit selection and never adds unrequested audio', async () => {
    const harness = createHarness()
    const trusted = harness.makeWindow()
    harness.boundary.registerAppWindow(trusted.window)
    const request: DisplayMediaRequest = {
      frame: trusted.contents.mainFrame,
      securityOrigin: new URL(harness.appUrl).origin,
      videoRequested: true,
      audioRequested: false,
      userGesture: true,
    }
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...mainFrameDetails(harness.appUrl),
        mediaTypes: [],
      }),
      true,
    )

    harness.setSelectedSource(undefined)
    assert.deepEqual(await requestDisplay(trusted.session, request), {})

    harness.setSelectedSource(harness.sources[1])
    assert.deepEqual(
      await requestDisplay(trusted.session, request),
      { video: harness.sources[1] },
    )

    const production = createHarness({ production: true })
    const productionWindow = production.makeWindow()
    production.boundary.registerAppWindow(productionWindow.window)
    assert.equal(
      await requestPermission(
        productionWindow.session,
        productionWindow.contents,
        'media',
        {
          ...mainFrameDetails(production.productionUrl),
          mediaTypes: [],
        },
      ),
      true,
    )
    assert.deepEqual(
      await requestDisplay(productionWindow.session, {
        ...request,
        frame: productionWindow.contents.mainFrame,
        securityOrigin: 'file:///',
      }),
      { video: production.sources[1] },
    )
  })

  test('grants loopback only when requested and supported', async () => {
    const windows = createHarness({ platform: 'win32' })
    const trusted = windows.makeWindow()
    windows.boundary.registerAppWindow(trusted.window)
    assert.equal(
      await requestPermission(trusted.session, trusted.contents, 'media', {
        ...mainFrameDetails(windows.appUrl),
        mediaTypes: [],
      }),
      true,
    )
    const request: DisplayMediaRequest = {
      frame: trusted.contents.mainFrame,
      securityOrigin: new URL(windows.appUrl).origin,
      videoRequested: true,
      audioRequested: true,
      userGesture: true,
    }
    assert.deepEqual(
      await requestDisplay(trusted.session, request),
      { video: windows.sources[1], audio: 'loopback' },
    )

    const mac = createHarness({ platform: 'darwin' })
    const macWindow = mac.makeWindow()
    mac.boundary.registerAppWindow(macWindow.window)
    assert.equal(
      await requestPermission(macWindow.session, macWindow.contents, 'media', {
        ...mainFrameDetails(mac.appUrl),
        mediaTypes: [],
      }),
      true,
    )
    assert.deepEqual(
      await requestDisplay(macWindow.session, {
        ...request,
        frame: macWindow.contents.mainFrame,
        securityOrigin: new URL(mac.appUrl).origin,
      }),
      {},
    )
  })
})
