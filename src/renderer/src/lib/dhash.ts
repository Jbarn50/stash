import { dHashFromRgba } from '../../../shared/dhash'

function bytesFromBase64(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

/**
 * Difference hash of one image, plus a small JPEG the preview can show.
 * Chromium decodes the file. The hash is what gets stored, not the pixels.
 * The thumbnail is a data URL, so the page does not open img-src to https or file.
 */
export async function inspectImage(
  base64: string,
  mime: string
): Promise<{ dhash: string | null; thumb: string | null }> {
  const bytes = bytesFromBase64(base64)
  if (bytes === null) return { dhash: null, thumb: null }
  try {
    const blob = new Blob(
      [bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer],
      { type: mime }
    )
    const bitmap = await createImageBitmap(blob)
    try {
      const sample = document.createElement('canvas')
      sample.width = 9
      sample.height = 8
      const sampleCtx = sample.getContext('2d', { willReadFrequently: true })
      if (sampleCtx === null) return { dhash: null, thumb: null }
      sampleCtx.drawImage(bitmap, 0, 0, 9, 8)
      const dhash = dHashFromRgba(sampleCtx.getImageData(0, 0, 9, 8).data, 9, 8)
      const thumbCanvas = document.createElement('canvas')
      thumbCanvas.width = 96
      thumbCanvas.height = 96
      const thumbCtx = thumbCanvas.getContext('2d')
      thumbCtx?.drawImage(bitmap, 0, 0, 96, 96)
      const thumb = thumbCanvas.toDataURL('image/jpeg', 0.7)
      return { dhash, thumb }
    } finally {
      bitmap.close()
    }
  } catch {
    return { dhash: null, thumb: null }
  }
}
