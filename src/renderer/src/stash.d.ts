// window.stash for the renderer. Task 14 declares the same property in src/preload/index.d.ts;
// once that lands, this file can be deleted (identical declarations merge without error).
import type { StashApi } from '../../shared/ipc'

declare global {
  interface Window {
    stash: StashApi
  }
}

export {}
