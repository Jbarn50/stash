import { expect, test } from 'vitest'
import { proposeVisionLabels, readWorkflowMeta } from '../../src/core/projects/hooks'

test('vision and workflow hooks do nothing until their phases', () => {
  expect(proposeVisionLabels(['abc'])).toEqual([])
  expect(readWorkflowMeta(new Uint8Array([1, 2, 3]))).toBeNull()
})
