import { expect, test } from 'vitest'
import { buildFolderView } from '../../src/core/view'
import type { ViewNode } from '../../src/shared/types'
import { treeFrom, type TreeEntry } from '../helpers/treeFrom'

const MiB = 1_048_576

function depthOf(node: ViewNode): number {
  if (!node.children || node.children.length === 0) return 0
  return 1 + Math.max(...node.children.map(depthOf))
}

test('buildFolderView caps children at 100 and merges the rest into one "other" node', () => {
  const entries: Record<string, TreeEntry> = {}
  // 150 tracked files of 2..151 MiB, so the smallest 51 are merged.
  for (let i = 0; i < 150; i++) entries[`big\\f${i}.bin`] = { size: (i + 2) * MiB, mtimeMs: i }
  const tree = treeFrom('X:\\', entries)
  const view = buildFolderView(tree, tree.findFolder('X:\\big')!, 1)

  const children = view.children!
  expect(children).toHaveLength(100)
  expect(children.slice(0, 99).every((c) => c.kind === 'file')).toBe(true)
  expect(children[0]).toMatchObject({ name: 'f149.bin', sizeOnDisk: 151 * MiB })
  const other = children[99]
  expect(other).toMatchObject({ kind: 'other', id: null, name: '(51 smaller items)' })
  // The 51 smallest are 2..52 MiB.
  expect(other.sizeOnDisk).toBe(((2 + 52) * 51 * MiB) / 2)
  // Nothing is lost: the children add up to the folder.
  expect(children.reduce((s, c) => s + c.sizeOnDisk, 0)).toBe(view.sizeOnDisk)
})

test('buildFolderView keeps every child when there are no more than the cap', () => {
  const entries: Record<string, TreeEntry> = {}
  for (let i = 0; i < 5; i++) entries[`d\\f${i}.bin`] = { size: (i + 2) * MiB, mtimeMs: i }
  const tree = treeFrom('X:\\', entries)
  const view = buildFolderView(tree, tree.findFolder('X:\\d')!, 1, 5)
  expect(view.children!.map((c) => c.kind)).toEqual(['file', 'file', 'file', 'file', 'file'])
})

test('buildFolderView shows small files as one block and clamps depth to 3', () => {
  const tree = treeFrom('X:\\', {
    'a\\b\\c\\d\\e\\deep.bin': { size: 2 * MiB, mtimeMs: 50 },
    'a\\tiny1.txt': { size: 100, onDisk: 4096, mtimeMs: 10 },
    'a\\tiny2.txt': { size: 200, onDisk: 4096, mtimeMs: 20 },
    'a\\big.iso': { size: 30 * MiB, mtimeMs: 5 },
    'a\\shortcut': { link: true },
    'a\\Locked': { dir: true, unreadable: true }
  })
  const a = tree.findFolder('X:\\a')!

  const view = buildFolderView(tree, a, 1)
  expect(view).toMatchObject({ kind: 'folder', id: a, name: 'a', mtimeMs: 50 })
  const byKind = Object.fromEntries(view.children!.map((c) => [c.kind + ':' + c.name, c]))
  expect(byKind['small:(2 small files)']).toEqual({
    kind: 'small',
    id: null,
    name: '(2 small files)',
    sizeOnDisk: 8192,
    mtimeMs: null
  })
  expect(byKind['link:shortcut']).toEqual({
    kind: 'link',
    id: null,
    name: 'shortcut',
    sizeOnDisk: 0,
    mtimeMs: null
  })
  expect(byKind['folder:Locked']).toMatchObject({ unreadable: true })
  // Largest first; equal sizes keep folders, files, small files, links in that order.
  expect(view.children!.map((c) => c.name)).toEqual([
    'big.iso',
    'b',
    '(2 small files)',
    'Locked',
    'shortcut'
  ])
  // depth 1: the children carry no children of their own.
  expect(byKind['folder:b'].children).toBeUndefined()

  expect(depthOf(buildFolderView(tree, a, 2))).toBe(2)
  expect(depthOf(buildFolderView(tree, a, 3))).toBe(3)
  expect(depthOf(buildFolderView(tree, a, 10))).toBe(3)
  expect(depthOf(buildFolderView(tree, a, 0))).toBe(1)
  expect(depthOf(buildFolderView(tree, a, -4))).toBe(1)
})

test('buildFolderView says "1 small file" for a single small file and counts extra hard links as 0', () => {
  const tree = treeFrom('X:\\', {
    'a\\one.txt': { size: 10, mtimeMs: 1 },
    'a\\first.bin': { size: 4 * MiB, mtimeMs: 1, hardLinkKey: '1:1' },
    'a\\second.bin': { size: 4 * MiB, mtimeMs: 1, hardLinkKey: '1:1' }
  })
  const view = buildFolderView(tree, tree.findFolder('X:\\a')!, 1)
  expect(view.children!.map((c) => [c.name, c.sizeOnDisk])).toEqual([
    ['first.bin', 4 * MiB],
    ['(1 small file)', 10],
    ['second.bin', 0]
  ])
})
