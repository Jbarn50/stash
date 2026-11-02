import { describe, expect, test } from 'vitest'
import { FEATURES, requireFeature } from '../../src/core/features'

describe('feature flags', () => {
  test('undo and organize are on', () => {
    expect(FEATURES.undo).toBe(true)
    expect(FEATURES.organize).toBe(true)
  })

  test('undo and organize are allowed through', () => {
    expect(() => requireFeature('undo')).not.toThrow()
    expect(() => requireFeature('organize')).not.toThrow()
  })
})
