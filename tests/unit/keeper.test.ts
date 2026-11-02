import { expect, test } from 'vitest'
import { groupsWithEveryCopySelected, suggestKeeper } from '../../src/core/keeper'
import type { Finding } from '../../src/shared/types'
import { SAMPLE_ENV } from '../helpers/env'

const E = SAMPLE_ENV

test('keeper: outside Downloads/Temp/Desktop first, then oldest', () =>
  expect(
    suggestKeeper(
      [
        { path: `${E.downloads}\\a.jpg`, mtimeMs: 1 },
        { path: `${E.documents}\\a.jpg`, mtimeMs: 5 },
        { path: `${E.pictures}\\b.jpg`, mtimeMs: 3 }
      ],
      E
    )
  ).toBe(2))

test('keeper: ties break by shortest path, then ordinal order', () => {
  expect(
    suggestKeeper(
      [
        { path: `${E.pictures}\\holiday\\a.jpg`, mtimeMs: 7 },
        { path: `${E.pictures}\\a.jpg`, mtimeMs: 7 }
      ],
      E
    )
  ).toBe(1)
  expect(
    suggestKeeper(
      [
        { path: `${E.pictures}\\b.jpg`, mtimeMs: 7 },
        { path: `${E.pictures}\\a.jpg`, mtimeMs: 7 }
      ],
      E
    )
  ).toBe(1)
})

test('keeper: all in Downloads/Temp/Desktop → oldest overall', () =>
  expect(
    suggestKeeper(
      [
        { path: `${E.downloads}\\a.zip`, mtimeMs: 9 },
        { path: `${E.desktop}\\a.zip`, mtimeMs: 2 },
        { path: `${E.temp}\\a.zip`, mtimeMs: 4 }
      ],
      E
    )
  ).toBe(1))

test('groupsWithEveryCopySelected flags only groups with every copy selected', () => {
  const copy = (id: string, groupId: string): Finding => ({
    id,
    scanId: 's1',
    ruleId: 'duplicates',
    category: 'duplicates',
    safety: 'review',
    title: 't',
    explanation: 'e',
    path: `C:\\${id}`,
    kind: 'file',
    sizeOnDisk: 1,
    logicalSize: 1,
    mtimeMs: 0,
    groupId
  })
  const findings = [
    copy('a', 'g1'),
    copy('b', 'g1'),
    copy('c', 'g2'),
    copy('d', 'g2'),
    copy('e', 'g2')
  ]
  expect(groupsWithEveryCopySelected(new Set(['a', 'b', 'c']), findings)).toEqual(['g1'])
  expect(groupsWithEveryCopySelected(new Set(['a', 'c', 'd']), findings)).toEqual([])
})
