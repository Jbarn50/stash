import { statfs as fsStatfs } from 'node:fs/promises'
import { driveOf } from '../core/paths'
import type { DriveUsage } from '../shared/types'

type Statfs = (path: string) => Promise<{ blocks: number; bsize: number; bavail: number }>

/**
 * The drives of `paths`, each once, as roots like `C:\`, in order of first appearance. A path with
 * no drive letter is left out.
 */
export function driveRoots(paths: readonly string[]): string[] {
  const roots: string[] = []
  for (const p of paths) {
    const drive = driveOf(p)
    if (drive !== '' && !roots.includes(`${drive}\\`)) roots.push(`${drive}\\`)
  }
  return roots
}

/** Size and free space of each root: `blocks * bsize` and `bavail * bsize`. A drive that fails is left out. */
export async function getDriveUsage(
  roots: string[],
  statfs: Statfs = fsStatfs
): Promise<DriveUsage[]> {
  const usage = await Promise.all(
    roots.map(async (root): Promise<DriveUsage | null> => {
      try {
        const s = await statfs(root)
        return { root, totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }
      } catch {
        return null
      }
    })
  )
  return usage.filter((u): u is DriveUsage => u !== null)
}
