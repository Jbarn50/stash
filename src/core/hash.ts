import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import type { Bytes } from '../shared/types'
import type { HashGroup, SizeGroup } from './detectors/duplicates'

const EDGE = 65_536

async function readExactly(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let filled = 0
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled)
    if (bytesRead === 0) throw new Error('The file is shorter than when it was scanned')
    filled += bytesRead
  }
  return buffer
}

/** SHA-256 of the first and last 64 KiB, or of the whole file when it is no bigger than that. */
export async function partialHash(path: string, size: Bytes): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const hash = createHash('sha256')
    if (size <= 2 * EDGE) {
      hash.update(await readExactly(handle, size, 0))
    } else {
      hash.update(await readExactly(handle, EDGE, 0))
      hash.update(await readExactly(handle, EDGE, size - EDGE))
    }
    return hash.digest('hex')
  } finally {
    await handle.close()
  }
}

/** SHA-256 of the whole file. */
export async function fullHash(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

const isAbort = (e: unknown): boolean => (e as Error | undefined)?.name === 'AbortError'

/**
 * Splits same-size groups into groups of identical files. A cheap partial hash comes first; only
 * files that still match are read in full. Files that can't be read are dropped. Progress counts
 * every candidate byte once, so it ends exactly at the total.
 */
export async function hashGroups(
  groups: SizeGroup[],
  o: { signal?: AbortSignal; onProgress?: (hashedBytes: Bytes, totalBytes: Bytes) => void } = {}
): Promise<HashGroup[]> {
  const totalBytes = groups.reduce((sum, g) => sum + g.logicalSize * g.fileIds.length, 0)
  let hashedBytes = 0
  const settle = (bytes: number): void => {
    hashedBytes += bytes
    o.onProgress?.(hashedBytes, totalBytes)
  }

  const result: HashGroup[] = []
  for (const group of groups) {
    o.signal?.throwIfAborted()
    const byPartial = new Map<string, number[]>()
    for (let i = 0; i < group.fileIds.length; i++) {
      try {
        const key = await partialHash(group.paths[i], group.logicalSize)
        byPartial.set(key, [...(byPartial.get(key) ?? []), i])
      } catch {
        settle(group.logicalSize) // unreadable or gone: dropped
      }
    }

    for (const members of byPartial.values()) {
      if (members.length < 2) {
        settle(group.logicalSize * members.length)
        continue
      }
      const byFull = new Map<string, number[]>()
      for (const i of members) {
        o.signal?.throwIfAborted()
        try {
          const key = await fullHash(group.paths[i], o.signal)
          byFull.set(key, [...(byFull.get(key) ?? []), group.fileIds[i]])
        } catch (e) {
          if (isAbort(e)) throw e
        }
        settle(group.logicalSize)
      }
      for (const [hash, fileIds] of byFull) if (fileIds.length >= 2) result.push({ hash, fileIds })
    }
  }
  return result
}
