import { win32 } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createDetectorContext, type DetectorContext } from '../../src/core/detectors/context'
import { buildDuplicateFindings, duplicateCandidates } from '../../src/core/detectors/duplicates'
import { runStaticDetectors } from '../../src/core/detectors/index'
import { hashGroups } from '../../src/core/hash'
import { scanTree } from '../../src/core/scan/scanTree'
import type { Finding } from '../../src/shared/types'
import { buildFixture, type Fixture } from '../fixtures/buildFixture'

describe.runIf(process.platform === 'win32')('detectors on the fixture', () => {
  let fx: Fixture
  let ctx: DetectorContext
  let findings: Finding[]
  let rules: Record<string, string>

  beforeAll(async () => {
    fx = await buildFixture()
    const { tree } = await scanTree({
      root: fx.root,
      trackFileMinBytes: fx.settings.thresholds.trackFileMinBytes
    })
    ctx = createDetectorContext({
      scanId: 'fx',
      tree,
      env: fx.env,
      settings: fx.settings,
      now: Date.now(),
      // The fixture's six small frames stand in for a real sequence.
      limits: { imageSeqMinFiles: 5, imageSeqMinBytes: 307200 }
    })
    findings = runStaticDetectors(ctx)
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

  test('dev and creative leftovers on the fixture', () => {
    expect(rules[win32.join(fx.p.webapp, 'node_modules')]).toBe('dev-node-modules')
    expect(rules[win32.join(fx.p.active, 'node_modules')]).toBeUndefined()
    expect(rules[win32.join(fx.p.unity, 'Library')]).toBe('unity-library')
    expect(rules[win32.join(fx.p.venv, '.venv')]).toBe('dev-python-venv')
    expect(rules[fx.p.blend1]).toBe('blender-backups')
    expect(rules[fx.p.blend]).toBeUndefined()
    expect(rules[fx.p.frames]).toBe('image-sequences')
  })

  test('no path is reported twice', () => {
    expect(new Set(findings.map((f) => f.path)).size).toBe(findings.length)
  })

  test('duplicates on the fixture: the photo pair only, keeping the older photo', async () => {
    const groups = await hashGroups(duplicateCandidates(ctx))
    const dupes = buildDuplicateFindings(groups, { scanId: 'fx', tree: ctx.tree, env: fx.env })
    expect(dupes.map((f) => f.path).sort()).toEqual([fx.p.photo, fx.p.photoCopy].sort())
    expect(dupes.find((f) => f.suggestedKeep)?.path).toBe(fx.p.photo)
    for (const p of [fx.p.gitCopy, fx.p.nearA, fx.p.nearB, fx.p.hard1, fx.p.hard2]) {
      expect(dupes.some((f) => f.path === p)).toBe(false)
    }
  })
})
