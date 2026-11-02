import { expect, test, vi } from 'vitest'
import {
  forwarder,
  parseBatchId,
  parseBoolean,
  parseDepth,
  parseFindingIds,
  parseFolderId,
  parseItemRef,
  parseScanRoot,
  startupScanRoot
} from '../../src/main/ipc'
import { CHANNELS, INVOKE_NAMES } from '../../src/shared/ipc'
import { treeFrom } from '../helpers/treeFrom'

const MiB = 1_048_576
const INVALID = 'invalid argument'

test('parseFindingIds accepts 1 to 100000 strings only', () => {
  expect(parseFindingIds(['a'])).toEqual(['a'])
  expect(parseFindingIds(Array.from({ length: 100_000 }, (_, i) => `s:r:${i}`))).toHaveLength(
    100_000
  )
  expect(() => parseFindingIds([])).toThrow(INVALID)
  expect(() => parseFindingIds(Array.from({ length: 100_001 }, (_, i) => `${i}`))).toThrow(INVALID)
  expect(() => parseFindingIds(['a', 1])).toThrow(INVALID)
  expect(() => parseFindingIds('a')).toThrow(INVALID)
  expect(() => parseFindingIds(null)).toThrow(INVALID)
  expect(() => parseFindingIds(['x'.repeat(201)])).toThrow(INVALID)
  expect(parseFindingIds(['x'.repeat(200)])).toHaveLength(1)
})

test('parseFindingIds keeps each id once, in the order first given', () => {
  expect(parseFindingIds(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c'])
})

test('parseFolderId rejects negatives, fractions and ids beyond the tree', () => {
  const tree = treeFrom('X:\\', { 'a\\b\\f.bin': { size: 2 * MiB, mtimeMs: 1 } })
  expect(tree.folders).toHaveLength(3)
  expect(parseFolderId(0, tree)).toBe(0)
  expect(parseFolderId(2, tree)).toBe(2)
  for (const bad of [-1, 1.5, 3, NaN, Infinity, '1', null, undefined, 2 ** 53]) {
    expect(() => parseFolderId(bad, tree)).toThrow(INVALID)
  }
  expect(() => parseFolderId(0, null)).toThrow(INVALID)
})

test('parseScanRoot accepts drive-rooted paths only', () => {
  expect(parseScanRoot('d:/games')).toBe('D:\\games')
  expect(parseScanRoot('C:\\')).toBe('C:\\')
  expect(parseScanRoot('C:\\Users\\jorda\\')).toBe('C:\\Users\\jorda')
  expect(() => parseScanRoot('\\\\server\\share')).toThrow(INVALID)
  for (const bad of [
    'games',
    'C:games',
    '\\Windows',
    'C:\\PROGRA~1',
    'C:\\Windows.',
    'C:\\x:stream',
    '',
    42,
    null
  ]) {
    expect(() => parseScanRoot(bad)).toThrow(INVALID)
  }
})

test('the other arguments are checked too', () => {
  expect(parseBoolean(true)).toBe(true)
  expect(() => parseBoolean('true')).toThrow(INVALID)
  expect(parseDepth(2)).toBe(2)
  expect(() => parseDepth(1.5)).toThrow(INVALID)
  expect(() => parseDepth('2')).toThrow(INVALID)
  expect(parseBatchId('b-1')).toBe('b-1')
  for (const bad of ['', 'x'.repeat(201), 7, null]) expect(() => parseBatchId(bad)).toThrow(INVALID)

  const tree = treeFrom('X:\\', { 'a\\f.bin': { size: 2 * MiB, mtimeMs: 1 } })
  expect(parseItemRef({ kind: 'file', id: 0 }, tree)).toEqual({ kind: 'file', id: 0 })
  expect(parseItemRef({ kind: 'folder', id: 1 }, tree)).toEqual({ kind: 'folder', id: 1 })
  for (const bad of [
    { kind: 'file', id: 1 },
    { kind: 'folder', id: 2 },
    { kind: 'link', id: 0 },
    { kind: 'file', id: -1 },
    { kind: 'file', id: 0.5 },
    { kind: 'file' },
    null,
    'file'
  ]) {
    expect(() => parseItemRef(bad, tree)).toThrow(INVALID)
  }
  expect(() => parseItemRef({ kind: 'folder', id: 0 }, null)).toThrow(INVALID)
})

test('startupScanRoot takes a valid --scan= root and ignores anything else', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(startupScanRoot(['stash.exe', '--scan=d:/games'])).toBe('D:\\games')
  expect(startupScanRoot(['stash.exe'])).toBeNull()
  expect(startupScanRoot(['stash.exe', '--scan=\\\\server\\share'])).toBeNull()
  expect(error).toHaveBeenCalledTimes(1)
  error.mockRestore()
})

test('channels: stash:<name> for each invoke method, and the two event channels', () => {
  for (const name of INVOKE_NAMES) expect(CHANNELS[name]).toBe(`stash:${name}`)
  expect(INVOKE_NAMES).toHaveLength(22)
  expect(CHANNELS.onSessionEvent).toBe('stash:session-event')
  expect(CHANNELS.onCleanProgress).toBe('stash:clean-progress')
  expect(new Set(Object.values(CHANNELS)).size).toBe(24)
})

test('the forwarder sends to a live window and never throws', () => {
  const send = vi.fn()
  const live = { isDestroyed: () => false, webContents: { send } }
  forwarder(() => live, 'stash:x')(1, 2)
  expect(send).toHaveBeenCalledWith('stash:x', 1, 2)

  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(() => forwarder(() => null, 'stash:x')(1)).not.toThrow()
  const gone = { isDestroyed: () => true, webContents: { send: vi.fn() } }
  forwarder(() => gone, 'stash:x')(1)
  expect(gone.webContents.send).not.toHaveBeenCalled()
  const failing = {
    isDestroyed: () => false,
    webContents: {
      send: () => {
        throw new Error('Render frame was disposed')
      }
    }
  }
  expect(() => forwarder(() => failing, 'stash:x')(1)).not.toThrow()
  expect(() =>
    forwarder(() => {
      throw new Error('boom')
    }, 'stash:x')()
  ).not.toThrow()
  expect(error).toHaveBeenCalledTimes(2)
  error.mockRestore()
})
