import { win32 } from 'node:path'
import { isMarkerFile } from '../../src/core/rules/markers'
import { ScanTree } from '../../src/core/tree'

export type TreeEntry =
  | { size: number; mtimeMs: number; onDisk?: number; hardLinkKey?: string }
  | { dir: true; mtimeMs?: number; unreadable?: boolean }
  | { link: true }

/**
 * Builds a ScanTree from root-relative paths without touching the disk. Folders are created as
 * needed with time 0; list a `dir` entry before anything inside it to give it its own time.
 * Small files named like project manifests become markers, as the scanner makes them.
 */
export function treeFrom(
  root: string,
  entries: Record<string, TreeEntry>,
  trackFileMinBytes = 1_048_576
): ScanTree {
  const tree = new ScanTree(root, 0, trackFileMinBytes)
  const folderFor = (rel: string): number => {
    let id = 0
    if (rel === '.' || rel === '') return id
    for (const name of rel.split('\\'))
      id = tree.childByName(id, name) ?? tree.addFolder(id, name, 0)
    return id
  }

  for (const [rel, entry] of Object.entries(entries)) {
    const parentId = folderFor(win32.dirname(rel))
    const name = win32.basename(rel)
    if ('dir' in entry) {
      const id =
        tree.childByName(parentId, name) ?? tree.addFolder(parentId, name, entry.mtimeMs ?? 0)
      if (entry.unreadable) tree.markUnreadable(id)
    } else if ('link' in entry) {
      tree.addLink(parentId, name)
    } else {
      tree.addFile(parentId, {
        name,
        sizeOnDisk: entry.onDisk ?? entry.size,
        logicalSize: entry.size,
        mtimeMs: entry.mtimeMs,
        hardLinkKey: entry.hardLinkKey ?? null
      })
      if (entry.size < trackFileMinBytes && isMarkerFile(name)) tree.addMarker(parentId, name)
    }
  }
  return tree
}
