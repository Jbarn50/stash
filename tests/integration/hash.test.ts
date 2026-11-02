import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import type { SizeGroup } from '../../src/core/detectors/duplicates'
import { hashGroups, partialHash } from '../../src/core/hash'

const KiB = 1024
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stash-hash-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, content: Buffer): string {
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}
const group = (paths: string[], size: number): SizeGroup => ({
  logicalSize: size,
  fileIds: paths.map((_, i) => i),
  paths
})

test('files sharing a partial hash but differing in the middle are not duplicates', async () => {
  const same = randomBytes(300 * KiB)
  const near = randomBytes(300 * KiB)
  const nearB = Buffer.from(near)
  nearB[150 * KiB] ^= 0xff
  const paths = [
    write('a.bin', same),
    write('b.bin', same),
    write('c.bin', near),
    write('d.bin', nearB),
    write('e.bin', randomBytes(300 * KiB))
  ]
  expect(await partialHash(paths[2], 300 * KiB)).toBe(await partialHash(paths[3], 300 * KiB))
  const groups = await hashGroups([group(paths, 300 * KiB)])
  expect(groups.map((g) => g.fileIds)).toEqual([[0, 1]])
})

test('partialHash reads the whole of a small file but only the ends of a large one', async () => {
  const smallA = randomBytes(100 * KiB)
  const smallB = Buffer.from(smallA)
  smallB[50 * KiB] ^= 0xff
  expect(await partialHash(write('s1.bin', smallA), 100 * KiB)).not.toBe(
    await partialHash(write('s2.bin', smallB), 100 * KiB)
  )
})

test('a file deleted before hashing is dropped without failing', async () => {
  const same = randomBytes(200 * KiB)
  const paths = [write('x.bin', same), write('y.bin', same), write('z.bin', same)]
  unlinkSync(paths[2])
  const groups = await hashGroups([group(paths, 200 * KiB)])
  expect(groups.map((g) => g.fileIds)).toEqual([[0, 1]])
})

test('progress ends exactly at totalBytes', async () => {
  const same = randomBytes(200 * KiB)
  const paths = [write('p.bin', same), write('q.bin', same), write('r.bin', randomBytes(200 * KiB))]
  const calls: [number, number][] = []
  await hashGroups([group(paths, 200 * KiB)], {
    onProgress: (hashed, total) => calls.push([hashed, total])
  })
  expect(calls.at(-1)).toEqual([600 * KiB, 600 * KiB])
  expect(calls.every(([hashed, total]) => total === 600 * KiB && hashed <= total)).toBe(true)
})

test('an abort rejects with AbortError', async () => {
  const same = randomBytes(200 * KiB)
  const paths = [write('m.bin', same), write('n.bin', same)]
  const controller = new AbortController()
  controller.abort()
  await expect(
    hashGroups([group(paths, 200 * KiB)], { signal: controller.signal })
  ).rejects.toMatchObject({
    name: 'AbortError'
  })
})
