import { useEffect, useState } from 'react'
import type { StashApi } from '../../../shared/ipc'
import type { ScanProgress, ScanSummary, SessionState } from '../../../shared/types'
import { errorText, maybeApi, MISSING_API } from './api'

export interface SessionView {
  state: SessionState
  progress: ScanProgress | null
  summary: ScanSummary | null
  error: string | null
}

/**
 * The scan session as the renderer sees it: the state and last summary from getOverview, kept current by
 * session events. A failed run that produced no result sends only an 'error' event, so after an error the
 * state is read again rather than assumed.
 */
export function useSession(): SessionView {
  const [view, setView] = useState<SessionView>(() => ({
    state: 'idle',
    progress: null,
    summary: null,
    error: maybeApi() ? null : MISSING_API
  }))

  useEffect(() => {
    const stash: StashApi | null = maybeApi()
    if (!stash) return
    let alive = true
    let sawEvent = false
    const refreshState = (): void => {
      stash
        .getOverview()
        .then((o) => {
          if (!alive) return
          setView((v) => ({
            ...v,
            state: o.state,
            progress: o.state === 'ready' || o.state === 'idle' ? null : v.progress
          }))
        })
        .catch(() => {})
    }
    const off = stash.onSessionEvent((e) => {
      sawEvent = true
      if (e.type === 'progress') {
        setView((v) => ({ ...v, state: e.progress.phase, progress: e.progress, error: null }))
      } else if (e.type === 'done') {
        setView((v) => ({ ...v, state: 'ready', progress: null, summary: e.summary }))
      } else {
        setView((v) => ({ ...v, error: e.message }))
        refreshState()
      }
    })
    stash
      .getOverview()
      .then((o) => {
        if (!alive) return
        setView((v) =>
          sawEvent
            ? { ...v, summary: v.summary ?? o.lastScan }
            : { ...v, state: o.state, summary: o.lastScan }
        )
      })
      .catch((e) => alive && setView((v) => ({ ...v, error: errorText(e) })))
    return () => {
      alive = false
      off()
    }
  }, [])

  return view
}

export function isBusy(state: SessionState): boolean {
  return state === 'scanning' || state === 'hashing'
}
