import { ElectronAPI } from '@electron-toolkit/preload'
import type { StashApi } from '../shared/ipc'

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
    stash: StashApi
  }
}
