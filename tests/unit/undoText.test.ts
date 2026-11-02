import { expect, test } from 'vitest'
import { undoConfirmText, undoResultText } from '../../src/renderer/src/lib/undoText'
import type { RestoreRecord } from '../../src/shared/types'

test('undo tells the user items go back and the bin is not emptied', () => {
  expect(undoConfirmText(1)).toBe(
    'Put 1 item back where it was. Stash does not delete it, and it does not empty the Recycle Bin.'
  )
  expect(undoConfirmText(2)).toContain('2 items')
  expect(undoConfirmText(2)).toContain('does not empty the Recycle Bin')
})

test('undo reports what restore did', () => {
  const record: RestoreRecord = {
    type: 'restore',
    batchId: 'b',
    at: '2026-11-02T00:00:00.000Z',
    items: [
      { originalPath: 'C:\\a', status: 'restored' },
      { originalPath: 'C:\\b', status: 'purged' },
      { originalPath: 'C:\\c', status: 'failed' }
    ]
  }
  expect(undoResultText(record)).toBe(
    "Put 1 item back. 1 no longer in the Recycle Bin. 1 couldn't be put back."
  )
  expect(undoResultText({ ...record, items: [] })).toBe('Nothing left to put back.')
})
