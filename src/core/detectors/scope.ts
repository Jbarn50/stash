import { win32 } from 'node:path'
import type { Settings, WinEnv } from '../../shared/types'
import { isSameOrInside } from '../paths'
import type { ScanTree } from '../tree'

/**
 * Personal folders: the user's profile without AppData, plus any folders added in Settings.
 * Duplicates and stale files are only looked for here, because removing a "duplicate" inside an
 * app or game folder can break it.
 */
export function inPersonalScope(path: string, env: WinEnv, settings: Settings): boolean {
  const inProfile =
    isSameOrInside(path, env.userProfile) &&
    !isSameOrInside(path, win32.join(env.userProfile, 'AppData'))
  return inProfile || settings.personalFolders.some((folder) => isSameOrInside(path, folder))
}

/** True when the folder is a `.git` folder or lies inside one. */
export function insideGitFolder(tree: ScanTree, folderId: number): boolean {
  for (let f = folderId; f !== -1; f = tree.folders[f].parentId) {
    if (tree.folders[f].name.toLowerCase() === '.git') return true
  }
  return false
}
