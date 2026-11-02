import type { Finding, WinEnv } from '../shared/types'
import { isSameOrInside } from './paths'

export interface Copy {
  path: string
  mtimeMs: number
}

/**
 * Which copy of a duplicate to keep: one outside Downloads, Temp and Desktop where possible, then the
 * oldest (likely the original), then the shortest path, then the first in ordinal order.
 */
export function suggestKeeper(copies: Copy[], env: WinEnv): number {
  const scratch = [env.downloads, env.temp, env.desktop]
  const all = copies.map((_, i) => i)
  const settled = all.filter(
    (i) => !scratch.some((folder) => isSameOrInside(copies[i].path, folder))
  )
  const pool = settled.length > 0 ? settled : all
  return pool.sort((a, b) => {
    const x = copies[a]
    const y = copies[b]
    if (x.mtimeMs !== y.mtimeMs) return x.mtimeMs - y.mtimeMs
    if (x.path.length !== y.path.length) return x.path.length - y.path.length
    return x.path < y.path ? -1 : x.path > y.path ? 1 : 0
  })[0]
}

/** Duplicate groups in which every copy is selected — cleaning them would leave no copy at all. */
export function groupsWithEveryCopySelected(
  selectedIds: ReadonlySet<string>,
  findings: Finding[]
): string[] {
  const allSelected = new Map<string, boolean>()
  for (const f of findings) {
    if (f.groupId === undefined) continue
    allSelected.set(f.groupId, (allSelected.get(f.groupId) ?? true) && selectedIds.has(f.id))
  }
  return [...allSelected].filter(([, every]) => every).map(([groupId]) => groupId)
}
