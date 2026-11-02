import { win32 } from 'node:path'

// A drive root: the one place a normalized path keeps its trailing backslash.
const DRIVE_ROOT = /^[A-Z]:\\$/
// An absolute path on a drive, as normalizePath writes it: `C:\`, then the rest.
const DRIVE_PATH = /^[A-Z]:\\/
// The shape of an 8.3 short name such as PROGRA~1 or LONGFI~1.TXT: 1-6 characters, ~ and digits,
// then an optional extension of up to 3 characters.
const SHORT_NAME = /^[^~]{1,6}~\d+(\.[^.]{1,3})?$/

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

// Windows reads these names as another spelling of a different name. It drops a trailing dot or space
// from every name (`Downloads.` is `Downloads`, and `Downloads\...` is `Downloads` itself), a colon
// starts an NTFS stream (`Windows::$INDEX_ALLOCATION` is the Windows folder), and an 8.3 short name
// (`PROGRA~1`) stands for the long one.
function isAliasName(name: string): boolean {
  return /[. ]$/.test(name) || name.includes(':') || SHORT_NAME.test(name)
}

/**
 * True when `p` is an absolute path on a drive (`C:\...`) in which every name means what it says.
 * Checking spellings, as the blocklist and the exclusions do, is only safe for such paths: any other
 * spelling of a protected folder would walk around the check. Relative, rooted, network and
 * drive-relative (`C:x`) paths are not plain either.
 */
export function isPlainDrivePath(p: string): boolean {
  const normalized = normalizePath(p)
  // `C:\a\b` splits into the drive, then its names.
  return DRIVE_PATH.test(normalized) && !normalized.split('\\').slice(1).some(isAliasName)
}
