import type { Bytes, Category, Finding, ScanSummary } from '../shared/types'
import type { ScanTree } from './tree'

/**
 * What cleaning could free. Info findings are counted separately, as space Windows can clean itself,
 * and the copy kept in each duplicate group is never counted.
 */
export function summarizeFindings(fs: Finding[]): {
  reclaimable: Bytes
  byCategory: Record<Category, Bytes>
  windowsCanClean: Bytes
} {
  const byCategory: Record<Category, Bytes> = {
    duplicates: 0,
    tempCaches: 0,
    installersStale: 0,
    devLeftovers: 0,
    system: 0
  }
  let reclaimable = 0
  let windowsCanClean = 0
  for (const f of fs) {
    if (f.safety === 'info') {
      if (!f.sizeUnknown) windowsCanClean += f.sizeOnDisk
    } else if (!f.suggestedKeep) {
      reclaimable += f.sizeOnDisk
      byCategory[f.category] += f.sizeOnDisk
    }
  }
  return { reclaimable, byCategory, windowsCanClean }
}

export function buildSummary(a: {
  scanId: string
  root: string
  incomplete: boolean
  foldersScanned: number
  filesScanned: number
  durationMs: number
  tree: ScanTree
  findings: Finding[]
}): ScanSummary {
  return {
    scanId: a.scanId,
    root: a.root,
    incomplete: a.incomplete,
    foldersScanned: a.foldersScanned,
    filesScanned: a.filesScanned,
    totalSizeOnDisk: a.tree.folders[0].sizeOnDisk,
    unreadableFolders: a.tree.unreadableCount,
    ...summarizeFindings(a.findings),
    durationMs: a.durationMs
  }
}
