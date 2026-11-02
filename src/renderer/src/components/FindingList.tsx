import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef } from 'react'
import type { Finding } from '../../../shared/types'
import { formatBytes } from '../lib/format'
import type { Selection } from '../lib/selection'

type Row =
  | { type: 'group'; groupId: string; count: number; bytes: number }
  | { type: 'item'; finding: Finding }

const BADGE: Record<Finding['safety'], string> = { safe: 'Safe', review: 'Review', info: 'Info' }

/** Builds the rows: duplicates grouped under a header per group, everything else largest first. */
function buildRows(findings: Finding[]): Row[] {
  const groups = new Map<string, Finding[]>()
  const loose: Finding[] = []
  for (const f of findings) {
    if (f.groupId === undefined) loose.push(f)
    else groups.set(f.groupId, [...(groups.get(f.groupId) ?? []), f])
  }
  const rows: Row[] = []
  const ordered = [...groups].sort(
    (a, b) =>
      b[1].reduce((s, f) => s + f.sizeOnDisk, 0) - a[1].reduce((s, f) => s + f.sizeOnDisk, 0)
  )
  for (const [groupId, copies] of ordered) {
    rows.push({
      type: 'group',
      groupId,
      count: copies.length,
      bytes: copies.reduce((s, f) => s + f.sizeOnDisk, 0)
    })
    for (const f of copies) rows.push({ type: 'item', finding: f })
  }
  for (const f of [...loose].sort((a, b) => b.sizeOnDisk - a.sizeOnDisk))
    rows.push({ type: 'item', finding: f })
  return rows
}

/** A virtualized list of one category's findings, with a checkbox, path, size, safety badge and explanation. */
export default function FindingList({
  findings,
  sel,
  onToggle,
  onKeep
}: {
  findings: Finding[]
  sel: Selection
  onToggle: (f: Finding) => void
  onKeep: (f: Finding) => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => buildRows(findings), [findings])
  // TanStack Virtual returns functions that the React Compiler can't memoize; the list is fine without it.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 58,
    overscan: 8
  })

  return (
    <div
      ref={scrollRef}
      className="finding-list"
      // Short lists shrink to fit; long ones scroll inside a 320 px box.
      style={{ height: Math.min(320, virtualizer.getTotalSize() + 2) }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const row = rows[v.index]
          const style: React.CSSProperties = {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${v.start}px)`
          }
          if (row.type === 'group') {
            return (
              <div
                key={`g-${row.groupId}`}
                data-index={v.index}
                ref={virtualizer.measureElement}
                className="finding-row group-head"
                style={style}
              >
                <span>{row.count} identical copies — one is always kept</span>
                <span className="num">{formatBytes(row.bytes)}</span>
              </div>
            )
          }
          const f = row.finding
          const kept = f.groupId !== undefined && sel.keepers.get(f.groupId) === f.id
          return (
            <div
              key={f.id}
              data-index={v.index}
              ref={virtualizer.measureElement}
              className="finding-row"
              style={style}
            >
              <input
                type="checkbox"
                aria-label={`Select ${f.path}`}
                checked={sel.selected.has(f.id)}
                disabled={kept || f.safety === 'info'}
                onChange={() => onToggle(f)}
              />
              <div>
                <div className="path" title={f.path}>
                  {f.path}
                </div>
                <div className="why">{f.explanation}</div>
                {f.groupId !== undefined &&
                  (kept ? (
                    <span className="badge">Keeping this one</span>
                  ) : (
                    <button className="link" onClick={() => onKeep(f)}>
                      Keep this one
                    </button>
                  ))}
              </div>
              <span className="num">
                {f.sizeUnknown ? 'size unknown' : formatBytes(f.sizeOnDisk)}
              </span>
              <span className={`badge ${f.safety}`}>{BADGE[f.safety]}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
