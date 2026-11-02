import { describe, expect, test } from 'vitest'
import type { ViewNode } from '../../src/shared/types'
import { layoutTreemap } from '../../src/renderer/src/lib/treemapLayout'

const file = (id: number, name: string, size: number): ViewNode => ({
  kind: 'file',
  id,
  name,
  sizeOnDisk: size,
  mtimeMs: 0
})
const folder = (id: number, name: string, children: ViewNode[]): ViewNode => ({
  kind: 'folder',
  id,
  name,
  sizeOnDisk: children.reduce((s, c) => s + c.sizeOnDisk, 0),
  mtimeMs: 0,
  children
})
const area = (r: { x0: number; y0: number; x1: number; y1: number }): number =>
  (r.x1 - r.x0) * (r.y1 - r.y0)

describe('layoutTreemap', () => {
  test('rect areas follow sizes and stay inside the canvas', () => {
    const root = folder(0, 'C:\\', [file(1, 'a', 600), file(2, 'b', 300), file(3, 'c', 100)])
    const rects = layoutTreemap(root, 1000, 500)
    expect(rects).toHaveLength(3)
    for (const r of rects) {
      expect(r.x0).toBeGreaterThanOrEqual(0)
      expect(r.y0).toBeGreaterThanOrEqual(0)
      expect(r.x1).toBeLessThanOrEqual(1000)
      expect(r.y1).toBeLessThanOrEqual(500)
    }
    const total = rects.reduce((s, r) => s + area(r), 0)
    const share = (name: string): number => area(rects.find((r) => r.node.name === name)!) / total
    expect(Math.abs(share('a') - 0.6)).toBeLessThan(0.02)
    expect(Math.abs(share('b') - 0.3)).toBeLessThan(0.02)
    expect(Math.abs(share('c') - 0.1)).toBeLessThan(0.02)
  })

  test('zero-size nodes get no rect', () => {
    const root = folder(0, 'C:\\', [
      file(1, 'a', 500),
      file(2, 'empty', 0),
      { kind: 'link', id: 3, name: 'junction', sizeOnDisk: 0, mtimeMs: null }
    ])
    const names = layoutTreemap(root, 400, 300).map((r) => r.node.name)
    expect(names).toEqual(['a'])
    expect(layoutTreemap(folder(0, 'empty', []), 400, 300)).toEqual([])
  })

  test('children lie inside their parent rect', () => {
    const inner = folder(1, 'Users', [file(11, 'u1', 500), file(12, 'u2', 300)])
    const root = folder(0, 'C:\\', [inner, file(2, 'pagefile.sys', 200)])
    const rects = layoutTreemap(root, 800, 600)
    const parent = rects.find((r) => r.node.name === 'Users')!
    expect(parent.depth).toBe(1)
    const kids = rects.filter((r) => r.depth === 2)
    expect(kids.map((r) => r.node.name).sort()).toEqual(['u1', 'u2'])
    for (const k of kids) {
      expect(k.x0).toBeGreaterThanOrEqual(parent.x0)
      expect(k.y0).toBeGreaterThanOrEqual(parent.y0 + 16) // room for the folder's label
      expect(k.x1).toBeLessThanOrEqual(parent.x1)
      expect(k.y1).toBeLessThanOrEqual(parent.y1)
    }
  })
})
