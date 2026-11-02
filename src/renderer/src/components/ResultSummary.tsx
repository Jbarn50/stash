import type { CleanupBatch, CleanupItemRecord } from '../../../shared/types'
import { formatBytes } from '../lib/format'

/** What a cleanup did: the recycled count and size, then the skipped items grouped by their reason. */
export default function ResultSummary({
  batch,
  onOpenRecycleBin,
  onDismiss
}: {
  batch: CleanupBatch
  onOpenRecycleBin: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const recycled = batch.items.filter((i) => i.status === 'recycled')
  const skipped = batch.items.filter((i) => i.status === 'skipped')
  const bytes = recycled.reduce((s, i) => s + i.sizeOnDisk, 0)
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
      <div className="row" style={{ marginTop: 8 }}>
        <span>Space is only freed when you empty the Recycle Bin.</span>
        <button onClick={onOpenRecycleBin}>Open Recycle Bin</button>
        <button className="link" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  )
}
