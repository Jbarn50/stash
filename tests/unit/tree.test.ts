import { expect, test } from 'vitest'
import { ScanTree } from '../../src/core/tree'

const MiB = 1048576

test('aggregates up the chain and splits tracked vs small files', () => {
  const t = new ScanTree('X:\\root', 1000, 1048576)
  const a = t.addFolder(0, 'a', 2000)
  const b = t.addFolder(a, 'b', 3000)
  t.addFile(b, {
    name: 'big.bin',
    sizeOnDisk: 2097152,
    logicalSize: 2097152,
    mtimeMs: 5000,
    hardLinkKey: null
  })
  t.addFile(b, {
    name: 'small.txt',
    sizeOnDisk: 4096,
    logicalSize: 100,
    mtimeMs: 4000,
    hardLinkKey: null
  })
  expect(t.folders[0].sizeOnDisk).toBe(2101248)
  expect(t.folders[0].logicalSize).toBe(2097252)
  expect(t.folders[a]).toMatchObject({ sizeOnDisk: 2101248, fileCount: 2, smallFilesCount: 0 })
  expect(t.folders[b]).toMatchObject({ smallFilesCount: 1, smallFilesSize: 4096, fileCount: 2 })
  expect(t.filePath(t.folders[b].fileIds[0])).toBe('X:\\root\\a\\b\\big.bin')
  expect(t.folders[0].newestMtimeMs).toBe(5000)
  expect(t.folders[b].directFilesNewestMtimeMs).toBe(5000)
})

test('a file exactly at the threshold is tracked; one byte less is not', () => {
  const t = new ScanTree('X:\\root', 1, MiB)
  t.addFile(0, { name: 'at.bin', sizeOnDisk: MiB, logicalSize: MiB, mtimeMs: 1, hardLinkKey: null })
  t.addFile(0, {
    name: 'under.bin',
    sizeOnDisk: MiB,
    logicalSize: MiB - 1,
    mtimeMs: 1,
    hardLinkKey: null
  })
  expect(t.files.map((f) => f.name)).toEqual(['at.bin'])
  expect(t.folders[0].smallFilesCount).toBe(1)
})

test('a hard-linked file counts once', () => {
  const t = new ScanTree('X:\\root', 1, MiB)
  const f = t.addFolder(0, 'f', 1)
  t.addFile(0, {
    name: 'one.bin',
    sizeOnDisk: 2 * MiB,
    logicalSize: 2 * MiB,
    mtimeMs: 1,
    hardLinkKey: '1:42'
  })
  t.addFile(f, {
    name: 'two.bin',
    sizeOnDisk: 2 * MiB,
    logicalSize: 2 * MiB,
    mtimeMs: 1,
    hardLinkKey: '1:42'
  })
  expect(t.folders[0].sizeOnDisk).toBe(2097152)
  expect(t.folders[0].logicalSize).toBe(2097152)
  expect(t.folders[f].sizeOnDisk).toBe(0)
  expect(t.files.map((x) => x.extraHardLink)).toEqual([false, true])
  expect(t.folders[0].fileCount).toBe(2)
})

test('a small hard-linked file adds its size once', () => {
  const t = new ScanTree('X:\\root', 1, MiB)
  t.addFile(0, { name: 'a.txt', sizeOnDisk: 4096, logicalSize: 10, mtimeMs: 1, hardLinkKey: '1:7' })
  t.addFile(0, { name: 'b.txt', sizeOnDisk: 4096, logicalSize: 10, mtimeMs: 1, hardLinkKey: '1:7' })
  expect(t.folders[0]).toMatchObject({ smallFilesCount: 2, smallFilesSize: 4096, sizeOnDisk: 4096 })
})

test('a big file with nothing on disk is cloud-only and adds no size', () => {
  const t = new ScanTree('X:\\root', 1, MiB)
  t.addFile(0, {
    name: 'cloud.mp4',
    sizeOnDisk: 0,
    logicalSize: 5 * MiB,
    mtimeMs: 1,
    hardLinkKey: null
  })
  t.addFile(0, {
    name: 'local.mp4',
    sizeOnDisk: 2 * MiB,
    logicalSize: 2 * MiB,
    mtimeMs: 1,
    hardLinkKey: null
  })
  expect(t.files.map((f) => [f.name, f.cloudOnly])).toEqual([
    ['cloud.mp4', true],
    ['local.mp4', false]
  ])
  expect(t.folders[0].sizeOnDisk).toBe(2097152)
})

test('newestMtimeExcluding ignores the excluded child', () => {
  const t = new ScanTree('X:\\root', 500, MiB)
  const project = t.addFolder(0, 'project', 1000)
  t.addFile(project, {
    name: 'package.json',
    sizeOnDisk: 4096,
    logicalSize: 300,
    mtimeMs: 1500,
    hardLinkKey: null
  })
  const src = t.addFolder(project, 'src', 1200)
  t.addFile(src, {
    name: 'app.ts',
    sizeOnDisk: 4096,
    logicalSize: 300,
    mtimeMs: 2000,
    hardLinkKey: null
  })
  const nm = t.addFolder(project, 'node_modules', 800)
  t.addFile(nm, {
    name: 'x.js',
    sizeOnDisk: 4096,
    logicalSize: 10,
    mtimeMs: 9000,
    hardLinkKey: null
  })
  expect(t.newestMtimeExcluding(project, [nm])).toBe(2000)
  expect(t.newestMtimeExcluding(project, [nm, src])).toBe(1500)
  expect(t.newestMtimeExcluding(project, [])).toBe(9000)
  expect(t.folders[project].newestMtimeMs).toBe(9000)
})

test('a new folder raises newestMtimeMs up the chain', () => {
  const t = new ScanTree('X:\\root', 100, MiB)
  const a = t.addFolder(0, 'a', 200)
  t.addFolder(a, 'b', 7000)
  expect(t.folders[0].newestMtimeMs).toBe(7000)
  expect(t.folders[a].newestMtimeMs).toBe(7000)
})

test('findFolder is case-insensitive and survives toData/fromData', () => {
  const t = new ScanTree('C:\\Data', 1, MiB)
  const users = t.addFolder(0, 'Users', 2)
  const j = t.addFolder(users, 'Jorda', 3)
  t.addFile(j, {
    name: 'big.bin',
    sizeOnDisk: 3 * MiB,
    logicalSize: 3 * MiB,
    mtimeMs: 4,
    hardLinkKey: null
  })
  t.markUnreadable(users)
  expect(t.findFolder('c:/data/users/JORDA/')).toBe(j)
  expect(t.findFolder('C:\\Data')).toBe(0)
  expect(t.findFolder('C:\\Data\\Nope')).toBeUndefined()
  expect(t.findFolder('C:\\DataX\\Users')).toBeUndefined()
  expect(t.findFolder('D:\\Data\\Users')).toBeUndefined()

  const copy = ScanTree.fromData(JSON.parse(JSON.stringify(t.toData())))
  expect(copy.findFolder('C:\\DATA\\USERS\\jorda')).toBe(j)
  expect(copy.folderPath(j)).toBe('C:\\Data\\Users\\Jorda')
  expect(copy.folders[0].sizeOnDisk).toBe(3145728)
  expect(copy.filePath(0)).toBe('C:\\Data\\Users\\Jorda\\big.bin')
  expect(copy.unreadableCount).toBe(1)
})

test('paths under a drive root have a single separator', () => {
  const t = new ScanTree('c:/', 1, MiB)
  const w = t.addFolder(0, 'Windows', 1)
  t.addFile(0, {
    name: 'pagefile.sys',
    sizeOnDisk: 8 * MiB,
    logicalSize: 8 * MiB,
    mtimeMs: 1,
    hardLinkKey: null
  })
  expect(t.folderPath(0)).toBe('C:\\')
  expect(t.folderPath(w)).toBe('C:\\Windows')
  expect(t.filePath(0)).toBe('C:\\pagefile.sys')
  expect(t.findFolder('C:\\windows')).toBe(w)
})

test('links add no size and are listed by name', () => {
  const t = new ScanTree('X:\\root', 1, MiB)
  t.addLink(0, 'loop')
  expect(t.folders[0].links).toEqual(['loop'])
  expect(t.folders[0]).toMatchObject({ sizeOnDisk: 0, fileCount: 0 })
  expect(t.childByName(0, 'loop')).toBeUndefined()
})

test('childByName and isInside', () => {
  const t = new ScanTree('X:\\root', 1, MiB)
  const users = t.addFolder(0, 'Users', 1)
  const j = t.addFolder(users, 'jorda', 1)
  expect(t.childByName(0, 'USERS')).toBe(users)
  expect(t.childByName(users, 'other')).toBeUndefined()
  expect(t.isInside(j, users)).toBe(true)
  expect(t.isInside(j, 0)).toBe(true)
  expect(t.isInside(j, j)).toBe(true)
  expect(t.isInside(users, j)).toBe(false)
})

test('markers are kept lower-cased; unmeasured names and unreadable folders are recorded', () => {
  const t = new ScanTree('X:\\root', 1, MiB)
  const a = t.addFolder(0, 'a', 1)
  t.addMarker(a, 'Package.JSON')
  t.addUnmeasured(0, 'pagefile.sys')
  t.markUnreadable(a)
  t.markUnreadable(a)
  t.markUnreadable(0)
  expect(t.folders[a].markers).toEqual(['package.json'])
  expect(t.folders[0].unmeasured).toEqual(['pagefile.sys'])
  expect(t.folders[a].unreadable).toBe(true)
  expect(t.unreadableCount).toBe(2)
})
