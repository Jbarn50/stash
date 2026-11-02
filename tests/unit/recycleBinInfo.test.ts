import { describe, expect, test } from 'vitest'
import { parseIRecord } from '../../src/core/recycleBinInfo'
import { makeIRecord } from '../helpers/iRecord'

const UNSUPPORTED = new Error('Unsupported $I record')
const DELETED_AT = Date.UTC(2026, 10, 1)

function record(path = 'C:\\Users\\jorda\\Downloads\\old.zip'): Buffer {
  return makeIRecord({ originalSize: 4096n, deletedAtMs: DELETED_AT, path })
}

test('parses a version 2 record with a non-ASCII path', () => {
  const path = 'C:\\Users\\jorda\\Música\\naïve 📁 写真.txt'
  expect(
    parseIRecord(makeIRecord({ originalSize: 1234n, deletedAtMs: Date.UTC(2026, 10, 1), path }))
  ).toEqual({
    version: 2,
    originalSize: 1234n,
    deletedAtMs: Date.UTC(2026, 10, 1),
    originalPath: path
  })
})

test('the deletion time is read from the FILETIME, whose epoch is 1601', () => {
  // 116444736000000000 ticks of 100 ns is exactly 1970-01-01T00:00:00Z.
  const buf = record()
  buf.writeBigUInt64LE(116_444_736_000_000_000n, 16)
  expect(parseIRecord(buf).deletedAtMs).toBe(0)
  // One more millisecond is 10,000 more ticks; ticks below a millisecond are dropped.
  buf.writeBigUInt64LE(116_444_736_000_000_000n + 10_000n * 1_500n + 9_999n, 16)
  expect(parseIRecord(buf).deletedAtMs).toBe(1500)
})

test('the original size is read as an unsigned 64-bit number', () => {
  const buf = record()
  buf.writeBigUInt64LE(5_000_000_000_000n, 8)
  expect(parseIRecord(buf).originalSize).toBe(5_000_000_000_000n)
  // A damaged record must never read as a negative size: a negative one would shrink a total.
  buf.writeBigUInt64LE(2n ** 64n - 1n, 8)
  expect(parseIRecord(buf).originalSize).toBe(2n ** 64n - 1n)
})

test('the path ends at the first NUL, even when the stored length reaches past it', () => {
  const buf = makeIRecord({
    originalSize: 1n,
    deletedAtMs: DELETED_AT,
    path: 'C:\\a.txt\0left over from an earlier name'
  })
  expect(parseIRecord(buf).originalPath).toBe('C:\\a.txt')
})

test('bytes after the stored path are ignored', () => {
  const buf = Buffer.concat([record('C:\\a.txt'), Buffer.from('trailing bytes')])
  expect(parseIRecord(buf).originalPath).toBe('C:\\a.txt')
})

test('rejects version 1 and truncated records', () => {
  const v1 = record()
  v1.writeBigInt64LE(1n, 0)
  expect(() => parseIRecord(v1)).toThrow(UNSUPPORTED)
  expect(() => parseIRecord(record().subarray(0, 20))).toThrow(UNSUPPORTED)
  expect(() => parseIRecord(record().subarray(0, record().length - 2))).toThrow(UNSUPPORTED)
})

describe('records it does not understand', () => {
  test('rejects any other version', () => {
    for (const version of [0n, 3n, -2n, 2n ** 40n + 2n]) {
      const buf = record()
      buf.writeBigInt64LE(version, 0)
      expect(() => parseIRecord(buf)).toThrow(UNSUPPORTED)
    }
  })

  test('rejects a buffer shorter than the 28-byte header', () => {
    expect(() => parseIRecord(Buffer.alloc(0))).toThrow(UNSUPPORTED)
    expect(() => parseIRecord(record().subarray(0, 27))).toThrow(UNSUPPORTED)
  })

  test('rejects a path length of zero or less', () => {
    for (const length of [0, -1, -2_000_000_000]) {
      const buf = record()
      buf.writeInt32LE(length, 24)
      expect(() => parseIRecord(buf)).toThrow(UNSUPPORTED)
    }
  })

  test('rejects a path that runs past the end of the buffer', () => {
    const whole = record('C:\\Users\\jorda\\Downloads\\old.zip')
    // One UTF-16 unit short, header only, and a length far larger than the file.
    expect(() => parseIRecord(whole.subarray(0, whole.length - 2))).toThrow(UNSUPPORTED)
    expect(() => parseIRecord(whole.subarray(0, 28))).toThrow(UNSUPPORTED)
    const huge = Buffer.from(whole)
    huge.writeInt32LE(0x7fffffff, 24)
    expect(() => parseIRecord(huge)).toThrow(UNSUPPORTED)
  })

  test('accepts a path that ends exactly at the end of the buffer', () => {
    const whole = record('C:\\a.txt')
    expect(parseIRecord(whole.subarray(0, whole.length)).originalPath).toBe('C:\\a.txt')
  })
})
