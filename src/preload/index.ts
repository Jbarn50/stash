import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
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

// Custom APIs for renderer
const api = {}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('stash', stash)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.stash = stash
}
