import { describe, expect, test } from 'vitest'
import { likenessKey, type WorkflowMeta } from '../../src/core/projects/likeness'

const meta = (over: Partial<WorkflowMeta>): WorkflowMeta => ({
  source: 'unknown',
  prompt: null,
  model: null,
  seed: null,
  workflowHash: null,
  ...over
})

describe('workflow likeness', () => {
  test('the same workflow stays together even when the seed changes', () => {
    const a = likenessKey(
      meta({ source: 'comfyui', workflowHash: 'abc123', seed: '1', prompt: 'Mara' })
    )
    const b = likenessKey(
      meta({ source: 'comfyui', workflowHash: 'abc123', seed: '2', prompt: 'other' })
    )
    expect(a).toBe('workflow:abc123')
    expect(b).toBe(a)
  })

  test('without a workflow, the prompt and model are the group, and spacing does not split them', () => {
    const a = likenessKey(
      meta({
        source: 'automatic1111',
        model: 'flux',
        seed: '9',
        prompt: 'Mara,  mist pines'
      })
    )
    const b = likenessKey(
      meta({
        source: 'automatic1111',
        model: 'Flux',
        seed: '10',
        prompt: '  mara, mist   pines  '
      })
    )
    expect(a).toBe(b)
    expect(a?.startsWith('prompt:')).toBe(true)
  })

  test('a different prompt is a different group, and a file with no prompt is not grouped', () => {
    const mara = likenessKey(meta({ prompt: 'Mara', model: 'flux' }))
    const pines = likenessKey(meta({ prompt: 'mist pines', model: 'flux' }))
    expect(mara).not.toBe(pines)
    expect(likenessKey(meta({ seed: '4' }))).toBeNull()
    expect(likenessKey(meta({ prompt: '   ' }))).toBeNull()
  })
})
