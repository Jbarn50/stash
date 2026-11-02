import { randomUUID } from 'node:crypto'
import { win32 } from 'node:path'
import { requireFeature } from '../core/features'
import { pathKey } from '../core/paths'
import { proposeGroups, type GroupItem, type KnownSubject } from '../core/projects/grouping'
import type { WorkflowMeta } from '../core/projects/likeness'
import { ORGANIZE_REASONS, type OrganizeMoveRequest } from '../core/projects/movePlan'
import { readWorkflowMeta } from '../core/projects/hooks'
import { folderSegment } from '../core/projects/tree'
import { isDHash } from '../shared/dhash'
import type {
  ConfirmedGroup,
  ImportFileInput,
  ImportMoveResult,
  ImportPreview,
  ImportResult,
  OrganizeUndoResult
} from '../shared/organize'
import type { BranchKind, ProjectTree } from '../shared/projects'
import type { WinEnv } from '../shared/types'
import { readImageBytes } from './importImage'
import { LikenessStore } from './likenessStore'
import { applyOrganize, nodeOrganizeIo, undoOrganizeMoves, type OrganizeIo } from './organize'
import { OrganizeLog } from './organizeLog'
import type { ProjectsStore } from './projectsStore'

interface ResolvedMove {
  from: string
  branch: BranchKind
  folder: string | null
  subjectId: string | null
  hash: string | null
  error: string | null
}

/**
 * Preview, confirm, and undo for one import the user started.
 * Preview only reads. Confirm and undo rename, and each of those calls requireFeature first.
 */
export class OrganizeService {
  private last: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly projects: ProjectsStore,
    private readonly log: OrganizeLog,
    private readonly hashes: LikenessStore,
    private readonly env: WinEnv,
    private readonly io: OrganizeIo = nodeOrganizeIo,
    private readonly readBytes: (path: string) => Promise<Uint8Array | null> = readImageBytes,
    private readonly now: () => number = Date.now,
    private readonly ids: () => string = randomUUID
  ) {}

  preview(projectId: string, files: readonly ImportFileInput[]): Promise<ImportPreview> {
    return this.queue(() => this.previewNow(projectId, files))
  }

  confirm(projectId: string, groups: readonly ConfirmedGroup[]): Promise<ImportResult> {
    return this.queue(() => this.confirmNow(projectId, groups))
  }

  undo(): Promise<OrganizeUndoResult> {
    return this.queue(() => this.undoNow())
  }

  subjectHashes(): Promise<Record<string, string[]>> {
    return this.hashes.all()
  }

  private queue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.last.then(job)
    this.last = run.catch(() => undefined)
    return run
  }

  private async project(projectId: string): Promise<ProjectTree> {
    const trees = await this.projects.list()
    const tree = trees.find((item) => item.id === projectId)
    if (tree === undefined) throw new Error('unknown project')
    return tree
  }

  private async previewNow(
    projectId: string,
    files: readonly ImportFileInput[]
  ): Promise<ImportPreview> {
    const tree = await this.project(projectId)
    const stored = await this.hashes.all()
    const subjects: KnownSubject[] = tree.branches.flatMap((branch) =>
      branch.subjects.map((subject) => ({
        id: subject.id,
        kind: branch.kind,
        name: subject.name,
        folder: subject.folder,
        hashes: stored[subject.id] ?? []
      }))
    )
    const items: GroupItem[] = []
    const skipped: ImportPreview['skipped'] = []
    for (const file of files) {
      if (typeof file.path !== 'string' || file.path.trim() === '') {
        skipped.push({ path: '', reason: 'That path is not a file Stash can read.' })
        continue
      }
      let meta: WorkflowMeta | null = null
      if (win32.extname(file.path).toLowerCase() === '.png') {
        const bytes = await this.readBytes(file.path)
        meta = bytes === null ? null : readWorkflowMeta(bytes)
      }
      const dhash = typeof file.dhash === 'string' && isDHash(file.dhash) ? file.dhash : null
      items.push({ path: file.path, meta, dhash })
    }
    return { groups: proposeGroups(items, subjects), skipped }
  }

  private resolve(tree: ProjectTree, group: ConfirmedGroup): ResolvedMove[] {
    let branch = group.branch
    let folder: string | null = null
    let subjectId: string | null = null
    let error: string | null = null
    if (group.subjectId !== null) {
      const found = findSubject(tree, group.subjectId)
      if (found === null) error = ORGANIZE_REASONS.unknownSubject
      else {
        branch = found.kind
        folder = found.folder
        subjectId = found.id
      }
    } else if (group.folder.trim() === '') {
      if (group.branch !== 'inbox') error = ORGANIZE_REASONS.badName
    } else {
      const segment = folderSegment(group.folder)
      if (segment === null) error = ORGANIZE_REASONS.badName
      else folder = segment
    }
    return group.paths.map((from, index) => ({
      from,
      branch,
      folder,
      subjectId,
      hash: group.hashes[index] ?? null,
      error
    }))
  }

  private async confirmNow(
    projectId: string,
    groups: readonly ConfirmedGroup[]
  ): Promise<ImportResult> {
    requireFeature('organize')
    let tree = await this.project(projectId)
    const ready: OrganizeMoveRequest[] = []
    const early: ImportMoveResult[] = []
    const meta = new Map<string, ResolvedMove>()
    for (const group of groups) {
      for (const item of this.resolve(tree, group)) {
        if (item.error !== null) {
          early.push({ from: item.from, to: null, status: 'failed', reason: item.error })
          continue
        }
        ready.push({ from: item.from, branch: item.branch, folder: item.folder })
        meta.set(pathKey(item.from), item)
      }
    }
    const applied = await applyOrganize({
      root: tree.rootPath,
      env: this.env,
      projectId,
      requests: ready,
      io: this.io,
      log: this.log,
      now: this.now,
      id: this.ids()
    })
    if (applied.status === 'refused') {
      return {
        status: 'refused',
        reason: applied.reason,
        project: tree,
        moves: [
          ...early,
          ...ready.map((request) => ({
            from: request.from,
            to: null,
            status: 'failed' as const,
            reason: applied.reason
          }))
        ]
      }
    }
    const moves: ImportMoveResult[] = [...early]
    for (const move of applied.moves) {
      moves.push({
        from: move.from,
        to: move.status === 'moved' ? move.to : null,
        status: move.status,
        reason: move.reason
      })
      if (move.status !== 'moved') continue
      const planned = meta.get(pathKey(move.from))
      if (planned === undefined) continue
      const subjectId = await this.remember(projectId, tree, planned)
      tree = subjectId.tree
      if (subjectId.id !== null && planned.hash !== null && isDHash(planned.hash)) {
        await this.hashes.add(subjectId.id, projectId, planned.hash)
      }
    }
    return { status: 'done', reason: null, moves, project: tree }
  }

  private async remember(
    projectId: string,
    tree: ProjectTree,
    planned: ResolvedMove
  ): Promise<{ tree: ProjectTree; id: string | null }> {
    if (planned.folder === null) return { tree, id: null }
    if (planned.subjectId !== null) return { tree, id: planned.subjectId }
    const existing = findFolder(tree, planned.branch, planned.folder)
    if (existing !== null) return { tree, id: existing }
    try {
      tree = await this.projects.addSubject(projectId, planned.branch, planned.folder)
    } catch {
      tree = await this.project(projectId)
    }
    return { tree, id: findFolder(tree, planned.branch, planned.folder) }
  }

  private async undoNow(): Promise<OrganizeUndoResult> {
    const pending = await this.log.pending()
    if (pending === null) return { status: 'nothing', movedBack: 0, failed: 0 }
    const result = await undoOrganizeMoves({
      projectId: pending.projectId,
      organizeId: pending.organizeId,
      id: this.ids(),
      moves: pending.moves,
      io: this.io,
      log: this.log,
      now: this.now
    })
    return { status: 'done', movedBack: result.movedBack, failed: result.failed }
  }
}

function findSubject(
  tree: ProjectTree,
  subjectId: string
): { kind: BranchKind; folder: string; id: string } | null {
  for (const branch of tree.branches) {
    const subject = branch.subjects.find((item) => item.id === subjectId)
    if (subject) return { kind: branch.kind, folder: subject.folder, id: subject.id }
  }
  return null
}

function findFolder(tree: ProjectTree, kind: BranchKind, folder: string): string | null {
  const branch = tree.branches.find((item) => item.kind === kind)
  const subject = branch?.subjects.find(
    (item) => item.folder.toLowerCase() === folder.toLowerCase()
  )
  return subject?.id ?? null
}
