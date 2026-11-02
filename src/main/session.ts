import { randomUUID } from 'node:crypto'
import {
  buildDuplicateFindings,
  type HashGroup,
  type SizeGroup
} from '../core/detectors/duplicates'
import { errorMessage } from '../core/errorMessage'
import { buildSummary, summarizeFindings } from '../core/findings'
import { suggestKeeper } from '../core/keeper'
import { isSameOrInside } from '../core/paths'
import type { ScanProgressPayload } from '../core/scan/scanTree'
import { ScanTree } from '../core/tree'
import type {
  Bytes,
  Finding,
  ScanSummary,
  SessionEvent,
  SessionState,
  Settings,
  WinEnv
} from '../shared/types'
import type { ScanDone, ScanJob } from '../workers/protocol'

// This file never imports electron or the worker runners, so the tests can drive it with fake runners.

/**
 * Walks the drive and finds everything except duplicates. When `signal` aborts it stops and resolves
 * with what it has so far (`incomplete: true`); it rejects only when it has no result at all.
 */
export interface ScanRunner {
  run(
    job: ScanJob,
    onProgress: (p: ScanProgressPayload) => void,
    signal: AbortSignal
  ): Promise<ScanDone>
}

/**
 * Finds which same-size files are really identical. When `signal` aborts it may resolve with
 * nothing found; the session knows it cancelled and discards whatever comes back.
 */
export interface HashRunner {
  run(
    groups: SizeGroup[],
    onProgress: (hashed: Bytes, total: Bytes) => void,
    signal: AbortSignal
  ): Promise<HashGroup[]>
}

/** The newest finished scan, which cleanup and the explorer work from. */
export interface LatestScan {
  scanId: string
  root: string
  tree: ScanTree
  findings: Finding[]
  summary: ScanSummary
}

export interface SessionDeps {
  scanRunner: ScanRunner
  hashRunner: HashRunner
  getSettings(): Settings
  env: WinEnv
  emit(e: SessionEvent): void
  now?(): number
}

const NO_PROGRESS: ScanProgressPayload = {
  foldersScanned: 0,
  filesScanned: 0,
  bytesSeen: 0,
  currentPath: '',
  topLevel: []
}

/** The scan an id belongs to: the text before its first colon. */
function scanIdOf(findingId: string): string {
  const colon = findingId.indexOf(':')
  return colon < 0 ? findingId : findingId.slice(0, colon)
}

/**
 * Keeps the duplicate groups (findings that share a groupId) meaningful once some findings are gone.
 * A group left with one copy is no longer a duplicate, and the last copy of a file must never be
 * offered for cleanup, so that copy goes too. A group left with several copies but without the one
 * to keep gets a new keeper, chosen the way the scan chose the first. A group that still has its
 * keeper is left alone.
 */
function normalizeDuplicateGroups(findings: Finding[], env: WinEnv): Finding[] {
  const groups = new Map<string, Finding[]>()
  for (const f of findings) {
    if (f.groupId === undefined) continue
    const copies = groups.get(f.groupId)
    if (copies) copies.push(f)
    else groups.set(f.groupId, [f])
  }

  const lastCopies = new Set<string>()
  const newKeepers = new Set<string>()
  for (const copies of groups.values()) {
    if (copies.length === 1) lastCopies.add(copies[0].id)
    else if (!copies.some((c) => c.suggestedKeep)) {
      const keeperIndex = suggestKeeper(
        copies.map((c) => ({ path: c.path, mtimeMs: c.mtimeMs })),
        env
      )
      newKeepers.add(copies[keeperIndex].id)
    }
  }

  if (lastCopies.size === 0 && newKeepers.size === 0) return findings
  return findings
    .filter((f) => !lastCopies.has(f.id))
    .map((f) => (newKeepers.has(f.id) ? { ...f, suggestedKeep: true } : f))
}

/**
 * One scan at a time: walk the drive, hash the files that might be duplicates, and keep the result
 * as `latest` until the next scan replaces it. A scan that is cancelled or fails midway still leaves
 * what it found, marked incomplete.
 */
export class ScanSession {
  private _state: SessionState = 'idle'
  private _latest: LatestScan | null = null
  private running: AbortController | null = null

  constructor(private readonly deps: SessionDeps) {}

  get state(): SessionState {
    return this._state
  }

  get latest(): LatestScan | null {
    return this._latest
  }

  /** Starts a scan in the background and returns its id. Progress and the end arrive as events. */
  start(root: string): string {
    if (this.busy) throw new Error('busy')
    const scanId = randomUUID()
    const running = new AbortController()
    this.running = running
    this._state = 'scanning'
    void this.run(scanId, root, running.signal)
    return scanId
  }

  /** Stops the scan or the hashing. The session ends with what it has, marked incomplete. */
  cancel(): void {
    if (this.busy) this.running?.abort()
  }

  resolveFindings(
    ids: string[]
  ):
    | { ok: true; findings: Finding[] }
    | { ok: false; reason: 'stale-scan' | 'busy' | 'unknown-finding' } {
    if (this.busy) return { ok: false, reason: 'busy' }
    const latest = this._latest
    const stale = ids.some((id) => scanIdOf(id) !== latest?.scanId)
    if (stale) return { ok: false, reason: 'stale-scan' }
    const byId = new Map((latest?.findings ?? []).map((f) => [f.id, f]))
    const findings: Finding[] = []
    for (const id of ids) {
      const found = byId.get(id)
      if (!found) return { ok: false, reason: 'unknown-finding' }
      findings.push(found)
    }
    return { ok: true, findings }
  }

  /**
   * Forgets findings that have been dealt with, for example once they are recycled. A duplicate group
   * left with one copy loses that copy too; one left without its keeper gets a new one.
   */
  removeFindings(ids: string[]): void {
    const latest = this._latest
    if (!latest) return
    const gone = new Set(ids)
    const kept = latest.findings.filter((f) => !gone.has(f.id))
    this.replaceFindings(latest, kept)
  }

  /**
   * Drops the findings that lie inside one of the exclusions. Duplicate groups are tidied as
   * removeFindings does.
   */
  applyExclusions(settings: Settings): void {
    const latest = this._latest
    if (!latest) return
    const excluded = (path: string): boolean =>
      settings.exclusions.some((exclusion) => isSameOrInside(path, exclusion))
    const kept = latest.findings.filter((f) => !excluded(f.path))
    this.replaceFindings(latest, kept)
  }

  private get busy(): boolean {
    return this._state === 'scanning' || this._state === 'hashing'
  }

  // Duplicate groups are put right first. The summary keeps what the scan measured and takes the
  // totals from the findings that are left, so a copy marked to keep is never counted.
  private replaceFindings(latest: LatestScan, findings: Finding[]): void {
    const tidied = normalizeDuplicateGroups(findings, this.deps.env)
    this._latest = {
      ...latest,
      findings: tidied,
      summary: { ...latest.summary, ...summarizeFindings(tidied) }
    }
  }

  // A listener that fails (a window that has gone, say) must not leave a scan half finished.
  private emit(event: SessionEvent): void {
    try {
      this.deps.emit(event)
    } catch {
      // nothing to do about it here
    }
  }

  // Back to rest: ready when there are results to show, idle when there are none.
  private settle(): void {
    this.running = null
    this._state = this._latest ? 'ready' : 'idle'
  }

  private async run(scanId: string, root: string, signal: AbortSignal): Promise<void> {
    const { deps } = this
    let lastProgress = NO_PROGRESS
    try {
      const scan = await deps.scanRunner.run(
        {
          scanId,
          root,
          settings: deps.getSettings(),
          env: deps.env,
          now: deps.now?.() ?? Date.now()
        },
        (progress) => {
          lastProgress = progress
          this.emit({ type: 'progress', progress: { scanId, phase: 'scanning', ...progress } })
        },
        signal
      )
      const tree = ScanTree.fromData(scan.tree)
      let findings = scan.findings
      let error = scan.error
      // A cancel or a failure keeps the scan as far as it got and skips hashing.
      let incomplete = scan.incomplete || error !== undefined || signal.aborted

      if (!incomplete) {
        this._state = 'hashing'
        try {
          const groups = await deps.hashRunner.run(
            scan.candidates,
            (hashedBytes, hashTotalBytes) =>
              this.emit({
                type: 'progress',
                progress: { scanId, phase: 'hashing', ...lastProgress, hashedBytes, hashTotalBytes }
              }),
            signal
          )
          if (signal.aborted) {
            incomplete = true // a cancel makes whatever came back unusable
          } else {
            const duplicates = buildDuplicateFindings(groups, { scanId, tree, env: deps.env })
            findings = [...findings, ...duplicates]
          }
        } catch (e) {
          // The scan itself is fine: keep its findings, without duplicates.
          incomplete = true
          error = errorMessage(e)
        }
      }

      const summary = buildSummary({
        scanId,
        root,
        incomplete,
        foldersScanned: scan.foldersScanned,
        filesScanned: scan.filesScanned,
        durationMs: scan.durationMs,
        tree,
        findings
      })
      // The results are in place before anyone is told, so a listener can act on them at once.
      this._latest = { scanId, root, tree, findings, summary }
      this.settle()
      if (error !== undefined) this.emit({ type: 'error', message: error })
      this.emit({ type: 'done', summary })
    } catch (e) {
      // No scan result at all: the previous one, if any, stays.
      this.settle()
      this.emit({ type: 'error', message: errorMessage(e) })
    }
  }
}
