import type { Finding, RuleId, Settings, WinEnv } from '../../shared/types'
import { DEFAULT_LIMITS, RULES } from '../rules/catalog'
import type { ScanTree } from '../tree'

export interface Limits {
  imageSeqMinFiles: number
  imageSeqMinBytes: number
}

/**
 * What earlier detectors have already reported. A later detector skips anything claimed, or inside
 * something claimed, so no space is reported twice.
 */
export class Claims {
  private readonly folders = new Set<number>()
  private readonly files = new Set<number>()

  constructor(private readonly tree: ScanTree) {}

  claimFolder(id: number): void {
    this.folders.add(id)
  }

  claimFile(id: number): void {
    this.files.add(id)
  }

  /** The folder itself or one of its ancestors is claimed. */
  folderClaimed(id: number): boolean {
    for (let f = id; f !== -1; f = this.tree.folders[f].parentId) {
      if (this.folders.has(f)) return true
    }
    return false
  }

  /** The file itself or a folder it is in is claimed. */
  fileClaimed(id: number): boolean {
    return this.files.has(id) || this.folderClaimed(this.tree.files[id].folderId)
  }
}

export interface DetectorContext {
  scanId: string
  tree: ScanTree
  env: WinEnv
  settings: Settings
  now: number
  limits: Limits
  claims: Claims
  /** `${scanId}:${ruleId}:${n}`, unique within the scan. */
  nextId(ruleId: RuleId): string
}

export function createDetectorContext(a: {
  scanId: string
  tree: ScanTree
  env: WinEnv
  settings: Settings
  now: number
  limits?: Partial<Limits>
}): DetectorContext {
  let counter = 0
  return {
    scanId: a.scanId,
    tree: a.tree,
    env: a.env,
    settings: a.settings,
    now: a.now,
    limits: { ...DEFAULT_LIMITS, ...a.limits },
    claims: new Claims(a.tree),
    nextId: (ruleId) => `${a.scanId}:${ruleId}:${counter++}`
  }
}

function base(
  ctx: DetectorContext,
  ruleId: RuleId
): Omit<Finding, 'path' | 'kind' | 'sizeOnDisk' | 'logicalSize' | 'mtimeMs'> {
  const rule = RULES[ruleId]
  return {
    id: ctx.nextId(ruleId),
    scanId: ctx.scanId,
    ruleId,
    category: rule.category,
    safety: rule.safety,
    title: rule.title,
    explanation: rule.explanation
  }
}

/** A finding for a whole folder. Its time is the folder's own, which cleanup checks again before moving it. */
export function folderFinding(ctx: DetectorContext, ruleId: RuleId, folderId: number): Finding {
  const folder = ctx.tree.folders[folderId]
  ctx.claims.claimFolder(folderId)
  return {
    ...base(ctx, ruleId),
    path: ctx.tree.folderPath(folderId),
    kind: 'folder',
    sizeOnDisk: folder.sizeOnDisk,
    logicalSize: folder.logicalSize,
    mtimeMs: folder.mtimeMs,
    ...(folder.unreadable ? { sizeUnknown: true } : {})
  }
}

export function fileFinding(ctx: DetectorContext, ruleId: RuleId, fileId: number): Finding {
  const file = ctx.tree.files[fileId]
  ctx.claims.claimFile(fileId)
  return {
    ...base(ctx, ruleId),
    path: ctx.tree.filePath(fileId),
    kind: 'file',
    sizeOnDisk: file.sizeOnDisk,
    logicalSize: file.logicalSize,
    mtimeMs: file.mtimeMs
  }
}
