import type { Dirent, Stats } from 'node:fs'
import { lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { win32 } from 'node:path'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { nodeFsDeps, type FsDeps } from '../../src/core/scan/fsDeps'
import { measureLockedFiles } from '../../src/core/scan/lockedFiles'
import { scanTree, type ScanProgressPayload } from '../../src/core/scan/scanTree'
import type { ScanTree } from '../../src/core/tree'
import { buildFixture, type Fixture } from '../fixtures/buildFixture'
import { findFile } from '../helpers/treeQueries'

const TRACK = 65536
const DAY = 86_400_000
const withCode = (code: string): Error => Object.assign(new Error(code), { code })

describe.runIf(process.platform === 'win32')('scanTree on the fixture', () => {
  let fx: Fixture
  let tree: ScanTree

  beforeAll(async () => {
    fx = await buildFixture()
    tree = (await scanTree({ root: fx.root, trackFileMinBytes: TRACK })).tree
  })
  afterAll(async () => {
    await fx?.dispose()
  })

  test('size on disk matches the fixture, counting the hard link once', async () => {
    const r = await scanTree({ root: fx.root, trackFileMinBytes: TRACK })
    expect(r.incomplete).toBe(false)
    expect(r.tree.folders[0].sizeOnDisk).toBe(fx.expectedSizeOnDisk)
    const links = [findFile(r.tree, fx.p.hard1), findFile(r.tree, fx.p.hard2)]
    expect(links.filter((f) => f?.extraHardLink)).toHaveLength(1)
  })

  test('the junction is a link and is not followed', () => {
    const docs = tree.findFolder(win32.dirname(fx.p.loop))!
    expect(tree.folders[docs].links).toContain('loop')
    expect(tree.childByName(docs, 'loop')).toBeUndefined()
  })

  test('small project manifests are kept as markers', () => {
    expect(tree.folders[tree.findFolder(fx.p.webapp)!].markers).toContain('package.json')
    expect(tree.folders[tree.findFolder(win32.join(fx.p.venv, '.venv'))!].markers).toContain(
      'pyvenv.cfg'
    )
  })

  test('a path over 260 characters is scanned and sized', () => {
    expect(fx.p.deep.length).toBeGreaterThan(260)
    expect(findFile(tree, fx.p.deep)?.sizeOnDisk).toBe(lstatSync(fx.p.deep).blocks * 512)
  })

  test("folder ages set by the fixture reach the tree's own modified times", () => {
    const shot = tree.findFolder(fx.p.frames)!
    expect(tree.folders[shot].mtimeMs).toBeLessThan(Date.now() - 59 * DAY)
    expect(tree.folders[tree.findFolder(fx.p.webapp)!].mtimeMs).toBeLessThan(Date.now() - 399 * DAY)
  })

  test('a file that vanishes before lstat is skipped without marking its folder unreadable', async () => {
    const deps: FsDeps = {
      ...nodeFsDeps,
      lstat: async (p) => {
        if (p === fx.p.tempFresh) throw withCode('ENOENT')
        return nodeFsDeps.lstat(p)
      }
    }
    const r = await scanTree({ root: fx.root, trackFileMinBytes: TRACK }, deps)
    expect(r.tree.unreadableCount).toBe(0)
    expect(findFile(r.tree, fx.p.tempFresh)).toBeUndefined()
    expect(r.tree.folders[r.tree.findFolder(fx.env.temp)!].unmeasured).toEqual([])
  })

  test('an EPERM file is unmeasured, and measureLocked is not used below a drive root', async () => {
    const measureLocked = vi.fn(async () => new Map<string, { size: number; mtimeMs: number }>())
    const deps: FsDeps = {
      ...nodeFsDeps,
      measureLocked,
      lstat: async (p) => {
        if (p === fx.p.setupNew) throw withCode('EPERM')
        return nodeFsDeps.lstat(p)
      }
    }
    const r = await scanTree({ root: fx.root, trackFileMinBytes: TRACK }, deps)
    expect(r.tree.folders[r.tree.findFolder(fx.env.downloads)!].unmeasured).toEqual([
      'setup-new.msi'
    ])
    expect(measureLocked).not.toHaveBeenCalled()
  })

  test('a folder that cannot be read is marked unreadable and the scan goes on', async () => {
    const deps: FsDeps = {
      ...nodeFsDeps,
      readdir: async (d) => {
        if (d === fx.p.webapp) throw withCode('EPERM')
        return nodeFsDeps.readdir(d)
      }
    }
    const r = await scanTree({ root: fx.root, trackFileMinBytes: TRACK }, deps)
    expect(r.tree.folders[r.tree.findFolder(fx.p.webapp)!].unreadable).toBe(true)
    expect(r.tree.unreadableCount).toBe(1)
    expect(findFile(r.tree, fx.p.photo)).toBeDefined()
  })

  test('a folder that vanishes before it is read is skipped silently', async () => {
    const deps: FsDeps = {
      ...nodeFsDeps,
      readdir: async (d) => {
        if (d === fx.p.small) throw withCode('ENOENT')
        return nodeFsDeps.readdir(d)
      }
    }
    const r = await scanTree({ root: fx.root, trackFileMinBytes: TRACK }, deps)
    expect(r.tree.unreadableCount).toBe(0)
  })

  test('a reparse point that lstat reports as a plain file is scanned as a file', async () => {
    // OneDrive placeholders can be listed as reparse points; lstat decides what they really are.
    const deps: FsDeps = {
      ...nodeFsDeps,
      readdir: async (d) =>
        (await nodeFsDeps.readdir(d)).map((e) =>
          e.name === 'photo.jpg'
            ? ({
                name: e.name,
                isSymbolicLink: () => true,
                isFile: () => false,
                isDirectory: () => false
              } as unknown as Dirent)
            : e
        )
    }
    const r = await scanTree({ root: fx.root, trackFileMinBytes: TRACK }, deps)
    expect(findFile(r.tree, fx.p.photo)?.sizeOnDisk).toBe(lstatSync(fx.p.photo).blocks * 512)
  })

  test('abort returns partial results marked incomplete', async () => {
    const ac = new AbortController()
    const r = await scanTree({
      root: fx.root,
      trackFileMinBytes: TRACK,
      progressIntervalMs: 0,
      signal: ac.signal,
      onProgress: () => ac.abort()
    })
    expect(r.incomplete).toBe(true)
    expect(r.tree.folders[0].sizeOnDisk).toBeLessThan(fx.expectedSizeOnDisk)
  })

  test('an error inside the walk ends it like an abort: the partial tree comes back with the error', async () => {
    // A throwing onProgress is how the walk is made to fail. It throws again on the final report,
    // which must not lose the tree either.
    const r = await scanTree({
      root: fx.root,
      trackFileMinBytes: TRACK,
      progressIntervalMs: 0,
      onProgress: () => {
        throw new Error('boom')
      }
    })
    expect(r.incomplete).toBe(true)
    expect(r.error).toContain('boom')
    expect(r.tree.folders[0].sizeOnDisk).toBeLessThan(fx.expectedSizeOnDisk)
  })

  test('a failure in the very last progress report keeps the finished tree and still reports the error', async () => {
    let reports = 0
    const r = await scanTree({
      root: fx.root,
      trackFileMinBytes: TRACK,
      progressIntervalMs: 1e9, // only the first report and the forced final one
      onProgress: () => {
        if (++reports === 2) throw new Error('late')
      }
    })
    expect(r.error).toBe('late')
    expect(r.incomplete).toBe(true) // an error always comes with incomplete: true
    expect(r.tree.folders[0].sizeOnDisk).toBe(fx.expectedSizeOnDisk)
  })

  test('a scan that finishes without an error carries none', async () => {
    const r = await scanTree({ root: fx.root, trackFileMinBytes: TRACK })
    expect(r.error).toBeUndefined()
  })

  test('progress reports counts and the largest top-level folders', async () => {
    const seen: ScanProgressPayload[] = []
    await scanTree({
      root: fx.root,
      trackFileMinBytes: TRACK,
      progressIntervalMs: 0,
      onProgress: (p) => seen.push(p)
    })
    const last = seen[seen.length - 1]
    expect(last.bytesSeen).toBe(fx.expectedSizeOnDisk)
    expect(last.topLevel.map((t) => t.name)).toEqual(['Users', 'Windows'])
    expect(last.foldersScanned).toBeGreaterThan(40)
    // The fixture table creates 46 file entries; the hard-linked file has two names and counts twice.
    expect(last.filesScanned).toBe(46)
  })

  test('measureLockedFiles reads sizes through PowerShell', async () => {
    const missing = win32.join(fx.root, 'missing.bin')
    const sizes = await measureLockedFiles([fx.p.photo, missing])
    expect(sizes.get(fx.p.photo)?.size).toBe(204800)
    expect(sizes.has(missing)).toBe(false)
  })

  test('measureLockedFiles finds a name with wildcard characters by its exact name', async () => {
    const odd = win32.join(fx.root, 'odd [1].bin')
    writeFileSync(odd, Buffer.alloc(3000))
    try {
      const sizes = await measureLockedFiles([odd])
      expect(sizes.get(odd)?.size).toBe(3000)
    } finally {
      rmSync(odd)
    }
  })
})

// Windows will not let anything stat its own paging and hibernation files, not even Get-Item; the
// directory listing (dir, Get-ChildItem) still has their sizes. Runs only where C:\ has one.
const rootSysFiles =
  process.platform === 'win32'
    ? readdirSync('C:\\').filter((n) => /^(pagefile|hiberfil|swapfile)\.sys$/i.test(n))
    : []
test.runIf(rootSysFiles.length > 0)(
  'measureLockedFiles sizes the real C:\\ paging and hibernation files from the listing',
  async () => {
    const paths = rootSysFiles.map((n) => `C:\\${n}`)
    const sizes = await measureLockedFiles(paths)
    for (const p of paths) {
      expect(sizes.get(p)?.size).toBeGreaterThan(0)
      expect(Number.isFinite(sizes.get(p)?.mtimeMs)).toBe(true)
    }
  }
)

test('locked files at a drive root are measured through measureLocked', async () => {
  const stats = (dir: boolean): Stats =>
    ({
      isSymbolicLink: () => false,
      isDirectory: () => dir,
      isFile: () => !dir,
      mtimeMs: 1,
      size: 0,
      blocks: 0,
      nlink: 1
    }) as unknown as Stats
  const pagefile = {
    name: 'pagefile.sys',
    isSymbolicLink: () => false,
    isDirectory: () => false,
    isFile: () => true
  }
  const deps: FsDeps = {
    readdir: async () => [pagefile as unknown as Dirent],
    lstat: async (p) => {
      if (p === 'X:\\') return stats(true)
      throw withCode('EPERM')
    },
    hardLinkKey: async () => 'unused',
    measureLocked: async (paths) =>
      new Map(paths.map((p) => [p, { size: 27_000_000_000, mtimeMs: 5 }]))
  }
  const r = await scanTree({ root: 'x:/', trackFileMinBytes: TRACK }, deps)
  expect(r.tree.files.map((f) => [f.name, f.sizeOnDisk])).toEqual([
    ['pagefile.sys', 27_000_000_000]
  ])
  expect(r.tree.folders[0].unmeasured).toEqual([])
  expect(r.tree.folders[0].sizeOnDisk).toBe(27_000_000_000)
})

describe('size on disk when lstat reports an impossible allocation', () => {
  // blocks comes from the NTFS allocation size, which some files (OneDrive's logs, for one) report as
  // nonsense: a 111-byte file with 5e18 bytes allocated. Such a file counts as its size rounded up to
  // the cluster; ordinary over-allocation, which a growing file really has, is kept.
  const scanOne = async (size: number, blocks: number, blksize = 4096): Promise<number> => {
    const file = {
      name: 'f.bin',
      isSymbolicLink: () => false,
      isDirectory: () => false,
      isFile: () => true
    }
    const stats = (dir: boolean): Stats =>
      ({
        isSymbolicLink: () => false,
        isDirectory: () => dir,
        isFile: () => !dir,
        mtimeMs: 1,
        size: dir ? 0 : size,
        blocks: dir ? 0 : blocks,
        blksize,
        nlink: 1
      }) as unknown as Stats
    const deps: FsDeps = {
      readdir: async () => [file as unknown as Dirent],
      lstat: async (p) => stats(p === 'X:\\'),
      hardLinkKey: async () => 'unused',
      measureLocked: async () => new Map()
    }
    const r = await scanTree({ root: 'X:\\', trackFileMinBytes: 0 }, deps)
    return r.tree.folders[0].sizeOnDisk
  }

  test('a wildly over-allocated small file counts as its size rounded up to the cluster', async () => {
    expect(await scanOne(111, 10452630453499056)).toBe(4096)
    expect(await scanOne(256, 1_873_944)).toBe(4096)
    expect(await scanOne(111, 10452630453499056, 8192)).toBe(8192)
  })

  test('a large file with an impossible allocation counts as its size rounded up', async () => {
    expect(await scanOne(10_000_000, 9e15)).toBe(10_002_432)
  })

  test('ordinary over-allocation of a growing file is kept', async () => {
    // From this PC: a 42 MB temp file with 97 MB allocated, a 6.9 MB log with 32.6 MB allocated.
    expect(await scanOne(42_274_669, 189_864)).toBe(189_864 * 512)
    expect(await scanOne(6_880_682, 63_616)).toBe(63_616 * 512)
  })

  test('the limit is 64 MiB beyond the rounded size, or double it for a large file', async () => {
    // A small file preallocated by up to 64 MiB is believed...
    expect(await scanOne(1000, (60 * 1024 * 1024) / 512)).toBe(60 * 1024 * 1024)
    // ...and so is a 1 GiB file with 1.5 GiB allocated, though that is 512 MiB beyond its size.
    expect(await scanOne(2 ** 30, (1.5 * 2 ** 30) / 512)).toBe(1.5 * 2 ** 30)
    // Beyond both, it is not.
    expect(await scanOne(1000, (65 * 1024 * 1024) / 512)).toBe(4096)
    expect(await scanOne(2 ** 30, (2 ** 31 + 2 ** 20) / 512)).toBe(2 ** 30)
  })

  test('allocation at or below the size is used as it is', async () => {
    expect(await scanOne(204_800, 400)).toBe(204_800)
    expect(await scanOne(5000, 0)).toBe(0) // cloud-only placeholder, or data kept in the MFT
    expect(await scanOne(1_000_000, 100)).toBe(51_200) // compressed or sparse
  })
})
