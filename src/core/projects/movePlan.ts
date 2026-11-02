import { win32 } from 'node:path'
import type { BranchKind } from '../../shared/projects'
import type { WinEnv } from '../../shared/types'
import { isBlocked } from '../blocklist'
import { driveOf, isPlainDrivePath, isSameOrInside, normalizePath, pathKey } from '../paths'
import { folderSegment, relativeDir } from './tree'

// Where a confirmed file would go. Nothing here creates a folder or renames a file.

export const ORGANIZE_REASONS = {
  blockedRoot: "That folder can't be a project.",
  crossVolume: 'That file is on another drive, so it stayed put.',
  blockedSource: 'That file is in a protected folder, so it stayed put.',
  notAFile: 'That path is not a file, so it stayed put.',
  badName: "That name can't be a folder, so the file stayed put.",
  outside: 'That destination is outside the project, so the file stayed put.',
  destTaken: 'That destination already has a file, so this one stayed put.',
  alreadyThere: 'That file is already in place.',
  renameFailed: 'That file could not be renamed, so it stayed put.',
  undoTaken: 'The old path is taken, so this file stayed where it is.',
  undoMissing: 'That file is no longer there, so it stayed where it is.',
  unknownSubject: 'That name is not in this project, so the file stayed put.',
  logFailed: 'Moved, but Undo cannot see it because the organize log could not be written.'
} as const

export interface OrganizeMoveRequest {
  from: string
  branch: BranchKind
  /** A folder segment, or null for the inbox holding folder (no subject name). */
  folder: string | null
}

export interface PlannedMove {
  from: string
  to: string | null
  branch: BranchKind
  folder: string | null
  status: 'ready' | 'failed'
  reason: string | null
}

/** The file's own name when it is safe to keep unchanged, or null. */
export function fileSegment(filePath: string): string | null {
  const name = win32.basename(normalizePath(filePath))
  if (folderSegment(name) !== name) return null
  return name
}

/** A sentence when `root` must not gain folders, or null when it may. */
export function checkRoot(root: string, env: WinEnv): string | null {
  if (!isPlainDrivePath(root) || isBlocked(root, env)) return ORGANIZE_REASONS.blockedRoot
  return null
}

function sameVolume(root: string, filePath: string): boolean {
  const rootDrive = driveOf(root)
  const fileDrive = driveOf(filePath)
  return rootDrive !== '' && rootDrive === fileDrive
}

/**
 * The destination of one confirmed file, or why it cannot move. Does not look at the disk:
 * a taken destination is checked by the move, immediately before the rename.
 */
export function classifyMove(root: string, env: WinEnv, request: OrganizeMoveRequest): PlannedMove {
  const from = normalizePath(request.from)
  const failed = (reason: string, to: string | null = null): PlannedMove => ({
    from,
    to,
    branch: request.branch,
    folder: request.folder,
    status: 'failed',
    reason
  })
  if (!isPlainDrivePath(from) || isBlocked(from, env)) return failed(ORGANIZE_REASONS.blockedSource)
  if (!sameVolume(root, from)) return failed(ORGANIZE_REASONS.crossVolume)
  if (request.folder !== null && folderSegment(request.folder) !== request.folder) {
    return failed(ORGANIZE_REASONS.badName)
  }
  const name = fileSegment(from)
  if (name === null) return failed(ORGANIZE_REASONS.badName)
  let to: string
  try {
    to =
      request.folder === null
        ? normalizePath(win32.join(root, 'inbox', name))
        : normalizePath(win32.join(root, relativeDir(request.branch, request.folder), name))
  } catch {
    return failed(ORGANIZE_REASONS.badName)
  }
  if (!isSameOrInside(to, root) || pathKey(to) === pathKey(root))
    return failed(ORGANIZE_REASONS.outside)
  if (pathKey(to) === pathKey(from)) return failed(ORGANIZE_REASONS.alreadyThere, to)
  return {
    from,
    to,
    branch: request.branch,
    folder: request.folder,
    status: 'ready',
    reason: null
  }
}
