import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { CleanupLog } from '../../src/main/cleanupLog'
import type { CleanupBatch, RestoreRecord } from '../../src/shared/types'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stash-log-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const logFile = (): string => join(dir, 'cleanup-log.jsonl')

function batch(batchId: string, startedAt: string): CleanupBatch {
  return {
    type: 'cleanup',
    batchId,
    startedAt,
    finishedAt: startedAt,
    items: [
      {
        findingId: `s1:temp-user:${batchId}`,
        ruleId: 'temp-user',
        kind: 'folder',
        originalPath: `C:\\Users\\jorda\\AppData\\Local\\Temp\\${batchId}`,
        sizeOnDisk: 4096,
        mtime: '2026-10-01T00:00:00.000Z',
        status: 'recycled',
        recycledAs: '$RABC123'
      }
    ]
  }
}

function restore(batchId: string, at: string): RestoreRecord {
  const originalPath = `C:\\Users\\jorda\\AppData\\Local\\Temp\\${batchId}`
  return {
    type: 'restore',
    batchId,
    at,
    items: [{ originalPath, status: 'restored', restoredTo: originalPath }]
  }
}

test('the log appends one line per entry and skips malformed lines', async () => {
  const log = new CleanupLog(dir)
  const a = batch('a', '2026-11-01T10:00:00.000Z')
  const r = restore('a', '2026-11-01T11:00:00.000Z')
  const b = batch('b', '2026-11-01T12:00:00.000Z')
  await log.append(a)
  await log.append(r)
  await appendFile(
    logFile(),
    [
      'not json',
      '["an array"]',
      '{"type":"cleanup","batchId":7,"startedAt":"x","finishedAt":"x","items":[]}',
      '{"type":"restore","batchId":"a","at":"x","items":[1]}',
      '{"type":"purge","batchId":"a"}',
      ''
    ].join('\n') + '\n'
  )
  await log.append(b)
  expect(await log.readAll()).toEqual([a, r, b])
  const lines = (await readFile(logFile(), 'utf8')).split('\n')
  expect(lines[0]).toBe(JSON.stringify(a))
  expect(lines[1]).toBe(JSON.stringify(r))
  expect(lines.slice(-2)).toEqual([JSON.stringify(b), ''])
})

test('history lists batches newest first with their restore records', async () => {
  const log = new CleanupLog(dir)
  const a = batch('a', '2026-11-01T10:00:00.000Z')
  const b = batch('b', '2026-11-01T12:00:00.000Z')
  const ra1 = restore('a', '2026-11-01T13:00:00.000Z')
  const rb = restore('b', '2026-11-01T14:00:00.000Z')
  const ra2 = restore('a', '2026-11-01T15:00:00.000Z')
  const orphan = restore('gone', '2026-11-01T16:00:00.000Z')
  for (const entry of [a, ra1, b, rb, ra2, orphan]) await log.append(entry)
  expect(await log.history()).toEqual([
    { batch: b, restores: [rb] },
    { batch: a, restores: [ra1, ra2] }
  ])
})

test('getBatch finds a batch by its id, and null for an unknown id', async () => {
  const log = new CleanupLog(dir)
  const a = batch('a', '2026-11-01T10:00:00.000Z')
  await log.append(a)
  await log.append(restore('a', '2026-11-01T11:00:00.000Z'))
  await log.append(restore('gone', '2026-11-01T12:00:00.000Z')) // a restore record is not a batch
  expect(await log.getBatch('a')).toEqual(a)
  expect(await log.getBatch('missing')).toBeNull()
  expect(await log.getBatch('gone')).toBeNull()
})

test('a log that does not exist yet reads as empty', async () => {
  const log = new CleanupLog(join(dir, 'not-yet'))
  expect(await log.readAll()).toEqual([])
  expect(await log.history()).toEqual([])
  expect(await log.getBatch('a')).toBeNull()
})

test('a line cut short by a crash does not swallow the next entry', async () => {
  const log = new CleanupLog(dir)
  const a = batch('a', '2026-11-01T10:00:00.000Z')
  const b = batch('b', '2026-11-01T12:00:00.000Z')
  await log.append(a)
  await appendFile(logFile(), '{"type":"cleanup","batchId":"torn","startedAt":"2026') // no newline
  await log.append(b)
  expect(await log.readAll()).toEqual([a, b])
})

test('entries appended at the same moment each get their own line, in call order', async () => {
  const log = new CleanupLog(join(dir, 'Stash')) // not created yet: appending makes it
  const entries = Array.from({ length: 20 }, (_, i) =>
    batch(`b${i}`, `2026-11-01T10:00:${String(i).padStart(2, '0')}.000Z`)
  )
  await Promise.all(entries.map((entry) => log.append(entry)))
  expect(await log.readAll()).toEqual(entries)
})
