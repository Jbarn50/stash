// Milliseconds from 1601-01-01 (the FILETIME epoch) to 1970-01-01 (the Unix epoch).
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n

/**
 * Writes a Recycle Bin `$I` record the way Windows 10/11 does (version 2): int64 version (2), int64
 * original size, int64 deletion FILETIME (100 ns ticks since 1601), int32 path length in UTF-16 units
 * including the closing NUL, then the path in UTF-16LE with that NUL.
 */
export function makeIRecord(r: {
  originalSize: bigint
  deletedAtMs: number
  path: string
}): Buffer {
  const path = Buffer.from(`${r.path}\0`, 'utf16le')
  const record = Buffer.alloc(28 + path.length)
  record.writeBigInt64LE(2n, 0)
  record.writeBigInt64LE(r.originalSize, 8)
  record.writeBigUInt64LE((BigInt(r.deletedAtMs) + FILETIME_EPOCH_OFFSET_MS) * 10_000n, 16)
  record.writeInt32LE(path.length / 2, 24)
  path.copy(record, 28)
  return record
}
