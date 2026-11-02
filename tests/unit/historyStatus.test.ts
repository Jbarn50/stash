import { describe, expect, test } from 'vitest'
import type { CleanupItemRecord, HistoryEntry, RestoreItemRecord } from '../../src/shared/types'
import { batchStatus, itemStatus, restorableCount } from '../../src/renderer/src/lib/historyStatus'

const item = (path: string, status: 'recycled' | 'skipped'): CleanupItemRecord => ({
  findingId: path,
  ruleId: 'r',
  kind: 'file',
  originalPath: path,
  sizeOnDisk: 10,
  mtime: '2026-01-01T00:00:00.000Z',
  status,
  ...(status === 'skipped' ? { reason: 'changed since scan' } : { recycledAs: '$R' + path })
})
const entry = (items: CleanupItemRecord[], restored: RestoreItemRecord[][] = []): HistoryEntry => ({
  batch: { type: 'cleanup', batchId: 'b', startedAt: 'x', finishedAt: 'x', items },
  restores: restored.map((r) => ({ type: 'restore', batchId: 'b', at: 'y', items: r }))
})

describe('history status', () => {
  test('batchStatus covers recycled, restored, partly restored and nothing recycled', () => {
    const a = item('C:\\a', 'recycled')
    const b = item('C:\\b', 'recycled')
    expect(batchStatus(entry([a, b]))).toBe('recycled')
    expect(batchStatus(entry([a, b], [[{ originalPath: 'C:\\a', status: 'restored' }]]))).toBe(
      'partly restored'
    )
    expect(
      batchStatus(
        entry(
          [a, b],
          [
            [{ originalPath: 'C:\\a', status: 'restored' }],
            [{ originalPath: 'C:\\b', status: 'restored' }]
          ]
        )
      )
    ).toBe('restored')
    expect(batchStatus(entry([item('C:\\c', 'skipped')]))).toBe('nothing recycled')
  })

  test('restorable items exclude restored and purged ones but keep failed ones for a retry', () => {
    const items = [item('C:\\a', 'recycled'), item('C:\\b', 'recycled'), item('C:\\c', 'recycled')]
    const e = entry(items, [
      [
        { originalPath: 'C:\\a', status: 'restored' },
        { originalPath: 'C:\\b', status: 'purged', reason: 'no longer in the Recycle Bin' }
      ]
    ])
    expect(restorableCount(e)).toBe(1)
    const failed = entry(
      [item('C:\\d', 'recycled')],
      [[{ originalPath: 'C:\\d', status: 'failed', reason: 'in use' }]]
    )
    expect(restorableCount(failed)).toBe(1)
    expect(restorableCount(entry([item('C:\\e', 'skipped')]))).toBe(0)
  })

  test('itemStatus reads the latest restore record for an item', () => {
    const a = item('C:\\a', 'recycled')
    const e = entry(
      [a],
      [
        [{ originalPath: 'C:\\a', status: 'failed', reason: 'in use' }],
        [{ originalPath: 'C:\\a', status: 'restored', restoredTo: 'C:\\a (restored)' }]
      ]
    )
    expect(itemStatus(e, a)).toEqual({ label: 'put back', restoredTo: 'C:\\a (restored)' })
    expect(itemStatus(entry([a]), a)).toEqual({ label: 'in the Recycle Bin' })
    const s = item('C:\\s', 'skipped')
    expect(itemStatus(entry([s]), s)).toEqual({ label: 'skipped', reason: 'changed since scan' })
  })
})
