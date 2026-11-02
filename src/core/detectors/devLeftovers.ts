import { win32 } from 'node:path'
import type { Finding, RuleId } from '../../shared/types'
import { isSameOrInside } from '../paths'
import type { ScanTree } from '../tree'
import { fileFinding, folderFinding, type DetectorContext } from './context'

const DAY = 86_400_000
const BLEND_BACKUP = /\.blend\d+$/i
const FRAME = /^(.*?)(\d+)\.(png|jpe?g|exr|tiff?)$/i
const SEQUENCE_SHARE = 0.9

type ProjectTest = (tree: ScanTree, projectId: number) => boolean

// Marker names are stored lower-cased by the tree.
const hasMarker =
  (...names: string[]): ProjectTest =>
  (tree, id) =>
    tree.folders[id].markers.some((m) => names.includes(m))
const hasMarkerEnding =
  (ext: string): ProjectTest =>
  (tree, id) =>
    tree.folders[id].markers.some((m) => m.endsWith(ext))
const hasChildFolders =
  (...names: string[]): ProjectTest =>
  (tree, id) =>
    names.every((name) => tree.childByName(id, name) !== undefined)

/** A leftover folder, recognised by its name and by what sits next to it in its project. */
const FOLDER_RULES: { ruleId: RuleId; names: string[]; project: ProjectTest }[] = [
  { ruleId: 'dev-node-modules', names: ['node_modules'], project: hasMarker('package.json') },
  {
    ruleId: 'dev-build-output',
    names: ['build', 'dist'],
    project: hasMarker('package.json', 'pyproject.toml')
  },
  { ruleId: 'dev-build-output', names: ['target'], project: hasMarker('cargo.toml') },
  { ruleId: 'dev-build-output', names: ['bin', 'obj'], project: hasMarkerEnding('.csproj') },
  {
    ruleId: 'unity-library',
    names: ['library'],
    project: hasChildFolders('assets', 'projectsettings')
  },
  {
    ruleId: 'unreal-caches',
    names: ['intermediate', 'deriveddatacache'],
    project: hasMarkerEnding('.uproject')
  },
  { ruleId: 'godot-cache', names: ['.godot'], project: hasMarker('project.godot') }
]

/** The leftover rule whose shape the folder has — its name plus what sits next to it — idle or not. */
function leftoverRule(tree: ScanTree, folderId: number): RuleId | undefined {
  const folder = tree.folders[folderId]
  if (folder.parentId === -1) return undefined
  if (folder.markers.includes('pyvenv.cfg')) return 'dev-python-venv'
  const name = folder.name.toLowerCase()
  return FOLDER_RULES.find((r) => r.names.includes(name) && r.project(tree, folder.parentId))
    ?.ruleId
}

/**
 * True when the folder is, or lies inside, a project's dependency, build, cache or venv folder, idle
 * or not (spec §6.2). Duplicates and stale files are never looked for there: removing one file from
 * an active project's node_modules breaks the project.
 */
export function insideLeftoverShape(tree: ScanTree, folderId: number): boolean {
  for (let f = folderId; f !== -1; f = tree.folders[f].parentId) {
    if (leftoverRule(tree, f) !== undefined) return true
  }
  return false
}

/**
 * Apps and tools install themselves with package.json files and node_modules too (VS Code extensions
 * under .vscode, Electron apps under AppData\Local\Programs). Those are not projects: removing their
 * "leftovers" breaks them. So nothing inside AppData or inside a dot-folder counts as a project.
 */
function inToolArea(ctx: DetectorContext, folderId: number): boolean {
  const { tree } = ctx
  for (let f = folderId; f !== -1; f = tree.folders[f].parentId) {
    if (tree.folders[f].name.startsWith('.')) return true
  }
  return isSameOrInside(tree.folderPath(folderId), win32.join(ctx.env.userProfile, 'AppData'))
}

/** True when the folder holds an old numbered image sequence and little else. */
function isOldImageSequence(ctx: DetectorContext, folderId: number): boolean {
  const { tree, limits } = ctx
  const folder = tree.folders[folderId]
  if (folder.childIds.length > 0 || folder.fileIds.length < limits.imageSeqMinFiles) return false
  if (folder.newestMtimeMs >= ctx.now - ctx.settings.thresholds.idleDays * DAY) return false

  const groups = new Map<string, { count: number; bytes: number }>()
  for (const id of folder.fileIds) {
    const match = FRAME.exec(tree.files[id].name)
    if (!match) continue
    const key = `${match[1]}|${match[3].toLowerCase()}`
    const group = groups.get(key) ?? { count: 0, bytes: 0 }
    group.count++
    group.bytes += tree.files[id].sizeOnDisk
    groups.set(key, group)
  }
  const largest = [...groups.values()].sort((a, b) => b.count - a.count || b.bytes - a.bytes)[0]
  return (
    largest !== undefined &&
    largest.count >= limits.imageSeqMinFiles &&
    largest.bytes >= limits.imageSeqMinBytes &&
    largest.bytes >= SEQUENCE_SHARE * folder.sizeOnDisk
  )
}

/**
 * Leftovers of development and creative work: dependency folders, build output, editor caches and
 * virtual environments in idle projects; Blender backups; and old render frames.
 */
export function detectDevLeftovers(ctx: DetectorContext): Finding[] {
  const { tree, claims } = ctx
  const findings: Finding[] = []
  const idleCutoff = ctx.now - ctx.settings.thresholds.idleDays * DAY
  // A project is idle when nothing in it changed lately, the leftover itself aside.
  const idle = (projectId: number, leftoverId: number): boolean =>
    tree.newestMtimeExcluding(projectId, [leftoverId]) < idleCutoff

  // Folder ids grow as the walk goes deeper, so parents come first and a claimed leftover hides
  // everything inside it.
  for (let id = 1; id < tree.folders.length; id++) {
    const folder = tree.folders[id]
    if (claims.folderClaimed(id) || (folder.sizeOnDisk === 0 && !folder.unreadable)) continue
    const projectId = folder.parentId
    const ruleId = leftoverRule(tree, id)
    if (ruleId !== undefined) {
      if (idle(projectId, id) && !inToolArea(ctx, projectId)) {
        findings.push(folderFinding(ctx, ruleId, id))
      }
      continue
    }
    if (isOldImageSequence(ctx, id) && !inToolArea(ctx, id)) {
      findings.push(folderFinding(ctx, 'image-sequences', id))
    }
  }

  for (const file of tree.files) {
    if (
      BLEND_BACKUP.test(file.name) &&
      !file.cloudOnly &&
      !file.extraHardLink &&
      !claims.fileClaimed(file.id)
    ) {
      findings.push(fileFinding(ctx, 'blender-backups', file.id))
    }
  }
  return findings
}
