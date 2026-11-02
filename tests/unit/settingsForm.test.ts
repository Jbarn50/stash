import { describe, expect, test } from 'vitest'
// Only the test imports src/core: the renderer itself never does (PF-2).
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import { fromForm, toForm } from '../../src/renderer/src/lib/settingsForm'

describe('settings form', () => {
  test('settings form round-trips and converts MB with 1048576', () => {
    expect(toForm(DEFAULT_SETTINGS).trackFileMinMB).toBe(1)
    expect(fromForm(toForm(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS)
  })

  test('MB values become whole bytes', () => {
    const f = { ...toForm(DEFAULT_SETTINGS), trackFileMinMB: 1.5, staleMinMB: 0.3333 }
    const s = fromForm(f)
    expect(s.thresholds.trackFileMinBytes).toBe(1572864)
    expect(s.thresholds.staleMinBytes).toBe(Math.round(0.3333 * 1048576))
    expect(Number.isSafeInteger(s.thresholds.staleMinBytes)).toBe(true)
  })

  test('lists are copied, not shared', () => {
    const f = toForm(DEFAULT_SETTINGS)
    f.exclusions.push('C:\\Temp\\keep')
    expect(DEFAULT_SETTINGS.exclusions).not.toContain('C:\\Temp\\keep')
  })
})
