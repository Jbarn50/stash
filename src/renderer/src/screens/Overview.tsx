import { useEffect, useState } from 'react'
import type { Overview as OverviewData } from '../../../shared/types'
import { api, errorText, maybeApi } from '../lib/api'
import { formatBytes, formatPercent } from '../lib/format'
import { binLine, categoryBreakdown, freeLine, windowsLine } from '../lib/overviewText'
import { isBusy, type SessionView } from '../lib/useSession'

export default function Overview({ session }: { session: SessionView }): React.JSX.Element {
  const { state, progress, summary } = session
  const busy = isBusy(state)
  const [data, setData] = useState<OverviewData | null>(null)
  const [targets, setTargets] = useState<string[]>([])
  const [target, setTarget] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)

  // Drives and the Recycle Bin size change after every scan, so re-read them when a scan ends.
  // (A missing API is reported once, by useSession.)
  useEffect(() => {
    const stash = maybeApi()
    if (!stash) return
    let alive = true
    stash
      .getOverview()
      .then((o) => alive && setData(o))
      .catch((e) => alive && setActionError(errorText(e)))
    return () => {
      alive = false
    }
  }, [summary?.scanId, state])

  useEffect(() => {
    const stash = maybeApi()
    if (!stash) return
    let alive = true
    stash
      .getSettings()
      .then((s) => {
        if (!alive) return
        setTargets(s.scanTargets)
        setTarget((t) => t || s.scanTargets[0] || '')
      })
      .catch((e) => alive && setActionError(errorText(e)))
    return () => {
      alive = false
    }
  }, [])

  const run = (fn: () => Promise<unknown>): void => {
    setActionError(null)
    fn().catch((e) => setActionError(errorText(e)))
  }

  const topLevel = [...(progress?.topLevel ?? [])]
    .sort((a, b) => b.sizeOnDisk - a.sizeOnDisk)
    .slice(0, 8)
  const topMax = topLevel[0]?.sizeOnDisk || 1
  const breakdown = summary ? categoryBreakdown(summary.byCategory) : []

  return (
    <div className="screen">
      <h1>Overview</h1>

      {session.error && <div className="error">{session.error}</div>}
      {actionError && <div className="error">{actionError}</div>}

      <div className="card">
        <h2>Drives</h2>
        {(data?.drives ?? []).map((d) => {
          const used = Math.max(0, d.totalBytes - d.freeBytes)
          return (
            <div className="drive" key={d.root}>
              <div className="row">
                <strong>{d.root}</strong>
                <span className="muted">
                  {formatBytes(d.freeBytes)} free of {formatBytes(d.totalBytes)}
                </span>
              </div>
              <div
                className="bar"
                role="meter"
                aria-valuenow={used}
                aria-valuemin={0}
                aria-valuemax={d.totalBytes}
              >
                <span style={{ width: formatPercent(used, d.totalBytes).replace('<', '') }} />
              </div>
            </div>
          )
        })}
        {data && data.drives.length === 0 && (
          <p className="muted">No scan targets are set. Add one in Settings.</p>
        )}
      </div>

      <div className="card">
        <div className="row">
          {busy ? (
            <button onClick={() => run(() => api().cancelScan())}>Cancel</button>
          ) : (
            <>
              <button
                className="primary"
                disabled={!target}
                onClick={() => run(() => api().startScan(target))}
              >
                Scan
              </button>
              {targets.length > 1 && (
                <select
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  aria-label="Scan target"
                >
                  {targets.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
              {targets.length === 1 && <span className="muted">{targets[0]}</span>}
            </>
          )}
          {summary?.incomplete && !busy && <span className="badge warn">Incomplete scan</span>}
        </div>

        {busy && progress && (
          <div style={{ marginTop: 12 }}>
            <div className="row muted">
              <span>{progress.foldersScanned.toLocaleString()} folders</span>
              <span>{progress.filesScanned.toLocaleString()} files</span>
              <span>{formatBytes(progress.bytesSeen)}</span>
              {progress.phase === 'hashing' && (
                <span>
                  Checking duplicates: {formatBytes(progress.hashedBytes ?? 0)} of{' '}
                  {formatBytes(progress.hashTotalBytes ?? 0)}
                </span>
              )}
            </div>
            <div className="current-path" title={progress.currentPath}>
              {progress.currentPath}
            </div>
            {topLevel.length > 0 && (
              <div className="top-level">
                {topLevel.map((t) => (
                  <TopLevelBar key={t.name} name={t.name} size={t.sizeOnDisk} max={topMax} />
                ))}
              </div>
            )}
          </div>
        )}
        {busy && !progress && <p className="muted">Starting the scan…</p>}
      </div>

      {summary && !busy && (
        <div className="card">
          <div className="big-line">{freeLine(summary.reclaimable)}</div>
          {breakdown.length > 0 && (
            <ul className="breakdown">
              {breakdown.map((b) => (
                <li key={b.category}>
                  <span className="swatch" style={{ background: `var(--cat-${b.category})` }} />
                  <span>{b.label}</span>
                  <span className="muted">{formatBytes(b.bytes)}</span>
                </li>
              ))}
            </ul>
          )}
          <p>{windowsLine(summary.windowsCanClean)}</p>
          <p className="muted">
            Scanned {summary.root}: {formatBytes(summary.totalSizeOnDisk)} in{' '}
            {summary.filesScanned.toLocaleString()} files.
          </p>
          {summary.unreadableFolders > 0 && (
            <div className="row">
              <span className="muted">
                {summary.unreadableFolders.toLocaleString()} folder
                {summary.unreadableFolders === 1 ? '' : 's'} couldn&apos;t be read.
              </span>
              <button onClick={() => run(() => api().rescanAsAdmin())}>
                Rescan as administrator
              </button>
            </div>
          )}
        </div>
      )}

      {data && (
        <div className="card">
          <p>{binLine(data.recycleBinUsedBytes)}</p>
        </div>
      )}
    </div>
  )
}

function TopLevelBar({
  name,
  size,
  max
}: {
  name: string
  size: number
  max: number
}): React.JSX.Element {
  return (
    <>
      <span className="current-path" title={name}>
        {name}
      </span>
      <div className="bar">
        <span style={{ width: `${Math.max(1, (size / max) * 100)}%` }} />
      </div>
      <span className="muted" style={{ textAlign: 'right' }}>
        {formatBytes(size)}
      </span>
    </>
  )
}
