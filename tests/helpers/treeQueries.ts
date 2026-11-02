import { win32 } from 'node:path'
import type { FileEntry, ScanTree } from '../../src/core/tree'

/** The tracked file at `absPath`, or undefined when the scan did not track it. */
export function findFile(tree: ScanTree, absPath: string): FileEntry | undefined {
  const folderId = tree.findFolder(win32.dirname(absPath))
  if (folderId === undefined) return undefined
  const name = win32.basename(absPath).toLowerCase()
  return tree.folders[folderId].fileIds
    .map((id) => tree.files[id])
    .find((f) => f.name.toLowerCase() === name)
}
