import type { ViewNode } from '../shared/types'
import type { ScanTree } from './tree'

/** How many children a folder shows before the smallest are merged into one "other" node. */
export const VIEW_CAP = 100
const MAX_DEPTH = 3

// A child before it is turned into a node: a folder's own children are only built for the folders
// that are kept, so a folder with many subfolders does not build views it then throws away.
interface Entry {
  sizeOnDisk: number
  build(): ViewNode
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many)

function folderNode(tree: ScanTree, folderId: number, levels: number, cap: number): ViewNode {
  const folder = tree.folders[folderId]
  const node: ViewNode = {
    kind: 'folder',
    id: folderId,
    name: folder.name,
    sizeOnDisk: folder.sizeOnDisk,
    mtimeMs: folder.newestMtimeMs
  }
  if (folder.unreadable) node.unreadable = true
  if (levels > 0) node.children = childrenOf(tree, folderId, levels - 1, cap)
  return node
}

function childrenOf(tree: ScanTree, folderId: number, levels: number, cap: number): ViewNode[] {
  const folder = tree.folders[folderId]
  const entries: Entry[] = []
  for (const childId of folder.childIds) {
    entries.push({
      sizeOnDisk: tree.folders[childId].sizeOnDisk,
      build: () => folderNode(tree, childId, levels, cap)
    })
  }
  for (const fileId of folder.fileIds) {
    const file = tree.files[fileId]
    // Another name for a file already counted adds nothing to the folder, so it takes no space here.
    const sizeOnDisk = file.extraHardLink ? 0 : file.sizeOnDisk
    entries.push({
      sizeOnDisk,
      build: () => ({
        kind: 'file',
        id: fileId,
        name: file.name,
        sizeOnDisk,
        mtimeMs: file.mtimeMs
      })
    })
  }
  if (folder.smallFilesCount > 0) {
    const n = folder.smallFilesCount
    const node: ViewNode = {
      kind: 'small',
      id: null,
      name: `(${n} ${plural(n, 'small file', 'small files')})`,
      sizeOnDisk: folder.smallFilesSize,
      mtimeMs: null
    }
    entries.push({ sizeOnDisk: node.sizeOnDisk, build: () => node })
  }
  for (const name of folder.links) {
    const node: ViewNode = { kind: 'link', id: null, name, sizeOnDisk: 0, mtimeMs: null }
    entries.push({ sizeOnDisk: 0, build: () => node })
  }

  // Array.prototype.sort is stable, so equal sizes keep the order above.
  entries.sort((a, b) => b.sizeOnDisk - a.sizeOnDisk)
  if (entries.length <= cap) return entries.map((e) => e.build())

  const kept = entries.slice(0, Math.max(0, cap - 1))
  const rest = entries.slice(kept.length)
  const other: ViewNode = {
    kind: 'other',
    id: null,
    name: `(${rest.length} smaller items)`,
    sizeOnDisk: rest.reduce((sum, e) => sum + e.sizeOnDisk, 0),
    mtimeMs: null
  }
  return [...kept.map((e) => e.build()), other]
}

/**
 * What Explore shows of one folder: the folder and `depth` levels below it (clamped to 1-3). Its
 * children are its subfolders, its tracked files, one `small` node for the files too small to track,
 * and its junctions and symlinks (`link`, size 0, never followed), largest first. A folder with more
 * than `cap` children shows the largest `cap - 1` and one `other` node for the rest, so no folder has
 * more than `cap` children. A folder's `mtimeMs` is the newest time anywhere beneath it.
 */
export function buildFolderView(
  tree: ScanTree,
  folderId: number,
  depth: number,
  cap = VIEW_CAP
): ViewNode {
  const levels = Number.isFinite(depth) ? Math.min(MAX_DEPTH, Math.max(1, Math.trunc(depth))) : 1
  return folderNode(tree, folderId, levels, Math.max(1, Math.trunc(cap)))
}
