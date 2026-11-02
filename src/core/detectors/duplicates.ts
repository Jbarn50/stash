import type { Bytes, Finding, WinEnv } from '../../shared/types'
import { isBlocked } from '../blocklist'
import { suggestKeeper } from '../keeper'
import { isSameOrInside } from '../paths'
import { RULES } from '../rules/catalog'
import type { ScanTree } from '../tree'
import type { DetectorContext } from './context'
import { insideLeftoverShape } from './devLeftovers'
import { insideGitFolder, inPersonalScope } from './scope'

/** Tracked files of one size, the first sift for duplicates. */
export interface SizeGroup {
  logicalSize: Bytes
  fileIds: number[]
  paths: string[]
}

/** Files with identical content. */
export interface HashGroup {
  hash: string
  fileIds: number[]
}

/**
 * Groups of same-size personal files that might be duplicates. Run it after runStaticDetectors on
 * the same context, so files those detectors claimed are left out.
 */
export function duplicateCandidates(ctx: DetectorContext): SizeGroup[] {
  const { tree, claims, env, settings } = ctx
  const bySize = new Map<number, number[]>()
  for (const file of tree.files) {
    if (file.cloudOnly || file.extraHardLink || claims.fileClaimed(file.id)) continue
    bySize.set(file.logicalSize, [...(bySize.get(file.logicalSize) ?? []), file.id])
  }

  // Paths are only built for sizes that occur more than once: most sizes are unique.
  const groups: SizeGroup[] = []
  for (const [logicalSize, ids] of bySize) {
    if (ids.length < 2) continue
    const kept = ids
      .map((id) => ({ id, path: tree.filePath(id) }))
      .filter(
        ({ id, path }) =>
          inPersonalScope(path, env, settings) &&
          !insideGitFolder(tree, tree.files[id].folderId) &&
          !insideLeftoverShape(tree, tree.files[id].folderId) &&
          !settings.exclusions.some((excluded) => isSameOrInside(path, excluded)) &&
          !isBlocked(path, env)
      )
    if (kept.length >= 2) {
      groups.push({ logicalSize, fileIds: kept.map((k) => k.id), paths: kept.map((k) => k.path) })
    }
  }
  return groups
}

/** One finding per copy. The copies of a group share a groupId and exactly one is marked to keep. */
export function buildDuplicateFindings(
  groups: HashGroup[],
  a: { scanId: string; tree: ScanTree; env: WinEnv }
): Finding[] {
  const rule = RULES.duplicates
  const findings: Finding[] = []
  let n = 0
  groups.forEach((group, g) => {
    const groupId = `${a.scanId}:dup:${g}`
    const copies = group.fileIds.map((id) => ({
      path: a.tree.filePath(id),
      mtimeMs: a.tree.files[id].mtimeMs
    }))
    const keep = suggestKeeper(copies, a.env)
    group.fileIds.forEach((id, i) => {
      const file = a.tree.files[id]
      findings.push({
        id: `${a.scanId}:duplicates:${n++}`,
        scanId: a.scanId,
        ruleId: 'duplicates',
        category: rule.category,
        safety: rule.safety,
        title: rule.title,
        explanation: rule.explanation,
        path: copies[i].path,
        kind: 'file',
        sizeOnDisk: file.sizeOnDisk,
        logicalSize: file.logicalSize,
        mtimeMs: file.mtimeMs,
        groupId,
        ...(i === keep ? { suggestedKeep: true } : {})
      })
    })
  })
  return findings
}
