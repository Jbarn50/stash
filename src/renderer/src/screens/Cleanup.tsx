import { useEffect, useMemo, useState } from 'react'
import type { CleanOutcome, CleanupBatch, Finding } from '../../../shared/types'
import ConfirmDialog from '../components/ConfirmDialog'
import FindingList from '../components/FindingList'
import ResultSummary from '../components/ResultSummary'
import { api, errorText, maybeApi } from '../lib/api'
import { formatBytes } from '../lib/format'
import { CATEGORY_LABELS, CLEANABLE_CATEGORIES } from '../lib/overviewText'
import {
  initialSelection,
  selectCategory,
  selectedTotal,
  setKeeper,
  toggle,
  type Selection
} from '../lib/selection'
import { isBusy, type SessionView } from '../lib/useSession'

type RejectReason = Extract<CleanOutcome, { status: 'rejected' }>['reason']

const INCOMPLETE = "This scan didn't finish — run a full scan to clean"
const REJECTED: Record<RejectReason, string> = {
  'stale-scan': 'Your results are out of date. Scan again before cleaning.',
  'incomplete-scan': INCOMPLETE,
  busy: 'Stash is busy right now. Try again when the scan finishes.',
  'unknown-finding': 'Some selected items are no longer in the results. Scan again before cleaning.'
}
const OVERFLOW =
  'This is more than your Recycle Bin has room for. Windows will permanently remove your oldest recycled items to make space.'

type Dialog = { kind: 'confirm'; ids: string[] } | { kind: 'overflow'; ids: string[] } | null

export default function Cleanup({
  session,
  onCleaned
}: {
  session: SessionView
  onCleaned?: () => void
}): React.JSX.Element {
  const { summary } = session
  const busy = isBusy(session.state)
  const [findings, setFindings] = useState<Finding[]>([])
  const [sel, setSel] = useState<Selection>(() => initialSelection([]))
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [dialog, setDialog] = useState<Dialog>(null)
  const [cleaning, setCleaning] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<CleanupBatch | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const load = (): void => {
    api()
      .getFindings()
      .then((list) => {
        setFindings(list)
        setSel(initialSelection(list))
      })
      .catch((e) => setProblem(errorText(e)))
  }

  // App remounts this screen (key = scanId) for each new scan, so this runs once per scan.
  useEffect(() => {
    const stash = maybeApi()
    if (!stash || !summary) return
    let alive = true
    stash
      .getFindings()
      .then((list) => {
        if (!alive) return
        setFindings(list)
        setSel(initialSelection(list))
      })
      .catch((e) => alive && setProblem(errorText(e)))
    return () => {
      alive = false
    }
  }, [summary])

  const cleanable = useMemo(() => findings.filter((f) => f.safety !== 'info'), [findings])
  const info = useMemo(() => findings.filter((f) => f.safety === 'info'), [findings])
  const total = selectedTotal(sel, findings)
  const blocked = busy ? 'Wait for the scan to finish.' : summary?.incomplete ? INCOMPLETE : null

  const runClean = (ids: string[], confirmOverflow: boolean): void => {
    setDialog(null)
    setProblem(null)
    setCleaning({ done: 0, total: ids.length })
    const off = api().onCleanProgress((done, all) => setCleaning({ done, total: all }))
    api()
      .clean(ids, confirmOverflow)
      .then((out) => {
        if (out.status === 'needsOverflowConfirm') setDialog({ kind: 'overflow', ids })
        else if (out.status === 'rejected')
          setProblem(REJECTED[out.reason] ?? `Stash refused this cleanup (${out.reason}).`)
        else {
          setResult(out.batch)
          load()
          onCleaned?.()
        }
      })
      .catch((e) => setProblem(errorText(e)))
      .finally(() => {
        off()
        setCleaning(null)
      })
  }

  if (!summary) {
    return (
      <div className="screen">
        <h1>Cleanup</h1>
        <p className="muted">Run a scan from Overview to find things to clean.</p>
      </div>
    )
  }

  return (
    <div className="screen with-footer">
      <div className="cards">
        <h1>Cleanup</h1>
        {problem && <div className="error">{problem}</div>}
        {result && (
          <ResultSummary
            batch={result}
            onOpenRecycleBin={() =>
              api()
                .openRecycleBin()
                .catch((e) => setProblem(errorText(e)))
            }
            onDismiss={() => setResult(null)}
            onUndo={() => {
              const outcome = api().undoLatest()
              outcome.then(() => onCleaned?.()).catch(() => undefined)
              return outcome
            }}
          />
        )}

        {CLEANABLE_CATEGORIES.map((c) => {
          const list = cleanable.filter((f) => f.category === c)
          const bytes = list.reduce((s, f) => s + f.sizeOnDisk, 0)
          const open = expanded.has(c)
          return (
            <section className="card category-card" key={c} aria-label={CATEGORY_LABELS[c]}>
              <div className="head">
                <button
                  className="link"
                  aria-expanded={open}
                  aria-label={`${open ? 'Hide' : 'Show'} ${CATEGORY_LABELS[c]}`}
                  disabled={list.length === 0}
                  onClick={() =>
                    setExpanded((s) => {
                      const next = new Set(s)
                      if (open) next.delete(c)
                      else next.add(c)
                      return next
                    })
                  }
                >
                  {open ? '▾' : '▸'}
                </button>
                <span className="title">{CATEGORY_LABELS[c]}</span>
                <span className="muted">
                  {list.length} item{list.length === 1 ? '' : 's'} · {formatBytes(bytes)}
                </span>
                <button
                  disabled={list.length === 0}
                  onClick={() => setSel((s) => selectCategory(s, findings, c, true))}
                >
                  Select all
                </button>
                <button
                  disabled={list.length === 0}
                  onClick={() => setSel((s) => selectCategory(s, findings, c, false))}
                >
                  Select none
                </button>
              </div>
              {open && list.length > 0 && (
                <FindingList
                  findings={list}
                  sel={sel}
                  onToggle={(f) => setSel((s) => toggle(s, f))}
                  onKeep={(f) => setSel((s) => setKeeper(s, f))}
                />
              )}
            </section>
          )
        })}

        <section className="card" aria-label="Windows can clean these">
          <h2>Windows can clean these</h2>
          {info.length === 0 && <p className="muted">Nothing found.</p>}
          {info.map((f) => (
            <div
              key={f.id}
              className="finding-row"
              style={{ gridTemplateColumns: 'minmax(0,1fr) 110px' }}
            >
              <div>
                <strong>{f.title}</strong>
                <div className="path">{f.path}</div>
                <div className="why">{f.explanation}</div>
              </div>
              <span className="num">
                {f.sizeUnknown ? 'size unknown' : formatBytes(f.sizeOnDisk)}
              </span>
            </div>
          ))}
          <div className="row" style={{ marginTop: 10 }}>
            <button
              onClick={() =>
                api()
                  .openDiskCleanup()
                  .catch((e) => setProblem(errorText(e)))
              }
            >
              Open Disk Cleanup
            </button>
            <button
              onClick={() =>
                api()
                  .openStorageSettings()
                  .catch((e) => setProblem(errorText(e)))
              }
            >
              Open Storage settings
            </button>
          </div>
        </section>
      </div>

      <div className="footer">
        <span>
          {total.count} selected · {formatBytes(total.bytes)}
        </span>
        <span className="grow muted">
          {cleaning ? `Recycling ${cleaning.done} of ${cleaning.total}…` : blocked}
        </span>
        <button
          className="primary"
          disabled={total.count === 0 || !!blocked || !!cleaning}
          onClick={() => setDialog({ kind: 'confirm', ids: [...sel.selected] })}
        >
          Clean selected
        </button>
      </div>

      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          message={`${total.count} items, ${formatBytes(total.bytes)}. These go to the Recycle Bin.`}
          confirmLabel="Clean"
          onCancel={() => setDialog(null)}
          onConfirm={() => runClean(dialog.ids, false)}
        />
      )}
      {dialog?.kind === 'overflow' && (
        <ConfirmDialog
          message={OVERFLOW}
          confirmLabel="Continue anyway"
          onCancel={() => setDialog(null)}
          onConfirm={() => runClean(dialog.ids, true)}
        />
      )}
    </div>
  )
}
