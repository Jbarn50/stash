// The typed API the preload script exposes as window.stash, and the IPC channel behind each method.
// No runtime code here may need Node or Electron: the renderer imports this file (types only) and
// the preload bundles it.

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

/** The two methods that subscribe to events from the main process instead of asking it something. */
export type StashEventName = 'onSessionEvent' | 'onCleanProgress'
/** The methods that are one `ipcRenderer.invoke` each. */
export type StashInvokeName = Exclude<keyof StashApi, StashEventName>

/** Every invoke method, in the order of StashApi. */
export const INVOKE_NAMES: readonly StashInvokeName[] = [
  'getOverview',
  'startScan',
  'cancelScan',
  'getFolderView',
  'getFindings',
  'clean',
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

/**
 * The channel of each method: `stash:<name>` for an invoke method. The two subscriptions listen on
 * the event channels the main process sends on.
 */
export const CHANNELS: Record<keyof StashApi, string> = {
  ...(Object.fromEntries(INVOKE_NAMES.map((name) => [name, `stash:${name}`])) as Record<
    StashInvokeName,
    string
  >),
  onSessionEvent: 'stash:session-event',
  onCleanProgress: 'stash:clean-progress'
}
