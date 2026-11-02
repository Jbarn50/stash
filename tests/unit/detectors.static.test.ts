import { expect, test } from 'vitest'
import { createDetectorContext } from '../../src/core/detectors/context'
import { runStaticDetectors } from '../../src/core/detectors/index'
import { RULES } from '../../src/core/rules/catalog'
import { validateSettings } from '../../src/core/settings'
import type { ScanTree } from '../../src/core/tree'
import type { Finding, Settings } from '../../src/shared/types'
import { SAMPLE_ENV } from '../helpers/env'
import { treeFrom, type TreeEntry } from '../helpers/treeFrom'

const now = Date.UTC(2026, 10, 1)
const HOUR = 3_600_000
const DAY = 24 * HOUR
const MiB = 1_048_576
const TEMP = 'Users\\jorda\\AppData\\Local\\Temp'
const LOCAL = 'Users\\jorda\\AppData\\Local'
const DOWNLOADS = 'Users\\jorda\\Downloads'

function detect(tree: ScanTree, settings: Settings = validateSettings({})): Finding[] {
  return runStaticDetectors(
    createDetectorContext({ scanId: 's1', tree, env: SAMPLE_ENV, settings, now })
  )
}
const rulesByPath = (findings: Finding[]): Record<string, string> =>
  Object.fromEntries(findings.map((f) => [f.path, f.ruleId]))
const big = (
  mtimeMs: number,
  extra: Partial<Extract<TreeEntry, { size: number }>> = {}
): TreeEntry => ({
  size: 200 * MiB,
  mtimeMs,
  ...extra
})

test('temp-user flags only top-level temp items older than 24 hours', () => {
  const tree = treeFrom('C:\\', {
    [`${TEMP}\\old-dir`]: { dir: true, mtimeMs: now - 30 * HOUR },
    [`${TEMP}\\old-dir\\a.bin`]: { size: 2 * MiB, mtimeMs: now - 25 * HOUR },
    [`${TEMP}\\fresh.bin`]: { size: 2 * MiB, mtimeMs: now - 1 * HOUR },
    [`${TEMP}\\stale.bin`]: { size: 2 * MiB, mtimeMs: now - 48 * HOUR },
    [`${TEMP}\\fresh-dir`]: { dir: true, mtimeMs: now - 1 * HOUR },
    [`${TEMP}\\fresh-dir\\old-sub`]: { dir: true, mtimeMs: now - 100 * HOUR },
    [`${TEMP}\\fresh-dir\\old-sub\\b.bin`]: { size: 2 * MiB, mtimeMs: now - 100 * HOUR },
    [`${TEMP}\\empty-old`]: { dir: true, mtimeMs: now - 100 * HOUR },
    // Old itself, but something inside changed an hour ago: still in use.
    [`${TEMP}\\busy-dir`]: { dir: true, mtimeMs: now - 48 * HOUR },
    [`${TEMP}\\busy-dir\\log.bin`]: { size: 2 * MiB, mtimeMs: now - 2 * HOUR }
  })
  const temp = detect(tree).filter((f) => f.ruleId === 'temp-user')
  expect(temp.map((f) => [f.path, f.kind]).sort()).toEqual([
    [`C:\\${TEMP}\\old-dir`, 'folder'],
    [`C:\\${TEMP}\\stale.bin`, 'file']
  ])
  expect(temp.every((f) => f.safety === 'safe' && f.category === 'tempCaches')).toBe(true)
})

test('browser caches, package caches and crash dumps are safe and found per profile', () => {
  const f = { size: 2 * MiB, mtimeMs: now }
  const tree = treeFrom('C:\\', {
    [`${LOCAL}\\Google\\Chrome\\User Data\\Default\\Cache\\a`]: f,
    [`${LOCAL}\\Google\\Chrome\\User Data\\Profile 1\\Code Cache\\a`]: f,
    [`${LOCAL}\\Google\\Chrome\\User Data\\Default\\Network\\a`]: f,
    [`${LOCAL}\\Google\\Chrome\\User Data\\Profile 2\\Cache`]: { dir: true },
    [`${LOCAL}\\Microsoft\\Edge\\User Data\\Default\\GPUCache\\a`]: f,
    [`${LOCAL}\\Mozilla\\Firefox\\Profiles\\abc.default\\cache2\\a`]: f,
    [`${LOCAL}\\CrashDumps\\app.dmp`]: f,
    [`${LOCAL}\\npm-cache\\_cacache\\a`]: f,
    [`${LOCAL}\\pip\\Cache\\a`]: f,
    [`${LOCAL}\\Yarn\\Cache\\a`]: f
  })
  const findings = detect(tree)
  expect(rulesByPath(findings)).toEqual({
    [`C:\\${LOCAL}\\Google\\Chrome\\User Data\\Default\\Cache`]: 'browser-cache-chromium',
    [`C:\\${LOCAL}\\Google\\Chrome\\User Data\\Profile 1\\Code Cache`]: 'browser-cache-chromium',
    [`C:\\${LOCAL}\\Microsoft\\Edge\\User Data\\Default\\GPUCache`]: 'browser-cache-chromium',
    [`C:\\${LOCAL}\\Mozilla\\Firefox\\Profiles\\abc.default\\cache2`]: 'browser-cache-firefox',
    [`C:\\${LOCAL}\\CrashDumps`]: 'crash-dumps',
    [`C:\\${LOCAL}\\npm-cache`]: 'pkg-cache-npm',
    [`C:\\${LOCAL}\\pip\\Cache`]: 'pkg-cache-pip',
    [`C:\\${LOCAL}\\Yarn\\Cache`]: 'pkg-cache-yarn'
  })
  expect(
    findings.every((f) => f.safety === 'safe' && f.kind === 'folder' && f.sizeOnDisk === 2 * MiB)
  ).toBe(true)
})

test('an old zip in Downloads is reported once, as an installer', () => {
  const zip = `C:\\${DOWNLOADS}\\big-old.zip`
  const tree = treeFrom('C:\\', {
    [`${DOWNLOADS}\\big-old.zip`]: { size: 150 * MiB, mtimeMs: now - 214 * DAY },
    [`${DOWNLOADS}\\setup-old.exe`]: { size: 2 * MiB, mtimeMs: now - 40 * DAY },
    [`${DOWNLOADS}\\setup-new.msi`]: { size: 2 * MiB, mtimeMs: now - 1 * DAY },
    [`${DOWNLOADS}\\tools\\disk.ISO`]: { size: 2 * MiB, mtimeMs: now - 40 * DAY },
    [`${DOWNLOADS}\\notes.pdf`]: { size: 2 * MiB, mtimeMs: now - 400 * DAY }
  })
  const findings = detect(tree)
  expect(findings.filter((f) => f.path === zip).map((f) => f.ruleId)).toEqual([
    'downloads-installers'
  ])
  expect(rulesByPath(findings)).toEqual({
    [zip]: 'downloads-installers',
    [`C:\\${DOWNLOADS}\\setup-old.exe`]: 'downloads-installers',
    [`C:\\${DOWNLOADS}\\tools\\disk.ISO`]: 'downloads-installers'
  })
})

test('stale-large ignores AppData, .git, cloud-only, extra hard links, small, recent and non-personal files', () => {
  const old = now - 240 * DAY
  const tree = treeFrom('C:\\', {
    'Users\\jorda\\OneDrive\\Documents\\movie.mp4': big(old),
    'Users\\jorda\\AppData\\Local\\big.bin': big(old),
    'Users\\jorda\\Projects\\repo\\.git\\objects\\pack.pack': big(old),
    'Users\\jorda\\Videos\\cloud.mp4': big(old, { onDisk: 0 }),
    'Users\\jorda\\Videos\\a.mkv': big(old, { hardLinkKey: '1:9' }),
    'Users\\jorda\\Videos\\b.mkv': big(old, { hardLinkKey: '1:9' }),
    'Users\\jorda\\Videos\\new.mkv': big(now - 10 * DAY),
    'Users\\jorda\\Videos\\small.bin': { size: 50 * MiB, mtimeMs: old },
    'Games\\big.pak': big(old),
    'Data\\archive.bin': big(old)
  })
  const findings = detect(tree, validateSettings({ personalFolders: ['C:\\Data'] }))
  expect(
    findings
      .filter((f) => f.ruleId === 'stale-large')
      .map((f) => f.path)
      .sort()
  ).toEqual([
    'C:\\Data\\archive.bin',
    'C:\\Users\\jorda\\OneDrive\\Documents\\movie.mp4',
    'C:\\Users\\jorda\\Videos\\a.mkv'
  ])
})

test('stale-large uses calendar months', () => {
  const sixMonthsBefore = Date.UTC(2026, 4, 1)
  const tree = treeFrom('C:\\', {
    'Users\\jorda\\Videos\\older.mkv': big(sixMonthsBefore - DAY),
    'Users\\jorda\\Videos\\newer.mkv': big(sixMonthsBefore + DAY)
  })
  expect(detect(tree).map((f) => f.path)).toEqual(['C:\\Users\\jorda\\Videos\\older.mkv'])
})

test('system areas are info-only; an unreadable one is size-unknown', () => {
  const tree = treeFrom('C:\\', {
    'Windows\\Temp': { dir: true, unreadable: true },
    'Windows\\SoftwareDistribution\\Download\\u.cab': { size: 5 * MiB, mtimeMs: now },
    'Windows\\Installer\\x.msi': { size: 3 * MiB, mtimeMs: now },
    'ProgramData\\Package Cache\\y.bin': { size: 4 * MiB, mtimeMs: now },
    'Windows\\WinSxS\\z.dll': { size: 6 * MiB, mtimeMs: now },
    'hiberfil.sys': { size: 6 * 1024 * MiB, mtimeMs: now },
    'pagefile.sys': { size: 8 * 1024 * MiB, mtimeMs: now },
    'swapfile.sys': { size: 16 * MiB, mtimeMs: now }
  })
  const findings = detect(tree)
  expect(rulesByPath(findings)).toEqual({
    'C:\\Windows\\Temp': 'sys-windows-temp',
    'C:\\Windows\\SoftwareDistribution\\Download': 'sys-windows-update',
    'C:\\Windows\\Installer': 'sys-installer-cache',
    'C:\\ProgramData\\Package Cache': 'sys-installer-cache',
    'C:\\Windows\\WinSxS': 'sys-component-store',
    'C:\\hiberfil.sys': 'sys-hiberfil',
    'C:\\pagefile.sys': 'sys-pagefile',
    'C:\\swapfile.sys': 'sys-pagefile'
  })
  expect(findings.every((f) => f.safety === 'info' && f.category === 'system')).toBe(true)
  expect(findings.find((f) => f.path === 'C:\\Windows\\Temp')?.sizeUnknown).toBe(true)
  expect(findings.find((f) => f.path === 'C:\\hiberfil.sys')?.sizeOnDisk).toBe(6 * 1024 * MiB)
})

test('findings inside an exclusion are dropped', () => {
  const tree = treeFrom('C:\\', {
    [`${DOWNLOADS}\\Keep\\setup.exe`]: { size: 2 * MiB, mtimeMs: now - 40 * DAY },
    [`${DOWNLOADS}\\other.exe`]: { size: 2 * MiB, mtimeMs: now - 40 * DAY }
  })
  const findings = detect(
    tree,
    validateSettings({ exclusions: ['c:/users/JORDA/downloads/keep/'] })
  )
  expect(findings.map((f) => f.path)).toEqual([`C:\\${DOWNLOADS}\\other.exe`])
})

test('a rule match on a blocked path is dropped', () => {
  const tree = treeFrom('C:\\', { 'Windows\\big.bin': big(now - 400 * DAY) })
  expect(detect(tree, validateSettings({ personalFolders: ['C:\\Windows'] }))).toEqual([])
})

test('finding ids carry the scan id, and every finding has a unique id', () => {
  const tree = treeFrom('C:\\', {
    [`${DOWNLOADS}\\a.exe`]: { size: 2 * MiB, mtimeMs: now - 40 * DAY },
    [`${DOWNLOADS}\\b.exe`]: { size: 2 * MiB, mtimeMs: now - 40 * DAY }
  })
  const ids = detect(tree).map((f) => f.id)
  expect(ids.every((id) => id.startsWith('s1:downloads-installers:'))).toBe(true)
  expect(new Set(ids).size).toBe(2)
})

test('every rule has a non-empty title and explanation', () => {
  Object.values(RULES).forEach((r) => {
    expect(r.title).not.toBe('')
    expect(r.explanation).not.toBe('')
  })
})

test('the catalog holds every rule in the spec', () => {
  expect(Object.keys(RULES).sort()).toEqual(
    [
      'duplicates',
      'temp-user',
      'browser-cache-chromium',
      'browser-cache-firefox',
      'crash-dumps',
      'pkg-cache-npm',
      'pkg-cache-pip',
      'pkg-cache-yarn',
      'downloads-installers',
      'stale-large',
      'dev-node-modules',
      'dev-build-output',
      'dev-python-venv',
      'blender-backups',
      'unity-library',
      'unreal-caches',
      'godot-cache',
      'image-sequences',
      'sys-windows-temp',
      'sys-windows-update',
      'sys-installer-cache',
      'sys-component-store',
      'sys-hiberfil',
      'sys-pagefile'
    ].sort()
  )
})
