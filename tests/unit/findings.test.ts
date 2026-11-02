import { expect, test } from 'vitest'
import { buildSummary, summarizeFindings } from '../../src/core/findings'
import type { Category, Finding, SafetyRating } from '../../src/shared/types'
import { treeFrom } from '../helpers/treeFrom'

function finding(
  category: Category,
  safety: SafetyRating,
  sizeOnDisk: number,
  extra: Partial<Finding> = {}
): Finding {
  return {
    id: `s1:x:${Math.random()}`,
    scanId: 's1',
    ruleId: 'x',
    category,
    safety,
    title: 't',
    explanation: 'e',
    path: 'C:\\x',
    kind: 'file',
    sizeOnDisk,
    logicalSize: sizeOnDisk,
    mtimeMs: 0,
    ...extra
  }
}

test('summarizeFindings excludes keepers and info from reclaimable; windowsCanClean sums info', () => {
  const summary = summarizeFindings([
    finding('duplicates', 'review', 10, { groupId: 'g', suggestedKeep: true }),
    finding('duplicates', 'review', 10, { groupId: 'g' }),
    finding('tempCaches', 'safe', 5),
    finding('devLeftovers', 'review', 7),
    finding('system', 'info', 100),
    finding('system', 'info', 0, { sizeUnknown: true })
  ])
  expect(summary).toEqual({
    reclaimable: 22,
    byCategory: { duplicates: 10, tempCaches: 5, installersStale: 0, devLeftovers: 7, system: 0 },
    windowsCanClean: 100
  })
})

test('buildSummary takes totals from the tree and the findings', () => {
  const tree = treeFrom('C:\\', {
    'a\\x.bin': { size: 3_000_000, mtimeMs: 1 },
    locked: { dir: true, unreadable: true }
  })
  expect(
    buildSummary({
      scanId: 's1',
      root: 'C:\\',
      incomplete: true,
      foldersScanned: 3,
      filesScanned: 1,
      durationMs: 42,
      tree,
      findings: [finding('tempCaches', 'safe', 5)]
    })
  ).toEqual({
    scanId: 's1',
    root: 'C:\\',
    incomplete: true,
    foldersScanned: 3,
    filesScanned: 1,
    totalSizeOnDisk: 3_000_000,
    unreadableFolders: 1,
    reclaimable: 5,
    byCategory: { duplicates: 0, tempCaches: 5, installersStale: 0, devLeftovers: 0, system: 0 },
    windowsCanClean: 0,
    durationMs: 42
  })
})
