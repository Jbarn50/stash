import { win32 } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createDetectorContext } from '../../src/core/detectors/context'
import { runStaticDetectors } from '../../src/core/detectors/index'
import { scanTree } from '../../src/core/scan/scanTree'
import type { Finding } from '../../src/shared/types'
import { buildFixture, type Fixture } from '../fixtures/buildFixture'

describe.runIf(process.platform === 'win32')('detectors on the fixture', () => {
  let fx: Fixture
  let findings: Finding[]
  let rules: Record<string, string>

  beforeAll(async () => {
    fx = await buildFixture()
    const { tree } = await scanTree({
      root: fx.root,
      trackFileMinBytes: fx.settings.thresholds.trackFileMinBytes
    })
    findings = runStaticDetectors(
      createDetectorContext({
        scanId: 'fx',
        tree,
        env: fx.env,
        settings: fx.settings,
        now: Date.now()
      })
    )
    rules = Object.fromEntries(findings.map((f) => [f.path, f.ruleId]))
  })
  afterAll(async () => {
    await fx?.dispose()
  })

  test('static detectors on the fixture', () => {
    expect(rules[win32.dirname(fx.p.tempOld)]).toBe('temp-user')
    expect(rules[fx.p.tempFresh]).toBeUndefined()
    expect(rules[win32.dirname(fx.p.chromeCache)]).toBe('browser-cache-chromium')
    expect(rules[win32.join(fx.env.localAppData, 'npm-cache')]).toBe('pkg-cache-npm')
    expect(rules[fx.p.setupOld]).toBe('downloads-installers')
    expect(rules[fx.p.zipOld]).toBe('downloads-installers')
    expect(rules[fx.p.setupNew]).toBeUndefined()
    expect(rules[fx.p.oldVideo]).toBe('stale-large')
    expect(rules[win32.join(fx.root, 'Windows', 'Temp')]).toBe('sys-windows-temp')
    expect(rules[win32.join(fx.root, 'Windows', 'SoftwareDistribution', 'Download')]).toBe(
      'sys-windows-update'
    )
  })

  test('no path is reported twice', () => {
    expect(new Set(findings.map((f) => f.path)).size).toBe(findings.length)
  })
})
