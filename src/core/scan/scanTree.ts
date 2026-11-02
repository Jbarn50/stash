import type { Dirent, Stats } from 'node:fs'
import type { ScanProgress } from '../../shared/types'
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
  /** True when the scan was cancelled before it finished. */
  incomplete: boolean
  durationMs: number
  foldersScanned: number
  filesScanned: number
}

const DRIVE_ROOT = /^[A-Z]:\\$/
const TOP_LEVEL_COUNT = 12

function errorCode(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code
}

function joinPath(folder: string, name: string): string {
  return folder.endsWith('\\') ? folder + name : `${folder}\\${name}`
}

/**
 * Walks `root` without following junctions or symlinks and builds a ScanTree. Folders it cannot read
 * are marked unreadable and files it cannot measure are listed as unmeasured; the walk carries on.
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
  const aborted = (): boolean => opts.signal?.aborted ?? false

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
      sizeOnDisk: typeof stats.blocks === 'number' ? stats.blocks * 512 : stats.size,
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
      if (aborted()) break
      const childId = await addEntry(folderId, folderPath, entry)
      if (childId !== null) subfolders.push({ id: childId, path: joinPath(folderPath, entry.name) })
    }
    return subfolders
  }

  // Breadth-first, with a moving head instead of shift(): shift() is slow on a queue this long.
  const queue: { id: number; path: string }[] = [{ id: 0, path: root }]
  let head = 0
  let active = 0
  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      while (active < concurrency && head < queue.length && !aborted()) {
        const next = queue[head++]
        active++
        visit(next.id, next.path)
          .then((subfolders) => {
            for (const subfolder of subfolders) queue.push(subfolder)
            reportProgress(false)
          })
          .catch(reject)
          .finally(() => {
            active--
            if (active === 0 && (head >= queue.length || aborted())) resolve()
            else pump()
          })
      }
    }
    pump()
    if (active === 0) resolve()
  })

  const incomplete = aborted()
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

  reportProgress(true)
  return { tree, incomplete, durationMs: Date.now() - started, foldersScanned, filesScanned }
}
