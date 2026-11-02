import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { isBlocked } from '../core/blocklist'
import { errorMessage } from '../core/errorMessage'
import { driveOf, pathKey } from '../core/paths'
import type {
  CleanOutcome,
  CleanupBatch,
  CleanupItemRecord,
  Finding,
  WinEnv
} from '../shared/types'
import type { CleanupLog } from './cleanupLog'
import type { RecycleBinInfo, RecycledRecord } from './recycleBin'

// This is the only code that moves a user's files, and it only ever moves them to the Recycle Bin.
// The reasons below are the fixed strings the renderer shows as written.
const PROTECTED = 'protected'
const CHANGED = 'changed since scan'
const TOO_BIG = 'too big for the Recycle Bin'
const BIN_OFF = 'Recycle Bin is turned off on this drive'
const BIN_UNCONFIRMED = "Stash couldn't confirm this drive's Recycle Bin"
const UNMEASURED = "Stash couldn't measure it"
const EVERY_COPY = 'would remove every copy'

/** Moves one file or folder to the Recycle Bin, or rejects. */
export interface Recycler {
  trash(path: string): Promise<void>
}

export interface CleanupDeps {
  recycler: Recycler
  /** Asked once per drive per run. */
  binInfo(drive: string): Promise<RecycleBinInfo>
  /**
   * The records Windows wrote for `originalPaths` on `drive` since `sinceMs`, keyed by `pathKey`.
   * Asked once per drive, after the last item, with the paths that moved.
   */
  findRecords(
    drive: string,
    originalPaths: string[],
    sinceMs: number
  ): Promise<Map<string, RecycledRecord>>
  log: Pick<CleanupLog, 'append'>
  env: WinEnv
  now(): number
}

/** What happened to one item: it moved, or why it did not. */
type Result = { status: 'recycled' } | { status: 'skipped'; reason: string; tip?: string }

/** What the checks of an item need besides the item. */
interface Context {
  deps: CleanupDeps
  /** The copies in each duplicate group, from every finding of the scan. */
  groups: Map<string, Finding[]>
  /** The ids selected for this cleanup. */
  selectedIds: Set<string>
}

const iso = (ms: number): string => new Date(ms).toISOString()
const skip = (reason: string): Result => ({ status: 'skipped', reason })

// A browser's own folder that cannot be moved is most likely in use by the browser. Each entry is
// matched against a lower-case path with a backslash on both ends, so only whole names match.
const BROWSER_TIPS: readonly (readonly [folders: string, tip: string])[] = [
  ['\\google\\chrome\\', 'Close Chrome and retry'],
  ['\\microsoft\\edge\\', 'Close Edge and retry'],
  ['\\mozilla\\firefox\\', 'Close Firefox and retry']
]

/** What to suggest when `path` could not be moved to the Recycle Bin. */
export function tipFor(path: string): string {
  // The backslash added at the end lets the browser's folder itself match, not only what is in it.
  const key = `${pathKey(path)}\\`
  const browser = BROWSER_TIPS.find(([folders]) => key.includes(folders))
  return browser?.[1] ?? 'Close any program using it and retry'
}

/** The findings with the later copies of an id dropped, so one path is never moved twice. */
function uniqueById(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  const unique: Finding[] = []
  for (const f of findings) {
    if (seen.has(f.id)) continue
    seen.add(f.id)
    unique.push(f)
  }
  return unique
}

function groupCopies(findings: Finding[]): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>()
  for (const f of findings) {
    if (f.groupId === undefined) continue
    const copies = groups.get(f.groupId)
    if (copies) copies.push(f)
    else groups.set(f.groupId, [f])
  }
  return groups
}

/** The drive's Recycle Bin, asked for once per run. A lookup that fails counts as unconfirmed. */
async function binOf(
  drive: string,
  bins: Map<string, RecycleBinInfo>,
  deps: CleanupDeps
): Promise<RecycleBinInfo> {
  const known = bins.get(drive)
  if (known) return known
  let bin: RecycleBinInfo
  try {
    bin = await deps.binInfo(drive)
  } catch {
    bin = { drive, status: 'unknown', maxCapacityBytes: 0, usedBytes: 0 }
  }
  bins.set(drive, bin)
  return bin
}

/** Why an item is refused before anything moves, or null when it goes on to the later checks. */
async function refusalBeforeMove(
  f: Finding,
  bins: Map<string, RecycleBinInfo>,
  deps: CleanupDeps
): Promise<string | null> {
  if (f.safety === 'info') return PROTECTED
  const bin = await binOf(driveOf(f.path), bins, deps)
  if (bin.status === 'disabled') return BIN_OFF
  if (bin.status !== 'enabled') return BIN_UNCONFIRMED
  if (f.logicalSize > bin.maxCapacityBytes) return TOO_BIG
  // A folder Stash could not read was measured short, so the size checks cannot be trusted for it.
  if (f.sizeUnknown) return UNMEASURED
  return null
}

/**
 * The first drive, in order of first appearance among `items`, whose Recycle Bin the items that are
 * not refused would overflow. A drive with nothing left to move is never reported.
 */
function firstOverflow(
  items: Finding[],
  refused: ReadonlyMap<string, string>,
  bins: ReadonlyMap<string, RecycleBinInfo>
): CleanOutcome | null {
  const eligibleByDrive = new Map<string, Finding[]>()
  for (const f of items) {
    const drive = driveOf(f.path)
    const eligible = eligibleByDrive.get(drive) ?? []
    if (!refused.has(f.id)) eligible.push(f)
    eligibleByDrive.set(drive, eligible)
  }
  for (const [drive, eligible] of eligibleByDrive) {
    const bin = bins.get(drive)
    if (bin === undefined || eligible.length === 0) continue
    const batchBytes = eligible.reduce((sum, f) => sum + f.logicalSize, 0)
    if (bin.usedBytes + batchBytes > bin.maxCapacityBytes) {
      return {
        status: 'needsOverflowConfirm',
        drive,
        batchBytes,
        binUsedBytes: bin.usedBytes,
        binMaxBytes: bin.maxCapacityBytes
      }
    }
  }
  return null
}

/**
 * True when a copy in the group that is not part of this cleanup is still there, unchanged since the
 * scan. A copy overwritten since then no longer holds what the scan found, so it does not count.
 */
async function anotherCopyRemains(groupId: string, ctx: Context): Promise<boolean> {
  const unselected = (ctx.groups.get(groupId) ?? []).filter((copy) => !ctx.selectedIds.has(copy.id))
  for (const copy of unselected) {
    if (await unchangedSinceScan(copy)) return true
  }
  return false
}

/** True when what `stats` describes at `f.path` is still what the scan saw there. */
function matchesScan(f: Finding, stats: Stats): boolean {
  // lstat does not follow the last name, so a symlink or junction put there since is neither a file
  // nor a folder, and never matches.
  if (f.kind === 'folder') return stats.isDirectory() && stats.mtimeMs === f.mtimeMs
  return stats.isFile() && stats.size === f.logicalSize && stats.mtimeMs === f.mtimeMs
}

/**
 * True when `f.path` still is, and still leads to, what the scan saw. lstat does not follow the
 * last name but does follow every folder above it, so a folder swapped for a junction after the
 * scan would pass lstat and send the move elsewhere. realpath shows where the path really leads.
 */
async function unchangedSinceScan(f: Finding): Promise<boolean> {
  try {
    if (!matchesScan(f, await lstat(f.path))) return false
    return pathKey(await realpath(f.path)) === pathKey(f.path)
  } catch {
    return false // gone, or no longer readable: not what the scan saw
  }
}

/** The checks that belong to the moment before an item moves, then the move itself. */
async function recycleItem(f: Finding, ctx: Context): Promise<Result> {
  if (isBlocked(f.path, ctx.deps.env)) return skip(PROTECTED)
  if (f.groupId !== undefined && !(await anotherCopyRemains(f.groupId, ctx))) {
    return skip(EVERY_COPY)
  }
  if (!(await unchangedSinceScan(f))) return skip(CHANGED)
  try {
    await ctx.deps.recycler.trash(f.path)
  } catch (e) {
    return {
      status: 'skipped',
      reason: `couldn't move it to the Recycle Bin: ${errorMessage(e)}`,
      tip: tipFor(f.path)
    }
  }
  return { status: 'recycled' }
}

function recordOf(f: Finding): Omit<CleanupItemRecord, 'status'> {
  return {
    findingId: f.id,
    ruleId: f.ruleId,
    kind: f.kind,
    originalPath: f.path,
    sizeOnDisk: f.sizeOnDisk,
    mtime: iso(f.mtimeMs)
  }
}

// A callback that throws must not abandon a batch whose files have already moved, unlogged.
function reportProgress(
  onProgress: ((done: number, total: number) => void) | undefined,
  done: number,
  total: number
): void {
  try {
    onProgress?.(done, total)
  } catch {
    // Progress is only shown to the user.
  }
}

/**
 * Sets `recycledAs` on the recycled records from the Recycle Bin's own records, with one lookup per
 * drive. A lookup that fails leaves that drive's records as they are: the items are in the Recycle
 * Bin all the same.
 */
async function attachRecycledAs(
  recycled: CleanupItemRecord[],
  deps: CleanupDeps,
  sinceMs: number
): Promise<void> {
  const byDrive = new Map<string, CleanupItemRecord[]>()
  for (const record of recycled) {
    const drive = driveOf(record.originalPath)
    byDrive.set(drive, [...(byDrive.get(drive) ?? []), record])
  }
  for (const [drive, records] of byDrive) {
    let found: Map<string, RecycledRecord>
    try {
      found = await deps.findRecords(
        drive,
        records.map((r) => r.originalPath),
        sinceMs
      )
    } catch {
      continue
    }
    for (const record of records) {
      const rName = found.get(pathKey(record.originalPath))?.rName
      if (rName !== undefined) record.recycledAs = rName
    }
  }
}

/**
 * Moves the selected findings to the Recycle Bin, one at a time, and logs the batch.
 *
 * What can be refused outright is refused first: info findings, drives whose bin is off or
 * unconfirmed, items too big for the bin or not measured. If the rest would overflow a drive's bin
 * and `confirmOverflow` is false, nothing is moved or logged and that drive is returned. Each
 * remaining item is then checked again just before it goes, because the disk may have changed since
 * the scan. An item that cannot go is skipped with a reason. Only a log that cannot be written
 * rejects, and the items already moved stay in the Recycle Bin.
 *
 * `allFindings` is every finding of the scan, to tell which copies of a duplicate are not selected.
 */
export async function runCleanup(
  selected: Finding[],
  allFindings: Finding[],
  confirmOverflow: boolean,
  deps: CleanupDeps,
  onProgress?: (done: number, total: number) => void
): Promise<CleanOutcome> {
  const items = uniqueById(selected)
  // Built first, so a finding that cannot be recorded fails the run before anything has moved.
  const bases = items.map(recordOf)

  const bins = new Map<string, RecycleBinInfo>()
  const refused = new Map<string, string>()
  for (const f of items) {
    const reason = await refusalBeforeMove(f, bins, deps)
    if (reason !== null) refused.set(f.id, reason)
  }
  if (!confirmOverflow) {
    const overflow = firstOverflow(items, refused, bins)
    if (overflow !== null) return overflow
  }

  const batchStartMs = deps.now()
  const ctx: Context = {
    deps,
    groups: groupCopies(allFindings),
    selectedIds: new Set(selected.map((f) => f.id))
  }
  const records: CleanupItemRecord[] = []
  for (const [i, f] of items.entries()) {
    const refusal = refused.get(f.id)
    const result = refusal === undefined ? await recycleItem(f, ctx) : skip(refusal)
    records.push({ ...bases[i], ...result })
    reportProgress(onProgress, records.length, items.length)
  }
  await attachRecycledAs(
    records.filter((r) => r.status === 'recycled'),
    deps,
    batchStartMs
  )

  const batch: CleanupBatch = {
    type: 'cleanup',
    batchId: randomUUID(),
    startedAt: iso(batchStartMs),
    finishedAt: iso(deps.now()),
    items: records
  }
  try {
    await deps.log.append(batch)
  } catch (e) {
    // The items are already in the bin. Undo reads History, so without this line it cannot see them.
    throw new Error(
      `These items are in the Recycle Bin, but Stash could not write History, so Undo cannot put them back. Restore them from Explorer. ${errorMessage(e)}`,
      { cause: e }
    )
  }
  return { status: 'done', batch }
}
