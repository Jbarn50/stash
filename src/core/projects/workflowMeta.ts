import { createHash } from 'node:crypto'
import type { WorkflowMeta } from './likeness'

// Turns PNG text into workflow metadata. JSON is parsed and never evaluated.

const SEED_KEY = /^(seed|noise_seed|control_after_generate)$/i

export interface WorkflowText {
  parameters: string | null
  prompt: string | null
  workflow: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function typeOf(value: Record<string, unknown>): string {
  if (typeof value.class_type === 'string') return value.class_type
  if (typeof value.type === 'string') return value.type
  return ''
}

function titleOf(value: Record<string, unknown>): string {
  if (typeof value.title === 'string') return value.title
  const meta = value._meta
  if (isRecord(meta) && typeof meta.title === 'string') return meta.title
  return ''
}

function seedValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim()
  return null
}

interface Found {
  prompts: string[]
  model: string | null
  seed: string | null
}

function takeClip(value: Record<string, unknown>, found: Found): void {
  const kind = typeOf(value)
  if (!/cliptextencode/i.test(kind)) return
  if (/negative/i.test(titleOf(value)) || /negative/i.test(kind)) return
  const inputs = isRecord(value.inputs) ? value.inputs : null
  const text = inputs && typeof inputs.text === 'string' ? inputs.text : null
  if (text !== null && text.trim() !== '') {
    found.prompts.push(text)
    return
  }
  const widgets = value.widgets_values
  if (!Array.isArray(widgets)) return
  const first = widgets.find((item) => typeof item === 'string' && item.trim() !== '')
  if (typeof first === 'string') found.prompts.push(first)
}

function visit(value: unknown, found: Found): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, found)
    return
  }
  if (!isRecord(value)) return
  takeClip(value, found)
  const inputs = isRecord(value.inputs) ? value.inputs : null
  if (inputs) {
    if (found.model === null) {
      const model = inputs.ckpt_name ?? inputs.unet_name ?? inputs.model_name
      if (typeof model === 'string' && model.trim() !== '') found.model = model.trim()
    }
    if (found.seed === null) found.seed = seedValue(inputs.seed) ?? seedValue(inputs.noise_seed)
  }
  for (const child of Object.values(value)) visit(child, found)
}

function extract(value: unknown): {
  prompt: string | null
  model: string | null
  seed: string | null
} {
  const found: Found = { prompts: [], model: null, seed: null }
  visit(value, found)
  const prompt = found.prompts.join('\n').trim()
  return { prompt: prompt === '' ? null : prompt, model: found.model, seed: found.seed }
}

/** Drops seed fields so two seeds of one graph share a hash. Does not run the graph. */
function stripSeeds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSeeds)
  if (!isRecord(value)) return value
  const kind = typeOf(value)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    if (SEED_KEY.test(key)) continue
    const child = value[key]
    if (key === 'widgets_values' && /sampler/i.test(kind) && Array.isArray(child)) {
      out[key] = child.map((item, index) =>
        index === 0 && typeof item === 'number' ? 0 : stripSeeds(item)
      )
      continue
    }
    out[key] = stripSeeds(child)
  }
  return out
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (isRecord(value)) {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function jsonHash(text: string | null): { hash: string; value: Record<string, unknown> } | null {
  if (text === null) return null
  const value = parseJson(text)
  if (!isRecord(value)) return null
  try {
    const hash = createHash('sha256')
      .update(canonical(stripSeeds(value)))
      .digest('hex')
    return { hash, value }
  } catch {
    return null
  }
}

function setting(settings: string, key: string): string | null {
  const match = new RegExp(`(?:^|, )${key}: ([^,]*)`).exec(settings)
  const value = match?.[1]?.trim() ?? ''
  return value === '' ? null : value
}

function parseAutomatic1111(parameters: string): WorkflowMeta {
  const text = parameters
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
  let prompt = text
  let settings = ''
  const negativeAt = text.indexOf('\nNegative prompt:')
  if (negativeAt >= 0) {
    prompt = text.slice(0, negativeAt)
    const after = text.slice(negativeAt + 1)
    const stepsAt = after.search(/\nSteps: /)
    settings = stepsAt >= 0 ? after.slice(stepsAt + 1) : ''
  } else {
    const stepsAt = text.search(/\nSteps: /)
    if (stepsAt >= 0) {
      prompt = text.slice(0, stepsAt)
      settings = text.slice(stepsAt + 1)
    }
  }
  const cleaned = prompt.trim()
  return {
    source: 'automatic1111',
    prompt: cleaned === '' ? null : cleaned,
    model: setting(settings, 'Model'),
    seed: setting(settings, 'Seed'),
    workflowHash: null
  }
}

/**
 * Metadata from the three PNG keywords. A ComfyUI `prompt` or `workflow` object wins over
 * Automatic1111 `parameters`. The hash is of the graph with seeds removed. Null when none
 * of the keywords carry a prompt or a workflow object.
 */
export function metaFromText(text: WorkflowText): WorkflowMeta | null {
  const workflow = jsonHash(text.workflow)
  const prompt = jsonHash(text.prompt)
  const hashed = workflow ?? prompt
  if (hashed !== null) {
    const described = prompt ?? workflow
    const details =
      described === null ? { prompt: null, model: null, seed: null } : extract(described.value)
    return {
      source: 'comfyui',
      prompt: details.prompt,
      model: details.model,
      seed: details.seed,
      workflowHash: hashed.hash
    }
  }
  if (text.parameters !== null) return parseAutomatic1111(text.parameters)
  return null
}
