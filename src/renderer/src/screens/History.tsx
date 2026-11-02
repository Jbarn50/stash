import { useEffect, useState } from 'react'
import type { HistoryEntry, RestoreRecord } from '../../../shared/types'
import { latestUndoTarget } from '../../../shared/undoTarget'
import { api, errorText, maybeApi } from '../lib/api'
import { formatBytes, formatDate } from '../lib/format'
import { batchStatus, itemStatus, restorableCount } from '../lib/historyStatus'

/** What a restore did, worded without "restored" so the batch's own status stays the one on screen. */
function restoreNote(r: RestoreRecord): string {
  const back = r.items.filter((i) => i.status === 'restored').length
  const gone = r.items.filter((i) => i.status === 'purged').length
  const failed = r.items.filter((i) => i.status === 'failed').length
  const parts = [`${back} item${back === 1 ? '' : 's'} put back`]
  if (gone) parts.push(`${gone} no longer in the Recycle Bin`)
  if (failed) parts.push(`${failed} couldn't be put back`)
  return parts.join(', ') + '.'
}

export default function History({ onRestored }: { onRestored?: () => void }): React.JSX.Element {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [busyBatch, setBusyBatch] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  const sortNewest = (list: HistoryEntry[]): HistoryEntry[] =>
    [...list].sort((a, b) => b.batch.startedAt.localeCompare(a.batch.startedAt))

  useEffect(() => {
    const stash = maybeApi()
    if (!stash) return
    let alive = true
    stash
      .getHistory()
      .then((list) => alive && setEntries(sortNewest(list)))
      .catch((e) => alive && setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [])

  const restore = (batchId: string): void => {
    setBusyBatch(batchId)
    setError(null)
    api()
      .restoreBatch(batchId)
      .then(async (record) => {
        setNotes((n) => ({ ...n, [batchId]: restoreNote(record) }))
        setEntries(sortNewest(await api().getHistory()))
        onRestored?.()
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusyBatch(null))
  }

  const undoId = latestUndoTarget(entries ?? [])?.batchId

  return (
    <div className="screen">
      <h1>History</h1>
      {error && <div className="error">{error}</div>}
      {entries && entries.length === 0 && <p className="muted">No cleanups yet</p>}
      {(entries ?? []).map((e) => {
        const { batch } = e
        const recycledBytes = batch.items
          .filter((i) => i.status === 'recycled')
          .reduce((s, i) => s + i.sizeOnDisk, 0)
        const isOpen = open.has(batch.batchId)
        return (
          <section
            className="card batch"
            key={batch.batchId}
            aria-label={`Cleanup of ${formatDate(batch.startedAt)}`}
          >
            <div className="head">
              <button
                className="link"
                aria-expanded={isOpen}
                aria-label={`${isOpen ? 'Hide' : 'Show'} items`}
                onClick={() =>
                  setOpen((s) => {
                    const next = new Set(s)
                    if (isOpen) next.delete(batch.batchId)
                    else next.add(batch.batchId)
                    return next
                  })
                }
              >
                {isOpen ? '▾' : '▸'}
              </button>
              <span className="grow">
                <strong>{formatDate(batch.startedAt)}</strong>{' '}
                <span className="muted">
                  {batch.items.length} item{batch.items.length === 1 ? '' : 's'} ·{' '}
                  {formatBytes(recycledBytes)}
                </span>
              </span>
              <span className="badge">{batchStatus(e)}</span>
              {restorableCount(e) > 0 && (
                <button disabled={busyBatch !== null} onClick={() => restore(batch.batchId)}>
                  {busyBatch === batch.batchId
                    ? 'Restoring…'
                    : batch.batchId === undoId
                      ? 'Undo'
                      : 'Restore'}
                </button>
              )}
            </div>
            {notes[batch.batchId] && <p className="muted">{notes[batch.batchId]}</p>}
            {isOpen && (
              <table className="list">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Size</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.items.map((item) => {
                    const st = itemStatus(e, item)
                    return (
                      <tr key={item.findingId}>
                        <td className="current-path" title={item.originalPath}>
                          {item.originalPath}
                          {st.restoredTo && st.restoredTo !== item.originalPath && (
                            <div className="muted">Now at {st.restoredTo}</div>
                          )}
                        </td>
                        <td className="num">{formatBytes(item.sizeOnDisk)}</td>
                        <td>
                          {st.label}
                          {st.reason && <div className="muted">{st.reason}</div>}
                          {st.tip && <div className="muted">Tip: {st.tip}</div>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </section>
        )
      })}
    </div>
  )
}
