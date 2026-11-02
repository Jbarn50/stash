import { lstat, mkdir, rename, unlink } from 'node:fs/promises'
import { win32 } from 'node:path'
import { errorMessage } from '../core/errorMessage'
import { driveOf } from '../core/paths'
import type {
  CleanupBatch,
  CleanupItemRecord,
  RestoreItemRecord,
  RestoreRecord
} from '../shared/types'
import type { CleanupLog } from './cleanupLog'

// Restore puts back what a cleanup moved to the Recycle Bin. In the bin it changes two things only:
// it moves an item's `$R` entry out, and it removes the `$I` record beside it. It never empties the
// bin, never deletes an item, and never overwrites a file that is in the way.
// The reasons below are the fixed strings the renderer shows as written.
const NOT_FOUND = "Stash couldn't find it in the Recycle Bin"
const PURGED = 'no longer in the Recycle Bin'
const NO_FREE_NAME = "couldn't find a free name to restore it to"
const RECORD_KEPT = "restored, but Stash couldn't remove its Recycle Bin record: "

/** How many "(restored N)" names are tried when the original path is taken. */
const MAX_ATTEMPTS = 99

// What Windows calls an item inside the bin: `$R`, a few characters of its own and the extension.
// It is a name, never a path, so a damaged log cannot point Restore at anything but the bin's items.
const R_NAME = /^\$R[^\\/:]+$/

export interface RestoreDeps {
  /** The user's own Recycle Bin folder on a drive given as `C:`. Rejects when it cannot be found. */
  binDir(drive: string): Promise<string>
  log: Pick<CleanupLog, 'append'>
  now(): number
}

/**
 * The path for the copy of `originalPath` restored beside it when the original is taken: the name
 * gets ` (restored)` on the first attempt and ` (restored N)` on attempt N from 2. A file gets it
 * before its last extension (`photo.jpg` becomes `photo (restored).jpg`), a folder, and a file with
 * no extension, at the end of the name; a dot that only starts a name (`.gitignore`) is no
 * extension. Only the last segment of the path changes.
 */
export function restoredName(
  originalPath: string,
  kind: 'file' | 'folder',
  attempt: number
): string {
  const suffix = attempt <= 1 ? ' (restored)' : ` (restored ${attempt})`
  const name = win32.basename(originalPath)
  const extension = kind === 'file' ? win32.extname(name) : ''
  const stem = name.slice(0, name.length - extension.length)
  return win32.join(win32.dirname(originalPath), `${stem}${suffix}${extension}`)
}

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * True when something, of any kind, is at `path`. lstat does not follow a link in the last place, so
 * a link that leads nowhere still counts. Only "there is nothing" is a no; an error that cannot say
 * is thrown, because rename replaces a file that is in its way.
 */
async function somethingAt(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (e) {
    if (isMissing(e)) return false
    throw e
  }
}

/** Where to put the item: its original path if that is free, else the first free "(restored N)". */
async function freePath(item: CleanupItemRecord): Promise<string | null> {
  if (!(await somethingAt(item.originalPath))) return item.originalPath
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const candidate = restoredName(item.originalPath, item.kind, attempt)
    if (!(await somethingAt(candidate))) return candidate
  }
  return null
}

/** The bin's name for the item, when it is a plain `$R` name; undefined for anything else. */
function recycledName(item: CleanupItemRecord): string | undefined {
  const { recycledAs } = item
  return typeof recycledAs === 'string' && R_NAME.test(recycledAs) ? recycledAs : undefined
}

/**
 * Moves one recycled item back and reports what happened. A failure is the item's result, not a
 * throw: every error from here on is caught and becomes `failed` with its message.
 */
async function restoreItem(
  item: CleanupItemRecord,
  deps: RestoreDeps,
  bins: Map<string, Promise<string>>
): Promise<RestoreItemRecord> {
  const { originalPath } = item
  try {
    const recycledAs = recycledName(item)
    if (item.status !== 'recycled' || recycledAs === undefined) {
      return { originalPath, status: 'failed', reason: NOT_FOUND }
    }

    // The bin is asked for once per drive. A drive whose bin cannot be found fails all its items.
    const drive = driveOf(originalPath)
    let asked = bins.get(drive)
    if (asked === undefined) {
      asked = deps.binDir(drive)
      bins.set(drive, asked)
    }
    const bin = await asked
    const rPath = win32.join(bin, recycledAs)
    const iPath = win32.join(bin, `$I${recycledAs.slice(2)}`)

    if (!(await somethingAt(rPath))) return { originalPath, status: 'purged', reason: PURGED }

    const target = await freePath(item)
    if (target === null) return { originalPath, status: 'failed', reason: NO_FREE_NAME }
    await mkdir(win32.dirname(target), { recursive: true })
    await rename(rPath, target)

    const restored: RestoreItemRecord = { originalPath, status: 'restored', restoredTo: target }
    try {
      await unlink(iPath)
    } catch (e) {
      // The data is back. A record that is already gone is what was wanted; one that cannot be
      // removed is said so, and the item is still restored.
      if (!isMissing(e)) restored.reason = `${RECORD_KEPT}${errorMessage(e)}`
    }
    return restored
  } catch (e) {
    return { originalPath, status: 'failed', reason: errorMessage(e) }
  }
}

/**
 * Puts the items of a cleanup batch back where they were, one at a time in the order of the batch,
 * and logs the result as one restore record. Only items that were recycled can be restored: skipped
 * ones never reached the bin and are left out of the record. A recycled item whose `$R` is no
 * longer in the bin is `purged`; one that cannot be put back is `failed`. If the original path is
 * taken the item comes back as `name (restored)`, and nothing is ever overwritten. Only a log that
 * cannot be written rejects; what has been restored stays restored.
 */
export async function restoreBatch(batch: CleanupBatch, deps: RestoreDeps): Promise<RestoreRecord> {
  const bins = new Map<string, Promise<string>>()
  const items: RestoreItemRecord[] = []
  for (const item of batch.items) {
    if (item.status === 'skipped') continue
    items.push(await restoreItem(item, deps, bins))
  }
  const record: RestoreRecord = {
    type: 'restore',
    batchId: batch.batchId,
    at: new Date(deps.now()).toISOString(),
    items
  }
  await deps.log.append(record)
  return record
}
