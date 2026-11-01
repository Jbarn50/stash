import { expect, test } from 'vitest'
import { DEFAULT_SETTINGS, validateSettings } from '../../src/core/settings'

test('defaults match the spec', () =>
  expect(DEFAULT_SETTINGS.thresholds).toEqual({
    trackFileMinBytes: 1048576,
    staleMinBytes: 104857600,
    staleAgeMonths: 6,
    tempMinAgeHours: 24,
    idleDays: 30
  }))

test('validateSettings fills, normalizes and rejects', () => {
  expect(validateSettings({ exclusions: ['d:/games/'] }).exclusions).toEqual(['D:\\games'])
  expect(() => validateSettings({ thresholds: { idleDays: 0 } })).toThrow(
    'Invalid settings: thresholds.idleDays'
  )
  expect(() => validateSettings({ personalFolders: ['relative\\x'] })).toThrow(
    'Invalid settings: personalFolders'
  )
})

test('validateSettings fills every missing field from the defaults', () => {
  expect(validateSettings({})).toEqual({
    version: 1,
    exclusions: [],
    personalFolders: [],
    scanTargets: ['C:\\'],
    thresholds: {
      trackFileMinBytes: 1048576,
      staleMinBytes: 104857600,
      staleAgeMonths: 6,
      tempMinAgeHours: 24,
      idleDays: 30
    }
  })
  // One threshold given: the other four keep their defaults rather than going missing.
  expect(validateSettings({ thresholds: { idleDays: 45 } }).thresholds).toEqual({
    trackFileMinBytes: 1048576,
    staleMinBytes: 104857600,
    staleAgeMonths: 6,
    tempMinAgeHours: 24,
    idleDays: 45
  })
})

test('validateSettings hands out fresh lists, so editing a result never changes the defaults', () => {
  const edited = validateSettings({})
  edited.exclusions.push('D:\\x')
  edited.personalFolders.push('D:\\y')
  edited.scanTargets.push('D:\\')
  edited.thresholds.idleDays = 1

  const again = validateSettings({})
  expect(again.exclusions).toEqual([])
  expect(again.personalFolders).toEqual([])
  expect(again.scanTargets).toEqual(['C:\\'])
  expect(again.thresholds.idleDays).toBe(30)
})

test.each([null, undefined, 42, 'settings', []])('rejects %j instead of settings', (input) =>
  expect(() => validateSettings(input)).toThrow('Invalid settings')
)

test.each([
  [{ version: 2 }, 'version'],
  [{ exclusions: 'D:\\games' }, 'exclusions'],
  [{ exclusions: [5] }, 'exclusions'],
  [{ exclusions: ['\\\\server\\share\\x'] }, 'exclusions'],
  [{ personalFolders: ['\\no-drive'] }, 'personalFolders'],
  [{ scanTargets: ['C:'] }, 'scanTargets'],
  [{ thresholds: 5 }, 'thresholds'],
  [{ thresholds: { trackFileMinBytes: -1 } }, 'thresholds.trackFileMinBytes'],
  [{ thresholds: { staleMinBytes: Number.NaN } }, 'thresholds.staleMinBytes'],
  [{ thresholds: { staleAgeMonths: 1.5 } }, 'thresholds.staleAgeMonths'],
  [{ thresholds: { tempMinAgeHours: '24' } }, 'thresholds.tempMinAgeHours']
])('rejects %j as invalid %s', (input, field) =>
  expect(() => validateSettings(input)).toThrow(`Invalid settings: ${field}`)
)
