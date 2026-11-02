// The messages between the main process and the two worker threads. Types only.
import type { HashGroup, SizeGroup } from '../core/detectors/duplicates'
import type { ScanProgressPayload } from '../core/scan/scanTree'
import type { ScanTreeData } from '../core/tree'
import type { Bytes, Finding, Settings, WinEnv } from '../shared/types'

/** What the scan worker is started with (as `workerData`). */
export interface ScanJob {
  scanId: string
  root: string
  settings: Settings
  env: WinEnv
  now: number
}

/**
 * What the scan worker found. A scan that was cancelled or failed midway still sends this, with
 * `incomplete: true` (and `error` for a failure) and whatever had been built by then.
 */
export interface ScanDone {
  tree: ScanTreeData
  findings: Finding[]
  /** Same-size files for the hash worker to compare. */
  candidates: SizeGroup[]
  incomplete: boolean
  durationMs: number
  foldersScanned: number
  filesScanned: number
  error?: string
}

/** What the hash worker is started with (as `workerData`). */
export interface HashJob {
  groups: SizeGroup[]
}

export type ScanWorkerMessage =
  | { type: 'progress'; progress: ScanProgressPayload }
  | ({ type: 'done' } & ScanDone)
  // No tree at all, for example because the root could not be read.
  | { type: 'error'; message: string }

export type HashWorkerMessage =
  | { type: 'progress'; hashedBytes: Bytes; totalBytes: Bytes }
  // A cancelled run sends `groups: []`; the session knows it cancelled and does not use them anyway.
  | { type: 'done'; groups: HashGroup[] }
  | { type: 'error'; message: string }

/** Sent from the main process to either worker. */
export type WorkerCommand = { type: 'cancel' }
