import { describe, expect, test, vi } from 'vitest'
import { validateSettings } from '../../src/core/settings'
import type { ScanTree } from '../../src/core/tree'
import { createHandlers, type HandlerDeps } from '../../src/main/ipc'
import type { RecycleBinInfo } from '../../src/main/recycleBin'
import type { LatestScan } from '../../src/main/session'
import type {
  CleanupBatch,
  Finding,
  HistoryEntry,
  RestoreRecord,
  ScanSummary,
  SessionState,
  Settings
} from '../../src/shared/types'
import { SAMPLE_ENV } from '../helpers/env'
import { treeFrom } from '../helpers/treeFrom'

const MiB = 1_048_576
const NOW = Date.UTC(2026, 10, 2)

// Nothing here touches the disk: every file the cleanup and the restore would move is a fake.
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>()
  return {
    ...real,
    lstat: vi.fn(),
    realpath: vi.fn(),
    link: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn()
  }
})
const fs = await import('node:fs/promises')

function finding(n: number, over: Partial<Finding> = {}): Finding {
  return {
    id: `scan-1:temp:${n}`,
    scanId: 'scan-1',
    ruleId: 'temp',
    category: 'tempCaches',
    safety: 'safe',
    title: 'Old temporary files',
    explanation: 'Files apps left behind.',
    path: `X:\\Temp\\f${n}.tmp`,
    kind: 'file',
    sizeOnDisk: MiB,
    logicalSize: MiB,
    mtimeMs: 1,
    ...over
  }
}

function summary(over: Partial<ScanSummary> = {}): ScanSummary {
  return {
    scanId: 'scan-1',
    root: 'X:\\',
    incomplete: false,
    foldersScanned: 2,
    filesScanned: 2,
    totalSizeOnDisk: 2 * MiB,
    unreadableFolders: 0,
    reclaimable: 2 * MiB,
    byCategory: {
      duplicates: 0,
      tempCaches: 2 * MiB,
      installersStale: 0,
      devLeftovers: 0,
      system: 0
    },
    windowsCanClean: 0,
    durationMs: 10,
    ...over
  }
}

const ENABLED: RecycleBinInfo = {
  drive: 'X:',
  status: 'enabled',
  maxCapacityBytes: 1000 * MiB,
  usedBytes: 0
}

interface Harness {
  deps: HandlerDeps
  latest: { value: LatestScan | null }
  state: { value: SessionState }
  calls: string[]
  live: { value: Settings }
  history: HistoryEntry[]
}

function harness(over: Partial<HandlerDeps> = {}): Harness {
  const tree: ScanTree = treeFrom('X:\\', {
    'Temp\\f0.tmp': { size: MiB, mtimeMs: 1 },
    'Temp\\f1.tmp': { size: MiB, mtimeMs: 1 }
  })
  const findings = [finding(0), finding(1)]
  const latest = {
    value: {
      scanId: 'scan-1',
      root: 'X:\\',
      tree,
      findings,
      summary: summary()
    } as LatestScan | null
  }
  const state = { value: 'ready' as SessionState }
  const calls: string[] = []
  const live = { value: validateSettings({ scanTargets: ['X:\\', 'x:\\games', 'Y:\\'] }) }
  const history: HistoryEntry[] = []
  const deps: HandlerDeps = {
    session: {
      get state() {
        return state.value
      },
      get latest() {
        return latest.value
      },
      start: vi.fn(() => 'scan-2'),
      cancel: vi.fn(),
      resolveFindings: vi.fn((ids: string[]) => {
        const byId = new Map(latest.value!.findings.map((f) => [f.id, f]))
        return { ok: true as const, findings: ids.map((id) => byId.get(id)!) }
      }),
      removeFindings: vi.fn(),
      applyExclusions: vi.fn(() => {
        calls.push('applyExclusions')
      })
    },
    log: {
      append: vi.fn(async () => {
        calls.push('append')
      }),
      history: vi.fn(async () => history),
      getBatch: vi.fn(
        async (id: string) => history.find((h) => h.batch.batchId === id)?.batch ?? null
      )
    },
    settings: {
      get: () => live.value,
      save: vi.fn(async (input: unknown) => {
        calls.push('store')
        live.value = validateSettings(input)
        return live.value
      })
    },
    binUsage: {
      usedBytes: 123,
      refresh: vi.fn(async () => {
        calls.push('refreshBin')
      })
    },
    cleanup: {
      recycler: { trash: vi.fn(async () => undefined) },
      binInfo: vi.fn(async () => ENABLED),
      findRecords: vi.fn(async () => new Map()),
      env: SAMPLE_ENV,
      now: () => NOW
    },
    binDir: vi.fn(async () => 'X:\\$Recycle.Bin\\S-1-5-21-1'),
    driveUsage: vi.fn(async (roots: string[]) =>
      roots.map((root) => ({ root, totalBytes: 10, freeBytes: 5 }))
    ),
    cleanProgress: vi.fn(),
    pickFolder: vi.fn(async () => 'd:/games/'),
    showItem: vi.fn(),
    openDiskCleanup: vi.fn(),
    openStorageSettings: vi.fn(async () => undefined),
    openRecycleBin: vi.fn(),
    relaunchElevated: vi.fn(async () => false),
    now: () => NOW,
    ...over
  }
  return { deps, latest, state, calls, live, history }
}

// Every file still looks as the scan saw it, so the cleanup's checks pass.
function filesUnchanged(): void {
  vi.mocked(fs.lstat).mockImplementation(
    async () => ({ isFile: () => true, isDirectory: () => false, size: MiB, mtimeMs: 1 }) as never
  )
  vi.mocked(fs.realpath).mockImplementation(async (p) => String(p) as never)
}

describe('getOverview', () => {
  test('returns the drives of the scan targets once each, the cached bin usage, the last scan and the state', async () => {
    const h = harness()
    const overview = await createHandlers(h.deps).getOverview()
    expect(h.deps.driveUsage).toHaveBeenCalledWith(['X:\\', 'Y:\\'])
    expect(overview).toEqual({
      drives: [
        { root: 'X:\\', totalBytes: 10, freeBytes: 5 },
        { root: 'Y:\\', totalBytes: 10, freeBytes: 5 }
      ],
      recycleBinUsedBytes: 123,
      lastScan: summary(),
      state: 'ready'
    })
    // The bin is never measured for the Overview itself.
    expect(h.deps.binUsage.refresh).not.toHaveBeenCalled()
    expect(h.deps.cleanup.binInfo).not.toHaveBeenCalled()
  })
})

describe('clean', () => {
  test('checks its arguments', async () => {
    const handlers = createHandlers(harness().deps)
    await expect(handlers.clean([], false)).rejects.toThrow('invalid argument')
    await expect(handlers.clean(['a'], 'yes')).rejects.toThrow('invalid argument')
  })

  test.each(['stale-scan', 'busy', 'incomplete-scan', 'unknown-finding'] as const)(
    'passes the session refusal "%s" to the renderer',
    async (reason) => {
      const h = harness()
      vi.mocked(h.deps.session.resolveFindings).mockReturnValue({ ok: false, reason })
      const outcome = await createHandlers(h.deps).clean(['scan-1:temp:0'], false)
      expect(outcome).toEqual({ status: 'rejected', reason })
      expect(h.deps.cleanup.recycler.trash).not.toHaveBeenCalled()
    }
  )

  test('dedupes the ids, recycles from the main process findings, then forgets the recycled ones and refreshes the bin usage', async () => {
    filesUnchanged()
    const h = harness()
    const outcome = await createHandlers(h.deps).clean(
      ['scan-1:temp:0', 'scan-1:temp:1', 'scan-1:temp:0'],
      false
    )
    expect(h.deps.session.resolveFindings).toHaveBeenCalledWith(['scan-1:temp:0', 'scan-1:temp:1'])
    expect(outcome.status).toBe('done')
    expect(h.deps.cleanup.recycler.trash).toHaveBeenCalledTimes(2)
    expect(h.deps.session.removeFindings).toHaveBeenCalledWith(['scan-1:temp:0', 'scan-1:temp:1'])
    expect(h.deps.cleanProgress).toHaveBeenLastCalledWith(2, 2)
    expect(h.calls).toEqual(['append', 'refreshBin'])
  })

  test('forgets only what was recycled', async () => {
    filesUnchanged()
    const h = harness()
    vi.mocked(h.deps.cleanup.recycler.trash).mockImplementation(async (p) => {
      if (p.endsWith('f1.tmp')) throw new Error('in use')
    })
    const outcome = await createHandlers(h.deps).clean(['scan-1:temp:0', 'scan-1:temp:1'], false)
    expect(outcome.status).toBe('done')
    expect(h.deps.session.removeFindings).toHaveBeenCalledWith(['scan-1:temp:0'])
  })

  test('an overflow asks first and changes nothing', async () => {
    filesUnchanged()
    const h = harness()
    vi.mocked(h.deps.cleanup.binInfo).mockResolvedValue({ ...ENABLED, maxCapacityBytes: MiB })
    const outcome = await createHandlers(h.deps).clean(['scan-1:temp:0', 'scan-1:temp:1'], false)
    expect(outcome.status).toBe('needsOverflowConfirm')
    expect(h.deps.session.removeFindings).not.toHaveBeenCalled()
    expect(h.deps.binUsage.refresh).not.toHaveBeenCalled()
  })

  test('a second clean, a restore and a scan are refused while a clean runs', async () => {
    filesUnchanged()
    const h = harness()
    let release!: () => void
    vi.mocked(h.deps.cleanup.recycler.trash).mockImplementationOnce(
      () => new Promise<void>((r) => (release = r))
    )
    const handlers = createHandlers(h.deps)
    const first = handlers.clean(['scan-1:temp:0'], false)
    await vi.waitFor(() => expect(h.deps.cleanup.recycler.trash).toHaveBeenCalled())

    expect(await handlers.clean(['scan-1:temp:1'], false)).toEqual({
      status: 'rejected',
      reason: 'busy'
    })
    await expect(handlers.startScan('X:\\')).rejects.toThrow('busy')
    await expect(handlers.restoreBatch('b-1')).rejects.toThrow('busy')
    expect(h.deps.session.start).not.toHaveBeenCalled()

    release()
    expect((await first).status).toBe('done')
    // Free again once it is over.
    await expect(handlers.startScan('x:/')).resolves.toEqual({ scanId: 'scan-2' })
    expect(h.deps.session.start).toHaveBeenCalledWith('X:\\')
  })

  test('a log that cannot be written still frees the handlers and refreshes the bin usage', async () => {
    filesUnchanged()
    const h = harness()
    vi.mocked(h.deps.log.append).mockRejectedValueOnce(new Error('disk full'))
    const handlers = createHandlers(h.deps)
    await expect(handlers.clean(['scan-1:temp:0'], false)).rejects.toThrow('disk full')
    expect(h.deps.binUsage.refresh).toHaveBeenCalled()
    await expect(handlers.startScan('X:\\')).resolves.toEqual({ scanId: 'scan-2' })
  })
})

describe('restoreBatch', () => {
  const BIN = 'X:\\$Recycle.Bin\\S-1-5-21-1'

  function batch(): CleanupBatch {
    return {
      type: 'cleanup',
      batchId: 'b-1',
      startedAt: new Date(NOW).toISOString(),
      finishedAt: new Date(NOW).toISOString(),
      items: ['a', 'b', 'c'].map((n) => ({
        findingId: `scan-1:temp:${n}`,
        ruleId: 'temp',
        kind: 'file' as const,
        originalPath: `X:\\Temp\\${n}.tmp`,
        sizeOnDisk: MiB,
        mtime: new Date(1).toISOString(),
        status: 'recycled' as const,
        recycledAs: `$R${n.toUpperCase()}.tmp`
      }))
    }
  }

  function binHolds(names: string[]): void {
    vi.mocked(fs.lstat).mockImplementation(async (p) => {
      const path = String(p)
      if (names.some((n) => path === `${BIN}\\${n}`)) return { isFile: () => true } as never
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    vi.mocked(fs.link).mockResolvedValue(undefined)
    vi.mocked(fs.unlink).mockResolvedValue(undefined)
  }

  test('rejects an unknown batch and a bad id', async () => {
    const handlers = createHandlers(harness().deps)
    await expect(handlers.restoreBatch('nope')).rejects.toThrow('unknown batch')
    await expect(handlers.restoreBatch('')).rejects.toThrow('invalid argument')
  })

  test('leaves out what an earlier restore put back, then refreshes the bin usage', async () => {
    const h = harness()
    const earlier: RestoreRecord = {
      type: 'restore',
      batchId: 'b-1',
      at: new Date(NOW).toISOString(),
      items: [
        { originalPath: 'x:\\temp\\A.TMP', status: 'restored', restoredTo: 'X:\\Temp\\a.tmp' },
        { originalPath: 'X:\\Temp\\b.tmp', status: 'failed', reason: 'in use' }
      ]
    }
    h.history.push({ batch: batch(), restores: [earlier] })
    binHolds(['$RB.tmp', '$RC.tmp'])

    const record = await createHandlers(h.deps).restoreBatch('b-1')
    expect(record.items.map((i) => [i.originalPath, i.status])).toEqual([
      ['X:\\Temp\\b.tmp', 'restored'],
      ['X:\\Temp\\c.tmp', 'restored']
    ])
    expect(h.deps.binDir).toHaveBeenCalledWith('X:')
    expect(h.calls).toEqual(['append', 'refreshBin'])
  })

  test('a batch already put back in full logs nothing', async () => {
    const h = harness()
    const all: RestoreRecord = {
      type: 'restore',
      batchId: 'b-1',
      at: new Date(NOW).toISOString(),
      items: batch().items.map((i) => ({
        originalPath: i.originalPath,
        status: 'restored' as const
      }))
    }
    h.history.push({ batch: batch(), restores: [all] })
    const record = await createHandlers(h.deps).restoreBatch('b-1')
    expect(record).toEqual({
      type: 'restore',
      batchId: 'b-1',
      at: new Date(NOW).toISOString(),
      items: []
    })
    expect(h.deps.log.append).not.toHaveBeenCalled()
  })
})

describe('settings and exclusions', () => {
  test('saveSettings stores first, then makes the exclusions apply, and returns what was stored', async () => {
    const h = harness()
    const saved = await createHandlers(h.deps).saveSettings({
      ...h.live.value,
      exclusions: ['x:/keep/']
    })
    expect(saved.exclusions).toEqual(['X:\\keep'])
    expect(h.calls).toEqual(['store', 'applyExclusions'])
    expect(h.deps.session.applyExclusions).toHaveBeenCalledWith(saved)
    expect(await createHandlers(h.deps).getSettings()).toBe(saved)
  })

  test('saveSettings that fails validation changes nothing', async () => {
    const h = harness()
    await expect(
      createHandlers(h.deps).saveSettings({ ...h.live.value, exclusions: ['relative'] })
    ).rejects.toThrow('Invalid settings')
    expect(h.deps.session.applyExclusions).not.toHaveBeenCalled()
  })

  test('new scan drives refresh the bin usage', async () => {
    const h = harness()
    const handlers = createHandlers(h.deps)
    await handlers.saveSettings({ ...h.live.value, exclusions: ['X:\\a'] })
    expect(h.deps.binUsage.refresh).not.toHaveBeenCalled()
    await handlers.saveSettings({ ...h.live.value, scanTargets: ['Z:\\'] })
    expect(h.deps.binUsage.refresh).toHaveBeenCalledTimes(1)
  })

  test('excludeFolder appends the folder path once, by pathKey', async () => {
    const h = harness()
    const handlers = createHandlers(h.deps)
    const temp = h.latest.value!.tree.findFolder('X:\\Temp')!
    const saved = await handlers.excludeFolder(temp)
    expect(saved.exclusions).toEqual(['X:\\Temp'])
    expect(h.calls).toEqual(['store', 'applyExclusions'])
    h.live.value = { ...h.live.value, exclusions: ['x:\\temp'] }
    expect((await handlers.excludeFolder(temp)).exclusions).toEqual(['x:\\temp'])
    expect(h.deps.settings.save).toHaveBeenCalledTimes(1)
    await expect(handlers.excludeFolder(99)).rejects.toThrow('invalid argument')
  })

  test('excludeFolder and showItem need a scan', async () => {
    const h = harness()
    h.latest.value = null
    const handlers = createHandlers(h.deps)
    await expect(handlers.excludeFolder(0)).rejects.toThrow('invalid argument')
    await expect(handlers.showItem({ kind: 'folder', id: 0 })).rejects.toThrow('invalid argument')
    expect(await handlers.getFolderView(0, 2)).toBeNull()
    expect(await handlers.getFindings()).toEqual([])
  })

  test('pickFolder returns the normalized path, or null', async () => {
    const h = harness()
    expect(await createHandlers(h.deps).pickFolder()).toBe('D:\\games')
    vi.mocked(h.deps.pickFolder).mockResolvedValue(null)
    expect(await createHandlers(h.deps).pickFolder()).toBeNull()
  })
})

describe('explore and system actions', () => {
  test('getFolderView and showItem work from the latest tree', async () => {
    const h = harness()
    const handlers = createHandlers(h.deps)
    const view = await handlers.getFolderView(0, 2)
    expect(view?.children?.[0]).toMatchObject({ kind: 'folder', name: 'Temp' })
    expect(view?.children?.[0].children).toHaveLength(2)
    await expect(handlers.getFolderView(0, '2')).rejects.toThrow('invalid argument')

    await handlers.showItem({ kind: 'file', id: 1 })
    expect(h.deps.showItem).toHaveBeenLastCalledWith('X:\\Temp\\f1.tmp')
    await handlers.showItem({ kind: 'folder', id: 1 })
    expect(h.deps.showItem).toHaveBeenLastCalledWith('X:\\Temp')
  })

  test('rescanAsAdmin relaunches for the latest scan root, else the first scan target, and resolves either way', async () => {
    const h = harness()
    const handlers = createHandlers(h.deps)
    await expect(handlers.rescanAsAdmin()).resolves.toBeUndefined()
    expect(h.deps.relaunchElevated).toHaveBeenLastCalledWith('X:\\')
    h.latest.value = null
    h.live.value = { ...h.live.value, scanTargets: ['Y:\\data'] }
    await handlers.rescanAsAdmin()
    expect(h.deps.relaunchElevated).toHaveBeenLastCalledWith('Y:\\data')
  })

  test('scan controls and system actions go to the session and Windows', async () => {
    const h = harness()
    const handlers = createHandlers(h.deps)
    await expect(handlers.startScan('\\\\server\\share')).rejects.toThrow('invalid argument')
    await handlers.cancelScan()
    expect(h.deps.session.cancel).toHaveBeenCalled()
    await handlers.openDiskCleanup()
    await handlers.openStorageSettings()
    await handlers.openRecycleBin()
    expect(h.deps.openDiskCleanup).toHaveBeenCalled()
    expect(h.deps.openStorageSettings).toHaveBeenCalled()
    expect(h.deps.openRecycleBin).toHaveBeenCalled()
  })
})
