import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { driveOf, isSameOrInside, pathKey } from '../../src/core/paths'
import { parseIRecord } from '../../src/core/recycleBinInfo'
import { findRecycledRecords, recycleBinDir } from '../../src/main/recycleBin'
import { buildFixture, type Fixture } from '../fixtures/buildFixture'

// Shared by Tasks 15-19: one app, launched once, scanning the fixture at startup.
test.describe.configure({ mode: 'serial' })

// The round trip at the end really sends a fixture file to this machine's Recycle Bin and restores
// it through History. So the fixture lives in the git-ignored, test-owned `<repo>/.test-recycle`,
// never in %TEMP% (an MSIX-packaged shell may redirect writes there, and the `$I` record would then
// name another path). afterAll puts back whatever a failed run left in the bin, using only the
// records of the fixture's own items, and checks that no record points into the fixture.
const REPO = realpathSync.native(resolve(__dirname, '..', '..'))
const OWNED = join(REPO, '.test-recycle')
// A minute of slack before the run started, as the record lookup allows for clock rounding.
const SLACK_MS = 60_000

let fx: Fixture
let userData: string
let app: ElectronApplication
let page: Page
let startedAt = 0

/** The fixture items the round trip may send to the bin: afterAll looks for exactly these. */
const atRisk = (): string[] => [fx.p.blend1, join(fx.p.webapp, 'node_modules')]

const exists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false
  )

/** Puts back any at-risk item that is missing and still in the bin. Returns what it could not. */
async function putBackStranded(): Promise<string[]> {
  const missing: string[] = []
  for (const path of atRisk()) if (!(await exists(path))) missing.push(path)
  if (missing.length === 0) return []
  const drive = driveOf(fx.root)
  const bin = await recycleBinDir(drive)
  const records = await findRecycledRecords(drive, missing, startedAt - SLACK_MS)
  const stranded: string[] = []
  for (const path of missing) {
    const record = records.get(pathKey(path))
    if (record === undefined) {
      stranded.push(`${path}: missing, and no record of it in the bin`)
      continue
    }
    try {
      await mkdir(dirname(path), { recursive: true })
      await rename(join(bin, record.rName), path)
      await unlink(join(bin, record.iName))
    } catch (e) {
      stranded.push(`${path}: ${String(e)}`)
    }
  }
  return stranded
}

/** The original paths of the `$I` records in the user's bin that point inside `folder`. */
async function recordsInside(folder: string): Promise<string[]> {
  const bin = await recycleBinDir(driveOf(folder))
  let names: string[]
  try {
    names = await readdir(bin)
  } catch (e) {
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
      // Not a record this test can read, so not one Windows wrote for it.
    }
  }
  return inside
}

/** Unticks everything in every category, then ticks only the finding at `path`. */
async function selectOnly(category: string, path: string): Promise<void> {
  await page.getByRole('tab', { name: 'Cleanup' }).click()
  for (const none of await page
    .locator('section.category-card')
    .getByRole('button', { name: 'Select none' })
    .all()) {
    if (await none.isEnabled()) await none.click()
  }
  const card = page.getByRole('region', { name: category })
  const show = card.getByRole('button', { name: `Show ${category}` })
  if (await show.isVisible()) await show.click()
  await card.getByRole('checkbox', { name: `Select ${path}`, exact: true }).check()
  // Nothing else may go to the bin: exactly one item is selected.
  await expect(page.locator('.footer')).toContainText(/^1 selected/)
}

async function cleanSelected(): Promise<void> {
  await page.getByRole('button', { name: 'Clean selected' }).click()
  await page.getByRole('dialog', { name: 'Clean' }).getByRole('button', { name: 'Clean' }).click()
}

test.beforeAll(async () => {
  startedAt = Date.now()
  mkdirSync(OWNED, { recursive: true })
  fx = await buildFixture({ under: OWNED })
  userData = mkdtempSync(join(tmpdir(), 'stash-ud-'))
  writeFileSync(join(userData, 'settings.json'), JSON.stringify(fx.settings))
  app = await electron.launch({
    args: ['.', `--scan=${fx.root}`],
    env: { ...process.env, STASH_USER_DATA: userData }
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  if (userData) rmSync(userData, { recursive: true, force: true })
  if (!fx) return
  // Never delete anything but the fixture this run made inside the test-owned folder.
  if (!isSameOrInside(fx.root, OWNED) || !basename(fx.root).startsWith('stash-fx-')) {
    throw new Error(`${fx.root} is not a fixture of this test`)
  }
  const stranded = await putBackStranded()
  const left = await recordsInside(fx.root)
  // The fixture goes only when nothing of it is left in the bin.
  if (stranded.length === 0 && left.length === 0) {
    await fx.dispose()
    await rmdir(OWNED).catch(() => undefined) // only if it is empty
  }
  expect(stranded, 'items the safety net could not put back').toEqual([])
  expect(left, 'records in the bin that point into the fixture').toEqual([])
})

test('the startup scan of the fixture ends on Overview with a reclaimable line', async () => {
  await expect(page.getByText(/You could free about/)).toBeVisible({ timeout: 60_000 })
})

test('Explore lists the fixture folders and drills into Users', async () => {
  await page.getByRole('tab', { name: 'Explore' }).click()
  const row = page
    .locator('table.list tbody tr')
    .filter({ has: page.locator('.name', { hasText: /^Users$/ }) })
  await row.click()
  await expect(page.locator('.breadcrumb button').last()).toHaveText('Users')
})

test('Cleanup lists the fixture .blend1 under Dev & creative leftovers, unselected', async () => {
  await page.getByRole('tab', { name: 'Cleanup' }).click()
  const card = page.getByRole('region', { name: 'Dev & creative leftovers' })
  await card.getByRole('button', { name: 'Show Dev & creative leftovers' }).click()
  const box = card.getByRole('checkbox', { name: /scene\.blend1$/ })
  await expect(box).toBeVisible()
  await expect(box).not.toBeChecked()
})

test('History starts empty; a changed threshold survives a Save and reload', async () => {
  await page.getByRole('tab', { name: 'History' }).click()
  await expect(page.getByText('No cleanups yet')).toBeVisible()

  await page.getByRole('tab', { name: 'Settings' }).click()
  const months = page.getByRole('spinbutton', { name: 'Stale after' })
  await months.fill('7')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Saved.')).toBeVisible()

  await page.reload()
  await page.getByRole('tab', { name: 'Settings' }).click()
  await expect(page.getByRole('spinbutton', { name: 'Stale after' })).toHaveValue('7')
})

test('recycle the fixture .blend1, then restore it from History', async () => {
  const original = readFileSync(fx.p.blend1)
  await selectOnly('Dev & creative leftovers', fx.p.blend1)
  await cleanSelected()
  await expect(page.getByText(/Recycled 1 item/)).toBeVisible({ timeout: 30_000 })
  expect(existsSync(fx.p.blend1)).toBe(false)

  await page.getByRole('tab', { name: 'History' }).click()
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText('restored', { exact: true })).toBeVisible({ timeout: 30_000 })
  expect(readFileSync(fx.p.blend1)).toEqual(original)
})

test('a folder changed after the scan is skipped as "changed since scan"', async () => {
  const nodeModules = join(fx.p.webapp, 'node_modules')
  await selectOnly('Dev & creative leftovers', nodeModules)
  writeFileSync(join(nodeModules, 'new.txt'), 'x') // changes the folder's own mtime
  await cleanSelected()
  await expect(page.getByText(/changed since scan/)).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Recycled 0 items/)).toBeVisible()
  expect(existsSync(nodeModules)).toBe(true)
})
