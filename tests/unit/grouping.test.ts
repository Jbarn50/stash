import { expect, test } from 'vitest'
import { proposeGroups, type GroupItem, type KnownSubject } from '../../src/core/projects/grouping'
import type { WorkflowMeta } from '../../src/core/projects/likeness'

const meta = (over: Partial<WorkflowMeta>): WorkflowMeta => ({
  source: 'comfyui',
  prompt: null,
  model: null,
  seed: null,
  workflowHash: null,
  ...over
})

const file = (path: string, over: Partial<GroupItem> = {}): GroupItem => ({
  path,
  meta: null,
  dhash: null,
  ...over
})

test('two seeds of one prompt are one group, and two prompts are two groups', () => {
  const groups = proposeGroups(
    [
      file('D:\\Imports\\a.png', {
        meta: meta({ prompt: 'Mara, mist pines', model: 'flux', seed: '1', workflowHash: 'abc123' })
      }),
      file('D:\\Imports\\b.png', {
        meta: meta({ prompt: 'Mara, mist pines', model: 'flux', seed: '2', workflowHash: 'abc123' })
      }),
      file('D:\\Imports\\c.png', {
        meta: meta({ prompt: 'the north gate', model: 'flux', seed: '1', workflowHash: 'def456' })
      })
    ],
    []
  )
  const mara = groups.find((group) => group.folder === 'Mara')
  const gate = groups.find((group) => group.folder === 'the north gate')
  expect(mara?.paths).toEqual(['D:\\Imports\\a.png', 'D:\\Imports\\b.png'])
  expect(mara?.reason).toBe('workflow')
  expect(mara?.branch).toBe('character')
  expect(gate?.paths).toEqual(['D:\\Imports\\c.png'])
  expect(groups).toHaveLength(2)
})

test('a file with no prompt and no workflow hash stays in Inbox until it is named', () => {
  const groups = proposeGroups([file('D:\\Imports\\lone.png', { meta: meta({ seed: '4' }) })], [])
  expect(groups).toEqual([
    {
      id: 'g1',
      reason: 'inbox',
      branch: 'inbox',
      folder: '',
      nearbySubjectId: null,
      nearbyName: null,
      paths: ['D:\\Imports\\lone.png']
    }
  ])
})

test('the same look suggests an existing subject, and a distant hash does not', () => {
  const subjects: KnownSubject[] = [
    {
      id: 's1',
      kind: 'location',
      name: 'North Gate',
      folder: 'North Gate',
      hashes: ['00000000000003ff']
    },
    {
      id: 's2',
      kind: 'scenery',
      name: 'Pines',
      folder: 'Pines',
      hashes: ['ffffffffffffffff']
    }
  ]
  const near = proposeGroups(
    [file('D:\\Imports\\gate.png', { dhash: '0000000000000000' })],
    subjects
  )
  expect(near[0]).toMatchObject({
    reason: 'look',
    nearbySubjectId: 's1',
    nearbyName: 'North Gate'
  })
  const far = proposeGroups(
    [file('D:\\Imports\\other.png', { dhash: 'ffffffffffffffff' })],
    [subjects[0]]
  )
  expect(far[0]).toMatchObject({ reason: 'inbox', nearbySubjectId: null, folder: '' })
})

test('two files with no workflow and the same look are one suggestion', () => {
  const groups = proposeGroups(
    [
      file('D:\\Imports\\b.png', { dhash: '0000000000000000' }),
      file('D:\\Imports\\a.png', { dhash: '0000000000000001' })
    ],
    []
  )
  expect(groups).toHaveLength(1)
  expect(groups[0]).toMatchObject({
    reason: 'look',
    folder: '',
    branch: 'inbox',
    paths: ['D:\\Imports\\a.png', 'D:\\Imports\\b.png']
  })
})
