import { describe, expect, test } from 'vitest'
import { formatBytes } from '../../src/renderer/src/lib/format'

describe('formatBytes', () => {
  test('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1048576)).toBe('1.0 MB')
    expect(formatBytes(Math.round(12.3 * 2 ** 30))).toBe('12.3 GB')
  })

  test('goes up to TB and never shows 1024.0 of a unit', () => {
    expect(formatBytes(1.5 * 2 ** 40)).toBe('1.5 TB')
    expect(formatBytes(2 ** 20 - 1)).toBe('1.0 MB')
    expect(formatBytes(3 * 2 ** 50)).toBe('3072.0 TB')
  })

  test('treats negative and non-finite input as zero', () => {
    expect(formatBytes(-5)).toBe('0 B')
    expect(formatBytes(Number.NaN)).toBe('0 B')
  })
})
