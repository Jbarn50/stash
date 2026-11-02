import { existsSync, readdirSync, realpathSync, type Stats } from 'node:fs'
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { driveOf, pathKey } from '../../src/core/paths'
import { runCleanup, tipFor, type CleanupDeps } from '../../src/main/cleanup'
import type { RecycleBinInfo, RecycledRecord } from '../../src/main/recycleBin'
import type { CleanOutcome, CleanupBatch, Finding, WinEnv } from '../../src/shared/types'

// `lstat` and `realpath` pass through to the real disk unless a test overrides one path. Two things
// need that, which a temp folder cannot give: a path on a drive this machine does not have (to see
// what is asked of each drive), and a `realpath` that fails. Everything else uses real files.
const fsStubs = vi.hoisted(() => new Map<string, () => unknown>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const wrap =
    (name: 'lstat' | 'realpath') =>
    async (...args: unknown[]): Promise<unknown> => {
      const stub = fsStubs.get(`${name}:${String(args[0])}`)
      return stub ? stub() : (fs[name] as (...a: unknown[]) => Promise<unknown>)(...args)
    }
  return { ...fs, lstat: wrap('lstat'), realpath: wrap('realpath') }
})

const T0 = 1_700_000_000_000
const STEP = 1000
/** What the first `now()` of a run returns: the start of the batch. */
const START = T0 + STEP
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/
const BIN_OK: Omit<RecycleBinInfo, 'drive'> = {
  status: 'enabled',
  maxCapacityBytes: 1_000_000,
  usedBytes: 0
}

let root: string
let env: WinEnv
let binDir: string
let binCount: number
let findingCount: number
const junctions: string[] = []

beforeEach(async () => {
  // realpath expands an 8.3 temp folder (C:\Users\RUNNER~1\...), so every path here is plain and
  // spelled as the disk spells it.
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'stash-clean-')))
  const profile = join(root, 'Users', 'tester')
  const local = join(profile, 'AppData', 'Local')
  env = {
    systemRoot: root,
    usersRoot: join(root, 'Users'),
    userProfile: profile,
    localAppData: local,
    temp: join(local, 'Temp'),
    downloads: join(profile, 'Downloads'),
    desktop: join(profile, 'Desktop'),
    documents: join(profile, 'Documents'),
    pictures: join(profile, 'Pictures'),
    music: join(profile, 'Music'),
    videos: join(profile, 'Videos'),
    oneDrive: null,
    stashDirs: [join(profile, 'AppData', 'Roaming', 'Stash')]
  }
  binDir = join(root, 'bin')
  await mkdir(binDir)
  binCount = 0
  findingCount = 0
})

afterEach(async () => {
  fsStubs.clear()
  // A junction goes first so that removing the tree can never walk through it.
  for (const junction of junctions.splice(0)) await unlink(junction).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

// ---- fixtures -----------------------------------------------------------------------------------

async function put(path: string, content = 'data'): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

/** Sets both times of `path` to `ms`. A whole number of ms reads back as exactly that. */
const setTimes = (path: string, ms: number): Promise<void> =>
  utimes(path, new Date(ms), new Date(ms))

async function makeJunction(target: string, path: string): Promise<void> {
  await symlink(target, path, 'junction')
  junctions.push(path)
}

function finding(over: Partial<Finding> & Pick<Finding, 'path'>): Finding {
  return {
    id: `s1:temp-user:${findingCount++}`,
    scanId: 's1',
    ruleId: 'temp-user',
    category: 'tempCaches',
    safety: 'safe',
    title: 'Temporary files',
    explanation: 'Files programs leave behind',
    kind: 'file',
    sizeOnDisk: 4096,
    logicalSize: 0,
    mtimeMs: 0,
    ...over
  }
}

/** The finding a scan would make for what is on disk at `path` right now. */
async function scanned(path: string, over: Partial<Finding> = {}): Promise<Finding> {
  const stats = await lstat(path)
  return finding({
    path,
    kind: stats.isDirectory() ? 'folder' : 'file',
    logicalSize: stats.isDirectory() ? 0 : stats.size,
    mtimeMs: stats.mtimeMs,
    ...over
  })
}

/** A file on a drive this machine may not have: `lstat` and `realpath` answer for it. */
function fakeFile(path: string, size = 10): Finding {
  const mtimeMs = 1_650_000_000_000.5
  const stats = { isFile: () => true, isDirectory: () => false, size, mtimeMs } as unknown as Stats
  fsStubs.set(`lstat:${path}`, () => stats)
  fsStubs.set(`realpath:${path}`, () => path)
  return finding({ path, logicalSize: size, mtimeMs })
}

const errno = (code: string): Error => Object.assign(new Error(code), { code })

// ---- the dependencies ---------------------------------------------------------------------------

interface Fakes {
  trash: (path: string) => Promise<void>
  binInfo: CleanupDeps['binInfo']
  findRecords: CleanupDeps['findRecords']
  append: CleanupDeps['log']['append']
}

interface Harness {
  deps: CleanupDeps
  trash: Mock<Fakes['trash']>
  binInfo: Mock<Fakes['binInfo']>
  findRecords: Mock<Fakes['findRecords']>
  append: Mock<Fakes['append']>
  now: Mock<() => number>
}

/** What the real recycler does, as far as these tests can tell: the item leaves its place. */
async function moveToBin(path: string): Promise<void> {
  await rename(path, join(binDir, `${binCount++}-${basename(path)}`))
}

/** A bin that is plainly on, unless `over` says otherwise, on every drive. */
const bin =
  (over: Partial<RecycleBinInfo> = {}): Fakes['binInfo'] =>
  async (drive) => ({ ...BIN_OK, ...over, drive })

const binsByDrive =
  (table: Record<string, Partial<RecycleBinInfo>>): Fakes['binInfo'] =>
  async (drive) => ({ ...BIN_OK, ...table[drive], drive })

function harness(over: Partial<Fakes> = {}): Harness {
  const trash = vi.fn(over.trash ?? moveToBin)
  const binInfo = vi.fn(over.binInfo ?? bin())
  const findRecords = vi.fn<Fakes['findRecords']>(
    over.findRecords ??
      (async (_drive, paths) =>
        new Map(
          paths.map((path): [string, RecycledRecord] => [
            pathKey(path),
            {
              iName: `$I${basename(path)}`,
              rName: `$R${basename(path)}`,
              originalPath: path,
              deletedAtMs: START
            }
          ])
        ))
  )
  const append = vi.fn<Fakes['append']>(over.append ?? (async () => undefined))
  let clock = T0
  const now = vi.fn(() => (clock += STEP))
  return {
    deps: { recycler: { trash }, binInfo, findRecords, log: { append }, env, now },
    trash,
    binInfo,
    findRecords,
    append,
    now
  }
}

function batchOf(out: CleanOutcome): CleanupBatch {
  if (out.status !== 'done') throw new Error(`expected a finished cleanup, got ${out.status}`)
  return out.batch
}

/** Each item's status, then its reason if it has one: 'recycled', 'skipped: protected'. */
const summary = (batch: CleanupBatch): string[] =>
  batch.items.map((i) => (i.reason === undefined ? i.status : `${i.status}: ${i.reason}`))

// ---- what each item goes through, and in what order ---------------------------------------------

test('recycles unchanged items and records recycledAs', async () => {
  const file = await put(join(env.temp, 'junk', 'a.bin'), 'x'.repeat(10))
  const folder = join(env.temp, 'cache-dir')
  await put(join(folder, 'inner.bin'))
  const items = [await scanned(file), await scanned(folder)]
  const h = harness()

  const out = await runCleanup(items, items, false, h.deps)

  expect(batchOf(out).items).toEqual([
    {
      findingId: items[0].id,
      ruleId: 'temp-user',
      kind: 'file',
      originalPath: file,
      sizeOnDisk: 4096,
      mtime: new Date(items[0].mtimeMs).toISOString(),
      status: 'recycled',
      recycledAs: '$Ra.bin'
    },
    {
      findingId: items[1].id,
      ruleId: 'temp-user',
      kind: 'folder',
      originalPath: folder,
      sizeOnDisk: 4096,
      mtime: new Date(items[1].mtimeMs).toISOString(),
      status: 'recycled',
      recycledAs: '$Rcache-dir'
    }
  ])
  expect(h.trash.mock.calls).toEqual([[file], [folder]])
  expect(existsSync(file) || existsSync(folder)).toBe(false)
  expect(readdirSync(binDir)).toHaveLength(2)
})

test('a file modified after the scan is skipped as "changed since scan"', async () => {
  // Each file changes in one way only, which shows size and time are each checked on their own.
  const resized = await put(join(env.temp, 'resized.bin'), 'abc')
  const touched = await put(join(env.temp, 'touched.bin'), 'abc')
  const same = await put(join(env.temp, 'same.bin'), 'abc')
  for (const file of [resized, touched, same]) await setTimes(file, T0)
  const items = [await scanned(resized), await scanned(touched), await scanned(same)]
  await appendFile(resized, 'def') // another size, then the old time again
  await setTimes(resized, T0)
  await setTimes(touched, T0 + 60_000) // the same size, another time
  const h = harness()

  const batch = batchOf(await runCleanup(items, items, false, h.deps))

  expect(summary(batch)).toEqual([
    'skipped: changed since scan',
    'skipped: changed since scan',
    'recycled'
  ])
  expect(h.trash.mock.calls).toEqual([[same]])
  expect(existsSync(resized) && existsSync(touched)).toBe(true)
})

test('a folder that gained a file since the scan is skipped as "changed since scan"', async () => {
  const folder = join(env.temp, 'cache-dir')
  await put(join(folder, 'inner.bin'))
  await setTimes(folder, T0)
  const item = await scanned(folder)
  await put(join(folder, 'new.bin')) // an entry added to a folder changes the folder's own time
  const h = harness()

  const batch = batchOf(await runCleanup([item], [item], false, h.deps))

  expect(summary(batch)).toEqual(['skipped: changed since scan'])
  expect(h.trash).not.toHaveBeenCalled()
  expect(existsSync(join(folder, 'new.bin'))).toBe(true)
})

test('a folder replaced by a junction is skipped as "changed since scan"', async () => {
  const folder = join(env.temp, 'cache-dir')
  await put(join(folder, 'inner.bin'))
  const precious = await put(join(root, 'precious', 'keep.txt'))
  const item = await scanned(folder)
  await rm(folder, { recursive: true })
  await makeJunction(join(root, 'precious'), folder)
  const h = harness()

  const batch = batchOf(await runCleanup([item], [item], false, h.deps))

  expect(summary(batch)).toEqual(['skipped: changed since scan'])
  expect(h.trash).not.toHaveBeenCalled()
  expect(existsSync(precious)).toBe(true)
})

test('blocklisted and info findings are never recycled', async () => {
  const info = await scanned(await put(join(env.temp, 'for-your-eyes-only.bin')), {
    safety: 'info'
  })
  await put(join(env.downloads, 'keep.txt'))
  const protectedFolder = await scanned(env.downloads)
  const ownFile = await scanned(await put(join(env.stashDirs[0], 'cleanup-log.jsonl')))
  const system = finding({ path: 'C:\\Windows\\System32\\kernel32.dll', logicalSize: 10 })
  const items = [info, protectedFolder, ownFile, system]
  const h = harness()

  const batch = batchOf(await runCleanup(items, items, false, h.deps))

  expect(summary(batch)).toEqual(Array(4).fill('skipped: protected'))
  expect(h.trash).not.toHaveBeenCalled()
  expect(existsSync(join(env.downloads, 'keep.txt'))).toBe(true)
  expect(existsSync(ownFile.path)).toBe(true)
})

test.each([
  ['off', 'disabled', 'Recycle Bin is turned off on this drive'],
  ['unconfirmed', 'unknown', "Stash couldn't confirm this drive's Recycle Bin"]
] as const)(
  'every item on a drive whose bin is off, or unconfirmed, is refused (%s)',
  async (_name, status, reason) => {
    const items = [
      await scanned(await put(join(env.temp, 'one.bin'))),
      await scanned(await put(join(env.temp, 'two.bin')))
    ]
    const h = harness({ binInfo: bin({ status, maxCapacityBytes: 0 }) })

    const batch = batchOf(await runCleanup(items, items, false, h.deps))

    expect(summary(batch)).toEqual([`skipped: ${reason}`, `skipped: ${reason}`])
    expect(h.trash).not.toHaveBeenCalled()
    expect(h.binInfo.mock.calls).toEqual([[driveOf(items[0].path)]]) // once per drive, not per item
    expect(h.append).toHaveBeenCalledTimes(1) // refusals are logged like any other outcome
  }
)

test('an item bigger than the bin is skipped as "too big for the Recycle Bin"', async () => {
  const big = await put(join(env.temp, 'big.bin'), 'x'.repeat(200))
  const exact = await put(join(env.temp, 'exact.bin'), 'x'.repeat(100))
  const items = [await scanned(big), await scanned(exact)]
  const h = harness({ binInfo: bin({ maxCapacityBytes: 100 }) })

  const batch = batchOf(await runCleanup(items, items, false, h.deps))

  // The big one does not count toward the overflow check (200 + 100 would have), and a size equal
  // to the bin's capacity still fits.
  expect(summary(batch)).toEqual(['skipped: too big for the Recycle Bin', 'recycled'])
  expect(h.trash.mock.calls).toEqual([[exact]])
})

test('overflow asks first and recycles and logs nothing', async () => {
  const sel = [
    await scanned(await put(join(env.temp, 'a.bin'), 'x'.repeat(100))),
    await scanned(await put(join(env.temp, 'b.bin'), 'x'.repeat(200)))
  ]
  const h = harness({ binInfo: bin({ maxCapacityBytes: 1000, usedBytes: 900 }) })
  const onProgress = vi.fn()

  const out = await runCleanup(sel, sel, false, h.deps, onProgress)

  expect(out).toEqual({
    status: 'needsOverflowConfirm',
    drive: driveOf(sel[0].path),
    batchBytes: 300,
    binUsedBytes: 900,
    binMaxBytes: 1000
  })
  expect(h.trash).not.toHaveBeenCalled()
  expect(h.append).not.toHaveBeenCalled()
  expect(h.findRecords).not.toHaveBeenCalled()
  expect(onProgress).not.toHaveBeenCalled()
  expect(existsSync(sel[0].path) && existsSync(sel[1].path)).toBe(true)
})

test.each([
  ['exactly fills the bin', 700, 'done'],
  ['is one byte over', 701, 'needsOverflowConfirm']
] as const)('a batch that %s: %i bytes in the bin', async (_name, usedBytes, status) => {
  const sel = [await scanned(await put(join(env.temp, 'a.bin'), 'x'.repeat(300)))]
  const h = harness({ binInfo: bin({ maxCapacityBytes: 1000, usedBytes }) })

  const out = await runCleanup(sel, sel, false, h.deps)

  expect(out.status).toBe(status)
})

test('confirmOverflow proceeds', async () => {
  const sel = [
    await scanned(await put(join(env.temp, 'a.bin'), 'x'.repeat(100))),
    await scanned(await put(join(env.temp, 'b.bin'), 'x'.repeat(200)))
  ]
  const h = harness({ binInfo: bin({ maxCapacityBytes: 1000, usedBytes: 900 }) })

  const out = await runCleanup(sel, sel, true, h.deps)

  expect(summary(batchOf(out))).toEqual(['recycled', 'recycled'])
  expect(h.trash).toHaveBeenCalledTimes(2)
  expect(h.append).toHaveBeenCalledTimes(1)
})

test('a duplicate is recycled while an unselected copy remains', async () => {
  const copy = await scanned(await put(join(env.temp, 'copy.bin')), { groupId: 's1:dup:0' })
  const keeper = await scanned(await put(join(env.documents, 'keeper.bin')), {
    groupId: 's1:dup:0',
    suggestedKeep: true
  })
  const h = harness()

  const batch = batchOf(await runCleanup([copy], [copy, keeper], false, h.deps))

  expect(summary(batch)).toEqual(['recycled'])
  expect(existsSync(keeper.path)).toBe(true)
})

test('duplicates are skipped when no other copy would remain, including when the unselected copy vanished', async () => {
  const group = (n: number): Partial<Finding> => ({ groupId: `s1:dup:${n}` })
  const copy = async (name: string, over: Partial<Finding>): Promise<Finding> =>
    scanned(await put(join(env.temp, name)), over)

  // 1: the copy that was to stay has been deleted since the scan
  const vanishedSelected = await copy('c1.bin', group(1))
  const vanished = await copy('k1.bin', group(1))
  await rm(vanished.path)
  // 2: every copy is selected
  const bothA = await copy('c2a.bin', group(2))
  const bothB = await copy('c2b.bin', group(2))
  // 3: the copy that was to stay is now a folder, not a file
  const swappedSelected = await copy('c3.bin', group(3))
  const swapped = await copy('k3.bin', group(3))
  await rm(swapped.path)
  await mkdir(swapped.path)
  // 4: a copy that does remain (control)
  const remainSelected = await copy('c4.bin', group(4))
  const remains = await copy('k4.bin', group(4))
  // 5: the group has no other member at all
  const lone = await copy('c5.bin', group(5))

  const sel = [vanishedSelected, bothA, bothB, swappedSelected, remainSelected, lone]
  const all = [...sel, vanished, swapped, remains]
  const h = harness()

  const batch = batchOf(await runCleanup(sel, all, false, h.deps))

  const everyCopy = 'skipped: would remove every copy'
  expect(summary(batch)).toEqual([
    everyCopy,
    everyCopy,
    everyCopy,
    everyCopy,
    'recycled',
    everyCopy
  ])
  expect(h.trash.mock.calls).toEqual([[remainSelected.path]])
  expect(existsSync(remains.path)).toBe(true)
})

test('a duplicate is skipped when the copy kept back has changed since the scan', async () => {
  // The kept copy no longer holds what the scan hashed, so the selected copy is the last one of it.
  const group = { groupId: 's1:dup:7' }
  const selected = await scanned(await put(join(env.temp, 'c7.bin')), group)
  const keeper = await scanned(await put(join(env.documents, 'k7.bin')), {
    ...group,
    suggestedKeep: true
  })
  await writeFile(keeper.path, 'overwritten since the scan')
  const h = harness()

  const batch = batchOf(await runCleanup([selected], [selected, keeper], false, h.deps))

  expect(summary(batch)).toEqual(['skipped: would remove every copy'])
  expect(h.trash).not.toHaveBeenCalled()
  expect(existsSync(selected.path)).toBe(true)
})

test('a failed move is skipped with the reason and a Chrome tip', async () => {
  const cache = await put(
    join(env.localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Cache', 'data_0')
  )
  const item = await scanned(cache)
  const h = harness({
    trash: async () => {
      throw new Error('in use')
    }
  })

  const batch = batchOf(await runCleanup([item], [item], false, h.deps))

  expect(batch.items).toEqual([
    {
      findingId: item.id,
      ruleId: 'temp-user',
      kind: 'file',
      originalPath: cache,
      sizeOnDisk: 4096,
      mtime: new Date(item.mtimeMs).toISOString(),
      status: 'skipped',
      reason: "couldn't move it to the Recycle Bin: in use",
      tip: 'Close Chrome and retry'
    }
  ])
  expect(h.findRecords).not.toHaveBeenCalled() // nothing moved, so there is nothing to look up
})

test('each run appends exactly one batch', async () => {
  const h = harness()
  const first = [
    await scanned(await put(join(env.temp, 'a.bin'))),
    finding({ path: join(env.temp, 'never-existed.bin') })
  ]
  const second = [await scanned(await put(join(env.temp, 'b.bin')), { safety: 'info' })]

  const one = batchOf(await runCleanup(first, first, false, h.deps))
  expect(h.append.mock.calls).toEqual([[one]])
  // A run in which nothing could move is a batch too.
  const two = batchOf(await runCleanup(second, second, false, h.deps))

  expect(h.append.mock.calls).toEqual([[one], [two]])
  expect(summary(two)).toEqual(['skipped: protected'])
  expect(one.type).toBe('cleanup')
  expect(one.batchId).toMatch(UUID)
  expect(two.batchId).toMatch(UUID)
  expect(two.batchId).not.toBe(one.batchId)
})

test('when several checks apply, the first in order decides', async () => {
  const off = harness({ binInfo: bin({ status: 'disabled', maxCapacityBytes: 100 }) })
  const unconfirmed = harness({ binInfo: bin({ status: 'unknown', maxCapacityBytes: 100 }) })
  const info = finding({ path: join(env.temp, 'a.bin'), safety: 'info', logicalSize: 200 })
  const big = finding({ path: join(env.temp, 'b.bin'), logicalSize: 200 })
  const reasonFor = async (item: Finding, h: Harness): Promise<string> =>
    summary(batchOf(await runCleanup([item], [item], false, h.deps)))[0]

  // Before the bin is asked: info. Then the bin, and only then the size.
  expect(await reasonFor(info, off)).toBe('skipped: protected')
  expect(await reasonFor(big, off)).toBe('skipped: Recycle Bin is turned off on this drive')
  expect(await reasonFor(big, unconfirmed)).toBe(
    "skipped: Stash couldn't confirm this drive's Recycle Bin"
  )

  // Just before the move: protected, then every copy, then changed since scan.
  const system = finding({ path: 'C:\\Windows\\System32\\kernel32.dll', groupId: 's1:dup:1' })
  const alone = await scanned(await put(join(env.temp, 'alone.bin')), { groupId: 's1:dup:2' })
  await appendFile(alone.path, 'more') // changed as well
  const items = [system, alone]

  const batch = batchOf(await runCleanup(items, items, false, harness().deps))

  expect(summary(batch)).toEqual(['skipped: protected', 'skipped: would remove every copy'])
})

// ---- the Recycle Bin is searched once per drive -------------------------------------------------

test('records are looked up once per drive, after the last move, for the paths that moved', async () => {
  const d1 = fakeFile('D:\\data\\one.bin')
  const e1 = fakeFile('E:\\data\\three.bin')
  const stuck = fakeFile('F:\\data\\stuck.bin')
  const d2 = fakeFile('D:\\data\\two.bin')
  const items = [d1, e1, stuck, d2]
  const h = harness({
    trash: async (path) => {
      if (path === stuck.path) throw new Error('in use')
    }
  })

  const batch = batchOf(await runCleanup(items, items, false, h.deps))

  expect(h.findRecords.mock.calls).toEqual([
    ['D:', [d1.path, d2.path], START],
    ['E:', [e1.path], START]
  ]) // F: moved nothing, so it is not asked about
  expect(Math.min(...h.findRecords.mock.invocationCallOrder)).toBeGreaterThan(
    Math.max(...h.trash.mock.invocationCallOrder)
  )
  expect(batch.items.map((i) => i.recycledAs)).toEqual([
    '$Rone.bin',
    '$Rthree.bin',
    undefined,
    '$Rtwo.bin'
  ])
})

test('a lookup that fails leaves that drive without recycledAs, and nothing else', async () => {
  const d1 = fakeFile('D:\\data\\one.bin')
  const e1 = fakeFile('E:\\data\\two.bin')
  const items = [d1, e1]
  const h = harness({
    trash: async () => undefined,
    findRecords: async (drive, paths) => {
      if (drive === 'D:') throw new Error('bin unreadable')
      return new Map(
        paths.map((path): [string, RecycledRecord] => [
          pathKey(path),
          { iName: '$IE1', rName: '$RE1', originalPath: path, deletedAtMs: START }
        ])
      )
    }
  })

  const batch = batchOf(await runCleanup(items, items, false, h.deps))

  expect(summary(batch)).toEqual(['recycled', 'recycled'])
  expect(batch.items.map((i) => i.recycledAs)).toEqual([undefined, '$RE1'])
  expect(h.append).toHaveBeenCalledTimes(1)
})

// ---- the path must still lead where the scan saw it ---------------------------------------------

test('a folder above the item swapped for a junction after the scan is skipped, though lstat still sees the file', async () => {
  const parent = join(env.temp, 'cache')
  const file = await put(join(parent, 'x.bin'), 'hello')
  const lookalike = await put(join(root, 'elsewhere', 'x.bin'), 'hello')
  const when = new Date(T0)
  await utimes(file, when, when)
  await utimes(lookalike, when, when)
  const item = await scanned(file)
  await rm(parent, { recursive: true })
  await makeJunction(join(root, 'elsewhere'), parent)
  // The point of the test: from the item's own name, lstat cannot tell anything changed.
  const seen = await lstat(file)
  expect([seen.isFile(), seen.size, seen.mtimeMs]).toEqual([true, item.logicalSize, item.mtimeMs])
  const h = harness()

  const batch = batchOf(await runCleanup([item], [item], false, h.deps))

  expect(summary(batch)).toEqual(['skipped: changed since scan'])
  expect(h.trash).not.toHaveBeenCalled()
  expect(existsSync(lookalike)).toBe(true)
})

test('an item whose real location cannot be resolved is skipped as "changed since scan"', async () => {
  const file = await put(join(env.temp, 'a.bin'))
  const item = await scanned(file)
  fsStubs.set(`realpath:${file}`, () => {
    throw errno('EPERM')
  })
  const h = harness()

  const batch = batchOf(await runCleanup([item], [item], false, h.deps))

  expect(summary(batch)).toEqual(['skipped: changed since scan'])
  expect(h.trash).not.toHaveBeenCalled()
})

test('the same path in another spelling still moves', async () => {
  const file = await put(join(env.temp, 'Mixed Case', 'File.BIN'))
  const item = await scanned(file, { path: file.toLowerCase().replaceAll('\\', '/') })
  const h = harness()

  const batch = batchOf(await runCleanup([item], [item], false, h.deps))

  expect(summary(batch)).toEqual(['recycled'])
  expect(existsSync(file)).toBe(false)
})

test('an item that is now a different kind of thing is skipped as "changed since scan"', async () => {
  // Size and time are made to match what the scan saw, so only the kind can give the change away.
  const wasFile = await put(join(env.temp, 'was-file'), '')
  const wasFolder = join(env.temp, 'was-folder')
  await mkdir(wasFolder)
  for (const path of [wasFile, wasFolder]) await setTimes(path, T0)
  const items = [await scanned(wasFile), await scanned(wasFolder)]
  await rm(wasFile)
  await mkdir(wasFile)
  await rm(wasFolder, { recursive: true })
  await put(wasFolder, '')
  for (const path of [wasFile, wasFolder]) await setTimes(path, T0)
  const h = harness()

  const batch = batchOf(await runCleanup(items, items, false, h.deps))

  expect(summary(batch)).toEqual(['skipped: changed since scan', 'skipped: changed since scan'])
  expect(h.trash).not.toHaveBeenCalled()
})

// ---- what Stash could not measure is refused ----------------------------------------------------

test('a folder Stash could not measure is refused, and stays out of the overflow sum', async () => {
  const unread = join(env.temp, 'unread-dir')
  await put(join(unread, 'inner.bin'))
  const small = await put(join(env.temp, 'small.bin'), 'x'.repeat(200))
  // Its size is an undercount of what it holds, which is the danger.
  const unmeasured = await scanned(unread, { logicalSize: 900, sizeUnknown: true })
  const items = [unmeasured, await scanned(small)]
  const h = harness({ binInfo: bin({ maxCapacityBytes: 1000 }) })

  const batch = batchOf(await runCleanup(items, items, false, h.deps))

  // With it, 900 + 200 would not fit in 1000 and Stash would have asked. Without it, the rest fits.
  expect(summary(batch)).toEqual(["skipped: Stash couldn't measure it", 'recycled'])
  expect(existsSync(unread)).toBe(true)
})

test('an unmeasured folder gets the bin reasons before "couldn\'t measure it"', async () => {
  const unmeasured = (logicalSize: number): Finding =>
    finding({ path: join(env.temp, 'ghost'), kind: 'folder', logicalSize, sizeUnknown: true })

  const tooBig = harness({ binInfo: bin({ maxCapacityBytes: 100 }) })
  const off = harness({ binInfo: bin({ status: 'disabled', maxCapacityBytes: 0 }) })
  const sel = [unmeasured(500)]

  expect(summary(batchOf(await runCleanup(sel, sel, false, tooBig.deps)))).toEqual([
    'skipped: too big for the Recycle Bin'
  ])
  expect(summary(batchOf(await runCleanup(sel, sel, false, off.deps)))).toEqual([
    'skipped: Recycle Bin is turned off on this drive'
  ])
})

// ---- one id, one move ---------------------------------------------------------------------------

test('a finding selected twice is moved once, and counted once', async () => {
  const a = await put(join(env.temp, 'a.bin'))
  const b = await put(join(env.temp, 'b.bin'))
  const fa = await scanned(a)
  const fb = await scanned(b)
  const sameIdOtherPath = { ...fa, path: b }
  const progress: [number, number][] = []
  const h = harness()

  const out = await runCleanup([fa, fb, fa, sameIdOtherPath], [fa, fb], false, h.deps, (d, t) =>
    progress.push([d, t])
  )

  expect(h.trash.mock.calls).toEqual([[a], [b]]) // first occurrences win; b is moved once
  expect(batchOf(out).items.map((i) => i.findingId)).toEqual([fa.id, fb.id])
  expect(progress).toEqual([
    [1, 2],
    [2, 2]
  ])
})

// ---- the bin of a drive is asked once, and a failure is "unconfirmed" ---------------------------

test('a drive whose bin lookup fails is refused as unconfirmed', async () => {
  const items = [await scanned(await put(join(env.temp, 'a.bin')))]
  const h = harness({
    binInfo: async () => {
      throw new Error('reg.exe failed')
    }
  })

  const batch = batchOf(await runCleanup(items, items, false, h.deps))

  expect(summary(batch)).toEqual(["skipped: Stash couldn't confirm this drive's Recycle Bin"])
  expect(h.trash).not.toHaveBeenCalled()
})

test("a path with no drive letter is refused: nobody can confirm that drive's bin", async () => {
  const noDrive = finding({ path: '\\\\server\\share\\x.bin', logicalSize: 10 })
  const h = harness({
    // As the real lookup answers for anything that is not a drive.
    binInfo: async (drive) =>
      drive === ''
        ? { drive, status: 'unknown', maxCapacityBytes: 0, usedBytes: 0 }
        : { ...BIN_OK, drive }
  })

  const batch = batchOf(await runCleanup([noDrive], [noDrive], false, h.deps))

  expect(summary(batch)).toEqual(["skipped: Stash couldn't confirm this drive's Recycle Bin"])
  expect(h.binInfo.mock.calls).toEqual([['']])
})

test('overflow is reported for the first drive that overflows, never one with nothing to move', async () => {
  const d = fakeFile('D:\\data\\huge.bin', 200) // too big for D:, so refused: nothing there to move
  const f = fakeFile('F:\\data\\f.bin', 50)
  const e = fakeFile('E:\\data\\e.bin', 50)
  const sel = [d, f, e]
  const binInfo = binsByDrive({
    'D:': { maxCapacityBytes: 100, usedBytes: 150 }, // already over capacity
    'F:': { maxCapacityBytes: 100, usedBytes: 90 },
    'E:': { maxCapacityBytes: 100, usedBytes: 90 }
  })
  const h = harness({ binInfo, trash: async () => undefined })

  const asked = await runCleanup(sel, sel, false, h.deps)

  expect(asked).toEqual({
    status: 'needsOverflowConfirm',
    drive: 'F:',
    batchBytes: 50,
    binUsedBytes: 90,
    binMaxBytes: 100
  })
  expect(h.trash).not.toHaveBeenCalled()
  expect(h.binInfo.mock.calls).toEqual([['D:'], ['F:'], ['E:']])

  const confirmed = await runCleanup(sel, sel, true, h.deps)

  expect(summary(batchOf(confirmed))).toEqual([
    'skipped: too big for the Recycle Bin',
    'recycled',
    'recycled'
  ])
})

// ---- timing -------------------------------------------------------------------------------------

test('the batch is timed from the first move to the last, and each item keeps its modified time', async () => {
  const file = await put(join(env.temp, 'a.bin'))
  const item = await scanned(file)
  const h = harness()

  const batch = batchOf(await runCleanup([item], [item], false, h.deps))

  expect(batch.startedAt).toBe(new Date(START).toISOString())
  expect(batch.finishedAt).toBe(new Date(START + STEP).toISOString())
  expect(h.now).toHaveBeenCalledTimes(2)
  expect(h.findRecords.mock.calls[0][2]).toBe(START) // records are searched from the batch start
  expect(batch.items[0].mtime).toBe(new Date(item.mtimeMs).toISOString())
})

// ---- progress, in order, for every item ---------------------------------------------------------

test('progress is reported after every item, skipped ones included, in order', async () => {
  const info = await scanned(await put(join(env.temp, 'info.bin')), { safety: 'info' })
  const ok = await scanned(await put(join(env.temp, 'ok.bin')))
  const gone = await scanned(await put(join(env.temp, 'gone.bin')))
  await rm(gone.path)
  const stuck = await scanned(await put(join(env.temp, 'stuck.bin')))
  const items = [info, ok, gone, stuck]
  const h = harness({
    trash: async (path) => {
      if (path === stuck.path) throw new Error('in use')
      await moveToBin(path)
    }
  })
  const progress: [done: number, total: number, movesTried: number][] = []

  const out = await runCleanup(items, items, false, h.deps, (done, total) =>
    progress.push([done, total, h.trash.mock.calls.length])
  )

  expect(progress).toEqual([
    [1, 4, 0],
    [2, 4, 1],
    [3, 4, 1],
    [4, 4, 2]
  ])
  expect(summary(batchOf(out))).toEqual([
    'skipped: protected',
    'recycled',
    'skipped: changed since scan',
    "skipped: couldn't move it to the Recycle Bin: in use"
  ])
  expect(batchOf(out).items.map((i) => i.findingId)).toEqual(items.map((i) => i.id))
})

// ---- per-item failures never escape -------------------------------------------------------------

test('a failure on one item never escapes: it becomes a skipped record and the rest carry on', async () => {
  const vanished = await scanned(await put(join(env.temp, 'vanished.bin')))
  await rm(vanished.path)
  const unresolvable = await scanned(await put(join(env.temp, 'unresolvable.bin')))
  fsStubs.set(`realpath:${unresolvable.path}`, () => {
    throw errno('EACCES')
  })
  const locked = await scanned(await put(join(env.temp, 'locked.bin')))
  const fine = await scanned(await put(join(env.temp, 'fine.bin')))
  const items = [vanished, unresolvable, locked, fine]
  const h = harness({
    trash: async (path) => {
      // Not every rejection is an Error.
      if (path === locked.path) return Promise.reject('locked by another program')
      await moveToBin(path)
    }
  })

  const batch = batchOf(await runCleanup(items, items, false, h.deps))

  expect(summary(batch)).toEqual([
    'skipped: changed since scan',
    'skipped: changed since scan',
    "skipped: couldn't move it to the Recycle Bin: locked by another program",
    'recycled'
  ])
  expect(batch.items[2].tip).toBe('Close any program using it and retry')
  expect(h.append).toHaveBeenCalledTimes(1)
})

test('a lookup of records that fails leaves the items recycled, without recycledAs', async () => {
  const item = await scanned(await put(join(env.temp, 'a.bin')))
  const h = harness({
    findRecords: async () => {
      throw new Error('bin unreadable')
    }
  })

  const batch = batchOf(await runCleanup([item], [item], false, h.deps))

  expect(batch.items).toHaveLength(1)
  expect(batch.items[0].status).toBe('recycled')
  expect(batch.items[0]).not.toHaveProperty('recycledAs')
  expect(h.append).toHaveBeenCalledTimes(1)
})

test('a log that cannot be written rejects the run, and what was moved stays in the Recycle Bin', async () => {
  const file = await put(join(env.temp, 'a.bin'))
  const item = await scanned(file)
  const h = harness({
    append: async () => {
      throw new Error('disk full')
    }
  })

  await expect(runCleanup([item], [item], false, h.deps)).rejects.toThrow('disk full')

  expect(existsSync(file)).toBe(false)
  expect(readdirSync(binDir)).toHaveLength(1)
})

test('a progress callback that throws does not stop the cleanup or lose the log', async () => {
  const items = [
    await scanned(await put(join(env.temp, 'a.bin'))),
    await scanned(await put(join(env.temp, 'b.bin')))
  ]
  const h = harness()

  const out = await runCleanup(items, items, false, h.deps, () => {
    throw new Error('window is gone')
  })

  expect(summary(batchOf(out))).toEqual(['recycled', 'recycled'])
  expect(h.append).toHaveBeenCalledTimes(1)
})

// ---- the tip for a failed move ------------------------------------------------------------------

describe('tipFor', () => {
  const other = 'Close any program using it and retry'

  test.each([
    [
      'C:\\Users\\jorda\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache',
      'Close Chrome and retry'
    ],
    [
      'C:\\Users\\jorda\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cache',
      'Close Edge and retry'
    ],
    [
      'C:\\Users\\jorda\\AppData\\Local\\Mozilla\\Firefox\\Profiles\\ab.default\\cache2',
      'Close Firefox and retry'
    ],
    ['c:/users/jorda/appdata/local/GOOGLE/chrome/user data', 'Close Chrome and retry'],
    ['C:\\Users\\jorda\\AppData\\Local\\Google\\Chrome', 'Close Chrome and retry'],
    ['C:\\Users\\jorda\\AppData\\Local\\Temp\\npm-cache', other],
    ['C:\\Users\\jorda\\AppData\\Local\\Google\\ChromeSetup\\x', other],
    ['C:\\Users\\jorda\\AppData\\Local\\Chrome\\Google\\x', other],
    ['C:\\Users\\jorda\\Downloads\\Edge\\Microsoft\\x', other]
  ])('%s', (path, tip) => {
    expect(tipFor(path)).toBe(tip)
  })
})
