import { useState } from 'react'
import type { CleanupBatch, CleanupItemRecord, UndoOutcome } from '../../../shared/types'
import ConfirmDialog from './ConfirmDialog'
import { formatBytes } from '../lib/format'
import { undoConfirmText, undoResultText } from '../lib/undoText'

/** What a cleanup did: the recycled count and size, then the skipped items grouped by their reason. */
export default function ResultSummary({
  batch,
  onOpenRecycleBin,
  onDismiss,
  onUndo
}: {
  batch: CleanupBatch
  onOpenRecycleBin: () => void
  onDismiss: () => void
  onUndo: () => Promise<UndoOutcome>
}): React.JSX.Element {
  const recycled = batch.items.filter((i) => i.status === 'recycled')
  const skipped = batch.items.filter((i) => i.status === 'skipped')
  const bytes = recycled.reduce((s, i) => s + i.sizeOnDisk, 0)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [undoError, setUndoError] = useState<string | null>(null)

  const undo = (): void => {
    setConfirming(false)
    setBusy(true)
    setUndoError(null)
    onUndo()
      .then((outcome) => {
        if (outcome.status === 'busy')
          setUndoError('Stash is busy right now. Try again in a moment.')
        else if (outcome.status === 'nothing') setNote('Nothing left to put back.')
        else setNote(undoResultText(outcome.record))
      })
      .catch((e: unknown) => setUndoError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }
  // Reasons are shown exactly as the main process wrote them; new reasons need no change here.
  const byReason = new Map<string, CleanupItemRecord[]>()
  for (const item of skipped) {
    const reason = item.reason || 'skipped'
    byReason.set(reason, [...(byReason.get(reason) ?? []), item])
  }

  return (
    <div className="card" role="status">
      <h2>
        Recycled {recycled.length} item{recycled.length === 1 ? '' : 's'} ({formatBytes(bytes)}).
      </h2>
      {[...byReason].map(([reason, items]) => {
        const tips = [...new Set(items.map((i) => i.tip).filter((t): t is string => !!t))]
        return (
          <div className="skip-group" key={reason}>
            <strong>
              Skipped {items.length}: {reason}
            </strong>
            <ul>
              {items.map((i) => (
                <li key={i.findingId} className="current-path" title={i.originalPath}>
                  {i.originalPath}
                </li>
              ))}
            </ul>
            {tips.map((t) => (
              <p key={t} className="muted">
                Tip: {t}
              </p>
            ))}
          </div>
        )
      })}
      {undoError && <div className="error">{undoError}</div>}
      {note && <p>{note}</p>}
      <div className="row" style={{ marginTop: 8 }}>
        <span>Space is only freed when you empty the Recycle Bin.</span>
        {recycled.length > 0 && note === null && (
          <button className="primary" disabled={busy} onClick={() => setConfirming(true)}>
            {busy ? 'Putting back…' : 'Undo'}
          </button>
        )}
        <button onClick={onOpenRecycleBin}>Open Recycle Bin</button>
        <button className="link" onClick={onDismiss}>
          Done
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          message={undoConfirmText(recycled.length)}
          confirmLabel="Undo"
          onCancel={() => setConfirming(false)}
          onConfirm={undo}
        />
      )}
    </div>
  )
}
