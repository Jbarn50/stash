import { pathKey } from '../paths'
import { LOOK_DISTANCE, hammingDistance } from '../../shared/dhash'
import type { BranchKind } from '../../shared/projects'
import type { ProposedGroup } from '../../shared/organize'
import { likenessKey, suggestFolderName, type WorkflowMeta } from './likeness'

// Groups an import the user already started. It does not read the disk or move a file.

export interface GroupItem {
  path: string
  meta: WorkflowMeta | null
  dhash: string | null
}

export interface KnownSubject {
  id: string
  kind: BranchKind
  name: string
  folder: string
  hashes: readonly string[]
}

function byPath(a: string, b: string): number {
  return pathKey(a).localeCompare(pathKey(b))
}

function nearest(
  items: readonly GroupItem[],
  subjects: readonly KnownSubject[]
): KnownSubject | null {
  let best: { subject: KnownSubject; distance: number } | null = null
  for (const item of items) {
    if (item.dhash === null) continue
    for (const subject of subjects) {
      for (const hash of subject.hashes) {
        const distance = hammingDistance(item.dhash, hash)
        if (distance === null || distance > LOOK_DISTANCE) continue
        const name = subject.name.localeCompare(best?.subject.name ?? '', undefined, {
          sensitivity: 'base'
        })
        if (best === null || distance < best.distance || (distance === best.distance && name < 0)) {
          best = { subject, distance }
        }
      }
    }
  }
  return best?.subject ?? null
}

function folderFrom(items: readonly GroupItem[]): string {
  for (const item of items) {
    if (item.meta === null) continue
    const folder = suggestFolderName(item.meta)
    if (folder !== null) return folder
  }
  return ''
}

function makeGroup(
  items: readonly GroupItem[],
  reason: ProposedGroup['reason'],
  subjects: readonly KnownSubject[]
): ProposedGroup {
  const folder = folderFrom(items)
  const nearby = nearest(items, subjects)
  const branch: BranchKind = reason === 'workflow' && folder !== '' ? 'character' : 'inbox'
  return {
    id: '',
    reason,
    branch,
    folder,
    nearbySubjectId: nearby?.id ?? null,
    nearbyName: nearby?.name ?? null,
    paths: items.map((item) => item.path).sort(byPath)
  }
}

function clusterLoose(items: readonly GroupItem[]): GroupItem[][] {
  const parent = items.map((_, index) => index)
  const find = (index: number): number => {
    let at = index
    while (parent[at] !== at) at = parent[at] ?? at
    return at
  }
  const union = (left: number, right: number): void => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent[b] = a
  }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const left = items[i]?.dhash ?? null
      const right = items[j]?.dhash ?? null
      if (left === null || right === null) continue
      const distance = hammingDistance(left, right)
      if (distance !== null && distance <= LOOK_DISTANCE) union(i, j)
    }
  }
  const groups = new Map<number, GroupItem[]>()
  items.forEach((item, index) => {
    const root = find(index)
    const list = groups.get(root)
    if (list) list.push(item)
    else groups.set(root, [item])
  })
  return [...groups.values()]
}

/**
 * Workflow hashes (or the prompt and model) group first. Files with neither are clustered
 * by dHash, and a nearby existing subject is only a suggestion. Unnamed files stay Inbox.
 */
export function proposeGroups(
  items: readonly GroupItem[],
  subjects: readonly KnownSubject[]
): ProposedGroup[] {
  const byKey = new Map<string, GroupItem[]>()
  const loose: GroupItem[] = []
  for (const item of items) {
    const key = item.meta === null ? null : likenessKey(item.meta)
    if (key === null) {
      loose.push(item)
      continue
    }
    const list = byKey.get(key)
    if (list) list.push(item)
    else byKey.set(key, [item])
  }

  const groups: ProposedGroup[] = []
  for (const list of byKey.values()) groups.push(makeGroup(list, 'workflow', subjects))
  for (const list of clusterLoose(loose)) {
    const nearby = nearest(list, subjects)
    const reason = list.length > 1 || nearby !== null ? 'look' : 'inbox'
    groups.push(makeGroup(list, reason, subjects))
  }

  const rank: Record<ProposedGroup['reason'], number> = { workflow: 0, look: 1, inbox: 2 }
  return groups
    .sort((a, b) => {
      const byReason = rank[a.reason] - rank[b.reason]
      if (byReason !== 0) return byReason
      const byFolder = a.folder.localeCompare(b.folder, undefined, { sensitivity: 'base' })
      if (byFolder !== 0) return byFolder
      return byPath(a.paths[0] ?? '', b.paths[0] ?? '')
    })
    .map((group, index) => ({ ...group, id: `g${index + 1}` }))
}
