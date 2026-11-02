import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import { loadSettings, saveSettings } from '../../src/main/settings'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'stash-settings-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const settingsFile = (): string => join(dir, 'settings.json')

test('settings round-trip; a missing file gives defaults', async () => {
  const appData = join(dir, 'Stash') // not created yet: saving makes it
  expect(await loadSettings(appData)).toEqual(DEFAULT_SETTINGS)
  const saved = await saveSettings(appData, { ...DEFAULT_SETTINGS, exclusions: ['d:\\keep\\'] })
  expect(saved.exclusions).toEqual(['D:\\keep'])
  expect(await loadSettings(appData)).toEqual(saved)
  expect(await readdir(appData)).toEqual(['settings.json']) // the temporary file is gone
})

test('a corrupt settings file is set aside as settings.json.bad and defaults are used', async () => {
  await writeFile(join(dir, 'settings.json.bad'), 'from an earlier time')
  await writeFile(settingsFile(), '{"version": 1, "exclusions": [')
  expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
  expect(await readFile(join(dir, 'settings.json.bad'), 'utf8')).toBe(
    '{"version": 1, "exclusions": ['
  )
  expect(await readdir(dir)).toEqual(['settings.json.bad'])
})

test('settings that name a folder by another spelling are set aside too', async () => {
  const text = JSON.stringify({ version: 1, exclusions: ['C:\\PROGRA~1'] })
  await writeFile(settingsFile(), text)
  expect(await loadSettings(dir)).toEqual(DEFAULT_SETTINGS)
  expect(await readFile(join(dir, 'settings.json.bad'), 'utf8')).toBe(text)
})

test('an unreadable settings file is reported, not replaced by defaults', async () => {
  await mkdir(settingsFile()) // a folder where the file should be: reading it fails
  await expect(loadSettings(dir)).rejects.toMatchObject({ code: 'EISDIR' })
  expect(await readdir(dir)).toEqual(['settings.json'])
})

test('saveSettings rejects invalid input and leaves the old file untouched', async () => {
  await saveSettings(dir, { exclusions: ['D:\\Keep'] })
  const before = await readFile(settingsFile(), 'utf8')
  await expect(saveSettings(dir, { exclusions: 'D:\\Keep' })).rejects.toThrow(
    'Invalid settings: exclusions'
  )
  await expect(saveSettings(dir, { thresholds: { idleDays: 0 } })).rejects.toThrow(
    'Invalid settings: thresholds.idleDays'
  )
  expect(await readFile(settingsFile(), 'utf8')).toBe(before)
  expect(await readdir(dir)).toEqual(['settings.json'])
})

test('a save that fails part-way leaves the stored settings intact', async () => {
  await saveSettings(dir, { exclusions: ['D:\\Keep'] })
  const before = await readFile(settingsFile(), 'utf8')
  await mkdir(join(dir, 'settings.json.tmp')) // the temporary file cannot be written
  await expect(saveSettings(dir, { exclusions: [] })).rejects.toMatchObject({ code: 'EISDIR' })
  expect(await readFile(settingsFile(), 'utf8')).toBe(before)
})

test('saves made at the same moment all complete, and the last one wins', async () => {
  await Promise.all(
    [1, 2, 3, 4, 5].map((idleDays) => saveSettings(dir, { thresholds: { idleDays } }))
  )
  expect((await loadSettings(dir)).thresholds.idleDays).toBe(5)
  expect(await readdir(dir)).toEqual(['settings.json'])
})
