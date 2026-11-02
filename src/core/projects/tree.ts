import { win32 } from 'node:path'
import {
  BRANCH_KINDS,
  type BranchKind,
  type ProjectBranch,
  type ProjectSubject,
  type ProjectTree
} from '../../shared/projects'
import type { WinEnv } from '../../shared/types'
import { isBlocked } from '../blocklist'
import { isPlainDrivePath, normalizePath } from '../paths'

export {
  BRANCH_KINDS,
  PHOTO_BRANCHES,
  branchHoldsPhotos,
  type BranchKind,
  type ProjectBranch,
  type ProjectSubject,
  type ProjectTree
} from '../../shared/projects'

// The shape of a project folder, as data. Creating the directories waits until
// `requireFeature('organize')` is on. These functions never touch the disk.

const ID = /^[A-Za-z0-9_-]{1,80}$/
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const INVALID = /[<>:"/\\|?*]/

/**
 * A single Windows folder name, or null when the text is empty, too long,
 * reserved, or could be read as a path. The result is safe to join under a
 * branch. It is not a path.
 */
export function folderSegment(name: string): string | null {
  const collapsed = name.trim().replace(/\s+/g, ' ')
  if (collapsed.length === 0 || collapsed.length > 80) return null
  if (collapsed === '.' || collapsed === '..') return null
  if ([...collapsed].some((char) => char.charCodeAt(0) < 32)) return null
  if (INVALID.test(collapsed) || /[. ]$/.test(collapsed)) return null
  if (RESERVED.test(collapsed)) return null
  return collapsed
}

/** `character\Mara`. Refuses a folder that `folderSegment` would not return unchanged. */
export function relativeDir(kind: BranchKind, folder: string): string {
  if (!(BRANCH_KINDS as readonly string[]).includes(kind) || folderSegment(folder) !== folder) {
    throw new Error('folder segment is not safe')
  }
  return win32.join(kind, folder)
}

/**
 * An empty project at `rootPath`, or null when the name is not a folder segment
 * or the root is not a plain path Stash is allowed to work in. A folder inside
 * Documents is allowed. Documents itself, Windows, another user's profile, and
 * Stash's own folders are not.
 */
export function emptyProject(
  input: { id: string; name: string; rootPath: string },
  env: WinEnv
): ProjectTree | null {
  const name = folderSegment(input.name)
  if (name === null || !ID.test(input.id)) return null
  if (!isPlainDrivePath(input.rootPath) || isBlocked(input.rootPath, env)) return null
  return {
    version: 1,
    id: input.id,
    name,
    rootPath: normalizePath(input.rootPath),
    branches: BRANCH_KINDS.map((kind) => ({ kind, subjects: [] }))
  }
}

/**
 * A new subject on `kind`, or null when the name is unsafe or that branch
 * already has the same folder (Windows ignores case). Does not mutate `tree`.
 */
export function addSubject(
  tree: ProjectTree,
  kind: BranchKind,
  name: string,
  id: string
): ProjectTree | null {
  const folder = folderSegment(name)
  if (folder === null || !ID.test(id)) return null
  if (tree.branches.some((branch) => branch.subjects.some((subject) => subject.id === id))) {
    return null
  }
  const branch = tree.branches.find((item) => item.kind === kind)
  if (branch === undefined) return null
  const key = folder.toLowerCase()
  if (branch.subjects.some((subject) => subject.folder.toLowerCase() === key)) return null
  const subject: ProjectSubject = { id, name: folder, folder }
  return {
    ...tree,
    branches: tree.branches.map((item) =>
      item.kind === kind ? { ...item, subjects: [...item.subjects, subject] } : item
    )
  }
}

/** Drops one subject from the model. Null when the id is not in the tree. Does not mutate `tree`. */
export function removeSubject(tree: ProjectTree, subjectId: string): ProjectTree | null {
  let found = false
  const branches = tree.branches.map((branch) => ({
    ...branch,
    subjects: branch.subjects.filter((subject) => {
      if (subject.id !== subjectId) return true
      found = true
      return false
    })
  }))
  if (!found) return null
  return { ...tree, branches }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSubject(value: unknown): value is ProjectSubject {
  if (!isRecord(value)) return false
  const { id, name, folder } = value
  return (
    typeof id === 'string' &&
    ID.test(id) &&
    typeof name === 'string' &&
    typeof folder === 'string' &&
    name === folder &&
    folderSegment(folder) === folder
  )
}

function isBranch(value: unknown, kind: BranchKind): value is ProjectBranch {
  if (!isRecord(value) || value.kind !== kind || !Array.isArray(value.subjects)) return false
  if (!value.subjects.every(isSubject)) return false
  const ids = new Set(value.subjects.map((subject) => subject.id))
  const folders = new Set(value.subjects.map((subject) => subject.folder.toLowerCase()))
  return ids.size === value.subjects.length && folders.size === value.subjects.length
}

/** True when `value` is a project this build would have written, at a root it may remember. */
export function isProjectTree(value: unknown, env: WinEnv): value is ProjectTree {
  if (!isRecord(value) || value.version !== 1) return false
  if (typeof value.id !== 'string' || !ID.test(value.id)) return false
  if (typeof value.name !== 'string' || folderSegment(value.name) !== value.name) return false
  if (typeof value.rootPath !== 'string' || normalizePath(value.rootPath) !== value.rootPath) {
    return false
  }
  if (!isPlainDrivePath(value.rootPath) || isBlocked(value.rootPath, env)) return false
  if (!Array.isArray(value.branches) || value.branches.length !== BRANCH_KINDS.length) return false
  const branches: unknown[] = value.branches
  if (!BRANCH_KINDS.every((kind, index) => isBranch(branches[index], kind))) return false
  const ids = (branches as ProjectBranch[]).flatMap((branch) =>
    branch.subjects.map((subject) => subject.id)
  )
  return new Set(ids).size === ids.length
}
