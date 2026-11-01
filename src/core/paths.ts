import { win32 } from 'node:path'

// A drive root: the one place a normalized path keeps its trailing backslash.
const DRIVE_ROOT = /^[A-Z]:\\$/

/**
 * One canonical spelling of a Windows path: backslashes, no `\\?\` prefix, `.` and `..` resolved,
 * upper-case drive letter, and no trailing backslash except on a drive root (`C:\`).
 * The case of folder and file names is kept; use `pathKey` to compare.
 */
export function normalizePath(p: string): string {
  // The prefix goes first so that `..` stops at the drive root instead of climbing out of `\\?\C:`.
  const normalized = win32
    .normalize(p.replace(/^[\\/]{2}\?[\\/]/, ''))
    .replace(/^[a-z]:/, (drive) => drive.toUpperCase())
  return normalized.length > 1 && normalized.endsWith('\\') && !DRIVE_ROOT.test(normalized)
    ? normalized.slice(0, -1)
    : normalized
}

/** The key to compare or look up paths by: Windows ignores case, so it is `normalizePath` in lower case. */
export function pathKey(p: string): string {
  return normalizePath(p).toLowerCase()
}

/** True when `child` is `parent` or lies anywhere beneath it. `C:\Windows2` is not inside `C:\Windows`. */
export function isSameOrInside(child: string, parent: string): boolean {
  const childKey = pathKey(child)
  const parentKey = pathKey(parent)
  // Only a drive root still ends in a backslash here; every other parent needs one added.
  const parentPrefix = parentKey.endsWith('\\') ? parentKey : `${parentKey}\\`
  return childKey === parentKey || childKey.startsWith(parentPrefix)
}

/** The drive a path is on, as `C:`. Empty for a path with no drive letter, such as a network path. */
export function driveOf(p: string): string {
  return /^[A-Z]:/.exec(normalizePath(p))?.[0] ?? ''
}
