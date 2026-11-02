import { readFile, stat } from 'node:fs/promises'
import { win32 } from 'node:path'
import { isPlainDrivePath, normalizePath } from '../core/paths'
import type { ImportImage } from '../shared/organize'

/** One picked image. Larger files are skipped rather than sent across to the window. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

function mimeFor(filePath: string): string | null {
  return MIME[win32.extname(filePath).toLowerCase()] ?? null
}

/** The bytes of one image the user picked, or null when it is missing, not an image, or too large. */
export async function readImageBytes(filePath: string): Promise<Uint8Array | null> {
  if (!isPlainDrivePath(filePath)) return null
  const path = normalizePath(filePath)
  if (mimeFor(path) === null) return null
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return null
    return new Uint8Array(await readFile(path))
  } catch {
    return null
  }
}

/** Those bytes as base64, so the renderer can decode them. The main process does not keep them. */
export async function readImportImage(filePath: string): Promise<ImportImage | null> {
  const path = isPlainDrivePath(filePath) ? normalizePath(filePath) : ''
  const mime = mimeFor(path)
  if (mime === null) return null
  const bytes = await readImageBytes(path)
  if (bytes === null) return null
  return { base64: Buffer.from(bytes).toString('base64'), mime }
}
