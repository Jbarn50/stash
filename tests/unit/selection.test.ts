import { describe, expect, test } from 'vitest'
import type { Finding } from '../../src/shared/types'
import {
  initialSelection,
  selectCategory,
  selectedTotal,
  setKeeper,
  toggle
} from '../../src/renderer/src/lib/selection'

let n = 0
const f = (o: Partial<Finding>): Finding => ({
  id: `f${++n}`,
  scanId: 's1',
  ruleId: 'r',
  category: 'tempCaches',
  safety: 'safe',
  title: 't',
  explanation: 'e',
  path: `C:\\x\\${n}`,
  kind: 'file',
  sizeOnDisk: 100,
  logicalSize: 100,
  mtimeMs: 0,
  ...o
})

const groupId = 'g1'
const keeper = f({ category: 'duplicates', groupId, suggestedKeep: true, sizeOnDisk: 10 })
const other = f({ category: 'duplicates', groupId, sizeOnDisk: 10 })
const third = f({ category: 'duplicates', groupId, sizeOnDisk: 10 })
const group3 = [keeper, other, third]

describe('selection', () => {
  test('safe findings start selected; review and info do not', () => {
    const safe = f({ safety: 'safe' })
    const review = f({ safety: 'review', category: 'devLeftovers' })
    const info = f({ safety: 'info', category: 'system' })
    const s = initialSelection([safe, review, info])
    expect(s.selected.has(safe.id)).toBe(true)
    expect(s.selected.has(review.id)).toBe(false)
    expect(s.selected.has(info.id)).toBe(false)
  })

  test('a duplicate group never has every copy selected', () => {
    let s = selectCategory(initialSelection(group3), group3, 'duplicates', true)
    expect(s.selected.has(keeper.id)).toBe(false)
    expect(toggle(s, keeper).selected.has(keeper.id)).toBe(false)
    s = setKeeper(s, other)
    expect(s.selected.has(other.id)).toBe(false)
    expect(s.keepers.get(groupId)).toBe(other.id)
  })

  test('a group with no suggested keeper still keeps one copy', () => {
    const a = f({ category: 'duplicates', groupId: 'g2' })
    const b = f({ category: 'duplicates', groupId: 'g2' })
    const s = selectCategory(initialSelection([a, b]), [a, b], 'duplicates', true)
    expect(s.keepers.get('g2')).toBe(a.id)
    expect([...s.selected].filter((id) => id === a.id || id === b.id)).toEqual([b.id])
  })

  test('info findings cannot be selected', () => {
    const info = f({ safety: 'info', category: 'system' })
    const s0 = initialSelection([info])
    expect(toggle(s0, info).selected.has(info.id)).toBe(false)
    expect(selectCategory(s0, [info], 'system', true).selected.has(info.id)).toBe(false)
  })

  test('findings whose size is unknown start unselected but can be ticked', () => {
    const unknown = f({ safety: 'safe', kind: 'folder', sizeUnknown: true })
    const s = initialSelection([unknown])
    expect(s.selected.has(unknown.id)).toBe(false)
    expect(toggle(s, unknown).selected.has(unknown.id)).toBe(true)
  })

  test('toggle flips an ordinary finding and select none clears a category', () => {
    const a = f({ safety: 'review', category: 'installersStale' })
    const b = f({ safety: 'review', category: 'installersStale' })
    let s = toggle(initialSelection([a, b]), a)
    expect(s.selected.has(a.id)).toBe(true)
    s = selectCategory(s, [a, b], 'installersStale', true)
    expect(s.selected.has(b.id)).toBe(true)
    s = selectCategory(s, [a, b], 'installersStale', false)
    expect(s.selected.size).toBe(0)
  })

  test('selectedTotal sums selected findings only', () => {
    const a = f({ sizeOnDisk: 1000 })
    const b = f({ sizeOnDisk: 250 })
    const c = f({ sizeOnDisk: 5, safety: 'review' })
    const s = initialSelection([a, b, c])
    expect(selectedTotal(s, [a, b, c])).toEqual({ count: 2, bytes: 1250 })
  })
})
