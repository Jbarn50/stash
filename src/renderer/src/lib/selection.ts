import type { Bytes, Category, Finding } from '../../../shared/types'

/** What the user has ticked, and which copy of each duplicate group is being kept. */
export interface Selection {
  selected: ReadonlySet<string>
  keepers: ReadonlyMap<string, string> // groupId → finding id
}

const isKeeper = (sel: Selection, f: Finding): boolean =>
  f.groupId !== undefined && sel.keepers.get(f.groupId) === f.id

/** Can this finding be ticked at all? Info findings never; the kept copy of a duplicate group never. */
const selectable = (sel: Selection, f: Finding): boolean => f.safety !== 'info' && !isKeeper(sel, f)

/**
 * Safe findings start selected; review and info ones do not, and neither does a finding whose size is
 * unknown. Each duplicate group keeps its suggested copy (or its first copy when none is suggested).
 */
export function initialSelection(findings: Finding[]): Selection {
  const keepers = new Map<string, string>()
  for (const f of findings) {
    if (f.groupId !== undefined && f.suggestedKeep && !keepers.has(f.groupId))
      keepers.set(f.groupId, f.id)
  }
  for (const f of findings) {
    if (f.groupId !== undefined && !keepers.has(f.groupId)) keepers.set(f.groupId, f.id)
  }
  const sel: Selection = { selected: new Set(), keepers }
  const selected = new Set(
    findings
      .filter((f) => f.safety === 'safe' && !f.sizeUnknown && selectable(sel, f))
      .map((f) => f.id)
  )
  return { selected, keepers }
}

export function toggle(sel: Selection, f: Finding): Selection {
  if (!selectable(sel, f)) return sel
  const selected = new Set(sel.selected)
  if (selected.has(f.id)) selected.delete(f.id)
  else selected.add(f.id)
  return { selected, keepers: sel.keepers }
}

/** f becomes its group's kept copy and is deselected; the copy kept before becomes an ordinary one. */
export function setKeeper(sel: Selection, f: Finding): Selection {
  if (f.groupId === undefined) return sel
  const keepers = new Map(sel.keepers)
  keepers.set(f.groupId, f.id)
  const selected = new Set(sel.selected)
  selected.delete(f.id)
  return { selected, keepers }
}

/** Select all / none for a category. "All" never takes info findings or kept copies. */
export function selectCategory(
  sel: Selection,
  findings: Finding[],
  c: Category,
  on: boolean
): Selection {
  const selected = new Set(sel.selected)
  for (const f of findings) {
    if (f.category !== c) continue
    if (!on) selected.delete(f.id)
    else if (selectable(sel, f)) selected.add(f.id)
  }
  return { selected, keepers: sel.keepers }
}

export function selectedTotal(
  sel: Selection,
  findings: Finding[]
): { count: number; bytes: Bytes } {
  let count = 0
  let bytes = 0
  for (const f of findings) {
    if (!sel.selected.has(f.id)) continue
    count++
    bytes += f.sizeOnDisk
  }
  return { count, bytes }
}
