import { win32 } from 'node:path'
import type { WinEnv } from '../shared/types'
import { isPlainDrivePath, isSameOrInside, normalizePath, pathKey } from './paths'

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

// DumpStack.log and DumpStack.log.tmp, the crash-dump files Windows keeps at a drive root.
const CRASH_DUMP = /^dumpstack\.log/
// The registry files in a profile folder: NTUSER.DAT, ntuser.dat.LOG1 and so on.
const REGISTRY_HIVE = /^ntuser\./i

// The folders Stash must not clean: the user's profile and personal folders, %TEMP%, %LOCALAPPDATA%
// and Stash's own folders. Recycling a folder takes everything in it, so each is blocked together
// with every folder above it. What is inside stays open to cleanup, except inside Stash's own
// folders, which isBlocked checks separately.
function protectedFolders(env: WinEnv): string[] {
  const folders = [
    env.userProfile,
    env.downloads,
    env.desktop,
    env.documents,
    env.pictures,
    env.music,
    env.videos,
    env.oneDrive,
    env.temp,
    env.localAppData,
    ...env.stashDirs
  ]
  return folders.filter((folder) => folder !== null)
}

// Every WinEnv path the rules lean on. If one is empty, relative or another spelling of a folder,
// its rule would quietly stop matching what it should.
function envPathsArePlain(env: WinEnv): boolean {
  return [env.systemRoot, env.usersRoot, ...protectedFolders(env)].every(isPlainDrivePath)
}

/**
 * True for paths Stash must never move to the Recycle Bin:
 * - a path that is not a plain absolute path on a drive (see isPlainDrivePath), and every path when
 *   one of the paths in `env` is not: the rules below cannot be trusted, so nothing is cleaned;
 * - drive roots, and what sits directly under them: Windows, program folders, the Recycle Bin and
 *   the swap and crash-dump files;
 * - other users' profiles, and the registry files in this user's profile;
 * - this user's profile, personal folders, OneDrive, %TEMP%, %LOCALAPPDATA% and Stash's own folders,
 *   with every folder above them. What is inside them stays open to cleanup, except inside Stash's
 *   own folders.
 */
export function isBlocked(p: string, env: WinEnv): boolean {
  // Fail closed. The rules compare spellings, which is only safe for plain drive paths. No scan
  // produces anything else, so a relative, rooted, network or aliased path means something is wrong.
  if (!isPlainDrivePath(p) || !envPathsArePlain(env)) return true

  const normalized = normalizePath(p)
  // `c:\windows\x` splits into `c:`, `windows` and `x`: the drive, then the names below it.
  const [, nameBelowDrive = ''] = pathKey(normalized).split('\\')
  if (nameBelowDrive === '') return true // nothing below the drive: it is a drive root
  if (PROTECTED_AT_DRIVE_ROOT.has(nameBelowDrive) || CRASH_DUMP.test(nameBelowDrive)) return true

  // Other users' profiles, Public and Default: all of C:\Users except this user's own profile.
  if (isSameOrInside(normalized, env.usersRoot) && !isSameOrInside(normalized, env.userProfile)) {
    return true
  }

  const directlyInProfile = pathKey(win32.dirname(normalized)) === pathKey(env.userProfile)
  if (directlyInProfile && REGISTRY_HIVE.test(win32.basename(normalized))) return true

  // `normalized` is a protected folder, or a parent of one, when that folder lies beneath it.
  if (protectedFolders(env).some((folder) => isSameOrInside(folder, normalized))) return true

  return env.stashDirs.some((dir) => isSameOrInside(normalized, dir))
}
