import { folderSegment } from './tree'

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

const NOISE =
  /^(masterpiece|best quality|high quality|highres|highly detailed|ultra detailed|8k|4k|sharp focus|detailed|realistic)$/i

/**
 * A folder segment suggested from the prompt, or null when the prompt has nothing
 * safe to use as a name. The person can edit it before anything moves.
 */
export function suggestFolderName(meta: WorkflowMeta): string | null {
  if (meta.prompt === null) return null
  for (const raw of meta.prompt.split(/[,\n]/)) {
    const cleaned = raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[<>:"/\\|?*]/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim()
      .replace(/\s+/g, ' ')
    if (cleaned === '' || NOISE.test(cleaned)) continue
    const words = cleaned.split(' ').slice(0, 4).join(' ')
    const segment = folderSegment(words)
    if (segment !== null && !NOISE.test(segment)) return segment
  }
  return null
}
