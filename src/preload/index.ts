import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { CHANNELS, type StashApi } from '../shared/ipc'
import type { SessionEvent } from '../shared/types'

/**
 * Listens on `channel` and returns the function that removes exactly this listener. The renderer
 * gets the event's arguments only, never the IPC event, so ipcRenderer itself never crosses over.
 */
function subscribe<Args extends unknown[]>(
  channel: string,
  cb: (...args: Args) => void
): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as Args))
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

// window.stash: the one API Stash's screens use. Each method is one call to the main process.
const stash: StashApi = {
  getOverview: () => ipcRenderer.invoke(CHANNELS.getOverview),
  startScan: (root) => ipcRenderer.invoke(CHANNELS.startScan, root),
  cancelScan: () => ipcRenderer.invoke(CHANNELS.cancelScan),
  onSessionEvent: (cb) => subscribe<[SessionEvent]>(CHANNELS.onSessionEvent, cb),
  getFolderView: (folderId, depth) => ipcRenderer.invoke(CHANNELS.getFolderView, folderId, depth),
  getFindings: () => ipcRenderer.invoke(CHANNELS.getFindings),
  clean: (findingIds, confirmOverflow) =>
    ipcRenderer.invoke(CHANNELS.clean, findingIds, confirmOverflow),
  onCleanProgress: (cb) => subscribe<[number, number]>(CHANNELS.onCleanProgress, cb),
  getHistory: () => ipcRenderer.invoke(CHANNELS.getHistory),
  restoreBatch: (batchId) => ipcRenderer.invoke(CHANNELS.restoreBatch, batchId),
  getSettings: () => ipcRenderer.invoke(CHANNELS.getSettings),
  saveSettings: (s) => ipcRenderer.invoke(CHANNELS.saveSettings, s),
  pickFolder: () => ipcRenderer.invoke(CHANNELS.pickFolder),
  excludeFolder: (folderId) => ipcRenderer.invoke(CHANNELS.excludeFolder, folderId),
  showItem: (ref) => ipcRenderer.invoke(CHANNELS.showItem, ref),
  openDiskCleanup: () => ipcRenderer.invoke(CHANNELS.openDiskCleanup),
  openStorageSettings: () => ipcRenderer.invoke(CHANNELS.openStorageSettings),
  openRecycleBin: () => ipcRenderer.invoke(CHANNELS.openRecycleBin),
  rescanAsAdmin: () => ipcRenderer.invoke(CHANNELS.rescanAsAdmin)
}

// Spec §4.1: the preload exposes window.stash and nothing else.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('stash', stash)
  } catch (error) {
    console.error(error)
  }
} else {
  // index.d.ts augments Window for the renderer; this Node compile does not see that.
  ;(window as unknown as { stash: StashApi }).stash = stash
}
