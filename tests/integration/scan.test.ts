import type { Dirent, Stats } from 'node:fs'
import { lstatSync } from 'node:fs'
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
})

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
