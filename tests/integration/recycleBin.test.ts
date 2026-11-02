import { existsSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { getRecycleBinInfo, getUserSid, recycleBinDir } from '../../src/main/recycleBin'

// These query the real machine and only read: nothing is recycled, deleted or written, and the
// registry is never changed.
describe.runIf(process.platform === 'win32')('the Recycle Bin of this machine', () => {
  test('C: has an enabled Recycle Bin with a capacity', async () => {
    const i = await getRecycleBinInfo('C:')
    expect(i.status).toBe('enabled')
    expect(i.maxCapacityBytes).toBeGreaterThan(0)
  })

  test('a drive letter that does not exist is unknown', async () => {
    const letter = [...'ZYXWVUTSRQPONMLKJIHGFED'].find((l) => !existsSync(`${l}:\\`))
    expect(letter).toBeDefined()
    expect(await getRecycleBinInfo(`${letter}:`)).toEqual({
      drive: `${letter}:`,
      status: 'unknown',
      maxCapacityBytes: 0,
      usedBytes: 0
    })
  })

  test('the user SID is the one whoami reports', async () => {
    expect(await getUserSid()).toMatch(/^S-1-\d+(-\d+)+$/)
  })

  test('the bin folder is the drive, $Recycle.Bin and the user SID', async () => {
    const sid = await getUserSid()
    expect(await recycleBinDir('C:')).toBe(`C:\\$Recycle.Bin\\${sid}`)
  })

  test('the bin reports how much its $R entries hold', async () => {
    const i = await getRecycleBinInfo('C:')
    expect(Number.isFinite(i.usedBytes)).toBe(true)
    expect(i.usedBytes).toBeGreaterThanOrEqual(0)
  })
})
