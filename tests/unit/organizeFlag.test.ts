import { expect, test, vi } from 'vitest'
import type { OrganizeIo } from '../../src/main/organize'
import { SAMPLE_ENV } from '../helpers/env'

vi.mock('../../src/core/features', () => ({
  FEATURES: { undo: true, organize: false },
  requireFeature(name: string): void {
    if (name === 'organize') throw new Error('feature off: organize')
  }
}))

const { applyOrganize, undoOrganizeMoves } = await import('../../src/main/organize')

function throwingIo(): OrganizeIo & { calls: string[] } {
  const calls: string[] = []
  const refuse = (name: string) => async (): Promise<never> => {
    calls.push(name)
    throw new Error(name)
  }
  return {
    calls,
    exists: refuse('exists'),
    isFile: refuse('isFile'),
    mkdir: refuse('mkdir'),
    rename: refuse('rename')
  }
}

test('organize creates and renames nothing while the feature is off', async () => {
  const io = throwingIo()
  await expect(
    applyOrganize({
      root: 'D:\\Stories\\Ashfen',
      env: SAMPLE_ENV,
      projectId: 'p1',
      requests: [{ from: 'D:\\Imports\\a.png', branch: 'character', folder: 'Mara' }],
      io,
      log: { append: async () => undefined },
      now: () => 0,
      id: 'org-1'
    })
  ).rejects.toThrow(/feature off: organize/)
  await expect(
    undoOrganizeMoves({
      projectId: 'p1',
      organizeId: 'org-1',
      id: 'undo-1',
      moves: [{ from: 'D:\\Imports\\a.png', to: 'D:\\Stories\\Ashfen\\character\\Mara\\a.png' }],
      io,
      log: { append: async () => undefined },
      now: () => 0
    })
  ).rejects.toThrow(/feature off: organize/)
  expect(io.calls).toEqual([])
})
