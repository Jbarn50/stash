import type { BranchKind, ProjectTree } from './projects'

/** One image the user picked. `dhash` is computed in the renderer; null when it could not be. */
export interface ImportFileInput {
  path: string
  dhash: string | null
}

export type GroupReason = 'workflow' | 'look' | 'inbox'

/** A suggested group. Nothing has moved. `folder` is a folder segment, or empty when unnamed. */
export interface ProposedGroup {
  id: string
  reason: GroupReason
  branch: BranchKind
  folder: string
  nearbySubjectId: string | null
  nearbyName: string | null
  paths: string[]
}

export interface ImportPreview {
  groups: ProposedGroup[]
  skipped: { path: string; reason: string }[]
}

/** What the person confirmed. `subjectId` files into an existing name; otherwise `folder` is used. */
export interface ConfirmedGroup {
  branch: BranchKind
  folder: string
  subjectId: string | null
  paths: string[]
  hashes: (string | null)[]
}

export interface ImportMoveResult {
  from: string
  to: string | null
  status: 'moved' | 'failed'
  reason: string | null
}

export interface ImportResult {
  status: 'done' | 'refused'
  reason: string | null
  moves: ImportMoveResult[]
  project: ProjectTree | null
}

export interface OrganizeUndoResult {
  status: 'nothing' | 'done'
  movedBack: number
  failed: number
}

/** Bytes of one picked image, for the renderer to hash. Not stored. */
export interface ImportImage {
  base64: string
  mime: string
}
