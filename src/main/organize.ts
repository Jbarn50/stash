import { mkdir, rename, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { requireFeature } from '../core/features'
import { pathKey } from '../core/paths'
import {
  ORGANIZE_REASONS,
  checkRoot,
  classifyMove,
  type OrganizeMoveRequest,
  type PlannedMove
} from '../core/projects/movePlan'
import type { BranchKind } from '../shared/projects'
import type { WinEnv } from '../shared/types'
import type { OrganizeLog, OrganizeLogEntry } from './organizeLog'

// Same-volume renames inside a project the user confirmed. The first line of each
// function that creates a folder or renames a file is requireFeature('organize').
// A taken destination is left alone. Nothing here recycles or removes a user's file.
// Node's rename replaces a file that is in its way on Windows, so the destination is
// checked immediately before the rename. A file created in that moment could still be
// replaced: that window is as small as it can be made here.

export interface OrganizeIo {
  exists(path: string): Promise<boolean>
  isFile(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

export const nodeOrganizeIo: OrganizeIo = {
  async exists(path) {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  },
  async isFile(path) {
    try {
      return (await stat(path)).isFile()
    } catch {
      return false
    }
  },
  async mkdir(path) {
    await mkdir(path, { recursive: true })
  },
  async rename(from, to) {
    await rename(from, to)
  }
}

export interface AppliedMove {
  from: string
  to: string | null
  branch: BranchKind
  folder: string | null
  status: 'moved' | 'failed'
  reason: string | null
}

export interface OrganizeApplyResult {
  status: 'done' | 'refused'
  reason: string | null
  id: string | null
  moves: AppliedMove[]
}

function failed(planned: PlannedMove, reason: string): AppliedMove {
  return { ...planned, status: 'failed', reason, to: planned.to }
}

/**
 * Creates the folders a confirmed plan needs and renames each file into the project.
 * A blocked root creates nothing. A file that cannot move stays where it is.
 */
export async function applyOrganize(input: {
  root: string
  env: WinEnv
  projectId: string
  requests: readonly OrganizeMoveRequest[]
  io: OrganizeIo
  log: Pick<OrganizeLog, 'append'>
  now: () => number
  id: string
}): Promise<OrganizeApplyResult> {
  requireFeature('organize')
  const refused = checkRoot(input.root, input.env)
  if (refused !== null) return { status: 'refused', reason: refused, id: null, moves: [] }

  const taken = new Set<string>()
  const moves: AppliedMove[] = []
  for (const request of input.requests) {
    const planned = classifyMove(input.root, input.env, request)
    if (planned.status === 'failed' || planned.to === null) {
      moves.push({ ...planned, status: 'failed' })
      continue
    }
    const toKey = pathKey(planned.to)
    if (taken.has(toKey) || (await input.io.exists(planned.to))) {
      moves.push(failed(planned, ORGANIZE_REASONS.destTaken))
      continue
    }
    if (!(await input.io.isFile(planned.from))) {
      moves.push(failed(planned, ORGANIZE_REASONS.notAFile))
      continue
    }
    taken.add(toKey)
    try {
      await input.io.mkdir(win32.dirname(planned.to))
      await input.io.rename(planned.from, planned.to)
    } catch {
      taken.delete(toKey)
      moves.push(failed(planned, ORGANIZE_REASONS.renameFailed))
      continue
    }
    const entry: OrganizeLogEntry = {
      type: 'organize',
      id: input.id,
      at: new Date(input.now()).toISOString(),
      projectId: input.projectId,
      from: planned.from,
      to: planned.to
    }
    try {
      await input.log.append(entry)
      moves.push({ ...planned, status: 'moved', reason: null })
    } catch {
      moves.push({ ...planned, status: 'moved', reason: ORGANIZE_REASONS.logFailed })
    }
  }
  return { status: 'done', reason: null, id: input.id, moves }
}

/**
 * Renames a logged organize back. When the old path is taken, that file stays
 * where it is. Nothing is overwritten and nothing is removed.
 */
export async function undoOrganizeMoves(input: {
  projectId: string
  organizeId: string
  id: string
  moves: readonly { from: string; to: string }[]
  io: OrganizeIo
  log: Pick<OrganizeLog, 'append'>
  now: () => number
}): Promise<{ movedBack: number; failed: number }> {
  requireFeature('organize')
  let movedBack = 0
  let failedCount = 0
  for (const move of [...input.moves].reverse()) {
    if (await input.io.exists(move.from)) {
      failedCount++
      continue
    }
    if (!(await input.io.isFile(move.to))) {
      failedCount++
      continue
    }
    try {
      await input.io.mkdir(win32.dirname(move.from))
      await input.io.rename(move.to, move.from)
    } catch {
      failedCount++
      continue
    }
    try {
      await input.log.append({
        type: 'organize-undo',
        id: input.id,
        at: new Date(input.now()).toISOString(),
        projectId: input.projectId,
        from: move.to,
        to: move.from,
        organizeId: input.organizeId
      })
    } catch {
      // The file is back. A missing undo line would try this rename again and find it already there.
    }
    movedBack++
  }
  return { movedBack, failed: failedCount }
}
