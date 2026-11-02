import { describe, expect, test } from 'vitest'
import {
  binLine,
  CATEGORY_LABELS,
  categoryBreakdown,
  freeLine,
  windowsLine
} from '../../src/renderer/src/lib/overviewText'

describe('overview copy', () => {
  test('overview copy', () => {
    expect(freeLine(Math.round(12.3 * 2 ** 30))).toBe('You could free about 12.3 GB')
    expect(windowsLine(Math.round(32.6 * 2 ** 30))).toBe('+ 32.6 GB Windows can clean itself')
    expect(binLine(Math.round(1.2 * 2 ** 30))).toBe(
      'Recycle Bin: 1.2 GB. Space is only freed when you empty the Recycle Bin.'
    )
  })

  test('the breakdown lists the four cleanable categories in card order, skipping empty ones', () => {
    const rows = categoryBreakdown({
      duplicates: 2 * 2 ** 30,
      tempCaches: 0,
      installersStale: 512 * 2 ** 20,
      devLeftovers: 3 * 2 ** 30,
      system: 9 * 2 ** 30
    })
    expect(rows).toEqual([
      { category: 'duplicates', label: 'Duplicate files', bytes: 2 * 2 ** 30 },
      { category: 'installersStale', label: 'Old installers & stale files', bytes: 512 * 2 ** 20 },
      { category: 'devLeftovers', label: 'Dev & creative leftovers', bytes: 3 * 2 ** 30 }
    ])
    expect(CATEGORY_LABELS.tempCaches).toBe('Temp files & caches')
  })
})
