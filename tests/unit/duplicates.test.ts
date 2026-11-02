import { expect, test } from 'vitest'
import { createDetectorContext } from '../../src/core/detectors/context'
import { buildDuplicateFindings, duplicateCandidates } from '../../src/core/detectors/duplicates'
import { runStaticDetectors } from '../../src/core/detectors/index'
import { validateSettings } from '../../src/core/settings'
import type { ScanTree } from '../../src/core/tree'
import type { Settings } from '../../src/shared/types'
import { SAMPLE_ENV } from '../helpers/env'
import { treeFrom, type TreeEntry } from '../helpers/treeFrom'

const now = Date.UTC(2026, 10, 1)
const DAY = 86_400_000
const MiB = 1_048_576
const OLD = now - 60 * DAY
const five = (
  mtimeMs = OLD,
  extra: Partial<Extract<TreeEntry, { size: number }>> = {}
): TreeEntry => ({
  size: 5 * MiB,
  mtimeMs,
  ...extra
})

function candidatePaths(tree: ScanTree, settings: Settings = validateSettings({})): string[][] {
  const ctx = createDetectorContext({ scanId: 's1', tree, env: SAMPLE_ENV, settings, now })
  runStaticDetectors(ctx) // claims leftovers first, as the scan worker does
  return duplicateCandidates(ctx).map((g) => [...g.paths].sort())
}

test('candidates exclude AppData, .git, cloud-only, extra hard links, leftovers, exclusions and blocked paths', () => {
  const tree = treeFrom('C:\\', {
    'Users\\jorda\\OneDrive\\Documents\\a.bin': five(),
    'Users\\jorda\\Pictures\\a-copy.bin': five(),
    'Users\\jorda\\Videos\\h1.bin': five(OLD, { hardLinkKey: '1:5' }),
    'Users\\jorda\\Videos\\h2.bin': five(OLD, { hardLinkKey: '1:5' }),
    'Users\\jorda\\Videos\\cloud.bin': five(OLD, { onDisk: 0 }),
    'Users\\jorda\\AppData\\Local\\x.bin': five(),
    'Users\\jorda\\Projects\\r\\.git\\objects\\o.bin': five(),
    // An idle project's leftovers are claimed; an active project's are excluded all the same.
    'Users\\jorda\\Projects\\idle\\package.json': { size: 300, mtimeMs: OLD },
    'Users\\jorda\\Projects\\idle\\node_modules\\n.bin': five(),
    'Users\\jorda\\Projects\\live\\package.json': { size: 300, mtimeMs: now - DAY },
    'Users\\jorda\\Projects\\live\\node_modules\\n.bin': five(),
    'Users\\jorda\\Music\\m.bin': five(),
    'Windows\\w.bin': five()
  })
  const settings = validateSettings({
    exclusions: ['C:\\Users\\jorda\\Music'],
    personalFolders: ['C:\\Windows']
  })
  expect(candidatePaths(tree, settings)).toEqual([
    [
      'C:\\Users\\jorda\\OneDrive\\Documents\\a.bin',
      'C:\\Users\\jorda\\Pictures\\a-copy.bin',
      'C:\\Users\\jorda\\Videos\\h1.bin'
    ]
  ])
})

test('a lone file of a given size is not a candidate', () => {
  const tree = treeFrom('C:\\', {
    'Users\\jorda\\Pictures\\a.bin': five(),
    'Users\\jorda\\Pictures\\b.bin': { size: 6 * MiB, mtimeMs: OLD }
  })
  expect(candidatePaths(tree)).toEqual([])
})

test('each duplicate group has exactly one suggested keeper', () => {
  const tree = treeFrom('C:\\', {
    'Users\\jorda\\Downloads\\a.jpg': five(now - 1 * DAY),
    'Users\\jorda\\Pictures\\a.jpg': five(now - 3 * DAY),
    'Users\\jorda\\Pictures\\old\\a.jpg': five(now - 9 * DAY),
    'Users\\jorda\\Videos\\x.mkv': { size: 7 * MiB, mtimeMs: OLD },
    'Users\\jorda\\Videos\\copy\\x.mkv': { size: 7 * MiB, mtimeMs: OLD }
  })
  const groups = [
    { hash: 'h1', fileIds: [0, 1, 2] },
    { hash: 'h2', fileIds: [3, 4] }
  ]
  const findings = buildDuplicateFindings(groups, { scanId: 's1', tree, env: SAMPLE_ENV })
  expect(findings.map((f) => f.id)).toEqual([
    's1:duplicates:0',
    's1:duplicates:1',
    's1:duplicates:2',
    's1:duplicates:3',
    's1:duplicates:4'
  ])
  expect(findings.map((f) => f.groupId)).toEqual([
    's1:dup:0',
    's1:dup:0',
    's1:dup:0',
    's1:dup:1',
    's1:dup:1'
  ])
  expect(findings.filter((f) => f.suggestedKeep).map((f) => f.path)).toEqual([
    'C:\\Users\\jorda\\Pictures\\old\\a.jpg',
    'C:\\Users\\jorda\\Videos\\x.mkv'
  ])
  expect(
    findings.every(
      (f) => f.ruleId === 'duplicates' && f.category === 'duplicates' && f.safety === 'review'
    )
  ).toBe(true)
})

test("stale-large also skips an active project's node_modules", () => {
  const tree = treeFrom('C:\\', {
    'Users\\jorda\\Projects\\live\\package.json': { size: 300, mtimeMs: now - DAY },
    'Users\\jorda\\Projects\\live\\node_modules\\engine.bin': {
      size: 200 * MiB,
      mtimeMs: now - 400 * DAY
    }
  })
  const ctx = createDetectorContext({
    scanId: 's1',
    tree,
    env: SAMPLE_ENV,
    settings: validateSettings({}),
    now
  })
  expect(runStaticDetectors(ctx)).toEqual([])
})
