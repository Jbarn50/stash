import type { Bytes } from '../shared/types'
import { normalizePath, pathKey } from './paths'

export interface FolderNode {
  id: number
  parentId: number
  name: string
  mtimeMs: number
  /** Totals for everything beneath the folder, counting each hard-linked file once. */
  sizeOnDisk: Bytes
  logicalSize: Bytes
  fileCount: number
  /** Files directly in the folder that are too small to track one by one. */
  smallFilesCount: number
  smallFilesSize: Bytes
  directFilesNewestMtimeMs: number
  /** The newest modified time of the folder itself or anything beneath it. */
  newestMtimeMs: number
  unreadable: boolean
  childIds: number[]
  fileIds: number[]
  /** Junctions and symlinks found in the folder. They are never followed. */
  links: string[]
  /** Lower-cased names of small project files the detectors look for (see rules/markers.ts). */
  markers: string[]
  /** Files the scanner could not measure (access denied or locked). */
  unmeasured: string[]
}

export interface FileEntry {
  id: number
  folderId: number
  name: string
  sizeOnDisk: Bytes
  logicalSize: Bytes
  mtimeMs: number
  /** The data lives in the cloud (for example an OneDrive placeholder): there is nothing on disk. */
  cloudOnly: boolean
  /** Another name for a file already counted. It adds nothing to the folder totals. */
  extraHardLink: boolean
}

export interface AddFileInput {
  name: string
  sizeOnDisk: Bytes
  logicalSize: Bytes
  mtimeMs: number
  /** `${dev}:${ino}` for a file with more than one hard link, otherwise null. */
  hardLinkKey: string | null
}

export interface ScanTreeData {
  rootPath: string
  trackFileMinBytes: number
  folders: FolderNode[]
  files: FileEntry[]
}

function newFolder(id: number, parentId: number, name: string, mtimeMs: number): FolderNode {
  return {
    id,
    parentId,
    name,
    mtimeMs,
    sizeOnDisk: 0,
    logicalSize: 0,
    fileCount: 0,
    smallFilesCount: 0,
    smallFilesSize: 0,
    directFilesNewestMtimeMs: 0,
    newestMtimeMs: mtimeMs,
    unreadable: false,
    childIds: [],
    fileIds: [],
    links: [],
    markers: [],
    unmeasured: []
  }
}

/** Joins a folder path and a name; a drive root (`C:\`) already ends in its separator. */
function joinPath(folder: string, name: string): string {
  return folder.endsWith('\\') ? folder + name : `${folder}\\${name}`
}

/**
 * The result of a scan: every folder, the files large enough to track one by one, and totals that
 * are kept up to date on every add, so a tree that is still being built can be shown as it grows.
 */
export class ScanTree {
  readonly rootPath: string
  readonly trackFileMinBytes: number
  readonly folders: FolderNode[]
  readonly files: FileEntry[]
  private readonly seenHardLinks = new Set<string>()
  private unreadableFolders = 0

  constructor(rootPath: string, rootMtimeMs: number, trackFileMinBytes: number) {
    this.rootPath = normalizePath(rootPath)
    this.trackFileMinBytes = trackFileMinBytes
    this.folders = [newFolder(0, -1, this.rootPath, rootMtimeMs)]
    this.files = []
  }

  static fromData(d: ScanTreeData): ScanTree {
    const tree = new ScanTree(d.rootPath, d.folders[0]?.mtimeMs ?? 0, d.trackFileMinBytes)
    tree.folders.length = 0
    // A loop, not push(...spread): a large scan has more folders than a call can take as arguments.
    for (const folder of d.folders) {
      tree.folders.push(folder)
      if (folder.unreadable) tree.unreadableFolders++
    }
    for (const file of d.files) tree.files.push(file)
    return tree
  }

  toData(): ScanTreeData {
    return {
      rootPath: this.rootPath,
      trackFileMinBytes: this.trackFileMinBytes,
      folders: this.folders,
      files: this.files
    }
  }

  addFolder(parentId: number, name: string, mtimeMs: number): number {
    const id = this.folders.length
    this.folders.push(newFolder(id, parentId, name, mtimeMs))
    this.folders[parentId].childIds.push(id)
    // Every ancestor's newest time is at least its child's, so the walk can stop at the first one
    // that is already as new.
    for (let p = parentId; p !== -1; p = this.folders[p].parentId) {
      if (this.folders[p].newestMtimeMs >= mtimeMs) break
      this.folders[p].newestMtimeMs = mtimeMs
    }
    return id
  }

  addFile(folderId: number, f: AddFileInput): void {
    const repeatLink = f.hardLinkKey !== null && this.seenHardLinks.has(f.hardLinkKey)
    if (f.hardLinkKey !== null) this.seenHardLinks.add(f.hardLinkKey)
    const countedOnDisk = repeatLink ? 0 : f.sizeOnDisk
    const countedLogical = repeatLink ? 0 : f.logicalSize

    const folder = this.folders[folderId]
    if (f.logicalSize >= this.trackFileMinBytes) {
      const id = this.files.length
      this.files.push({
        id,
        folderId,
        name: f.name,
        sizeOnDisk: f.sizeOnDisk,
        logicalSize: f.logicalSize,
        mtimeMs: f.mtimeMs,
        cloudOnly: f.logicalSize > 0 && f.sizeOnDisk === 0,
        extraHardLink: repeatLink
      })
      folder.fileIds.push(id)
    } else {
      folder.smallFilesCount++
      folder.smallFilesSize += countedOnDisk
    }
    if (f.mtimeMs > folder.directFilesNewestMtimeMs) folder.directFilesNewestMtimeMs = f.mtimeMs

    for (let id = folderId; id !== -1; id = this.folders[id].parentId) {
      const node = this.folders[id]
      node.sizeOnDisk += countedOnDisk
      node.logicalSize += countedLogical
      node.fileCount++
      if (f.mtimeMs > node.newestMtimeMs) node.newestMtimeMs = f.mtimeMs
    }
  }

  addLink(folderId: number, name: string): void {
    this.folders[folderId].links.push(name)
  }

  addMarker(folderId: number, name: string): void {
    this.folders[folderId].markers.push(name.toLowerCase())
  }

  addUnmeasured(folderId: number, name: string): void {
    this.folders[folderId].unmeasured.push(name)
  }

  markUnreadable(folderId: number): void {
    const folder = this.folders[folderId]
    if (folder.unreadable) return
    folder.unreadable = true
    this.unreadableFolders++
  }

  folderPath(id: number): string {
    const names: string[] = []
    for (let f = id; f !== 0; f = this.folders[f].parentId) names.push(this.folders[f].name)
    return names.reverse().reduce(joinPath, this.rootPath)
  }

  filePath(id: number): string {
    const file = this.files[id]
    return joinPath(this.folderPath(file.folderId), file.name)
  }

  findFolder(absPath: string): number | undefined {
    const key = pathKey(absPath)
    const rootKey = pathKey(this.rootPath)
    if (key === rootKey) return 0
    const prefix = rootKey.endsWith('\\') ? rootKey : `${rootKey}\\`
    if (!key.startsWith(prefix)) return undefined
    let id: number | undefined = 0
    for (const name of key.slice(prefix.length).split('\\')) {
      id = this.childByName(id, name)
      if (id === undefined) return undefined
    }
    return id
  }

  childByName(folderId: number, name: string): number | undefined {
    const lower = name.toLowerCase()
    return this.folders[folderId].childIds.find((c) => this.folders[c].name.toLowerCase() === lower)
  }

  isInside(folderId: number, ancestorId: number): boolean {
    for (let f = folderId; f !== -1; f = this.folders[f].parentId) {
      if (f === ancestorId) return true
    }
    return false
  }

  newestMtimeExcluding(folderId: number, excludedChildIds: number[]): number {
    const folder = this.folders[folderId]
    let newest = Math.max(folder.mtimeMs, folder.directFilesNewestMtimeMs)
    for (const child of folder.childIds) {
      if (!excludedChildIds.includes(child))
        newest = Math.max(newest, this.folders[child].newestMtimeMs)
    }
    return newest
  }

  get unreadableCount(): number {
    return this.unreadableFolders
  }
}
