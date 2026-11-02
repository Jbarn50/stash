// Difference-hash helpers shared by the renderer (which decodes the image) and the
// main process (which only stores the hash). A hash is 64 bits, written as 16 hex
// characters. It is not a name and it is not pixels.

export const LOOK_DISTANCE = 10
const HEX = /^[0-9a-f]{16}$/

export function isDHash(value: string): boolean {
  return HEX.test(value)
}

/** Bits that differ, or null when either string is not a dHash. */
export function hammingDistance(a: string, b: string): number | null {
  if (!isDHash(a) || !isDHash(b)) return null
  let bits = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let count = 0
  while (bits > 0n) {
    count += Number(bits & 1n)
    bits >>= 1n
  }
  return count
}

function luma(rgba: ArrayLike<number>, index: number): number {
  const r = rgba[index] ?? 0
  const g = rgba[index + 1] ?? 0
  const b = rgba[index + 2] ?? 0
  return r * 299 + g * 587 + b * 114
}

/**
 * dHash of an image already scaled to 9×8 pixels, RGBA. Each bit says whether the
 * left sample is brighter than the one beside it. Null when the buffer is the wrong size.
 */
export function dHashFromRgba(rgba: ArrayLike<number>, width = 9, height = 8): string | null {
  if (width !== 9 || height !== 8 || rgba.length < width * height * 4) return null
  let bits = 0n
  let n = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width - 1; x++) {
      const left = luma(rgba, (y * width + x) * 4)
      const right = luma(rgba, (y * width + x + 1) * 4)
      if (left > right) bits |= 1n << BigInt(n)
      n++
    }
  }
  return bits.toString(16).padStart(16, '0')
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

function closest(hashList: readonly string[], other: readonly string[]): number {
  let best = Number.POSITIVE_INFINITY
  for (const left of hashList) {
    for (const right of other) {
      const distance = hammingDistance(left, right)
      if (distance !== null && distance < best) best = distance
    }
  }
  return best
}

/**
 * Subjects that have hashes are ordered so nearby looks sit together.
 * Subjects with no hash, and a list where nobody has a hash, stay alphabetical.
 */
export function orderByLikeness<T extends { id: string; name: string }>(
  subjects: readonly T[],
  hashes: Readonly<Record<string, readonly string[]>>
): T[] {
  const usable = (subject: T): readonly string[] =>
    (hashes[subject.id] ?? []).filter((hash) => isDHash(hash))
  const hashed = subjects.filter((subject) => usable(subject).length > 0)
  if (hashed.length === 0) return [...subjects].sort(byName)

  const remaining = [...hashed].sort(byName)
  const ordered: T[] = []
  const first = remaining.shift()
  if (first) ordered.push(first)
  while (remaining.length > 0) {
    const previous = ordered[ordered.length - 1]
    let bestAt = 0
    let bestDistance = Number.POSITIVE_INFINITY
    remaining.forEach((subject, index) => {
      const distance = closest(usable(previous), usable(subject))
      const closer = distance < bestDistance
      const tie = distance === bestDistance && byName(subject, remaining[bestAt]) < 0
      if (closer || tie) {
        bestDistance = distance
        bestAt = index
      }
    })
    const next = remaining.splice(bestAt, 1)[0]
    if (next) ordered.push(next)
  }
  const rest = subjects.filter((subject) => usable(subject).length === 0).sort(byName)
  return [...ordered, ...rest]
}
