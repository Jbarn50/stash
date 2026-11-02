import { expect, test } from 'vitest'
import { driveRoots, getDriveUsage } from '../../src/main/overview'

test('driveRoots lists each drive of the paths once, as a root', () => {
  expect(driveRoots(['C:\\', 'c:\\Users', 'D:\\games', '\\\\server\\share'])).toEqual([
    'C:\\',
    'D:\\'
  ])
})

test('getDriveUsage uses blocks * bsize and bavail * bsize, leaving out drives that fail', async () => {
  const usage = await getDriveUsage(['C:\\', 'Q:\\'], async (root) => {
    if (root === 'Q:\\') throw new Error('ENOENT')
    return { blocks: 100, bsize: 4096, bavail: 25 }
  })
  expect(usage).toEqual([{ root: 'C:\\', totalBytes: 409_600, freeBytes: 102_400 }])
})

test('getDriveUsage reads a real drive', async () => {
  const [c] = await getDriveUsage(['C:\\'])
  expect(c.totalBytes).toBeGreaterThan(c.freeBytes)
  expect(c.freeBytes).toBeGreaterThan(0)
})
