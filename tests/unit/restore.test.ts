import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { driveOf } from '../../src/core/paths'
import { restoreBatch, restoredName, type RestoreDeps } from '../../src/main/restore'
import type { CleanupBatch, CleanupItemRecord } from '../../src/shared/types'
import { makeIRecord } from '../helpers/iRecord'

// `lstat`, `mkdir`, `rename` and `unlink` pass through to the real disk unless a test overrides one
// path. A temp folder cannot make them fail on demand, and a test needs that to see what happens
// when Windows refuses one step. Everything else uses real files in a temp folder that plays the
// part of the Recycle Bin: the real bin is only touched by the round-trip test.
// Whatever the code under test works out, `mkdir`, `rename` and `unlink` refuse a path outside
// that temp folder (`sandbox.root`), so a wrong name can never put a file anywhere else.
const fsStubs = vi.hoisted(() => new Map<string, () => unknown>())
const sandbox = vi.hoisted(() => ({ root: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const inside = (path: string): boolean => {
    const [p, r] = [path.toLowerCase(), sandbox.root.toLowerCase()]
    return p === r || p.startsWith(`${r}\\`)
  }
  const wrap =
    (name: 'lstat' | 'mkdir' | 'rename' | 'unlink') =>
    async (...args: unknown[]): Promise<unknown> => {
      for (const arg of name === 'lstat' ? [] : args) {
        if (typeof arg === 'string' && !inside(arg)) {
          throw new Error(`${name} reached outside the test folder: ${arg}`)
        }
      }
      const stub = fsStubs.get(`${name}:${String(args[0])}`)
      return stub ? stub() : (fs[name] as (...a: unknown[]) => Promise<unknown>)(...args)
    }
  return {
    ...fs,
    lstat: wrap('lstat'),
    mkdir: wrap('mkdir'),
    rename: wrap('rename'),
    unlink: wrap('unlink')
  }
})

const T0 = 1_700_000_000_000
const NOW = T0 + 5000
const BATCH_ID = '7f1a2b3c-0000-4000-8000-000000000001'
const NOT_FOUND = "Stash couldn't find it in the Recycle Bin"

let root: string
let bin: string
let drive: string
let recycledCount: number

beforeEach(async () => {
  // realpath expands an 8.3 temp folder (C:\Users\RUNNER~1\...), so every path here is spelled as
  // the disk spells it.
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'stash-restore-')))
  sandbox.root = root
  bin = join(root, 'bin')
  await mkdir(bin)
  drive = driveOf(root)
  recycledCount = 0
})

afterEach(async () => {
  fsStubs.clear()
  // A junction goes first so that removing the tree can never walk through it.
  await unlink(join(root, 'orig', 'dangling')).catch(() => undefined)
  await rm(root, { recursive: true, force: true })
})

// ---- fixtures -----------------------------------------------------------------------------------

async function put(path: string, content = 'data'): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
  return path
}

/**
 * What a cleanup leaves in the bin for `originalPath`: the `$R` entry that holds the item and the
 * `$I` record beside it, named as Windows names them (`$R` and `$I`, a few characters, the extension).
 */
async function recycled(
  originalPath: string,
  kind: 'file' | 'folder' = 'file',
  content = 'data'
): Promise<CleanupItemRecord> {
  const id = String(recycledCount++).padStart(6, '0')
  const recycledAs = `$R${id}${kind === 'file' ? extname(originalPath) : ''}`
  const r = join(bin, recycledAs)
  if (kind === 'file') {
    await writeFile(r, content)
  } else {
    await mkdir(r)
    await writeFile(join(r, 'inner.txt'), content)
  }
  await writeFile(
    join(bin, `$I${recycledAs.slice(2)}`),
    makeIRecord({ originalSize: BigInt(content.length), deletedAtMs: T0, path: originalPath })
  )
  return {
    findingId: `s1:temp-user:${id}`,
    ruleId: 'temp-user',
    kind,
    originalPath,
    sizeOnDisk: 4096,
    mtime: new Date(T0).toISOString(),
    status: 'recycled',
    recycledAs
  }
}

/** An item the cleanup refused: it never reached the bin, so nothing of it is in there. */
function skippedItem(originalPath: string, reason = 'changed since scan'): CleanupItemRecord {
  return {
    findingId: 's1:temp-user:skipped',
    ruleId: 'temp-user',
    kind: 'file',
    originalPath,
    sizeOnDisk: 4096,
    mtime: new Date(T0).toISOString(),
    status: 'skipped',
    reason
  }
}

const rOf = (item: CleanupItemRecord): string => join(bin, item.recycledAs ?? '')
const iOf = (item: CleanupItemRecord): string => join(bin, `$I${(item.recycledAs ?? '').slice(2)}`)
/** True when both the `$R` entry and the `$I` record of `item` are still in the bin. */
const stillInBin = (item: CleanupItemRecord): boolean =>
  existsSync(rOf(item)) && existsSync(iOf(item))

function batchOf(...items: CleanupItemRecord[]): CleanupBatch {
  return {
    type: 'cleanup',
    batchId: BATCH_ID,
    startedAt: new Date(T0).toISOString(),
    finishedAt: new Date(T0 + 1000).toISOString(),
    items
  }
}

const errno = (code: string, message = code): Error => Object.assign(new Error(message), { code })
function failFs(call: 'lstat' | 'mkdir' | 'rename' | 'unlink', path: string, error: Error): void {
  fsStubs.set(`${call}:${path}`, () => {
    throw error
  })
}

// ---- the dependencies ---------------------------------------------------------------------------

interface Fakes {
  binDir: RestoreDeps['binDir']
  append: RestoreDeps['log']['append']
  now: RestoreDeps['now']
}

interface Harness {
  deps: RestoreDeps
  binDir: Mock<Fakes['binDir']>
  append: Mock<Fakes['append']>
  now: Mock<Fakes['now']>
}

/** The temp folder is the bin of every drive, unless `over` says otherwise. */
function harness(over: Partial<Fakes> = {}): Harness {
  const binDir = vi.fn<Fakes['binDir']>(over.binDir ?? (async () => bin))
  const append = vi.fn<Fakes['append']>(over.append ?? (async () => undefined))
  const now = vi.fn<Fakes['now']>(over.now ?? (() => NOW))
  return { deps: { binDir, log: { append }, now }, binDir, append, now }
}

// ---- the name of a restored copy ----------------------------------------------------------------

describe('restoredName', () => {
  test('restoredName', () => {
    expect(restoredName('C:\\a\\photo.jpg', 'file', 1)).toBe('C:\\a\\photo (restored).jpg')
    expect(restoredName('C:\\a\\photo.jpg', 'file', 2)).toBe('C:\\a\\photo (restored 2).jpg')
    expect(restoredName('C:\\a\\my.project', 'folder', 1)).toBe('C:\\a\\my.project (restored)')
  })

  test.each([
    // [original path, kind, attempt, restored name]
    ['C:\\a\\photo.jpg', 'file', 10, 'C:\\a\\photo (restored 10).jpg'],
    ['C:\\a\\photo.jpg', 'file', 99, 'C:\\a\\photo (restored 99).jpg'],
    ['C:\\a\\my.project', 'folder', 2, 'C:\\a\\my.project (restored 2)'],
    ['C:\\a\\plain', 'folder', 1, 'C:\\a\\plain (restored)'],
    // no dot, or a dot that only starts the name: the suffix goes at the end
    ['C:\\a\\README', 'file', 1, 'C:\\a\\README (restored)'],
    ['C:\\a\\.gitignore', 'file', 1, 'C:\\a\\.gitignore (restored)'],
    ['C:\\a\\.gitignore', 'file', 3, 'C:\\a\\.gitignore (restored 3)'],
    // only the last extension is the extension
    ['C:\\a\\archive.tar.gz', 'file', 1, 'C:\\a\\archive.tar (restored).gz'],
    ['C:\\a\\.hidden.txt', 'file', 1, 'C:\\a\\.hidden (restored).txt'],
    // only the last path segment changes: a dot in a folder above is not an extension
    ['C:\\my.dir\\photo', 'file', 1, 'C:\\my.dir\\photo (restored)'],
    ['C:\\my.dir\\sub.dir\\photo.jpg', 'file', 1, 'C:\\my.dir\\sub.dir\\photo (restored).jpg'],
    ['C:\\photo.jpg', 'file', 1, 'C:\\photo (restored).jpg'],
    // na\u00efve, a folder emoji and two CJK characters, written as escapes so that no editor can
    // normalize them
    [
      'C:\\a\\na\u00efve \u{1F4C1} \u5199\u771F.bin',
      'file',
      1,
      'C:\\a\\na\u00efve \u{1F4C1} \u5199\u771F (restored).bin'
    ]
  ] as const)('%s as a %s, attempt %i', (path, kind, attempt, expected) => {
    expect(restoredName(path, kind, attempt)).toBe(expected)
  })
})

// ---- the way back -------------------------------------------------------------------------------

test('moves $R back, removes $I and logs restored', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  await mkdir(dirname(original))
  const item = await recycled(original, 'file', 'pixels')
  const batch = batchOf(item)
  const before = structuredClone(batch)
  const h = harness()

  const record = await restoreBatch(batch, h.deps)

  expect(record).toStrictEqual({
    type: 'restore',
    batchId: BATCH_ID,
    at: new Date(NOW).toISOString(),
    items: [{ originalPath: original, status: 'restored', restoredTo: original }]
  })
  expect(await readFile(original, 'utf8')).toBe('pixels')
  expect(readdirSync(bin)).toEqual([]) // $R moved out and $I removed
  expect(h.append.mock.calls).toEqual([[record]])
  expect(h.binDir.mock.calls).toEqual([[drive]])
  expect(batch).toEqual(before) // the batch it was given is not changed
})

test('moves a folder back with everything in it', async () => {
  const original = join(root, 'orig', 'cache-dir')
  await mkdir(dirname(original))
  const item = await recycled(original, 'folder', 'inside')
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'restored', restoredTo: original }
  ])
  expect(await readFile(join(original, 'inner.txt'), 'utf8')).toBe('inside')
  expect(readdirSync(bin)).toEqual([])
})

test('restores as "(restored)" when the original path is taken', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  await put(original, 'the newer file')
  const item = await recycled(original, 'file', 'the old file')
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  const copy = join(root, 'orig', 'photo (restored).jpg')
  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'restored', restoredTo: copy }
  ])
  expect(await readFile(copy, 'utf8')).toBe('the old file')
  expect(await readFile(original, 'utf8')).toBe('the newer file') // never overwritten
  expect(readdirSync(bin)).toEqual([])
})

test('a folder whose path is taken comes back as "name (restored)", dot and all', async () => {
  const original = join(root, 'orig', 'my.project')
  await mkdir(original, { recursive: true })
  const item = await recycled(original, 'folder', 'old')
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  const copy = join(root, 'orig', 'my.project (restored)')
  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'restored', restoredTo: copy }
  ])
  expect(await readFile(join(copy, 'inner.txt'), 'utf8')).toBe('old')
})

test('names are tried in order, so the first free "(restored N)" is used', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  await put(original)
  await put(restoredName(original, 'file', 1))
  await put(restoredName(original, 'file', 2))
  const item = await recycled(original, 'file', 'old')
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  const copy = join(root, 'orig', 'photo (restored 3).jpg')
  expect(record.items[0].restoredTo).toBe(copy)
  expect(await readFile(copy, 'utf8')).toBe('old')
})

test('anything at the path counts as taken, a folder or a link that leads nowhere included', async () => {
  // lstat sees the link itself. stat would follow it to nothing and call the name free, and the
  // rename would then replace the link.
  const heldByFolder = join(root, 'orig', 'one.txt')
  await mkdir(heldByFolder, { recursive: true })
  const heldByLink = join(root, 'orig', 'dangling')
  await symlink(join(root, 'nowhere'), heldByLink, 'junction')
  const items = [await recycled(heldByFolder), await recycled(heldByLink)]
  const h = harness()

  const record = await restoreBatch(batchOf(...items), h.deps)

  expect(record.items.map((i) => i.restoredTo)).toEqual([
    join(root, 'orig', 'one (restored).txt'),
    join(root, 'orig', 'dangling (restored)')
  ])
})

test('two items with one original path never overwrite each other', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  const first = await recycled(original, 'file', 'first')
  const second = await recycled(original, 'file', 'second')
  const h = harness()

  const record = await restoreBatch(batchOf(first, second), h.deps)

  const copy = join(root, 'orig', 'photo (restored).jpg')
  expect(record.items.map((i) => i.restoredTo)).toEqual([original, copy])
  expect(await readFile(original, 'utf8')).toBe('first')
  expect(await readFile(copy, 'utf8')).toBe('second')
})

test('the 99th "(restored N)" name is the last one tried, and is used if it is free', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  await put(original)
  for (let n = 1; n <= 98; n++) await put(restoredName(original, 'file', n))
  const item = await recycled(original, 'file', 'old')
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'restored', restoredTo: restoredName(original, 'file', 99) }
  ])
})

test('fails when the name and all 99 "(restored)" names are taken, and moves nothing', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  await put(original, 'mine')
  for (let n = 1; n <= 99; n++) await put(restoredName(original, 'file', n), `copy ${n}`)
  const item = await recycled(original, 'file', 'old')
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items).toStrictEqual([
    {
      originalPath: original,
      status: 'failed',
      reason: "couldn't find a free name to restore it to"
    }
  ])
  expect(readdirSync(bin)).toHaveLength(2) // $R and $I are where they were
  expect(await readFile(rOf(item), 'utf8')).toBe('old')
  expect(await readFile(original, 'utf8')).toBe('mine')
  expect(h.append).toHaveBeenCalledTimes(1)
})

test('recreates a missing parent folder', async () => {
  const original = join(root, 'gone', 'deeper', 'still', 'photo.jpg')
  const item = await recycled(original, 'file', 'pixels')
  expect(existsSync(join(root, 'gone'))).toBe(false)
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'restored', restoredTo: original }
  ])
  expect(await readFile(original, 'utf8')).toBe('pixels')
})

test('reports "no longer in the Recycle Bin" when $R is gone, and carries on', async () => {
  const gone = await recycled(join(root, 'orig', 'gone.jpg'))
  await rm(rOf(gone)) // Windows emptied it, or the user did
  const kept = join(root, 'orig', 'kept.jpg')
  const next = await recycled(kept, 'file', 'still here')
  const h = harness()

  const record = await restoreBatch(batchOf(gone, next), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: gone.originalPath, status: 'purged', reason: 'no longer in the Recycle Bin' },
    { originalPath: kept, status: 'restored', restoredTo: kept }
  ])
  expect(await readFile(kept, 'utf8')).toBe('still here')
  // The record of an item that is gone is not Stash's to delete.
  expect(existsSync(iOf(gone))).toBe(true)
  expect(existsSync(gone.originalPath)).toBe(false)
})

// ---- what is not restorable ---------------------------------------------------------------------

test('items that were skipped never reached the bin and are left out of the record', async () => {
  const kept = join(root, 'orig', 'kept.jpg')
  const moved = await recycled(kept)
  const h = harness()

  const record = await restoreBatch(
    batchOf(skippedItem(join(root, 'orig', 'before.jpg')), moved, skippedItem('C:\\x\\after.jpg')),
    h.deps
  )

  expect(record.items).toStrictEqual([{ originalPath: kept, status: 'restored', restoredTo: kept }])
})

test('a batch where nothing was recycled still logs one record, with no items', async () => {
  const h = harness()

  const record = await restoreBatch(
    batchOf(skippedItem(join(root, 'orig', 'a.jpg'), 'protected')),
    h.deps
  )

  expect(record).toStrictEqual({
    type: 'restore',
    batchId: BATCH_ID,
    at: new Date(NOW).toISOString(),
    items: []
  })
  expect(h.append.mock.calls).toEqual([[record]])
  expect(h.binDir).not.toHaveBeenCalled()
})

test('a recycled item without recycledAs fails with "couldn\'t find it in the Recycle Bin"', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  const unpaired = await recycled(original)
  delete unpaired.recycledAs // the lookup that pairs an item with its $R failed when it was cleaned
  const after = join(root, 'orig', 'after.jpg')
  const next = await recycled(after)
  const h = harness()

  const record = await restoreBatch(batchOf(unpaired, next), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'failed', reason: NOT_FOUND },
    { originalPath: after, status: 'restored', restoredTo: after }
  ])
  expect(readdirSync(bin)).toHaveLength(2) // the first item's $R and $I were not touched
})

test('an item with a status other than recycled or skipped is not restored', async () => {
  // Not a status a cleanup writes, but the log is a file anyone can edit.
  const original = join(root, 'orig', 'photo.jpg')
  const item = { ...(await recycled(original)), status: 'weird' as never }
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'failed', reason: NOT_FOUND }
  ])
  expect(stillInBin(item)).toBe(true)
})

test.each([
  ['a way out of the bin', '$R\\..\\..\\outside.txt'],
  ['a $R name in another folder', '..\\$Rabc'],
  ['a folder inside the bin', '$Rsub\\inner.txt'],
  ['a forward slash', '$Rsub/inner.txt'],
  ['a stream', '$R:stream'],
  ['nothing after $R', '$R'],
  ['no $R at all', 'outside.txt'],
  ['the $I record itself', '$I000000.jpg'], // the first item of a test, a .jpg
  ['an empty name, which is the bin folder itself', '']
])('a recycledAs that is not a plain $R name is never followed: %s', async (_what, recycledAs) => {
  const outside = await put(join(root, 'outside.txt'), 'not in the bin')
  const aboveBin = await put(join(root, '$Rabc'), 'above the bin')
  const inner = await put(join(bin, '$Rsub', 'inner.txt'), 'in a folder of the bin')
  const original = join(root, 'orig', 'photo.jpg')
  const item = { ...(await recycled(original)), recycledAs }
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'failed', reason: NOT_FOUND }
  ])
  expect(existsSync(original)).toBe(false)
  expect(await readFile(outside, 'utf8')).toBe('not in the bin')
  expect(await readFile(aboveBin, 'utf8')).toBe('above the bin')
  expect(await readFile(inner, 'utf8')).toBe('in a folder of the bin')
  expect(existsSync(bin)).toBe(true)
  expect(existsSync(join(bin, '$I000000.jpg'))).toBe(true)
})

// ---- the bin of each drive ----------------------------------------------------------------------

test('when the bin of a drive cannot be found, every item on that drive fails with the message', async () => {
  const q1 = await recycled('Q:\\data\\one.bin')
  const q2 = await recycled('Q:\\data\\two.bin')
  const good = join(root, 'orig', 'good.jpg')
  const onThisDrive = await recycled(good)
  const h = harness({
    binDir: async (d) => {
      // Not every rejection is an Error.
      if (d === 'Q:') return Promise.reject('no Recycle Bin folder for Q:')
      return bin
    }
  })

  const record = await restoreBatch(batchOf(q1, onThisDrive, q2), h.deps)

  const failed = (originalPath: string): object => ({
    originalPath,
    status: 'failed',
    reason: 'no Recycle Bin folder for Q:'
  })
  expect(record.items).toStrictEqual([
    failed('Q:\\data\\one.bin'),
    { originalPath: good, status: 'restored', restoredTo: good },
    failed('Q:\\data\\two.bin')
  ])
  // Asked once per drive, in the order the drives first appear.
  expect(h.binDir.mock.calls).toEqual([['Q:'], [drive]])
})

test('a bin lookup that throws instead of rejecting fails the item, not the batch', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  const item = await recycled(original)
  const h = harness({
    binDir: () => {
      throw new Error('whoami is missing')
    }
  })

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'failed', reason: 'whoami is missing' }
  ])
  expect(h.append).toHaveBeenCalledTimes(1)
})

test("the bin is asked for by the item's drive in upper case, however its path spells it", async () => {
  const original = join(root, 'orig', 'photo.jpg')
  const item = await recycled(original, 'file', 'pixels')
  // Windows paths ignore case, so a lower-case drive letter finds the same folder.
  const spelled = { ...item, originalPath: original.replace(/^[A-Z]:/, (d) => d.toLowerCase()) }
  const h = harness()

  const record = await restoreBatch(batchOf(spelled), h.deps)

  expect(h.binDir.mock.calls).toEqual([[drive]])
  expect(record.items.map((i) => i.status)).toEqual(['restored'])
  expect(await readFile(original, 'utf8')).toBe('pixels')
})

test("$R and $I are looked for in the folder the bin lookup gives for the item's drive", async () => {
  const item = await recycled(join(root, 'orig', 'photo.jpg'))
  const elsewhere = join(root, 'other-bin')
  await mkdir(elsewhere)
  const h = harness({ binDir: async () => elsewhere })

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items.map((i) => i.status)).toEqual(['purged']) // nothing of it is in that folder
  expect(stillInBin(item)).toBe(true)
})

// ---- when a step goes wrong ---------------------------------------------------------------------

test('an $I record that is already gone is not a problem', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  const item = await recycled(original)
  await rm(iOf(item))
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'restored', restoredTo: original }
  ])
})

// Only ENOENT, "there is nothing here", is a plain answer. Every other code is an error to report,
// ENOTDIR (a file where a folder should be) included.
test.each([
  ['EBUSY', 'EBUSY: resource busy or locked, unlink'],
  ['ENOTDIR', 'ENOTDIR: not a directory, unlink']
])(
  'an $I record that cannot be removed (%s) leaves the item restored, with the reason',
  async (code, message) => {
    const original = join(root, 'orig', 'photo.jpg')
    const item = await recycled(original, 'file', 'pixels')
    const after = join(root, 'orig', 'after.jpg')
    const next = await recycled(after)
    failFs('unlink', iOf(item), errno(code, message))
    const h = harness()

    const record = await restoreBatch(batchOf(item, next), h.deps)

    expect(record.items).toStrictEqual([
      {
        originalPath: original,
        status: 'restored',
        restoredTo: original,
        reason: `restored, but Stash couldn't remove its Recycle Bin record: ${message}`
      },
      { originalPath: after, status: 'restored', restoredTo: after }
    ])
    expect(await readFile(original, 'utf8')).toBe('pixels') // the data is back
    expect(existsSync(rOf(item))).toBe(false)
  }
)

test.each([
  ['EACCES', 'EACCES: permission denied, lstat'],
  ['ENOTDIR', 'ENOTDIR: not a directory, lstat']
])(
  'a failure on $R other than "not there" (%s) fails the item and carries on',
  async (code, message) => {
    const original = join(root, 'orig', 'photo.jpg')
    const item = await recycled(original)
    const after = join(root, 'orig', 'after.jpg')
    const next = await recycled(after)
    failFs('lstat', rOf(item), errno(code, message))
    const h = harness()

    const record = await restoreBatch(batchOf(item, next), h.deps)

    expect(record.items).toStrictEqual([
      { originalPath: original, status: 'failed', reason: message },
      { originalPath: after, status: 'restored', restoredTo: after }
    ])
    expect(stillInBin(item)).toBe(true)
  }
)

test.each([
  ['EACCES', 'EACCES: permission denied, lstat'],
  ['ENOTDIR', 'ENOTDIR: not a directory, lstat']
])(
  'when it cannot be told whether the original path is free (%s), nothing is moved',
  async (code, message) => {
    // rename replaces a file that is in its way, so an unknown answer must never count as "free".
    const original = join(root, 'orig', 'photo.jpg')
    await mkdir(dirname(original))
    const item = await recycled(original)
    failFs('lstat', original, errno(code, message))
    const h = harness()

    const record = await restoreBatch(batchOf(item), h.deps)

    expect(record.items).toStrictEqual([
      { originalPath: original, status: 'failed', reason: message }
    ])
    expect(stillInBin(item)).toBe(true)
  }
)

test('a parent folder that cannot be made fails the item and leaves $R and $I alone', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  const item = await recycled(original)
  failFs('mkdir', dirname(original), errno('EACCES', 'EACCES: permission denied, mkdir'))
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'failed', reason: 'EACCES: permission denied, mkdir' }
  ])
  expect(stillInBin(item)).toBe(true)
})

test('a move that fails fails the item, and its $I record stays for the next try', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  const item = await recycled(original)
  failFs('rename', rOf(item), errno('EPERM', 'EPERM: operation not permitted, rename'))
  const h = harness()

  const record = await restoreBatch(batchOf(item), h.deps)

  expect(record.items).toStrictEqual([
    { originalPath: original, status: 'failed', reason: 'EPERM: operation not permitted, rename' }
  ])
  expect(stillInBin(item)).toBe(true)
  expect(existsSync(original)).toBe(false)
})

// ---- order, the log, and what escapes -----------------------------------------------------------

test('each item is finished before the next one is looked at', async () => {
  const first = await recycled(join(root, 'orig', 'a.txt'))
  const second = await recycled(join(root, 'orig', 'b.txt'))
  const firstIsDone = (): boolean =>
    existsSync(first.originalPath) && !existsSync(rOf(first)) && !existsSync(iOf(first))
  const seen: boolean[] = []
  // The look at the second item's $R is the first thing that happens to that item. The stub only
  // notes whether the first item was already finished, then answers as the real disk would.
  fsStubs.set(`lstat:${rOf(second)}`, () => {
    seen.push(firstIsDone())
    return lstatSync(rOf(second))
  })
  const h = harness()

  const record = await restoreBatch(batchOf(first, second), h.deps)

  expect(seen).toEqual([true])
  expect(record.items.map((i) => i.status)).toEqual(['restored', 'restored'])
})

test('the clock is read once, after the last item has moved, and the record is logged after that', async () => {
  const first = await recycled(join(root, 'orig', 'a.txt'))
  const last = await recycled(join(root, 'orig', 'b.txt'))
  const seen: boolean[] = []
  const h = harness({
    now: () => {
      seen.push(existsSync(first.originalPath) && existsSync(last.originalPath))
      return NOW
    }
  })

  await restoreBatch(batchOf(first, last), h.deps)

  expect(seen).toEqual([true]) // read once, with both items already back
  expect(h.append).toHaveBeenCalledTimes(1)
  expect(Math.min(...h.append.mock.invocationCallOrder)).toBeGreaterThan(
    Math.max(...h.now.mock.invocationCallOrder)
  )
})

test('a mixed batch logs one record with an entry for each recycled item, in batch order', async () => {
  const takenPath = join(root, 'orig', 'taken.jpg')
  await put(takenPath, 'in the way')
  const purged = await recycled(join(root, 'orig', 'purged.jpg'))
  await rm(rOf(purged))
  const unpaired = await recycled(join(root, 'orig', 'unpaired.jpg'))
  delete unpaired.recycledAs
  const items = [
    await recycled(join(root, 'orig', 'restored.jpg')),
    purged,
    skippedItem(join(root, 'orig', 'skipped.jpg')),
    await recycled(takenPath),
    unpaired
  ]
  const h = harness()

  const record = await restoreBatch(batchOf(...items), h.deps)

  expect(record.items.map((i) => i.status)).toEqual(['restored', 'purged', 'restored', 'failed'])
  expect(record.items.map((i) => i.originalPath)).toEqual(
    items.filter((i) => i.status === 'recycled').map((i) => i.originalPath)
  )
  expect(record.items[2].restoredTo).toBe(join(root, 'orig', 'taken (restored).jpg'))
  expect(h.append).toHaveBeenCalledTimes(1)
  expect(h.append.mock.calls[0][0]).toBe(record)
  // Written to the log and read back, it is the same record: no field is left undefined.
  expect(JSON.parse(JSON.stringify(record))).toStrictEqual(record)
})

test('a log that cannot be written rejects the restore, and what was moved stays moved', async () => {
  const original = join(root, 'orig', 'photo.jpg')
  const item = await recycled(original, 'file', 'pixels')
  const h = harness({
    append: async () => {
      throw new Error('disk full')
    }
  })

  await expect(restoreBatch(batchOf(item), h.deps)).rejects.toThrow('disk full')

  expect(await readFile(original, 'utf8')).toBe('pixels')
  expect(readdirSync(bin)).toEqual([])
})
