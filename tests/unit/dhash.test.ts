import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { dHashFromRgba, hammingDistance, orderByLikeness } from '../../src/shared/dhash'

function rgba(paint: (bytes: Uint8Array) => void): Uint8Array {
  const bytes = new Uint8Array(9 * 8 * 4)
  paint(bytes)
  return bytes
}

test('dHash compares each sample with the one beside it', () => {
  const blank = dHashFromRgba(rgba(() => undefined))
  expect(blank).toBe('0000000000000000')
  const oneBit = dHashFromRgba(
    rgba((bytes) => {
      bytes[0] = 255
      bytes[1] = 255
      bytes[2] = 255
    })
  )
  expect(oneBit).toBe('0000000000000001')
  expect(hammingDistance(blank ?? '', oneBit ?? '')).toBe(1)
  expect(hammingDistance('ffffffffffffffff', '0000000000000000')).toBe(64)
  expect(hammingDistance('abc', 'abc')).toBeNull()
})

test('subjects with hashes sit with a nearby look, and the rest stay alphabetical', () => {
  const subjects = [
    { id: 'c', name: 'Cedric' },
    { id: 'a', name: 'Mara' },
    { id: 'b', name: 'Pines' },
    { id: 'd', name: 'Aardvark' }
  ]
  expect(orderByLikeness(subjects, {}).map((subject) => subject.name)).toEqual([
    'Aardvark',
    'Cedric',
    'Mara',
    'Pines'
  ])
  const ordered = orderByLikeness(subjects, {
    a: ['0000000000000000'],
    c: ['0000000000000000'],
    b: ['ffffffffffffffff']
  })
  expect(ordered.map((subject) => subject.id)).toEqual(['c', 'a', 'b', 'd'])
})

test('the image CSP stays closed to the network and to file urls', () => {
  const html = readFileSync(join(process.cwd(), 'src/renderer/index.html'), 'utf8')
  const csp = /content="([^"]+)"/.exec(html)?.[1] ?? ''
  const img = /img-src ([^;]+)/.exec(csp)?.[1] ?? ''
  expect(img).toContain('data:')
  expect(img).not.toContain('https:')
  expect(img).not.toContain('file:')
})
