// The typed API the preload script exposes as window.stash, and its IPC channel names.
// Copied from the plan's Task 14 Interfaces block so the renderer (Tasks 15-18) can be built ahead of
// Task 14. Task 14 owns this file: on merge, keep Task 14's version.
// The renderer imports this file with `import type` only, so CHANNELS never reaches the sandboxed bundle.

import type {
  CleanOutcome,
  Finding,
  HistoryEntry,
  Overview,
  RestoreRecord,
  SessionEvent,
  Settings,
  ViewNode
} from './types'

export interface StashApi {
  getOverview(): Promise<Overview>
  startScan(root: string): Promise<{ scanId: string }>
  cancelScan(): Promise<void>
  onSessionEvent(cb: (e: SessionEvent) => void): () => void
  getFolderView(folderId: number, depth: number): Promise<ViewNode | null>
  getFindings(): Promise<Finding[]>
  clean(findingIds: string[], confirmOverflow: boolean): Promise<CleanOutcome>
  onCleanProgress(cb: (done: number, total: number) => void): () => void
  getHistory(): Promise<HistoryEntry[]>
  restoreBatch(batchId: string): Promise<RestoreRecord>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>
  pickFolder(): Promise<string | null>
  excludeFolder(folderId: number): Promise<Settings>
  showItem(ref: { kind: 'folder' | 'file'; id: number }): Promise<void>
  openDiskCleanup(): Promise<void>
  openStorageSettings(): Promise<void>
  openRecycleBin(): Promise<void>
  rescanAsAdmin(): Promise<void>
}

const NAMES: (keyof StashApi)[] = [
  'getOverview',
  'startScan',
  'cancelScan',
  'onSessionEvent',
  'getFolderView',
  'getFindings',
  'clean',
  'onCleanProgress',
  'getHistory',
  'restoreBatch',
  'getSettings',
  'saveSettings',
  'pickFolder',
  'excludeFolder',
  'showItem',
  'openDiskCleanup',
  'openStorageSettings',
  'openRecycleBin',
  'rescanAsAdmin'
]

export const CHANNELS = Object.fromEntries(NAMES.map((n) => [n, `stash:${n}`])) as Record<
  keyof StashApi,
  string
>
