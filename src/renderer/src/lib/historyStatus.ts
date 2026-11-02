import type { CleanupItemRecord, HistoryEntry, RestoreItemRecord } from '../../../shared/types'

export type BatchStatus = 'recycled' | 'restored' | 'partly restored' | 'nothing recycled'

/** The newest restore record for each original path in the batch (records are in log order). */
function latestRestores(e: HistoryEntry): Map<string, RestoreItemRecord> {
  const latest = new Map<string, RestoreItemRecord>()
  for (const record of e.restores)
    for (const item of record.items) latest.set(item.originalPath, item)
  return latest
}

const recycledItems = (e: HistoryEntry): CleanupItemRecord[] =>
  e.batch.items.filter((i) => i.status === 'recycled')

export function batchStatus(e: HistoryEntry): BatchStatus {
  const recycled = recycledItems(e)
  if (recycled.length === 0) return 'nothing recycled'
  const latest = latestRestores(e)
  const back = recycled.filter((i) => latest.get(i.originalPath)?.status === 'restored').length
  if (back === recycled.length) return 'restored'
  return back > 0 ? 'partly restored' : 'recycled'
}

/** Items Restore can still try: recycled, not already put back, not gone from the bin. A failed one may be retried. */
export function restorableCount(e: HistoryEntry): number {
  const latest = latestRestores(e)
  return recycledItems(e).filter((i) => {
    const s = latest.get(i.originalPath)?.status
    return s !== 'restored' && s !== 'purged'
  }).length
}

export interface ItemStatus {
  label: string
  reason?: string
  tip?: string
  restoredTo?: string
}

/** One line per item in the batch's detail list. ("put back" rather than "restored", so the batch badge stays the one "restored" on screen.) */
export function itemStatus(e: HistoryEntry, item: CleanupItemRecord): ItemStatus {
  if (item.status === 'skipped') {
    return {
      label: 'skipped',
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.tip ? { tip: item.tip } : {})
    }
  }
  const r = latestRestores(e).get(item.originalPath)
  if (!r) return { label: 'in the Recycle Bin' }
  if (r.status === 'restored')
    return { label: 'put back', ...(r.restoredTo ? { restoredTo: r.restoredTo } : {}) }
  if (r.status === 'purged')
    return { label: 'gone from the Recycle Bin', ...(r.reason ? { reason: r.reason } : {}) }
  return { label: "couldn't put back", ...(r.reason ? { reason: r.reason } : {}) }
}
