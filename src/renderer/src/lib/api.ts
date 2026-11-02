import type { StashApi } from '../../../shared/ipc'

export const MISSING_API = "Stash couldn't reach its main process. Restart Stash."

/** window.stash, or null when the preload API is missing. */
export function maybeApi(): StashApi | null {
  return (window as Partial<Window>).stash ?? null
}

/** window.stash, or a clear error when the preload API is missing (so a screen can say so instead of crashing). */
export function api(): StashApi {
  const stash = maybeApi()
  if (!stash) throw new Error(MISSING_API)
  return stash
}

export function errorText(e: unknown): string {
  if (e instanceof Error)
    return e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  return String(e)
}
