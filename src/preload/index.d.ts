import type { StashApi } from '../shared/ipc'

declare global {
  interface Window {
    stash: StashApi
  }
}
