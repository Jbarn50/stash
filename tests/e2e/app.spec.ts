import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildFixture, type Fixture } from '../fixtures/buildFixture'

// Shared by Tasks 15-19: one app, launched once, scanning the fixture at startup.
test.describe.configure({ mode: 'serial' })

let fx: Fixture
let userData: string
let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  fx = await buildFixture()
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
  await fx?.dispose()
  if (userData) rmSync(userData, { recursive: true, force: true })
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
