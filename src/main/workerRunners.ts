// The one place that starts the worker threads. It only carries messages and the cancel command;
// what a scan means lives in the session and the workers.
import type { Worker } from 'node:worker_threads'
import type { HashGroup } from '../core/detectors/duplicates'
import createHashWorker from '../workers/hashWorker?nodeWorker'
import createScanWorker from '../workers/scanWorker?nodeWorker'
import type {
  HashJob,
  HashWorkerMessage,
  ScanDone,
  ScanWorkerMessage,
  WorkerCommand
} from '../workers/protocol'
import type { HashRunner, ScanRunner } from './session'

/** What to do with one message: undefined to carry on, or the end of the run. */
type Step<Result> = { result: Result } | { failure: string } | undefined

/**
 * Follows a worker until its final message and returns what that message carries. Aborting `signal`
 * sends the worker a cancel command; the worker still answers, with what it has. The run fails if the
 * worker reports an error, throws, or exits without finishing. The worker is stopped afterwards.
 */
function follow<Message, Result>(
  name: 'scan' | 'hash',
  worker: Worker,
  signal: AbortSignal,
  onMessage: (message: Message) => Step<Result>
): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    let finished = false
    const cancel = (): void => worker.postMessage({ type: 'cancel' } satisfies WorkerCommand)
    const finish = (settle: () => void): void => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', cancel)
      void worker.terminate()
      settle()
    }

    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()

    worker.on('message', (message: Message) => {
      if (finished) return
      try {
        const step = onMessage(message)
        if (step === undefined) return
        if ('result' in step) finish(() => resolve(step.result))
        else finish(() => reject(new Error(step.failure)))
      } catch (e) {
        finish(() => reject(e))
      }
    })
    worker.on('error', (e) => finish(() => reject(e)))
    worker.on('exit', (code) =>
      finish(() => reject(new Error(`The ${name} worker stopped unexpectedly (exit code ${code})`)))
    )
  })
}

export function createScanRunner(): ScanRunner {
  return {
    run: (job, onProgress, signal) =>
      follow<ScanWorkerMessage, ScanDone>(
        'scan',
        createScanWorker({ workerData: job }),
        signal,
        (message) => {
          switch (message.type) {
            case 'progress':
              onProgress(message.progress)
              return undefined
            case 'done': {
              const { type, ...done } = message
              void type
              return { result: done }
            }
            case 'error':
              return { failure: message.message }
          }
        }
      )
  }
}

export function createHashRunner(): HashRunner {
  return {
    run: (groups, onProgress, signal) =>
      follow<HashWorkerMessage, HashGroup[]>(
        'hash',
        createHashWorker({ workerData: { groups } satisfies HashJob }),
        signal,
        (message) => {
          switch (message.type) {
            case 'progress':
              onProgress(message.hashedBytes, message.totalBytes)
              return undefined
            case 'done':
              return { result: message.groups }
            case 'error':
              return { failure: message.message }
          }
        }
      )
  }
}
