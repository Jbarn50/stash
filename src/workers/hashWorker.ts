// Runs in a worker thread: finds which same-size files are really identical.
import { parentPort, workerData } from 'node:worker_threads'
import { errorMessage } from '../core/errorMessage'
import { hashGroups } from '../core/hash'
import type { HashJob, HashWorkerMessage, WorkerCommand } from './protocol'

const PROGRESS_INTERVAL_MS = 250

const port = parentPort
if (!port) throw new Error('The hash worker must run in a worker thread')

const { groups } = workerData as HashJob
const post = (message: HashWorkerMessage): void => port.postMessage(message)

const cancel = new AbortController()
port.on('message', (command: WorkerCommand) => {
  if (command.type === 'cancel') cancel.abort()
})

async function main(): Promise<void> {
  let lastPosted = -Infinity
  try {
    const found = await hashGroups(groups, {
      signal: cancel.signal,
      onProgress: (hashedBytes, totalBytes) => {
        // hashGroups reports after every file: pass on one update in each interval, and the last.
        const now = Date.now()
        if (hashedBytes < totalBytes && now - lastPosted < PROGRESS_INTERVAL_MS) return
        lastPosted = now
        post({ type: 'progress', hashedBytes, totalBytes })
      }
    })
    post({ type: 'done', groups: found })
  } catch (e) {
    // A cancelled run ends as a finished one with nothing found; the session knows it cancelled.
    post(
      cancel.signal.aborted
        ? { type: 'done', groups: [] }
        : { type: 'error', message: errorMessage(e) }
    )
  }
}

void main()
