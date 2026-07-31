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
      false,
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
