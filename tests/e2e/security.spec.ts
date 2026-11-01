import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('window is hardened, titled Stash, and honours STASH_USER_DATA', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'stash-ud-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, STASH_USER_DATA: userData } })
  const win = await app.firstWindow()
  expect(await win.title()).toBe('Stash')
  expect(await win.evaluate(() => typeof (window as any).require)).toBe('undefined')
  expect(await win.evaluate(() => typeof (window as any).process)).toBe('undefined')
  // Electron 45 has no getLastWebPreferences(); the process metrics report the renderer's real OS sandbox state.
  const rendererSandboxed = await app.evaluate(({ app, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
    return app.getAppMetrics().find((m) => m.pid === pid)?.sandboxed
  })
  expect(rendererSandboxed).toBe(true)
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData)
  await app.close()
})
