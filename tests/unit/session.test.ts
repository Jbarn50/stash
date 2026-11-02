import { describe, expect, test, vi, type Mock } from 'vitest'
import type { HashGroup, SizeGroup } from '../../src/core/detectors/duplicates'
import type { ScanProgressPayload } from '../../src/core/scan/scanTree'
import { MiB, validateSettings } from '../../src/core/settings'
import type { ScanTree } from '../../src/core/tree'
import { ScanSession, type HashRunner, type ScanRunner } from '../../src/main/session'
import type { Finding, SessionEvent, SessionState } from '../../src/shared/types'
import type { ScanDone, ScanJob } from '../../src/workers/protocol'
import { SAMPLE_ENV } from '../helpers/env'
import { treeFrom } from '../helpers/treeFrom'

const NOW = Date.UTC(2026, 10, 1)
const ROOT = 'C:\\'
const SETTINGS = validateSettings({})

const DOWNLOADS_COPY = 'C:\\Users\\jorda\\Downloads\\photo.jpg'
const PICTURES_COPY = 'C:\\Users\\jorda\\Pictures\\photo.jpg'
const TEMP_FILE = 'C:\\Users\\jorda\\AppData\\Local\\Temp\\cache.tmp'
const UPDATE_CACHE = 'C:\\Windows\\SoftwareDistribution\\Download'

// 15 MiB in all. File ids follow the order of the entries, so the two copies of photo.jpg are 0 and 1.
const buildTree = (): ScanTree =>
  treeFrom(ROOT, {
    'Users\\jorda\\Downloads\\photo.jpg': { size: 5 * MiB, mtimeMs: 1 },
    'Users\\jorda\\Pictures\\photo.jpg': { size: 5 * MiB, mtimeMs: 5 },
    'Users\\jorda\\AppData\\Local\\Temp\\cache.tmp': { size: 2 * MiB, mtimeMs: 1 },
    'Windows\\SoftwareDistribution\\Download\\pkg.cab': { size: 3 * MiB, mtimeMs: 1 },
    'Users\\jorda\\Locked': { dir: true, unreadable: true }
  })

const CANDIDATES: SizeGroup[] = [
  { logicalSize: 5 * MiB, fileIds: [0, 1], paths: [DOWNLOADS_COPY, PICTURES_COPY] }
]
const HASHED: HashGroup[] = [{ hash: 'abc', fileIds: [0, 1] }]

const SCAN_A: ScanProgressPayload = {
  foldersScanned: 3,
  filesScanned: 8,
  bytesSeen: 4 * MiB,
  currentPath: 'C:\\Users',
  topLevel: [{ name: 'Users', sizeOnDisk: 4 * MiB }]
}
const SCAN_B: ScanProgressPayload = {
  foldersScanned: 12,
  filesScanned: 34,
  bytesSeen: 15 * MiB,
  currentPath: 'C:\\Windows',
  topLevel: [
    { name: 'Users', sizeOnDisk: 12 * MiB },
    { name: 'Windows', sizeOnDisk: 3 * MiB }
  ]
}

function finding(scanId: string, ruleId: string, n: number, over: Partial<Finding>): Finding {
  return {
    id: `${scanId}:${ruleId}:${n}`,
    scanId,
    ruleId,
    category: 'tempCaches',
    safety: 'safe',
    title: 'Old temporary files',
    explanation: 'Files apps left in your temp folder.',
    path: TEMP_FILE,
    kind: 'file',
    sizeOnDisk: 2 * MiB,
    logicalSize: 2 * MiB,
    mtimeMs: 1,
    ...over
  }
}

// What the static detectors would report: 2 MiB Stash can clean and 3 MiB only Windows can.
const staticFindings = (scanId: string): Finding[] => [
  finding(scanId, 'temp-user', 0, {}),
  finding(scanId, 'sys-windows-update', 1, {
    category: 'system',
    safety: 'info',
    title: 'Windows Update downloads',
    path: UPDATE_CACHE,
    kind: 'folder',
    sizeOnDisk: 3 * MiB,
    logicalSize: 3 * MiB
  })
]

function scanDone(job: ScanJob, over: Partial<ScanDone> = {}): ScanDone {
  return {
    tree: buildTree().toData(),
    findings: staticFindings(job.scanId),
    candidates: CANDIDATES,
    incomplete: false,
    durationMs: 1234,
    foldersScanned: 12,
    filesScanned: 34,
    ...over
  }
}

const defaultScan: ScanRunner['run'] = async (job, onProgress) => {
  onProgress(SCAN_A)
  onProgress(SCAN_B)
  return scanDone(job)
}
const defaultHash: HashRunner['run'] = async (_groups, onProgress) => {
  onProgress(5 * MiB, 10 * MiB)
  onProgress(10 * MiB, 10 * MiB)
  return HASHED
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** Resolves when the signal aborts, as a worker would see the cancel command. */
const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => resolve(), { once: true })
  })

interface Script {
  scan?: ScanRunner['run']
  hash?: HashRunner['run']
  onEmit?: (e: SessionEvent) => void
}

interface Harness {
  session: ScanSession
  scan: Mock<ScanRunner['run']>
  hash: Mock<HashRunner['run']>
  events: SessionEvent[]
  stateAtEvent: SessionState[]
  latestAtEvent: (string | null)[]
  settled(): Promise<void>
  /** Starts a scan and waits for it to end, whichever way it ends. Returns the scan id. */
  runToDone(): Promise<string>
  /** Everything emitted except progress. */
  nonProgress(): SessionEvent[]
}

function harness(script: Script = {}): Harness {
  const events: SessionEvent[] = []
  const stateAtEvent: SessionState[] = []
  const latestAtEvent: (string | null)[] = []
  const scan = vi.fn<ScanRunner['run']>(script.scan ?? defaultScan)
  const hash = vi.fn<HashRunner['run']>(script.hash ?? defaultHash)
  const session: ScanSession = new ScanSession({
    scanRunner: { run: scan },
    hashRunner: { run: hash },
    getSettings: () => SETTINGS,
    env: SAMPLE_ENV,
    emit: (e) => {
      events.push(e)
      stateAtEvent.push(session.state)
      latestAtEvent.push(session.latest?.scanId ?? null)
      script.onEmit?.(e)
    },
    now: () => NOW
  })
  const settled = (): Promise<void> =>
    vi.waitFor(
      () => {
        if (session.state === 'scanning' || session.state === 'hashing') throw new Error('running')
      },
      { interval: 1, timeout: 2000 }
    )
  const runToDone = async (): Promise<string> => {
    const scanId = session.start(ROOT)
    await settled()
    return scanId
  }
  const nonProgress = (): SessionEvent[] => events.filter((e) => e.type !== 'progress')
  return {
    session,
    scan,
    hash,
    events,
    stateAtEvent,
    latestAtEvent,
    settled,
    runToDone,
    nonProgress
  }
}

const idsOf = (session: ScanSession): string[] => session.latest!.findings.map((f) => f.id)

function resolvedIds(r: ReturnType<ScanSession['resolveFindings']>): string[] {
  if (!r.ok) throw new Error(`not resolved: ${r.reason}`)
  return r.findings.map((f) => f.id)
}

describe('a scan from start to done', () => {
  test('scan, then hash, then done with duplicates included and state ready', async () => {
    const h = harness()
    const scanId = await h.runToDone()

    expect(h.session.state).toBe('ready')
    // Static findings first, then one finding per copy. The Pictures copy is the one to keep even
    // though the Downloads copy is older: Downloads is where a copy is expected to be thrown away.
    expect(idsOf(h.session)).toEqual([
      `${scanId}:temp-user:0`,
      `${scanId}:sys-windows-update:1`,
      `${scanId}:duplicates:0`,
      `${scanId}:duplicates:1`
    ])
    expect(h.session.latest!.findings.slice(2).map((f) => [f.path, f.suggestedKeep])).toEqual([
      [DOWNLOADS_COPY, undefined],
      [PICTURES_COPY, true]
    ])
    expect(h.session.latest!.scanId).toBe(scanId)
    expect(h.session.latest!.root).toBe(ROOT)
    expect(h.session.latest!.tree.folders[0].sizeOnDisk).toBe(15 * MiB)
    const summary = {
      scanId,
      root: ROOT,
      incomplete: false,
      foldersScanned: 12,
      filesScanned: 34,
      totalSizeOnDisk: 15 * MiB,
      unreadableFolders: 1,
      reclaimable: 7 * MiB, // the temp files and the Downloads copy; the kept copy is not counted
      byCategory: {
        duplicates: 5 * MiB,
        tempCaches: 2 * MiB,
        installersStale: 0,
        devLeftovers: 0,
        system: 0
      },
      windowsCanClean: 3 * MiB,
      durationMs: 1234
    }
    expect(h.session.latest!.summary).toEqual(summary)
    expect(h.nonProgress()).toEqual([{ type: 'done', summary }])
  })

  test('the session is already ready, with its results in place, when done is emitted', async () => {
    const h = harness()
    const scanId = await h.runToDone()
    const done = h.events.findIndex((e) => e.type === 'done')
    expect(h.stateAtEvent[done]).toBe('ready')
    expect(h.latestAtEvent[done]).toBe(scanId)
  })

  test('the scan runner gets a job built from the settings, the environment and the clock', async () => {
    const h = harness()
    const scanId = await h.runToDone()
    expect(h.scan.mock.calls).toHaveLength(1)
    expect(h.scan.mock.calls[0][0]).toEqual({
      scanId,
      root: ROOT,
      settings: SETTINGS,
      env: SAMPLE_ENV,
      now: NOW
    })
  })

  test('the hash runner gets the candidates the scan found', async () => {
    const h = harness()
    await h.runToDone()
    expect(h.hash.mock.calls).toHaveLength(1)
    expect(h.hash.mock.calls[0][0]).toEqual(CANDIDATES)
  })

  test('progress names its phase; hashing progress keeps the last scan counts and adds the hashing bytes', async () => {
    const h = harness()
    const scanId = await h.runToDone()
    const progress = h.events.flatMap((e) => (e.type === 'progress' ? [e.progress] : []))
    expect(progress).toEqual([
      { scanId, phase: 'scanning', ...SCAN_A },
      { scanId, phase: 'scanning', ...SCAN_B },
      { scanId, phase: 'hashing', ...SCAN_B, hashedBytes: 5 * MiB, hashTotalBytes: 10 * MiB },
      { scanId, phase: 'hashing', ...SCAN_B, hashedBytes: 10 * MiB, hashTotalBytes: 10 * MiB }
    ])
  })

  test('hashing progress is zeroed when this scan reported none, not carried over from the one before', async () => {
    const h = harness()
    await h.runToDone() // reports SCAN_A and SCAN_B
    h.scan.mockImplementationOnce(async (job) => scanDone(job))
    const before = h.events.length
    const scanId = await h.runToDone()
    const progress = h.events
      .slice(before)
      .flatMap((e) => (e.type === 'progress' ? [e.progress] : []))
    expect(progress[0]).toEqual({
      scanId,
      phase: 'hashing',
      foldersScanned: 0,
      filesScanned: 0,
      bytesSeen: 0,
      currentPath: '',
      topLevel: [],
      hashedBytes: 5 * MiB,
      hashTotalBytes: 10 * MiB
    })
  })

  test('start while busy throws, and the scan that is running carries on', async () => {
    const scanGate = deferred()
    const hashEntered = deferred()
    const hashGate = deferred()
    const h = harness({
      scan: async (job) => {
        await scanGate.promise
        return scanDone(job)
      },
      hash: async () => {
        hashEntered.resolve()
        await hashGate.promise
        return HASHED
      }
    })

    const scanId = h.session.start(ROOT)
    expect(h.session.state).toBe('scanning')
    expect(() => h.session.start(ROOT)).toThrow('busy')

    scanGate.resolve()
    await hashEntered.promise
    expect(h.session.state).toBe('hashing')
    expect(() => h.session.start(ROOT)).toThrow('busy')

    hashGate.resolve()
    await h.settled()
    expect(h.session.state).toBe('ready')
    expect(h.session.latest!.scanId).toBe(scanId)
    expect(h.scan).toHaveBeenCalledTimes(1) // a refused start launches nothing
  })
})

describe('cancel', () => {
  test('cancel during the scan keeps the partial static findings, skips hashing and marks the result incomplete', async () => {
    const entered = deferred()
    const h = harness({
      scan: async (job, onProgress, signal) => {
        onProgress(SCAN_A)
        entered.resolve()
        await aborted(signal)
        // The worker answers a cancel with what it has found so far.
        return scanDone(job, { incomplete: true })
      }
    })
    const scanId = h.session.start(ROOT)
    await entered.promise
    h.session.cancel()
    await h.settled()

    expect(h.hash).not.toHaveBeenCalled()
    expect(h.session.state).toBe('ready')
    expect(idsOf(h.session)).toEqual([`${scanId}:temp-user:0`, `${scanId}:sys-windows-update:1`])
    expect(h.session.latest!.summary.incomplete).toBe(true)
    expect(h.nonProgress()).toEqual([{ type: 'done', summary: h.session.latest!.summary }])
  })

  test('a cancel that arrives as the scan finishes still skips hashing and marks the result incomplete', async () => {
    const entered = deferred()
    const release = deferred()
    const h = harness({
      scan: async (job) => {
        entered.resolve()
        await release.promise
        return scanDone(job) // finished before the cancel reached the worker
      }
    })
    h.session.start(ROOT)
    await entered.promise
    h.session.cancel()
    release.resolve()
    await h.settled()

    expect(h.hash).not.toHaveBeenCalled()
    expect(h.session.latest!.summary.incomplete).toBe(true)
  })

  test('cancel during hashing keeps the static findings, adds no duplicates and marks the result incomplete', async () => {
    const entered = deferred()
    const h = harness({
      hash: async (_groups, _onProgress, signal) => {
        entered.resolve()
        await aborted(signal)
        return HASHED // a result that slips through after the cancel is not used
      }
    })
    const scanId = h.session.start(ROOT)
    await entered.promise
    expect(h.session.state).toBe('hashing')
    h.session.cancel()
    await h.settled()

    expect(h.session.state).toBe('ready')
    expect(idsOf(h.session)).toEqual([`${scanId}:temp-user:0`, `${scanId}:sys-windows-update:1`])
    expect(h.session.latest!.summary).toMatchObject({
      incomplete: true,
      reclaimable: 2 * MiB,
      byCategory: { duplicates: 0, tempCaches: 2 * MiB }
    })
    expect(h.nonProgress()).toEqual([{ type: 'done', summary: h.session.latest!.summary }])
  })

  test('cancel with nothing running changes nothing and does not cancel the next scan', async () => {
    const h = harness()
    h.session.cancel()
    expect(h.session.state).toBe('idle')

    await h.runToDone()
    h.session.cancel()
    expect(h.session.state).toBe('ready')
    expect(h.session.latest!.summary.incomplete).toBe(false)

    await h.runToDone()
    expect(h.session.latest!.summary.incomplete).toBe(false)
    expect(idsOf(h.session)).toHaveLength(4) // duplicates included
  })

  test('a cancelled scan does not cancel the next one', async () => {
    const entered = deferred()
    const h = harness()
    h.scan.mockImplementationOnce(async (job, _onProgress, signal) => {
      entered.resolve()
      await aborted(signal)
      return scanDone(job, { incomplete: true })
    })
    h.session.start(ROOT)
    await entered.promise
    h.session.cancel()
    await h.settled()
    expect(h.session.latest!.summary.incomplete).toBe(true)

    await h.runToDone()
    expect(h.session.latest!.summary.incomplete).toBe(false)
    expect(idsOf(h.session)).toHaveLength(4)
  })
})

describe('resolveFindings', () => {
  test('returns the findings in the order of the ids asked for', async () => {
    const h = harness()
    const scanId = await h.runToDone()
    const ids = [`${scanId}:duplicates:1`, `${scanId}:temp-user:0`, `${scanId}:duplicates:0`]
    const r = h.session.resolveFindings(ids)
    expect(resolvedIds(r)).toEqual(ids)
    expect(r.ok && r.findings.map((f) => f.path)).toEqual([
      PICTURES_COPY,
      TEMP_FILE,
      DOWNLOADS_COPY
    ])
  })

  test('rejects ids from an earlier scan as stale-scan', async () => {
    const h = harness()
    await h.runToDone()
    const oldId = h.session.latest!.findings[0].id
    await h.runToDone()
    expect(h.session.resolveFindings([oldId])).toEqual({ ok: false, reason: 'stale-scan' })
  })

  test.each([
    [
      'an id of the latest scan that has no finding',
      (s: string) => [`${s}:duplicates:99`],
      'unknown-finding'
    ],
    ['an id that only starts with the scan id', (s: string) => [`${s}x:temp-user:0`], 'stale-scan'],
    ['an id with no colon', () => ['temp-user'], 'stale-scan'],
    [
      'a stale id among good ones',
      (s: string) => [`${s}:temp-user:0`, 'old:temp-user:0'],
      'stale-scan'
    ],
    [
      'an unknown id among good ones',
      (s: string) => [`${s}:temp-user:0`, `${s}:nope:5`],
      'unknown-finding'
    ],
    [
      'a stale id and an unknown one',
      (s: string) => [`${s}:nope:5`, 'old:temp-user:0'],
      'stale-scan'
    ]
  ])('%s is refused', async (_name, ids, reason) => {
    const h = harness()
    const scanId = await h.runToDone()
    expect(h.session.resolveFindings(ids(scanId))).toEqual({ ok: false, reason })
  })

  test('before any scan every id is stale', () => {
    const h = harness()
    expect(h.session.resolveFindings(['abc:temp-user:0'])).toEqual({
      ok: false,
      reason: 'stale-scan'
    })
  })

  test('is busy while a scan is scanning or hashing, even for ids that would otherwise resolve', async () => {
    const h = harness()
    const first = await h.runToDone()
    const ids = [`${first}:temp-user:0`]
    expect(resolvedIds(h.session.resolveFindings(ids))).toEqual(ids)

    const scanGate = deferred()
    const hashEntered = deferred()
    const hashGate = deferred()
    h.scan.mockImplementationOnce(async (job) => {
      await scanGate.promise
      return scanDone(job)
    })
    h.hash.mockImplementationOnce(async () => {
      hashEntered.resolve()
      await hashGate.promise
      return HASHED
    })
    h.session.start(ROOT)
    expect(h.session.resolveFindings(ids)).toEqual({ ok: false, reason: 'busy' })
    scanGate.resolve()
    await hashEntered.promise
    expect(h.session.resolveFindings(ids)).toEqual({ ok: false, reason: 'busy' })
    hashGate.resolve()
    await h.settled()
  })
})

describe('changing the results after a scan', () => {
  test('removeFindings drops the findings and recomputes the summary, keeping what the scan measured', async () => {
    // An incomplete scan, so the test can see the summary keep its incomplete flag.
    const h = harness({ scan: async (job) => scanDone(job, { incomplete: true }) })
    const scanId = await h.runToDone()
    const removed = `${scanId}:temp-user:0`

    h.session.removeFindings([removed])

    expect(idsOf(h.session)).toEqual([`${scanId}:sys-windows-update:1`])
    expect(h.session.latest!.summary).toEqual({
      scanId,
      root: ROOT,
      incomplete: true,
      foldersScanned: 12,
      filesScanned: 34,
      totalSizeOnDisk: 15 * MiB,
      unreadableFolders: 1,
      reclaimable: 0,
      byCategory: { duplicates: 0, tempCaches: 0, installersStale: 0, devLeftovers: 0, system: 0 },
      windowsCanClean: 3 * MiB,
      durationMs: 1234
    })
    // What was removed can no longer be cleaned.
    expect(h.session.resolveFindings([removed])).toEqual({ ok: false, reason: 'unknown-finding' })
  })

  test('applyExclusions drops findings inside an exclusion, ignoring case, but not a folder that only shares the start of its name', async () => {
    const h = harness()
    const scanId = await h.runToDone()
    const dropped = `${scanId}:duplicates:0` // the Downloads copy

    h.session.applyExclusions(
      validateSettings({
        exclusions: ['C:\\USERS\\JORDA\\DOWNLOADS', 'C:\\Users\\jorda\\AppData\\Local\\Tem']
      })
    )

    expect(idsOf(h.session)).toEqual([
      `${scanId}:temp-user:0`, // ...\Temp\cache.tmp is not inside ...\Tem
      `${scanId}:sys-windows-update:1`,
      `${scanId}:duplicates:1`
    ])
    expect(h.session.latest!.summary).toMatchObject({
      scanId,
      incomplete: false,
      totalSizeOnDisk: 15 * MiB,
      reclaimable: 2 * MiB, // only the temp files are left to clean; the kept copy is not counted
      byCategory: { duplicates: 0, tempCaches: 2 * MiB },
      windowsCanClean: 3 * MiB
    })
    expect(h.session.resolveFindings([dropped])).toEqual({ ok: false, reason: 'unknown-finding' })
  })

  test('removeFindings and applyExclusions do nothing before the first scan', () => {
    const h = harness()
    h.session.removeFindings(['abc:temp-user:0'])
    h.session.applyExclusions(validateSettings({ exclusions: ['C:\\Users'] }))
    expect(h.session.latest).toBeNull()
    expect(h.session.state).toBe('idle')
  })
})

describe('failures', () => {
  test.each([true, false])(
    'a scan that fails midway keeps its partial results, marked incomplete, and reports the error (worker flagged incomplete: %s)',
    async (flagged) => {
      const h = harness({
        scan: async (job) =>
          scanDone(job, {
            incomplete: flagged,
            error: 'boom',
            findings: staticFindings(job.scanId).slice(0, 1)
          })
      })
      const scanId = await h.runToDone()

      expect(h.hash).not.toHaveBeenCalled()
      expect(h.session.state).toBe('ready')
      expect(idsOf(h.session)).toEqual([`${scanId}:temp-user:0`])
      expect(h.session.latest!.summary.incomplete).toBe(true)
      expect(h.nonProgress()).toEqual([
        { type: 'error', message: 'boom' },
        { type: 'done', summary: h.session.latest!.summary }
      ])
    }
  )

  test('a hash worker that fails keeps the static findings, adds no duplicates, and reports the error', async () => {
    const h = harness({
      hash: async () => {
        throw new Error('The hash worker stopped unexpectedly')
      }
    })
    const scanId = await h.runToDone()

    expect(h.session.state).toBe('ready')
    expect(idsOf(h.session)).toEqual([`${scanId}:temp-user:0`, `${scanId}:sys-windows-update:1`])
    expect(h.session.latest!.summary.incomplete).toBe(true)
    expect(h.nonProgress()).toEqual([
      { type: 'error', message: 'The hash worker stopped unexpectedly' },
      { type: 'done', summary: h.session.latest!.summary }
    ])
  })

  test('a runner that rejects emits error and keeps the previous results', async () => {
    const h = harness()
    const first = await h.runToDone()
    const before = h.events.length
    h.scan.mockRejectedValueOnce(new Error('The scan worker stopped unexpectedly'))

    h.session.start(ROOT)
    await h.settled()

    expect(h.events.slice(before)).toEqual([
      { type: 'error', message: 'The scan worker stopped unexpectedly' }
    ])
    expect(h.session.state).toBe('ready')
    expect(h.session.latest!.scanId).toBe(first)
    expect(resolvedIds(h.session.resolveFindings([`${first}:temp-user:0`]))).toEqual([
      `${first}:temp-user:0`
    ])
  })

  test('a runner that rejects with no earlier scan leaves the session idle', async () => {
    const h = harness({
      scan: async () => {
        throw new Error('The root does not exist')
      }
    })
    await h.runToDone()

    expect(h.events).toEqual([{ type: 'error', message: 'The root does not exist' }])
    expect(h.session.state).toBe('idle')
    expect(h.session.latest).toBeNull()
  })

  test('a listener that throws does not leave the session stuck', async () => {
    const h = harness({
      onEmit: () => {
        throw new Error('Object has been destroyed')
      }
    })
    await h.runToDone()
    expect(h.session.state).toBe('ready')
    expect(idsOf(h.session)).toHaveLength(4)
  })
})
