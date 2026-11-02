/** Inbox first, then the four branches, in the order the tree shows them. */
export const BRANCH_KINDS = ['inbox', 'character', 'lore', 'scenery', 'location'] as const

export type BranchKind = (typeof BRANCH_KINDS)[number]

/** Branches whose subjects are places or looks, so the shell leaves room for photos. */
export const PHOTO_BRANCHES = ['scenery', 'location'] as const

export function branchHoldsPhotos(kind: BranchKind): boolean {
  return (PHOTO_BRANCHES as readonly string[]).includes(kind)
}

export interface ProjectSubject {
  id: string
  name: string
  folder: string
}

export interface ProjectBranch {
  kind: BranchKind
  subjects: ProjectSubject[]
}

/** A project tree remembered by Stash. `rootPath` is where a later phase may create folders. */
export interface ProjectTree {
  version: 1
  id: string
  name: string
  rootPath: string
  branches: ProjectBranch[]
}
