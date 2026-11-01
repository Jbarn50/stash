import { win32 } from 'node:path'
import type { WinEnv } from '../shared/types'
import { isSameOrInside, normalizePath, pathKey } from './paths'

// Folders and files that sit directly under the root of any drive. Names are lower case because
// they are matched against a pathKey.
const PROTECTED_AT_DRIVE_ROOT = new Set(
  [
    'Windows',
    'Program Files',
    'Program Files (x86)',
    'ProgramData',
    '$Recycle.Bin',
    'System Volume Information',
    'Recovery',
    'Boot',
    'pagefile.sys',
    'hiberfil.sys',
    'swapfile.sys'
  ].map((name) => name.toLowerCase())
)

const DRIVE_ROOT = /^[A-Z]:\\$/
// The first name below the drive root, taken from a pathKey: `c:\windows\x` gives `windows`.
const FIRST_NAME_BELOW_DRIVE = /^[a-z]:\\([^\\]+)/
// DumpStack.log and DumpStack.log.tmp, the crash-dump files Windows keeps at a drive root.
const CRASH_DUMP = /^dumpstack\.log/
// The registry files in a profile folder: NTUSER.DAT, ntuser.dat.LOG1 and so on.
const REGISTRY_HIVE = /^ntuser\./i

// The profile folder and the personal folders. They, and every folder above them, are blocked.
function personalFolders(env: WinEnv): string[] {
  const folders = [
    env.userProfile,
    env.downloads,
    env.desktop,
    env.documents,
    env.pictures,
    env.music,
    env.videos,
    env.oneDrive
  ]
  return folders.filter((folder) => folder !== null)
}

/**
 * True for paths Stash must never move to the Recycle Bin: drive roots, Windows and program
 * folders, other users' profiles, the registry files, the user's profile and personal folders along
 * with everything above them (their contents stay open to cleanup), and Stash's own folders.
 */
export function isBlocked(p: string, env: WinEnv): boolean {
  const normalized = normalizePath(p)
  if (DRIVE_ROOT.test(normalized)) return true

  const nameBelowDrive = FIRST_NAME_BELOW_DRIVE.exec(pathKey(normalized))?.[1] ?? ''
  if (PROTECTED_AT_DRIVE_ROOT.has(nameBelowDrive) || CRASH_DUMP.test(nameBelowDrive)) return true

  // Other users' profiles, Public and Default: all of C:\Users except this user's own profile.
  if (isSameOrInside(normalized, env.usersRoot) && !isSameOrInside(normalized, env.userProfile)) {
    return true
  }

  const directlyInProfile = pathKey(win32.dirname(normalized)) === pathKey(env.userProfile)
  if (directlyInProfile && REGISTRY_HIVE.test(win32.basename(normalized))) return true

  // `normalized` is one of the personal folders, or a parent of one, when that folder lies beneath it.
  if (personalFolders(env).some((folder) => isSameOrInside(folder, normalized))) return true

  return env.stashDirs.some((dir) => isSameOrInside(normalized, dir))
}
