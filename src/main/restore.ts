import { link, lstat, mkdir, rename, unlink } from 'node:fs/promises'
import { win32 } from 'node:path'
import { errorMessage } from '../core/errorMessage'
import { driveOf, isSameOrInside } from '../core/paths'
import type {
  CleanupBatch,
  CleanupItemRecord,
  RestoreItemRecord,
  RestoreRecord
} from '../shared/types'
import type { CleanupLog } from './cleanupLog'

// Restore puts back what a cleanup moved to the Recycle Bin. In the bin it changes two things only:
// it takes an item's `$R` entry out, and it removes the `$I` record beside it. It never empties the
// bin and never deletes an item.
//
// What it does about a path that is taken. Node's `rename` replaces a file that is in its way, and a
// check made before it can be out of date by the time it runs, so:
// - A file comes back through a hard link: `link($R, target)` makes the target only if nothing at
//   all is there, and fails with EEXIST otherwise, in one step. Only then is the `$R` name removed;
//   the data stays under the target. A file can therefore never be overwritten. A drive that cannot
//   make hard links (FAT32, exFAT) fails the item instead of falling back to `rename`: the item stays
//   in the bin, where Explorer's own Restore can still put it back.
// - A folder cannot be hard-linked. Its parent is made first, then the target is checked, then the
//   folder is renamed straight away. A file created at that exact path in the moment between the
//   check and the rename would still be replaced: that window is as small as it can be made here.
//
// The reasons below are the fixed strings the renderer shows as written.
const NOT_FOUND = "Stash couldn't find it in the Recycle Bin"
const PURGED = 'no longer in the Recycle Bin'
const NO_FREE_NAME = "couldn't find a free name to restore it to"
const BAD_PATH = "the path in the log isn't one Stash can restore to"
const NO_HARD_LINKS =
  "this drive can't put a file back without risk to a file in its place; restore it from the Recycle Bin in Explorer: "
const RECORD_KEPT = "restored, but Stash couldn't remove its Recycle Bin record: "
const R_KEPT = "restored, but Stash couldn't take it out of the Recycle Bin: "

/** How many "(restored N)" names are tried when the original path is taken. */
const MAX_ATTEMPTS = 99

// What Windows calls an item inside the bin: `$R`, a few characters of its own and the extension.
// It is a name, never a path, so a damaged log cannot point Restore at anything but the bin's items.
const R_NAME = /^\$R[^\\/:]+$/

// A path on a drive, `X:\` and then names: not relative, rooted, drive-relative (`C:x`), network or
// device (`\\?\`).
const DRIVE_PATH = /^[A-Za-z]:\\/

// The errors of a `link` that mean the drive cannot make hard links at all, or not between these two
// places: not "something is in the way" and not a refusal of this one file.
const NO_LINK_CODES = new Set(['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR', 'ENOSYS'])

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

const codeOf = (e: unknown): unknown => (e as NodeJS.ErrnoException | null)?.code

function isMissing(e: unknown): boolean {
  return codeOf(e) === 'ENOENT'
}

/**
 * True when the log's original path is one Restore may put something at: an absolute path on a
 * drive, with no NTFS stream in it, and not inside that drive's Recycle Bin. A hand-edited or
 * damaged log is refused here. The 8.3 rule of `isPlainDrivePath` is not used: a real long name
 * such as `ABC~1.txt` would fail it.
 */
function restorablePath(path: string): boolean {
  if (typeof path !== 'string' || !DRIVE_PATH.test(path) || path.slice(2).includes(':')) {
    return false
  }
  return !isSameOrInside(path, `${path.slice(0, 2)}\\$Recycle.Bin`)
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

/** The original path, then each "(restored N)" name, in the order they are tried. */
function* targets(item: CleanupItemRecord): Generator<string> {
  yield item.originalPath
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    yield restoredName(item.originalPath, item.kind, attempt)
  }
}

/**
 * Hard-links the file `rPath` at the first of the item's targets that nothing is at, and returns
 * it; null when all are taken. The link itself is the check, so nothing can slip in between.
 */
async function linkBack(rPath: string, item: CleanupItemRecord): Promise<string | null> {
  for (const target of targets(item)) {
    try {
      await link(rPath, target)
      return target
    } catch (e) {
      if (codeOf(e) === 'EEXIST') continue
      if (NO_LINK_CODES.has(String(codeOf(e))))
        throw new Error(`${NO_HARD_LINKS}${errorMessage(e)}`, { cause: e })
      throw e
    }
  }
  return null
}

/** Renames `rPath` to the first of the item's targets that nothing is at, checked just before. */
async function renameBack(rPath: string, item: CleanupItemRecord): Promise<string | null> {
  for (const target of targets(item)) {
    if (await somethingAt(target)) continue
    await rename(rPath, target)
    return target
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
    if (!restorablePath(originalPath)) return { originalPath, status: 'failed', reason: BAD_PATH }

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

    let entry
    try {
      entry = await lstat(rPath)
    } catch (e) {
      if (isMissing(e)) return { originalPath, status: 'purged', reason: PURGED }
      throw e
    }

    // The parent goes first, so that a folder's check and its rename follow each other directly.
    await mkdir(win32.dirname(originalPath), { recursive: true })
    // Only a plain file can be hard-linked; a folder, or a link the bin holds, is renamed.
    const isFile = entry.isFile()
    const target = isFile ? await linkBack(rPath, item) : await renameBack(rPath, item)
    if (target === null) return { originalPath, status: 'failed', reason: NO_FREE_NAME }

    const restored: RestoreItemRecord = { originalPath, status: 'restored', restoredTo: target }
    if (isFile) {
      try {
        await unlink(rPath) // the bin's name for the file; its data stays under the target
      } catch (e) {
        // The file is back and still in the bin under its `$R` name, one file with two names. Its
        // `$I` record stays, so that the bin's entry is not left without one.
        if (!isMissing(e)) {
          restored.reason = `${R_KEPT}${errorMessage(e)}`
          return restored
        }
      }
    }
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
 * taken the item comes back as `name (restored)`. A file is never overwritten; for a folder see the
 * note at the top of this file. Only a log that cannot be written rejects; what has been restored
 * stays restored.
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
