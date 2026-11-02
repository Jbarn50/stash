import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ScanSummary, ViewNode } from '../../../shared/types'
import ContextMenu, { type MenuItem } from '../components/ContextMenu'
import Treemap from '../components/Treemap'
import { api, errorText, maybeApi } from '../lib/api'
import { formatBytes, formatDate, formatPercent } from '../lib/format'

type SortKey = 'name' | 'size' | 'modified'
interface Crumb {
  id: number
  name: string
}

const ROOT_ID = 0

export default function Explore({ summary }: { summary: ScanSummary | null }): React.JSX.Element {
  const [trail, setTrail] = useState<Crumb[]>([])
  const [view, setView] = useState<ViewNode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; node: ViewNode } | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'size', desc: true })

  // App remounts this screen (key = scanId) when a new scan finishes, so the trail starts again at its root.
  const scanId = summary?.scanId
  const rootName = summary?.root ?? ''
  const crumbs = useMemo(
    () => (trail.length > 0 ? trail : [{ id: ROOT_ID, name: rootName }]),
    [trail, rootName]
  )
  const current = crumbs[crumbs.length - 1]

  useEffect(() => {
    const stash = maybeApi()
    if (!stash || !scanId) return
    let alive = true
    stash
      .getFolderView(current.id, 2)
      .then((v) => {
        if (!alive) return
        setView(v)
        setError(v ? null : 'This folder is no longer in the scan results. Scan again.')
      })
      .catch((e) => alive && setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [current.id, scanId])

  const drill = useCallback(
    (folder: ViewNode): void => {
      if (folder.id === null || folder.kind !== 'folder' || folder.unreadable) return
      setNote(null)
      setTrail([...crumbs, { id: folder.id, name: folder.name }])
    },
    [crumbs]
  )

  const menuItems = (node: ViewNode): MenuItem[] => {
    if (node.id === null) return []
    const id = node.id
    const items: MenuItem[] = [
      {
        label: 'Open in File Explorer',
        onSelect: () =>
          api()
            .showItem({ kind: node.kind === 'file' ? 'file' : 'folder', id })
            .catch((e) => setError(errorText(e)))
      }
    ]
    if (node.kind === 'folder') {
      items.push({
        label: 'Exclude from Stash',
        onSelect: () =>
          api()
            .excludeFolder(id)
            .then(() =>
              setNote(`${node.name} is excluded. Stash won't suggest cleaning anything in it.`)
            )
            .catch((e) => setError(errorText(e)))
      })
    }
    return items
  }

  const children = useMemo(() => {
    const rows = [...(view?.children ?? [])]
    const dir = sort.desc ? -1 : 1
    rows.sort((a, b) => {
      if (sort.key === 'name') return dir * a.name.localeCompare(b.name)
      if (sort.key === 'modified') return dir * ((a.mtimeMs ?? 0) - (b.mtimeMs ?? 0))
      return dir * (a.sizeOnDisk - b.sizeOnDisk)
    })
    return rows
  }, [view, sort])

  if (!summary) {
    return (
      <div className="screen">
        <h1>Explore</h1>
        <p className="muted">Run a scan from Overview to explore where the space goes.</p>
      </div>
    )
  }

  const header = (key: SortKey, label: string, num = false): React.JSX.Element => (
    <th
      className={num ? 'num' : undefined}
      aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : 'none'}
    >
      <button
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' }))}
      >
        {label}
        {sort.key === key ? (sort.desc ? ' ▼' : ' ▲') : ''}
      </button>
    </th>
  )

  return (
    <div className="screen">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <nav className="breadcrumb" aria-label="Folder path">
          {crumbs.map((c, i) => (
            <span key={`${c.id}-${i}`} className="row" style={{ gap: 4 }}>
              {i > 0 && <span className="muted">›</span>}
              <button
                aria-current={i === crumbs.length - 1 ? 'page' : undefined}
                onClick={() => setTrail(crumbs.slice(0, i + 1))}
              >
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        {summary.incomplete && <span className="badge warn">Incomplete scan</span>}
      </div>

      {error && <div className="error">{error}</div>}
      {note && <p className="muted">{note}</p>}

      {view && (
        <>
          <Treemap root={view} onDrill={drill} onMenu={(node, x, y) => setMenu({ node, x, y })} />
          <table className="list">
            <thead>
              <tr>
                {header('name', 'Name')}
                {header('size', 'Size on disk', true)}
                <th className="num">% of parent</th>
                {header('modified', 'Modified')}
              </tr>
            </thead>
            <tbody>
              {children.map((c, i) => {
                const canDrill = c.kind === 'folder' && c.id !== null && !c.unreadable
                return (
                  <tr
                    key={`${c.kind}-${c.id ?? c.name}-${i}`}
                    className={canDrill ? 'clickable' : undefined}
                    onClick={() => canDrill && drill(c)}
                    onContextMenu={(e) => {
                      if (c.id === null || (c.kind !== 'folder' && c.kind !== 'file')) return
                      e.preventDefault()
                      setMenu({ node: c, x: e.clientX, y: e.clientY })
                    }}
                  >
                    <td>
                      <span aria-hidden="true">
                        {c.kind === 'folder' ? '📁 ' : c.kind === 'link' ? '↪ ' : ''}
                      </span>
                      <span className="name">{c.name}</span>
                      {c.unreadable && (
                        <span className="badge warn" style={{ marginLeft: 8 }}>
                          Can&apos;t read
                        </span>
                      )}
                      {c.kind === 'link' && <span className="muted"> (link, not followed)</span>}
                    </td>
                    <td className="num">{formatBytes(c.sizeOnDisk)}</td>
                    <td className="num">{formatPercent(c.sizeOnDisk, view.sizeOnDisk)}</td>
                    <td>{c.mtimeMs ? formatDate(c.mtimeMs) : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}

      {menu && menuItems(menu.node).length > 0 && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.node)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
