import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StashApi } from '../../src/shared/ipc'

// Only reads: nothing is scanned, cleaned or restored here.
test('window.stash is the whole API and answers before any scan', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'stash-ud-'))
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, STASH_USER_DATA: userData }
  })
  const win = await app.firstWindow()
  const result = await win.evaluate(async () => {
    const stash = Reflect.get(window, 'stash') as StashApi
    const startError = await stash.startScan('\\\\server\\share').then(
      () => 'resolved',
      (e: Error) => e.message
    )
    return {
      keys: Object.keys(stash).sort(),
      overview: await stash.getOverview(),
      settings: await stash.getSettings(),
      findings: await stash.getFindings(),
      view: await stash.getFolderView(0, 1),
      clean: await stash.clean(['nothing:here:0'], false),
      history: await stash.getHistory(),
      startError,
      unsubscribe: typeof stash.onSessionEvent(() => undefined)
    }
  })
  expect(result.keys).toEqual(
    [
      'cancelScan',
      'clean',
      'excludeFolder',
      'getFindings',
      'getFolderView',
      'getHistory',
      'getOverview',
      'getSettings',
      'onCleanProgress',
      'onSessionEvent',
      'openDiskCleanup',
      'openRecycleBin',
      'openStorageSettings',
      'pickFolder',
      'rescanAsAdmin',
      'restoreBatch',
      'saveSettings',
      'showItem',
      'startScan'
    ].sort()
  )
  expect(result.overview).toMatchObject({ lastScan: null, state: 'idle' })
  expect(result.overview.drives.length).toBeGreaterThan(0)
  expect(result.settings.scanTargets).toEqual(['C:\\'])
  expect(result.findings).toEqual([])
  expect(result.view).toBeNull()
  expect(result.clean).toEqual({ status: 'rejected', reason: 'stale-scan' })
  expect(result.history).toEqual([])
  expect(result.startError).toContain('invalid argument')
  expect(result.unsubscribe).toBe('function')
  await app.close()
})
