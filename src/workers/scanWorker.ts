// Runs in a worker thread: walks the drive, then finds everything except duplicates.
import { parentPort, workerData } from 'node:worker_threads'
import { createDetectorContext } from '../core/detectors/context'
import { duplicateCandidates } from '../core/detectors/duplicates'
import { runStaticDetectors } from '../core/detectors/index'
import { errorMessage } from '../core/errorMessage'
import { scanTree, type ScanResult } from '../core/scan/scanTree'
import type { ScanDone, ScanJob, ScanWorkerMessage, WorkerCommand } from './protocol'

const port = parentPort
if (!port) throw new Error('The scan worker must run in a worker thread')

const job = workerData as ScanJob
const post = (message: ScanWorkerMessage): void => port.postMessage(message)

const cancel = new AbortController()
port.on('message', (command: WorkerCommand) => {
  if (command.type === 'cancel') cancel.abort()
})

async function main(): Promise<void> {
  let scan: ScanResult
  try {
    scan = await scanTree({
      root: job.root,
      trackFileMinBytes: job.settings.thresholds.trackFileMinBytes,
      signal: cancel.signal,
      onProgress: (progress) => post({ type: 'progress', progress })
    })
  } catch (e) {
    // The root itself could not be read: there is no tree to send.
    post({ type: 'error', message: errorMessage(e) })
    return
  }

  const done: ScanDone = {
    tree: scan.tree.toData(),
    findings: [],
    candidates: [],
    incomplete: scan.incomplete,
    durationMs: scan.durationMs,
    foldersScanned: scan.foldersScanned,
    filesScanned: scan.filesScanned,
    ...(scan.error === undefined ? {} : { error: scan.error })
  }
  try {
    // One context for both: the duplicate candidates leave out what the static detectors claimed.
    const ctx = createDetectorContext({
      scanId: job.scanId,
      tree: scan.tree,
      env: job.env,
      settings: job.settings,
      now: job.now
    })
    done.findings = runStaticDetectors(ctx)
    done.candidates = duplicateCandidates(ctx)
  } catch (e) {
    // The tree is still good; send it without findings rather than lose the scan.
    done.findings = []
    done.candidates = []
    done.incomplete = true
    done.error ??= errorMessage(e)
  }
  post({ type: 'done', ...done })
}

void main()
