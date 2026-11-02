import { describe, expect, test } from 'vitest'
import { latestUndoTarget } from '../../src/core/undoTarget'
import { restorableCount } from '../../src/renderer/src/lib/historyStatus'
import type { CleanupItemRecord, HistoryEntry, RestoreItemRecord } from '../../src/shared/types'

const item = (path: string, status: 'recycled' | 'skipped'): CleanupItemRecord => ({
  findingId: path,
  ruleId: 'r',
  kind: 'file',
  originalPath: path,
  sizeOnDisk: 10,
  mtime: '2026-01-01T00:00:00.000Z',
  status,
  ...(status === 'skipped' ? { reason: 'changed since scan' } : { recycledAs: '$RABC' })
})

const entry = (
  batchId: string,
  startedAt: string,
  items: CleanupItemRecord[],
  restored: RestoreItemRecord[][] = []
): HistoryEntry => ({
  batch: { type: 'cleanup', batchId, startedAt, finishedAt: startedAt, items },
  restores: restored.map((itemsInRecord) => ({
    type: 'restore',
    batchId,
    at: startedAt,
    items: itemsInRecord
  }))
})

describe('latest undo target', () => {
  test('there is nothing to undo when history is empty or nothing is still in the bin', () => {
    expect(latestUndoTarget([])).toBeNull()
    expect(
      latestUndoTarget([entry('b', '2026-11-02T00:00:00.000Z', [item('C:\\a', 'skipped')])])
    ).toBeNull()
    const restored = entry(
      'b',
      '2026-11-02T00:00:00.000Z',
      [item('C:\\a', 'recycled')],
      [[{ originalPath: 'C:\\a', status: 'restored' }]]
    )
    const purged = entry(
      'c',
      '2026-11-02T01:00:00.000Z',
      [item('C:\\b', 'recycled')],
      [[{ originalPath: 'C:\\b', status: 'purged', reason: 'no longer in the Recycle Bin' }]]
    )
    expect(latestUndoTarget([restored, purged])).toBeNull()
  })

  test('the newest cleanup that still has items in the bin is the one Undo puts back', () => {
    const older = entry('old', '2026-11-01T00:00:00.000Z', [
      item('C:\\old', 'recycled'),
      item('C:\\skip', 'skipped')
    ])
    const newer = entry('new', '2026-11-02T00:00:00.000Z', [item('C:\\new', 'recycled')])
    expect(latestUndoTarget([older, newer])).toEqual({
      batchId: 'new',
      startedAt: '2026-11-02T00:00:00.000Z',
      restorableCount: 1
    })
    expect(latestUndoTarget([newer, older])).toEqual({
      batchId: 'new',
      startedAt: '2026-11-02T00:00:00.000Z',
      restorableCount: 1
    })
  })

  test('a newer cleanup that is already back falls through to the previous one', () => {
    const older = entry('old', '2026-11-01T00:00:00.000Z', [
      item('C:\\a', 'recycled'),
      item('C:\\b', 'recycled')
    ])
    const newer = entry(
      'new',
      '2026-11-02T00:00:00.000Z',
      [item('C:\\c', 'recycled')],
      [[{ originalPath: 'C:\\c', status: 'restored', restoredTo: 'C:\\c' }]]
    )
    expect(latestUndoTarget([newer, older])).toEqual({
      batchId: 'old',
      startedAt: '2026-11-01T00:00:00.000Z',
      restorableCount: 2
    })
  })

  test('a failed put-back can be tried again, and a partial one still counts', () => {
    const partial = entry(
      'part',
      '2026-11-02T00:00:00.000Z',
      [item('C:\\a', 'recycled'), item('C:\\b', 'recycled')],
      [[{ originalPath: 'C:\\a', status: 'restored' }]]
    )
    expect(latestUndoTarget([partial])).toEqual({
      batchId: 'part',
      startedAt: '2026-11-02T00:00:00.000Z',
      restorableCount: 1
    })
    const failed = entry(
      'fail',
      '2026-11-02T03:00:00.000Z',
      [item('C:\\d', 'recycled')],
      [[{ originalPath: 'C:\\d', status: 'failed', reason: 'in use' }]]
    )
    expect(latestUndoTarget([partial, failed])?.batchId).toBe('fail')
  })

  test('the count matches the one History uses for Restore', () => {
    const mixed = entry(
      'mix',
      '2026-11-02T00:00:00.000Z',
      [item('C:\\a', 'recycled'), item('C:\\b', 'recycled'), item('C:\\c', 'skipped')],
      [
        [
          { originalPath: 'C:\\a', status: 'restored' },
          { originalPath: 'C:\\b', status: 'failed', reason: 'in use' }
        ]
      ]
    )
    expect(latestUndoTarget([mixed])?.restorableCount).toBe(restorableCount(mixed))
    expect(restorableCount(mixed)).toBe(1)
  })
})
