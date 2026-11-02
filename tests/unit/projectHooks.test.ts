import { expect, test } from 'vitest'
import { likenessKey } from '../../src/core/projects/likeness'
import { proposeVisionLabels, readWorkflowMeta } from '../../src/core/projects/hooks'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)])
}

function textChunk(keyword: string, text: string): Buffer {
  return chunk(
    'tEXt',
    Buffer.concat([Buffer.from(`${keyword}\0`, 'ascii'), Buffer.from(text, 'utf8')])
  )
}

function itxtChunk(keyword: string, text: string): Buffer {
  return chunk(
    'iTXt',
    Buffer.concat([
      Buffer.from(`${keyword}\0`, 'ascii'),
      Buffer.from([0, 0]),
      Buffer.from('\0\0', 'ascii'),
      Buffer.from(text, 'utf8')
    ])
  )
}

function png(parts: Buffer[]): Uint8Array {
  return new Uint8Array(Buffer.concat([SIGNATURE, ...parts, chunk('IEND', Buffer.alloc(0))]))
}

const PARAMETERS = [
  'Mara, mist pines',
  'Negative prompt: blurry',
  'Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 42, Model hash: abcd, Model: deliberate_v2'
].join('\n')

function comfyPrompt(seed: number, text: string): string {
  return JSON.stringify({
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux.safetensors' } },
    '6': {
      class_type: 'CLIPTextEncode',
      inputs: { text },
      _meta: { title: 'CLIP Text Encode (Prompt)' }
    },
    '7': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'blurry' },
      _meta: { title: 'CLIP Text Encode (Negative)' }
    },
    '3': { class_type: 'KSampler', inputs: { seed, steps: 20, cfg: 7 } },
    note: 'process.exit(1)'
  })
}

function comfyWorkflow(seed: number): string {
  return JSON.stringify({
    nodes: [
      { type: 'CLIPTextEncode', title: 'Prompt', widgets_values: ['Mara in the pines'] },
      { type: 'KSampler', widgets_values: [seed, 'fixed', 20] }
    ]
  })
}

test('an Automatic1111 parameters chunk returns the prompt, model, and seed', () => {
  const meta = readWorkflowMeta(png([textChunk('parameters', PARAMETERS)]))
  expect(meta).toMatchObject({
    source: 'automatic1111',
    prompt: 'Mara, mist pines',
    model: 'deliberate_v2',
    seed: '42',
    workflowHash: null
  })
})

test('a ComfyUI prompt chunk returns the prompt and a workflow hash, and the JSON is not run', () => {
  const meta = readWorkflowMeta(png([textChunk('prompt', comfyPrompt(1, 'Mara in the pines'))]))
  expect(meta?.source).toBe('comfyui')
  expect(meta?.prompt).toBe('Mara in the pines')
  expect(meta?.model).toBe('flux.safetensors')
  expect(meta?.seed).toBe('1')
  expect(meta?.workflowHash).toMatch(/^[0-9a-f]{64}$/)
})

test('a ComfyUI prompt in an iTXt chunk is read the same way', () => {
  const meta = readWorkflowMeta(png([itxtChunk('prompt', comfyPrompt(4, 'Mara in the pines'))]))
  expect(meta?.prompt).toBe('Mara in the pines')
  expect(meta?.workflowHash).toMatch(/^[0-9a-f]{64}$/)
})

test('two seeds of one prompt are one likeness group, and a different prompt is not', () => {
  const first = readWorkflowMeta(png([textChunk('prompt', comfyPrompt(1, 'Mara in the pines'))]))
  const second = readWorkflowMeta(png([textChunk('prompt', comfyPrompt(2, 'Mara in the pines'))]))
  const other = readWorkflowMeta(png([textChunk('prompt', comfyPrompt(1, 'the north gate'))]))
  expect(first?.seed).toBe('1')
  expect(second?.seed).toBe('2')
  expect(first?.workflowHash).toBe(second?.workflowHash)
  expect(first && second && likenessKey(first)).toBe(second && likenessKey(second))
  expect(first?.workflowHash).not.toBe(other?.workflowHash)
})

test('a workflow chunk groups two seeds even when the prompt chunk carries the seed', () => {
  const workflow = comfyWorkflow(1)
  const first = readWorkflowMeta(
    png([textChunk('workflow', workflow), textChunk('prompt', comfyPrompt(1, 'Mara in the pines'))])
  )
  const second = readWorkflowMeta(
    png([
      textChunk('workflow', comfyWorkflow(99)),
      textChunk('prompt', comfyPrompt(2, 'Mara in the pines'))
    ])
  )
  expect(first?.workflowHash).toMatch(/^[0-9a-f]{64}$/)
  expect(first?.workflowHash).toBe(second?.workflowHash)
  expect(first?.prompt).toBe('Mara in the pines')
})

test('a png with neither keyword, and bytes that are not a png, return null', () => {
  expect(readWorkflowMeta(png([textChunk('Comment', 'hello')]))).toBeNull()
  expect(readWorkflowMeta(new Uint8Array([1, 2, 3]))).toBeNull()
})

test('vision labels stay empty: a hash is not a name', () => {
  expect(proposeVisionLabels(['0000000000000001', 'ffffffffffffffff'])).toEqual([])
})
