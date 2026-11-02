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
