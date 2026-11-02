// How an import decides that two generated files are the same kind of thing,
// using workflow metadata only. Seed is not part of the key: two seeds of one
// prompt belong in one group. A file with nothing to group on returns null,
// and the vision phase (or the person) names it later. Nothing here reads a file.

export type WorkflowSource = 'comfyui' | 'automatic1111' | 'invokeai' | 'fooocus' | 'unknown'

export interface WorkflowMeta {
  source: WorkflowSource
  prompt: string | null
  model: string | null
  seed: string | null
  /** SHA-256 of the workflow graph when the file carried one. Not an image hash. */
  workflowHash: string | null
}

const HEX_HASH = /^[0-9a-f]{6,128}$/

function norm(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The group key for one file. `workflow:<hash>` wins when the file has a
 * workflow hash. Otherwise `prompt:<model>\n<prompt>`. Null when neither is
 * usable, so the file is not filed automatically.
 */
export function likenessKey(meta: WorkflowMeta): string | null {
  const hash = norm(meta.workflowHash ?? '')
  if (HEX_HASH.test(hash)) return `workflow:${hash}`
  const prompt = meta.prompt === null ? '' : norm(meta.prompt)
  if (prompt === '') return null
  const model = meta.model === null ? '' : norm(meta.model)
  return `prompt:${model}\n${prompt}`
}
