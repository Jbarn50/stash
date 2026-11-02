import { describe, expect, test } from 'vitest'
import { FEATURES, requireFeature } from '../../src/core/features'

describe('feature flags', () => {
  test('undo is on, and organize stays off until it can move files safely', () => {
    expect(FEATURES.undo).toBe(true)
    expect(FEATURES.organize).toBe(false)
  })

  test('organize refuses, and undo is allowed through', () => {
    expect(() => requireFeature('organize')).toThrow(/feature off: organize/)
    expect(() => requireFeature('undo')).not.toThrow()
  })
})
