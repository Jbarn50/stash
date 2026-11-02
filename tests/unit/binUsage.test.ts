import { expect, test, vi } from 'vitest'
import { BinUsageCache } from '../../src/main/binUsage'
import type { RecycleBinInfo } from '../../src/main/recycleBin'

const info = (drive: string, usedBytes: number): RecycleBinInfo => ({
  drive,
  status: 'enabled',
  maxCapacityBytes: 1000,
  usedBytes
})

test('is 0 until the first refresh, then the sum over the drives, each once', async () => {
  const binInfo = vi.fn(async (d: string) => info(d, d === 'C:' ? 10 : 5))
  const cache = new BinUsageCache(() => ['C:', 'D:', 'c:'], binInfo)
  expect(cache.usedBytes).toBe(0)
  await cache.refresh()
  expect(cache.usedBytes).toBe(15)
  expect(binInfo.mock.calls.map((c) => c[0])).toEqual(['C:', 'D:'])
})

test('a refresh asked for while one runs is run once more after it, and never rejects', async () => {
  const resolvers: (() => void)[] = []
  let used = 1
  const binInfo = vi.fn(
    (d: string) =>
      new Promise<RecycleBinInfo>((resolve) => {
        const value = used
        resolvers.push(() => resolve(info(d, value)))
      })
  )
  const cache = new BinUsageCache(() => ['C:'], binInfo)
  const first = cache.refresh()
  used = 2
  const second = cache.refresh()
  const third = cache.refresh()
  expect(second).toBe(third)
  resolvers.shift()!()
  await first
  expect(cache.usedBytes).toBe(1)
  await vi.waitFor(() => expect(resolvers).toHaveLength(1))
  resolvers.shift()!()
  await second
  expect(cache.usedBytes).toBe(2)
  expect(binInfo).toHaveBeenCalledTimes(2)

  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  binInfo.mockRejectedValueOnce(new Error('boom'))
  await expect(cache.refresh()).resolves.toBeUndefined()
  expect(cache.usedBytes).toBe(0)
  error.mockRestore()
})
