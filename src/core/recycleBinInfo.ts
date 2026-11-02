/** What Windows 10/11 (record version 2) keeps in a `$I` file beside each item in the Recycle Bin. */
export interface IRecord {
  version: 2
  originalSize: bigint
  deletedAtMs: number
  originalPath: string
}

// int64 version, int64 size, int64 FILETIME and int32 path length: the path starts after them.
const HEADER_BYTES = 28
// Milliseconds from 1601-01-01, where FILETIME counts from, to 1970-01-01.
const FILETIME_EPOCH_OFFSET_MS = 11_644_473_600_000n

/**
 * Reads a `$I` record: int64 version (2) | int64 original size | int64 deletion FILETIME (100 ns
 * ticks since 1601) | int32 path length in UTF-16 units including the closing NUL | the path in
 * UTF-16LE. The path ends at its first NUL, and bytes after the stored length are ignored.
 * Anything else throws `Unsupported $I record`: another version (Windows 8 and earlier wrote 1), a
 * buffer cut short, or a path length that is not positive or reaches past the end.
 */
export function parseIRecord(buf: Buffer): IRecord {
  if (buf.length < HEADER_BYTES || buf.readBigInt64LE(0) !== 2n) {
    throw new Error('Unsupported $I record')
  }
  const length = buf.readInt32LE(24)
  if (length <= 0 || HEADER_BYTES + 2 * length > buf.length) {
    throw new Error('Unsupported $I record')
  }
  const stored = buf.toString('utf16le', HEADER_BYTES, HEADER_BYTES + 2 * length)
  const end = stored.indexOf('\0')
  return {
    version: 2,
    // Read as unsigned, so that a damaged record cannot give a negative size that shrinks a total.
    originalSize: buf.readBigUInt64LE(8),
    deletedAtMs: Number(buf.readBigUInt64LE(16) / 10_000n - FILETIME_EPOCH_OFFSET_MS),
    originalPath: end === -1 ? stored : stored.slice(0, end)
  }
}
