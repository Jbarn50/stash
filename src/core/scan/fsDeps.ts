import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { measureLockedFiles } from './lockedFiles'

/** The file-system calls the scanner makes, so tests can make one of them fail on cue. */
export interface FsDeps {
  readdir(dir: string): Promise<Dirent[]>
  lstat(p: string): Promise<Stats>
  /** `${dev}:${ino}`: the same for every hard link to one file. */
  hardLinkKey(p: string): Promise<string>
  measureLocked(paths: string[]): Promise<Map<string, { size: number; mtimeMs: number }>>
}

export const nodeFsDeps: FsDeps = {
  readdir: (dir) => readdir(dir, { withFileTypes: true }),
  lstat: (p) => lstat(p),
  hardLinkKey: async (p) => {
    // BigInt: an NTFS file ID can be larger than a JavaScript number holds exactly.
    const s = await lstat(p, { bigint: true })
    return `${s.dev}:${s.ino}`
  },
  measureLocked: measureLockedFiles
}
