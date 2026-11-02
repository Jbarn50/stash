import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { driveOf, isPlainDrivePath, isSameOrInside, pathKey } from '../../src/core/paths'
import { parseIRecord } from '../../src/core/recycleBinInfo'
import { runCleanup, type CleanupDeps, type Recycler } from '../../src/main/cleanup'
import { CleanupLog } from '../../src/main/cleanupLog'
import { findRecycledRecords, getRecycleBinInfo, recycleBinDir } from '../../src/main/recycleBin'
import { restoreBatch } from '../../src/main/restore'
import type { CleanupBatch, Finding } from '../../src/shared/types'
import { psRecycler } from '../helpers/psRecycler'
import { realEnv } from '../helpers/realEnv'

// This is the one test that really sends files to this machine's Recycle Bin, and takes them out
// again with the restore engine. Only files it creates itself are ever recycled, and they are all
// inside one folder of its own, `<repo>/.test-recycle/stash-roundtrip-*` (git-ignored), never in
// %TEMP%: the Claude desktop app is MSIX-packaged, and a shell it starts may have its writes under
// %TEMP% redirected to a private folder. Windows would then record, in the `$I` file, a different
// path from the one the test recycled.
//
// The recycler the cleanup is given takes only a path the test registered with `own()` when it made
// it, so whatever the cleanup does, nothing else can reach the bin from here.
//
// Whatever goes into the bin comes back out. `afterAll` puts back anything a failed or crashed test
// left there, using only the records of the files this test made, and then checks that no record in
// the bin points inside the test folder. Nothing here empties the Recycle Bin or deletes a record
// that is not one of the test's own.
const REPO = realpathSync.native(fileURLToPath(new URL('../..', import.meta.url)))
const OWNED = join(REPO, '.test-recycle')
const PREFIX = 'stash-roundtrip-'
// A minute of slack before the test started, as the record lookup allows for clock rounding.
const SLACK_MS = 60_000

/** True when something, of any kind, is at `path`. */
const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false
  )

/** Each item's status, then its reason if it has one, so that a failure says why. */
const summary = (batch: CleanupBatch): string[] =>
  batch.items.map((i) => (i.reason === undefined ? i.status : `${i.status}: ${i.reason}`))

describe.runIf(process.platform === 'win32')('the real Recycle Bin', () => {
  let testRoot = ''
  let drive = ''
  let startedAt = 0
  /**
   * Every path the test made and hands to the cleanup. It is the only thing the recycler accepts,
   * and the only thing afterAll looks for in the bin.
   */
  const handedOver: string[] = []

  beforeAll(() => {
    startedAt = Date.now()
    mkdirSync(OWNED, { recursive: true })
    testRoot = realpathSync.native(mkdtempSync(join(OWNED, PREFIX)))
    drive = driveOf(testRoot)
  })

  afterAll(async () => {
    if (testRoot === '') return
    // Never delete anything but the folder this run made.
    if (!isSameOrInside(testRoot, OWNED) || !basename(testRoot).startsWith(PREFIX)) {
      throw new Error(`${testRoot} is not a folder of this test`)
    }

    // 1. Anything still in the bin goes back: rename $R to the path, then remove the $I beside it.
    const missing: string[] = []
    for (const path of handedOver) if (!(await exists(path))) missing.push(path)
    const stranded: string[] = []
    if (missing.length > 0) {
      const bin = await recycleBinDir(drive)
      const records = await findRecycledRecords(drive, missing, startedAt - SLACK_MS)
      for (const path of missing) {
        const record = records.get(pathKey(path))
        if (record === undefined) continue // not in the bin, so there is nothing to put back
        try {
          await mkdir(dirname(path), { recursive: true })
          await rename(join(bin, record.rName), path)
          await unlink(join(bin, record.iName))
        } catch (e) {
          stranded.push(`${path}: ${String(e)}`)
        }
      }
    }

    // 2. The last look: does any record in the bin still point inside the test folder?
    const left = await recordsInside(testRoot)

    // 3. The test folder goes only when nothing of it is left in the bin.
    if (stranded.length === 0 && left.length === 0) {
      await rm(testRoot, { recursive: true, force: true })
      await rmdir(OWNED).catch(() => undefined) // only if it is empty
    }

    expect(stranded, 'items the safety net could not put back').toEqual([])
    expect(left, 'records in the bin that point into the test folder').toEqual([])
  }, 60_000)

  /** The original paths of the `$I` records in the user's bin that point inside `folder`. */
  async function recordsInside(folder: string): Promise<string[]> {
    const bin = await recycleBinDir(driveOf(folder))
    let names: string[]
    try {
      names = await readdir(bin)
    } catch (e) {
      // A bin folder that is not there holds no records.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    const inside: string[] = []
    for (const name of names) {
      if (!name.startsWith('$I')) continue
      try {
        const { originalPath } = parseIRecord(await readFile(join(bin, name)))
        if (isSameOrInside(originalPath, folder)) inside.push(originalPath)
      } catch {
        // Not a record this test can read, so not one it wrote: Windows wrote its records just now.
      }
    }
    return inside
  }

  /** A file or folder the test made inside its own folder, noted before it goes to the cleanup. */
  function own(path: string): string {
    if (!isSameOrInside(path, testRoot) || pathKey(path) === pathKey(testRoot)) {
      throw new Error(`${path} is not inside the folder this test made, ${testRoot}`)
    }
    handedOver.push(path)
    return path
  }

  /**
   * The real recycler, except that it takes only a path the test made itself. Whatever the cleanup
   * code did wrong, nothing else can reach the user's Recycle Bin from here.
   */
  const ownedOnly: Recycler = {
    async trash(path) {
      if (!handedOver.some((mine) => pathKey(mine) === pathKey(path))) {
        throw new Error(`refusing to recycle ${path}: the round-trip test did not make it`)
      }
      await psRecycler.trash(path)
    }
  }

  /** The cleanup's dependencies, all real. The log lives inside the test folder. */
  function realDeps(log: CleanupLog): CleanupDeps {
    return {
      recycler: ownedOnly,
      binInfo: getRecycleBinInfo,
      findRecords: findRecycledRecords,
      log,
      env: realEnv(),
      now: Date.now
    }
  }

  /** The finding a scan would make for `path`; `sizedBy` is the file that gives a folder its size. */
  async function findingOf(n: number, path: string, sizedBy = path): Promise<Finding> {
    const [item, sized] = await Promise.all([lstat(path), lstat(sizedBy)])
    return {
      id: `roundtrip:${n}`,
      scanId: 'roundtrip',
      ruleId: 'temp-user',
      category: 'tempCaches',
      safety: 'safe',
      title: 'A file made by the round-trip test',
      explanation: 'Created by the test and removed by it',
      path,
      kind: item.isDirectory() ? 'folder' : 'file',
      sizeOnDisk: sized.blocks * 512,
      logicalSize: sized.size,
      mtimeMs: item.mtimeMs
    }
  }

  /** The bin of the test folder's drive must be on. Otherwise Windows would delete for good. */
  async function expectBinEnabled(): Promise<void> {
    const bin = await getRecycleBinInfo(drive)
    expect(
      bin.status,
      `The Recycle Bin of ${drive} is ${bin.status}, so recycling here may delete for good. ` +
        'The round-trip test does not run without it.'
    ).toBe('enabled')
  }

  function done(out: Awaited<ReturnType<typeof runCleanup>>): CleanupBatch {
    if (out.status !== 'done') throw new Error(`expected a finished cleanup, got ${out.status}`)
    return out.batch
  }

  test('recycle and restore real files, including a non-ASCII name', async () => {
    // 'plain.bin' and 'naïve 📁 写真.bin': an accent, an emoji outside the BMP and two CJK
    // characters. Written as escapes so that no editor can change them.
    const names = ['plain.bin', 'na\u00efve \u{1F4C1} \u5199\u771F.bin']
    const folder = join(testRoot, 'files')
    await mkdir(folder)
    const contents = new Map<string, Buffer>()
    for (const name of names) {
      const path = own(join(folder, name)) // the only things this run may recycle: files it makes
      const bytes = randomBytes(2048)
      await writeFile(path, bytes)
      contents.set(path, bytes)
    }
    const paths = [...contents.keys()]
    const findings = await Promise.all(paths.map((path, n) => findingOf(n, path)))
    await expectBinEnabled()
    const log = new CleanupLog(join(testRoot, 'data'))

    const batch = done(await runCleanup(findings, findings, false, realDeps(log)))

    expect(summary(batch)).toEqual(['recycled', 'recycled'])
    for (const item of batch.items) {
      expect(item.recycledAs, `${item.originalPath} was not paired with its $R`).toMatch(
        /^\$R\w+\.bin$/
      )
    }
    for (const path of paths) expect(await exists(path)).toBe(false)
    // Windows really holds them: each $R entry is in the bin, and its $I record names the path.
    const bin = await recycleBinDir(drive)
    for (const item of batch.items) {
      const rName = item.recycledAs ?? ''
      expect((await lstat(join(bin, rName))).size).toBe(2048)
      const record = parseIRecord(await readFile(join(bin, `$I${rName.slice(2)}`)))
      expect(record.originalPath).toBe(item.originalPath)
      expect(record.originalSize).toBe(2048n)
    }

    const restore = await restoreBatch(batch, { binDir: recycleBinDir, log, now: Date.now })

    expect(restore.items.map((i) => i.status)).toEqual(['restored', 'restored'])
    expect(restore.items.map((i) => i.restoredTo)).toEqual(paths)
    for (const [path, bytes] of contents) expect(await readFile(path)).toEqual(bytes)
    // Both records are gone from the bin along with their $R entries.
    for (const item of batch.items) {
      const rName = item.recycledAs ?? ''
      expect(await exists(join(bin, rName))).toBe(false)
      expect(await exists(join(bin, `$I${rName.slice(2)}`))).toBe(false)
    }
    // And the log tells the story: one cleanup, one restore of it.
    expect(await log.history()).toEqual([{ batch, restores: [restore] }])
  })

  test('recycle and restore a real folder with a file inside', async () => {
    const folder = own(join(testRoot, 'dirs', 'my.project'))
    const inner = join(folder, 'src', 'data.bin')
    const bytes = randomBytes(4096)
    await mkdir(dirname(inner), { recursive: true })
    await writeFile(inner, bytes)
    const findings = [await findingOf(0, folder, inner)]
    await expectBinEnabled()
    const log = new CleanupLog(join(testRoot, 'data-folder'))

    const batch = done(await runCleanup(findings, findings, false, realDeps(log)))

    expect(summary(batch)).toEqual(['recycled'])
    expect(batch.items[0].kind).toBe('folder')
    expect(batch.items[0].recycledAs).toMatch(/^\$R\w+/)
    expect(await exists(folder)).toBe(false)

    const restore = await restoreBatch(batch, { binDir: recycleBinDir, log, now: Date.now })

    expect(restore.items).toEqual([
      { originalPath: folder, status: 'restored', restoredTo: folder }
    ])
    expect(await readFile(inner)).toEqual(bytes)
  })
})

describe.runIf(process.platform === 'win32')('realEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('builds a plain environment from the real one, with no Stash folders', () => {
    const env = realEnv()

    const folders = [
      env.systemRoot,
      env.usersRoot,
      env.userProfile,
      env.localAppData,
      env.temp,
      env.downloads,
      env.desktop,
      env.documents,
      env.pictures,
      env.music,
      env.videos
    ]
    for (const folder of folders) expect(isPlainDrivePath(folder), folder).toBe(true)
    expect(pathKey(env.userProfile)).toBe(pathKey(process.env.USERPROFILE ?? ''))
    expect(env.usersRoot).toBe(win32.dirname(env.userProfile))
    expect(env.downloads).toBe(join(env.userProfile, 'Downloads'))
    expect(env.videos).toBe(join(env.userProfile, 'Videos'))
    expect(env.stashDirs).toEqual([])
  })

  test('a variable spelled another way is expanded to the spelling the disk uses', () => {
    const local = realpathSync.native(process.env.LOCALAPPDATA ?? '')
    vi.stubEnv('LOCALAPPDATA', local.toUpperCase())

    expect(realEnv().localAppData).toBe(local)
  })

  test('a folder that does not exist is kept as it is, and OneDrive is null when not set', () => {
    vi.stubEnv('TEMP', 'C:\\No Such Folder\\Temp')
    vi.stubEnv('OneDrive', undefined)

    const env = realEnv()

    expect(env.temp).toBe('C:\\No Such Folder\\Temp')
    expect(env.oneDrive).toBeNull()
  })
})
