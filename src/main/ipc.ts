import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { requireFeature } from '../core/features'
import { isPlainDrivePath, normalizePath, pathKey } from '../core/paths'
import { isDHash } from '../shared/dhash'
import type { ScanTree } from '../core/tree'
import { buildFolderView } from '../core/view'
import { CHANNELS, INVOKE_NAMES, type StashApi, type StashInvokeName } from '../shared/ipc'
import type {
  ConfirmedGroup,
  ImportFileInput,
  ImportImage,
  ImportPreview,
  ImportResult,
  OrganizeUndoResult
} from '../shared/organize'
import { BRANCH_KINDS, type BranchKind, type ProjectTree } from '../shared/projects'
import { latestUndoTarget } from '../shared/undoTarget'
import type {
  CleanOutcome,
  CleanupBatch,
  DriveUsage,
  Finding,
  HistoryEntry,
  Overview,
  RestoreRecord,
  Settings,
  UndoOutcome,
  ViewNode,
  WinEnv
} from '../shared/types'
import type { BinUsageCache } from './binUsage'
import { runCleanup, type CleanupDeps, type Recycler } from './cleanup'
import type { CleanupLog } from './cleanupLog'
import { relaunchElevated } from './elevate'
import type { LiveSettings } from './liveSettings'
import { driveRoots, getDriveUsage } from './overview'
import { findRecycledRecords, getRecycleBinInfo, recycleBinDir } from './recycleBin'
import { readImportImage } from './importImage'
import { OrganizeLog } from './organizeLog'
import { OrganizeService } from './organizeService'
import { LikenessStore } from './likenessStore'
import { ProjectsStore } from './projectsStore'
import { restoreBatch, type RestoreDeps } from './restore'
import type { ScanSession } from './session'
import * as systemActions from './systemActions'

// Everything the renderer asks for arrives here. Each argument is checked before it is used: the
// renderer is trusted no more than any other input, and a bad argument is `invalid argument`.

const MAX_FINDING_IDS = 100_000
const MAX_ID_LENGTH = 200
// Windows' own limit for a path, with room for the `\\?\` prefix it may carry.
const MAX_PATH_LENGTH = 32_767

function invalid(): never {
  throw new Error('invalid argument')
}

/** 1 to 100,000 strings of at most 200 characters, each kept once, in the order first given. */
export function parseFindingIds(x: unknown): string[] {
  if (!Array.isArray(x) || x.length < 1 || x.length > MAX_FINDING_IDS) invalid()
  const ids = new Set<string>()
  for (const id of x) {
    if (typeof id !== 'string' || id.length > MAX_ID_LENGTH) invalid()
    ids.add(id)
  }
  return [...ids]
}

/** A folder id of `tree`: a safe integer from 0 to the number of folders less one. */
export function parseFolderId(x: unknown, tree: ScanTree | null): number {
  if (tree === null || typeof x !== 'number' || !Number.isSafeInteger(x)) invalid()
  if (x < 0 || x >= tree.folders.length) invalid()
  return x
}

/** A path to scan: normalized, and only a plain path on a drive (see isPlainDrivePath). */
export function parseScanRoot(x: unknown): string {
  if (typeof x !== 'string' || x.length === 0 || x.length > MAX_PATH_LENGTH) invalid()
  const root = normalizePath(x)
  if (!isPlainDrivePath(root)) invalid()
  return root
}

/** A view depth: any safe integer; buildFolderView clamps it to 1-3. */
export function parseDepth(x: unknown): number {
  if (typeof x !== 'number' || !Number.isSafeInteger(x)) invalid()
  return x
}

export function parseBoolean(x: unknown): boolean {
  if (typeof x !== 'boolean') invalid()
  return x
}

/** A batch id: a non-empty string of at most 200 characters. */
export function parseBatchId(x: unknown): string {
  if (typeof x !== 'string' || x.length === 0 || x.length > MAX_ID_LENGTH) invalid()
  return x
}

/** A project or subject id, as `emptyProject` stores it. */
export function parseProjectId(x: unknown): string {
  if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(x)) invalid()
  return x
}

/** A display name before `folderSegment` trims it. The store decides if it is safe. */
export function parseProjectName(x: unknown): string {
  if (typeof x !== 'string' || x.length === 0 || x.length > 200) invalid()
  return x
}

/** A folder the user picked. Blocked roots are refused by the store, not here. */
export function parseProjectRoot(x: unknown): string {
  if (typeof x !== 'string' || x.length === 0 || x.length > MAX_PATH_LENGTH) invalid()
  return x
}

export function parseBranchKind(x: unknown): BranchKind {
  if (typeof x !== 'string' || !(BRANCH_KINDS as readonly string[]).includes(x)) invalid()
  return x as BranchKind
}

const MAX_IMPORT = 200

function parseDHash(x: unknown): string | null {
  if (x === null) return null
  if (typeof x !== 'string' || !isDHash(x)) invalid()
  return x
}

function parseImportPath(x: unknown): string {
  if (typeof x !== 'string' || x.length === 0 || x.length > MAX_PATH_LENGTH) invalid()
  const path = normalizePath(x)
  if (!isPlainDrivePath(path)) invalid()
  return path
}

/** Images the renderer wants grouped. At most 200, each a plain drive path. */
export function parseImportFiles(x: unknown): ImportFileInput[] {
  if (!Array.isArray(x) || x.length < 1 || x.length > MAX_IMPORT) invalid()
  const out: ImportFileInput[] = []
  const seen = new Set<string>()
  for (const item of x) {
    if (typeof item !== 'object' || item === null) invalid()
    const row = item as { path?: unknown; dhash?: unknown }
    const path = parseImportPath(row.path)
    const key = pathKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ path, dhash: parseDHash(row.dhash) })
  }
  if (out.length === 0) invalid()
  return out
}

/** Groups the person confirmed. Paths are plain drive paths; hashes are dHashes or null. */
export function parseConfirmedGroups(x: unknown): ConfirmedGroup[] {
  if (!Array.isArray(x) || x.length < 1 || x.length > MAX_IMPORT) invalid()
  let count = 0
  const groups: ConfirmedGroup[] = []
  for (const item of x) {
    if (typeof item !== 'object' || item === null) invalid()
    const row = item as {
      branch?: unknown
      folder?: unknown
      subjectId?: unknown
      paths?: unknown
      hashes?: unknown
    }
    const branch = parseBranchKind(row.branch)
    if (typeof row.folder !== 'string' || row.folder.length > 200) invalid()
    const subjectId = row.subjectId === null ? null : parseProjectId(row.subjectId)
    if (!Array.isArray(row.paths) || !Array.isArray(row.hashes)) invalid()
    if (row.paths.length !== row.hashes.length || row.paths.length < 1) invalid()
    const paths: string[] = []
    const hashes: (string | null)[] = []
    for (let i = 0; i < row.paths.length; i++) {
      paths.push(parseImportPath(row.paths[i]))
      hashes.push(parseDHash(row.hashes[i]))
      count++
      if (count > MAX_IMPORT) invalid()
    }
    groups.push({ branch, folder: row.folder, subjectId, paths, hashes })
  }
  return groups
}

/** A folder or tracked file of `tree`, by id. */
export function parseItemRef(
  x: unknown,
  tree: ScanTree | null
): { kind: 'folder' | 'file'; id: number } {
  if (tree === null || typeof x !== 'object' || x === null) invalid()
  const { kind, id } = x as { kind?: unknown; id?: unknown }
  if (kind !== 'folder' && kind !== 'file') invalid()
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) invalid()
  const count = kind === 'folder' ? tree.folders.length : tree.files.length
  if (id >= count) invalid()
  return { kind, id }
}

/**
 * The scan root asked for on the command line (`--scan=<root>`, as a "Rescan as administrator"
 * relaunch passes it), or null when there is none or it is not a path Stash scans.
 */
export function startupScanRoot(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith('--scan='))
  if (arg === undefined) return null
  try {
    return parseScanRoot(arg.slice('--scan='.length))
  } catch {
    console.error(`Ignoring ${arg}: not a drive path Stash can scan`)
    return null
  }
}

/** What the forwarder needs of a window. */
export interface EventTarget {
  isDestroyed(): boolean
  webContents: { send(channel: string, ...args: unknown[]): void }
}

/**
 * A function that sends its arguments to the window on `channel`. It never throws: with no window,
 * or one that is gone, nothing is sent, and a failed send is only logged, so a scan or a cleanup
 * never stops because nobody is listening.
 */
export function forwarder(
  window: () => EventTarget | null,
  channel: string
): (...args: unknown[]) => void {
  return (...args) => {
    try {
      const win = window()
      if (win === null || win.isDestroyed()) return
      win.webContents.send(channel, ...args)
    } catch (e) {
      console.error(`Couldn't send ${channel} to the window:`, e)
    }
  }
}

/** The renderer's methods, as the main process carries them out. Arguments are not yet checked. */
export type StashHandlers = {
  [K in StashInvokeName]: (...args: unknown[]) => ReturnType<StashApi[K]>
}

export interface HandlerDeps {
  session: Pick<
    ScanSession,
    | 'state'
    | 'latest'
    | 'start'
    | 'cancel'
    | 'resolveFindings'
    | 'removeFindings'
    | 'applyExclusions'
  >
  log: Pick<CleanupLog, 'append' | 'history' | 'getBatch'>
  settings: Pick<LiveSettings, 'get' | 'save'>
  binUsage: Pick<BinUsageCache, 'usedBytes' | 'refresh'>
  cleanup: Omit<CleanupDeps, 'log'>
  binDir: RestoreDeps['binDir']
  projects: Pick<ProjectsStore, 'list' | 'create' | 'addSubject' | 'removeSubject'>
  imports: {
    pickImages(): Promise<string[] | null>
    readImage(path: string): Promise<ImportImage | null>
    preview(projectId: string, files: ImportFileInput[]): Promise<ImportPreview>
    confirm(projectId: string, groups: ConfirmedGroup[]): Promise<ImportResult>
    undo(): Promise<OrganizeUndoResult>
    subjectHashes(): Promise<Record<string, string[]>>
  }
  driveUsage(roots: string[]): Promise<DriveUsage[]>
  cleanProgress(done: number, total: number): void
  pickFolder(): Promise<string | null>
  showItem(path: string): void
  openDiskCleanup(): void
  openStorageSettings(): Promise<void>
  openRecycleBin(): void
  relaunchElevated(root: string): Promise<boolean>
  now(): number
}

/** The ids of the items a batch's earlier restores already put back, by pathKey. */
function alreadyRestored(history: HistoryEntry[], batchId: string): Set<string> {
  const keys = new Set<string>()
  for (const entry of history) {
    if (entry.batch.batchId !== batchId) continue
    for (const restore of entry.restores) {
      for (const item of restore.items) {
        if (item.status === 'restored') keys.add(pathKey(item.originalPath))
      }
    }
  }
  return keys
}

/**
 * The handlers behind window.stash. A cleanup and a restore each run alone: while one runs, another
 * cleanup is `rejected: busy`, and a restore or a scan is refused with `busy`. The session itself
 * refuses a cleanup while a scan runs.
 */
export function createHandlers(deps: HandlerDeps): StashHandlers {
  const { session, log, settings, binUsage } = deps
  let working: 'clean' | 'restore' | null = null

  const latestTree = (): ScanTree | null => session.latest?.tree ?? null
  // Folder and item ids only mean something in a scan's tree.
  const treeOrInvalid = (): ScanTree => latestTree() ?? invalid()
  const refreshBin = (): void => void binUsage.refresh()

  /** Puts a batch back through Restore. The renderer passes a batch id, never a path. */
  async function putBack(id: string): Promise<RestoreRecord> {
    if (working !== null) throw new Error('busy')
    working = 'restore'
    try {
      const batch = await log.getBatch(id)
      if (batch === null) throw new Error('unknown batch')
      // Items an earlier restore put back are left out; otherwise they would now be recorded as
      // no longer in the Recycle Bin.
      const restored = alreadyRestored(await log.history(), id)
      const remaining: CleanupBatch = {
        ...batch,
        items: batch.items.filter(
          (i) => i.status !== 'recycled' || !restored.has(pathKey(i.originalPath))
        )
      }
      if (!remaining.items.some((i) => i.status === 'recycled')) {
        // Nothing is left to put back: say so without logging an empty restore.
        return { type: 'restore', batchId: id, at: new Date(deps.now()).toISOString(), items: [] }
      }
      try {
        return await restoreBatch(remaining, { binDir: deps.binDir, log, now: deps.now })
      } finally {
        refreshBin()
      }
    } finally {
      working = null
    }
  }

  async function saveSettings(input: unknown): Promise<Settings> {
    const before = driveRoots(settings.get().scanTargets).join('|')
    // Stored before the session sees it: the session reads the live settings when a scan ends.
    const saved = await settings.save(input)
    session.applyExclusions(saved)
    if (driveRoots(saved.scanTargets).join('|') !== before) refreshBin()
    return saved
  }

  return {
    async getOverview(): Promise<Overview> {
      return {
        drives: await deps.driveUsage(driveRoots(settings.get().scanTargets)),
        recycleBinUsedBytes: binUsage.usedBytes,
        lastScan: session.latest?.summary ?? null,
        state: session.state
      }
    },

    async startScan(root: unknown): Promise<{ scanId: string }> {
      const parsed = parseScanRoot(root)
      // A scan must not replace the session while items are being put back.
      if (working !== null) throw new Error('busy')
      return { scanId: session.start(parsed) }
    },

    async cancelScan(): Promise<void> {
      session.cancel()
    },

    async getFolderView(folderId: unknown, depth: unknown): Promise<ViewNode | null> {
      const tree = latestTree()
      if (tree === null) return null
      return buildFolderView(tree, parseFolderId(folderId, tree), parseDepth(depth))
    },

    async getFindings(): Promise<Finding[]> {
      return session.latest?.findings ?? []
    },

    async clean(findingIds: unknown, confirmOverflow: unknown): Promise<CleanOutcome> {
      const ids = parseFindingIds(findingIds)
      const confirm = parseBoolean(confirmOverflow)
      if (working !== null) return { status: 'rejected', reason: 'busy' }
      const resolved = session.resolveFindings(ids)
      if (!resolved.ok) return { status: 'rejected', reason: resolved.reason }
      const latest = session.latest
      if (latest === null) return { status: 'rejected', reason: 'stale-scan' }

      working = 'clean'
      let outcome: CleanOutcome | undefined
      try {
        // Every finding of the scan as the main process holds it, never a copy from the renderer.
        outcome = await runCleanup(
          resolved.findings,
          latest.findings,
          confirm,
          { ...deps.cleanup, log },
          (done, total) => deps.cleanProgress(done, total)
        )
      } finally {
        working = null
        // Something may have moved even when the log could not be written.
        if (outcome === undefined || outcome.status === 'done') refreshBin()
      }
      if (outcome.status === 'done') {
        session.removeFindings(
          outcome.batch.items.filter((i) => i.status === 'recycled').map((i) => i.findingId)
        )
      }
      return outcome
    },

    async getHistory(): Promise<HistoryEntry[]> {
      return log.history()
    },

    async restoreBatch(batchId: unknown): Promise<RestoreRecord> {
      return putBack(parseBatchId(batchId))
    },

    async undoLatest(): Promise<UndoOutcome> {
      requireFeature('undo')
      if (working !== null) return { status: 'busy' }
      const target = latestUndoTarget(await log.history())
      // history() yielded. A clean or another restore may have started.
      if (working !== null) return { status: 'busy' }
      if (target === null) return { status: 'nothing' }
      try {
        const record = await putBack(target.batchId)
        return {
          status: 'done',
          batchId: target.batchId,
          restorableCount: target.restorableCount,
          record
        }
      } catch (e) {
        if (e instanceof Error && e.message === 'busy') return { status: 'busy' }
        throw e
      }
    },

    async getProjects(): Promise<ProjectTree[]> {
      return deps.projects.list()
    },

    async createProject(name: unknown, rootPath: unknown): Promise<ProjectTree> {
      return deps.projects.create(parseProjectName(name), parseProjectRoot(rootPath))
    },

    async addSubject(projectId: unknown, kind: unknown, name: unknown): Promise<ProjectTree> {
      return deps.projects.addSubject(
        parseProjectId(projectId),
        parseBranchKind(kind),
        parseProjectName(name)
      )
    },

    async removeSubject(projectId: unknown, subjectId: unknown): Promise<ProjectTree> {
      return deps.projects.removeSubject(parseProjectId(projectId), parseProjectId(subjectId))
    },

    async pickImages(): Promise<string[] | null> {
      return deps.imports.pickImages()
    },

    async readImportImage(path: unknown): Promise<ImportImage | null> {
      return deps.imports.readImage(parseImportPath(path))
    },

    async previewImport(projectId: unknown, files: unknown): Promise<ImportPreview> {
      return deps.imports.preview(parseProjectId(projectId), parseImportFiles(files))
    },

    async confirmImport(projectId: unknown, groups: unknown): Promise<ImportResult> {
      return deps.imports.confirm(parseProjectId(projectId), parseConfirmedGroups(groups))
    },

    async undoOrganize(): Promise<OrganizeUndoResult> {
      return deps.imports.undo()
    },

    async getSubjectHashes(): Promise<Record<string, string[]>> {
      return deps.imports.subjectHashes()
    },

    async getSettings(): Promise<Settings> {
      return settings.get()
    },

    saveSettings,

    async pickFolder(): Promise<string | null> {
      const picked = await deps.pickFolder()
      return picked === null ? null : normalizePath(picked)
    },

    async excludeFolder(folderId: unknown): Promise<Settings> {
      const tree = treeOrInvalid()
      const path = tree.folderPath(parseFolderId(folderId, tree))
      const current = settings.get()
      const key = pathKey(path)
      if (current.exclusions.some((e) => pathKey(e) === key)) return current
      return saveSettings({ ...current, exclusions: [...current.exclusions, path] })
    },

    async showItem(ref: unknown): Promise<void> {
      const tree = treeOrInvalid()
      const { kind, id } = parseItemRef(ref, tree)
      deps.showItem(kind === 'folder' ? tree.folderPath(id) : tree.filePath(id))
    },

    async openDiskCleanup(): Promise<void> {
      deps.openDiskCleanup()
    },

    async openStorageSettings(): Promise<void> {
      await deps.openStorageSettings()
    },

    async openRecycleBin(): Promise<void> {
      deps.openRecycleBin()
    },

    async rescanAsAdmin(): Promise<void> {
      const root = session.latest?.root ?? settings.get().scanTargets[0]
      if (root === undefined) throw new Error('Add a drive or folder to scan first')
      // A declined UAC prompt leaves this copy running; either way the call resolves.
      await deps.relaunchElevated(root)
    }
  }
}

export interface IpcDeps {
  session: ScanSession
  log: CleanupLog
  settingsDir: string
  env: WinEnv
  recycler: Recycler
  window(): BrowserWindow | null
  settings: LiveSettings
  binUsage: BinUsageCache
}

/**
 * Registers every window.stash method with ipcMain. Only the app's own window may call them. Cleanup
 * progress goes to the window on `stash:clean-progress`.
 */
export function registerIpc(deps: IpcDeps): void {
  const projects = new ProjectsStore(deps.settingsDir, deps.env)
  const organize = new OrganizeService(
    projects,
    new OrganizeLog(deps.settingsDir),
    new LikenessStore(deps.settingsDir),
    deps.env
  )
  const handlers = createHandlers({
    session: deps.session,
    log: deps.log,
    settings: deps.settings,
    binUsage: deps.binUsage,
    projects,
    cleanup: {
      recycler: deps.recycler,
      binInfo: getRecycleBinInfo,
      findRecords: findRecycledRecords,
      env: deps.env,
      now: Date.now
    },
    binDir: recycleBinDir,
    driveUsage: getDriveUsage,
    cleanProgress: forwarder(deps.window, CHANNELS.onCleanProgress),
    imports: {
      pickImages: async () => {
        const win = deps.window()
        const options = {
          title: 'Choose images to organize',
          properties: ['openFile' as const, 'multiSelections' as const],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
        }
        const result = await (win
          ? dialog.showOpenDialog(win, options)
          : dialog.showOpenDialog(options))
        if (result.canceled || result.filePaths.length === 0) return null
        const paths = result.filePaths
          .map((file) => normalizePath(file))
          .filter((file) => isPlainDrivePath(file))
        return paths.length === 0 ? null : paths
      },
      readImage: readImportImage,
      preview: (projectId, files) => organize.preview(projectId, files),
      confirm: (projectId, groups) => organize.confirm(projectId, groups),
      undo: () => organize.undo(),
      subjectHashes: () => organize.subjectHashes()
    },
    pickFolder: async () => {
      const win = deps.window()
      const options = { properties: ['openDirectory' as const] }
      const result = await (win
        ? dialog.showOpenDialog(win, options)
        : dialog.showOpenDialog(options))
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
    },
    showItem: systemActions.showItem,
    openDiskCleanup: systemActions.openDiskCleanup,
    openStorageSettings: systemActions.openStorageSettings,
    openRecycleBin: systemActions.openRecycleBin,
    relaunchElevated,
    now: Date.now
  })

  for (const name of INVOKE_NAMES) {
    const handler = handlers[name] as (...args: unknown[]) => Promise<unknown>
    ipcMain.handle(CHANNELS[name], (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender !== deps.window()?.webContents) throw new Error('unknown sender')
      return handler(...args)
    })
  }
}
