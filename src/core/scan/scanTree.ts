import type { Dirent, Stats } from 'node:fs'
import type { ScanProgress } from '../../shared/types'
import { errorMessage } from '../errorMessage'
import { normalizePath } from '../paths'
import { isMarkerFile } from '../rules/markers'
import { ScanTree } from '../tree'
import { nodeFsDeps, type FsDeps } from './fsDeps'

export type ScanProgressPayload = Omit<
  ScanProgress,
  'scanId' | 'phase' | 'hashedBytes' | 'hashTotalBytes'
>

export interface ScanOptions {
  root: string
  trackFileMinBytes: number
  /** Directory reads in flight at once. */
  concurrency?: number
  progressIntervalMs?: number
  signal?: AbortSignal
  onProgress?: (p: ScanProgressPayload) => void
}

export interface ScanResult {
  tree: ScanTree
  /** True when the scan was cancelled or failed before it finished. */
  incomplete: boolean
  durationMs: number
  foldersScanned: number
  filesScanned: number
  /** Set when something unexpected went wrong in the walk. The tree is whatever was built by then. */
  error?: string
}

const DRIVE_ROOT = /^[A-Z]:\\$/
const TOP_LEVEL_COUNT = 12
const DEFAULT_CLUSTER = 4096
// Allocation beyond the size this much (or beyond double the size, if more) cannot be real.
const IMPOSSIBLE_EXTRA = 64 * 1024 * 1024

/**
 * Size on disk from lstat: `blocks * 512`, the NTFS allocation size. Some files (OneDrive's logs,
 * for one) report nonsense there, such as 5e18 bytes for a 111-byte file. When the allocation is
 * beyond the size rounded up to the cluster by more than that rounded size and by more than 64 MiB,
 * the rounded size is used instead. Ordinary over-allocation of a growing file stays as it is.
 */
export function sizeOnDiskOf(stats: Pick<Stats, 'size' | 'blocks' | 'blksize'>): number {
  if (typeof stats.blocks !== 'number') return stats.size
  const allocated = stats.blocks * 512
  const cluster = stats.blksize > 0 ? stats.blksize : DEFAULT_CLUSTER
  const rounded = Math.ceil(stats.size / cluster) * cluster
  return allocated - rounded > Math.max(rounded, IMPOSSIBLE_EXTRA) ? rounded : allocated
}

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code
}

function joinPath(folder: string, name: string): string {
  return folder.endsWith('\\') ? folder + name : `${folder}\\${name}`
}

/**
 * Walks `root` without following junctions or symlinks and builds a ScanTree. Folders it cannot read
 * are marked unreadable and files it cannot measure are listed as unmeasured; the walk carries on.
 * An unexpected error in the walk (a progress callback that throws, say) stops it the way an abort
 * does: the partial tree comes back, marked incomplete, with the message in `error`. Only a root that
 * cannot be read at all makes it throw.
 */
export async function scanTree(opts: ScanOptions, deps: FsDeps = nodeFsDeps): Promise<ScanResult> {
  const started = Date.now()
  const root = normalizePath(opts.root)
  const concurrency = opts.concurrency ?? 32
  const progressIntervalMs = opts.progressIntervalMs ?? 250

  const rootStats = await deps.lstat(root)
  const tree = new ScanTree(root, rootStats.mtimeMs, opts.trackFileMinBytes)
  let foldersScanned = 0
  let filesScanned = 0
  let currentPath = root
  let lastProgress = -Infinity
  let failure: string | undefined
  const aborted = (): boolean => opts.signal?.aborted ?? false
  const stopped = (): boolean => aborted() || failure !== undefined

  const reportProgress = (force: boolean): void => {
    if (!opts.onProgress) return
    const now = Date.now()
    if (!force && now - lastProgress < progressIntervalMs) return
    lastProgress = now
    const rootNode = tree.folders[0]
    const children = [
      ...rootNode.childIds.map((id) => tree.folders[id]),
      ...rootNode.fileIds.map((id) => tree.files[id])
    ]
    opts.onProgress({
      foldersScanned,
      filesScanned,
      bytesSeen: rootNode.sizeOnDisk,
      currentPath,
      topLevel: children
        .sort((a, b) => b.sizeOnDisk - a.sizeOnDisk)
        .slice(0, TOP_LEVEL_COUNT)
        .map((c) => ({ name: c.name, sizeOnDisk: c.sizeOnDisk }))
    })
  }

  // One entry of a folder listing. lstat, not the listing, decides what it is: OneDrive placeholders
  // and other reparse points can be listed as links while lstat sees an ordinary file.
  const addEntry = async (
    folderId: number,
    folderPath: string,
    entry: Dirent
  ): Promise<number | null> => {
    const path = joinPath(folderPath, entry.name)
    let stats: Stats
    try {
      stats = await deps.lstat(path)
    } catch (e) {
      if (errorCode(e) === 'ENOENT') return null // gone since the listing
      if (entry.isSymbolicLink()) tree.addLink(folderId, entry.name)
      else if (entry.isDirectory()) tree.markUnreadable(tree.addFolder(folderId, entry.name, 0))
      else tree.addUnmeasured(folderId, entry.name)
      return null
    }
    if (stats.isSymbolicLink()) {
      tree.addLink(folderId, entry.name) // junctions and symlinks are never followed
      return null
    }
    if (stats.isDirectory()) return tree.addFolder(folderId, entry.name, stats.mtimeMs)
    if (!stats.isFile()) return null

    const hardLinkKey = stats.nlink > 1 ? await deps.hardLinkKey(path).catch(() => null) : null
    tree.addFile(folderId, {
      name: entry.name,
      sizeOnDisk: sizeOnDiskOf(stats),
      logicalSize: stats.size,
      mtimeMs: stats.mtimeMs,
      hardLinkKey
    })
    if (stats.size < opts.trackFileMinBytes && isMarkerFile(entry.name))
      tree.addMarker(folderId, entry.name)
    filesScanned++
    return null
  }

  const visit = async (
    folderId: number,
    folderPath: string
  ): Promise<{ id: number; path: string }[]> => {
    foldersScanned++
    currentPath = folderPath
    let entries: Dirent[]
    try {
      entries = await deps.readdir(folderPath)
    } catch (e) {
      if (errorCode(e) !== 'ENOENT') tree.markUnreadable(folderId)
      return []
    }
    const subfolders: { id: number; path: string }[] = []
    for (const entry of entries) {
      if (stopped()) break
      const childId = await addEntry(folderId, folderPath, entry)
      if (childId !== null) subfolders.push({ id: childId, path: joinPath(folderPath, entry.name) })
    }
    return subfolders
  }

  // Breadth-first, with a moving head instead of shift(): shift() is slow on a queue this long.
  const queue: { id: number; path: string }[] = [{ id: 0, path: root }]
  let head = 0
  let active = 0
  await new Promise<void>((resolve) => {
    const pump = (): void => {
      while (active < concurrency && head < queue.length && !stopped()) {
        const next = queue[head++]
        active++
        visit(next.id, next.path)
          .then((subfolders) => {
            for (const subfolder of subfolders) queue.push(subfolder)
            reportProgress(false)
          })
          .catch((e) => {
            failure ??= errorMessage(e) // stops the walk; the tree built so far is kept
          })
          .finally(() => {
            active--
            if (active === 0 && (head >= queue.length || stopped())) resolve()
            else pump()
          })
      }
    }
    pump()
    if (active === 0) resolve()
  })

  const incomplete = stopped()
  const rootNode = tree.folders[0]
  if (!incomplete && DRIVE_ROOT.test(root) && rootNode.unmeasured.length > 0) {
    const sizes = await deps
      .measureLocked(rootNode.unmeasured.map((name) => joinPath(root, name)))
      .catch(() => null)
    if (sizes) {
      for (const name of [...rootNode.unmeasured]) {
        const measured = sizes.get(joinPath(root, name))
        if (!measured) continue
        tree.addFile(0, {
          name,
          sizeOnDisk: measured.size,
          logicalSize: measured.size,
          mtimeMs: measured.mtimeMs,
          hardLinkKey: null
        })
        rootNode.unmeasured.splice(rootNode.unmeasured.indexOf(name), 1)
      }
    }
  }

  try {
    reportProgress(true)
  } catch (e) {
    failure ??= errorMessage(e)
  }
  return {
    tree,
    incomplete: stopped(),
    durationMs: Date.now() - started,
    foldersScanned,
    filesScanned,
    ...(failure === undefined ? {} : { error: failure })
  }
}
