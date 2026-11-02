import { inflateSync } from 'node:zlib'

// Local PNG text chunks only. The bytes are not executed, and nothing here opens a network
// connection or writes a file.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const KEYWORDS = new Set(['parameters', 'prompt', 'workflow'])
const MAX_CHUNK = 8_000_000
const MAX_TEXT = 1_000_000

function u32(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  )
}

function latin1(bytes: Uint8Array): string {
  return new TextDecoder('latin1').decode(bytes)
}

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

/** Splits on the first null. `empty` allows an empty head (language tags may be empty). */
function splitNull(
  bytes: Uint8Array,
  empty: boolean
): { head: Uint8Array; tail: Uint8Array } | null {
  const at = bytes.indexOf(0)
  if (at < 0 || (!empty && (at === 0 || at > 79))) return null
  return { head: bytes.subarray(0, at), tail: bytes.subarray(at + 1) }
}

function inflateCap(bytes: Uint8Array): Uint8Array | null {
  try {
    const out = inflateSync(bytes, { maxOutputLength: MAX_TEXT })
    return out.length > MAX_TEXT ? null : out
  } catch {
    return null
  }
}

function remember(out: Map<string, string>, keyword: string, text: string): void {
  if (!KEYWORDS.has(keyword) || out.has(keyword) || text.length > MAX_TEXT) return
  out.set(keyword, text)
}

function readText(out: Map<string, string>, data: Uint8Array): void {
  const parts = splitNull(data, false)
  if (parts === null) return
  remember(out, latin1(parts.head), latin1(parts.tail))
}

function readItxt(out: Map<string, string>, data: Uint8Array): void {
  const key = splitNull(data, false)
  if (key === null || key.tail.length < 2) return
  const flag = key.tail[0]
  const method = key.tail[1]
  let rest = key.tail.subarray(2)
  const language = splitNull(rest, true)
  if (language === null) return
  rest = language.tail
  const translated = splitNull(rest, true)
  if (translated === null) return
  let textBytes: Uint8Array | null = translated.tail
  if (flag === 1) {
    if (method !== 0) return
    textBytes = inflateCap(translated.tail)
  } else if (flag !== 0) return
  if (textBytes === null) return
  remember(out, latin1(key.head), utf8(textBytes))
}

function readZtxt(out: Map<string, string>, data: Uint8Array): void {
  const key = splitNull(data, false)
  if (key === null || key.tail.length < 2 || key.tail[0] !== 0) return
  const text = inflateCap(key.tail.subarray(1))
  if (text === null) return
  remember(out, latin1(key.head), latin1(text))
}

/**
 * The `parameters`, `prompt`, and `workflow` text of a PNG, or null when `bytes` is not a PNG.
 * Other keywords are ignored. A compressed chunk that will not inflate is skipped.
 */
export function readPngText(bytes: Uint8Array): Map<string, string> | null {
  if (bytes.length < SIGNATURE.length) return null
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) return null
  }
  const out = new Map<string, string>()
  let offset = SIGNATURE.length
  while (offset + 12 <= bytes.length) {
    const length = u32(bytes, offset)
    if (length > MAX_CHUNK) break
    const type = latin1(bytes.subarray(offset + 4, offset + 8))
    const start = offset + 8
    const next = start + length + 4
    if (next > bytes.length) break
    const data = bytes.subarray(start, start + length)
    if (type === 'tEXt') readText(out, data)
    else if (type === 'iTXt') readItxt(out, data)
    else if (type === 'zTXt') readZtxt(out, data)
    if (type === 'IEND') break
    offset = next
  }
  return out
}
