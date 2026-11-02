import { useEffect, useState } from 'react'
import type { UndoTarget } from '../../../shared/undoTarget'
import { latestUndoTarget } from '../../../shared/undoTarget'
import { api, errorText, maybeApi } from '../lib/api'
import { formatDate } from '../lib/format'
import { undoConfirmText, undoResultText } from '../lib/undoText'
import ConfirmDialog from './ConfirmDialog'

/** The last cleanup that can still be put back, on every screen. Hidden when there is nothing. */
export default function UndoBar({
  refreshKey,
  onDone
}: {
  refreshKey: number
  onDone: () => void
}): React.JSX.Element | null {
  const [target, setTarget] = useState<UndoTarget | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const stash = maybeApi()
    if (!stash) return
    let alive = true
    stash
      .getHistory()
      .then((entries) => alive && setTarget(latestUndoTarget(entries)))
      .catch((e) => alive && setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [refreshKey])

  if (target === null && note === null && error === null) return null

  const run = (): void => {
    setConfirming(false)
    setBusy(true)
    setError(null)
    api()
      .undoLatest()
      .then((outcome) => {
        if (outcome.status === 'busy') setError('Stash is busy right now. Try again in a moment.')
        else if (outcome.status === 'nothing') setNote('Nothing left to put back.')
        else setNote(undoResultText(outcome.record))
        setTarget(null)
        onDone()
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="undo-bar" role="region" aria-label="Undo">
      {error && <span className="error">{error}</span>}
      {note && <span>{note}</span>}
      {target && (
        <>
          <span className="grow">
            Last cleanup ({formatDate(target.startedAt)}, {target.restorableCount} item
            {target.restorableCount === 1 ? '' : 's'}) can be put back.
          </span>
          <button className="primary" disabled={busy} onClick={() => setConfirming(true)}>
            {busy ? 'Putting back…' : 'Undo'}
          </button>
        </>
      )}
      {confirming && target && (
        <ConfirmDialog
          message={undoConfirmText(target.restorableCount)}
          confirmLabel="Undo"
          onCancel={() => setConfirming(false)}
          onConfirm={run}
        />
      )}
    </div>
  )
}
