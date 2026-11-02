import type { HistoryEntry, RestoreItemRecord } from './types'

/**
 * Which cleanup Undo puts back: the newest batch that still has items History
 * would offer to Restore.
 *
 * The count must stay the same as `restorableCount` in
 * `src/renderer/src/lib/historyStatus.ts`. A failed put-back can be tried
 * again. An item already put back, or already gone from the bin, cannot.
 * This picks a batch id only. It does not move files, and it does not hand
 * back the paths.
 */
export interface UndoTarget {
  batchId: string
  startedAt: string
  restorableCount: number
}

function restorableCount(entry: HistoryEntry): number {
  const latest = new Map<string, RestoreItemRecord>()
  for (const record of entry.restores) {
    for (const item of record.items) latest.set(item.originalPath, item)
  }
  return entry.batch.items.filter((item) => {
    if (item.status !== 'recycled') return false
    const status = latest.get(item.originalPath)?.status
    return status !== 'restored' && status !== 'purged'
  }).length
}

/**
 * The newest restorable batch, compared by `startedAt`. When two batches share
 * a timestamp, the earlier one in `entries` wins. `CleanupLog.history` is
 * newest-first, so that is the later line in the log.
 */
export function latestUndoTarget(entries: readonly HistoryEntry[]): UndoTarget | null {
  let best: UndoTarget | null = null
  for (const entry of entries) {
    const count = restorableCount(entry)
    if (count === 0) continue
    if (best !== null && entry.batch.startedAt <= best.startedAt) continue
    best = {
      batchId: entry.batch.batchId,
      startedAt: entry.batch.startedAt,
      restorableCount: count
    }
  }
  return best
}
