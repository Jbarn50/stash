import type { WorkflowMeta } from './likeness'
import { readPngText } from './pngText'
import { metaFromText } from './workflowMeta'

// Vision labels stay empty: a hash is not a name. Workflow text is read locally from PNG chunks.

export interface VisionLabel {
  branch: 'character' | 'lore' | 'scenery' | 'location'
  name: string
  confidence: number
}

/** Phase 5 names images. This phase does not: a perceptual hash is not a label. */
export function proposeVisionLabels(hashes: readonly string[]): VisionLabel[] {
  void hashes
  return []
}

/**
 * Reads Automatic1111 `parameters` and ComfyUI `prompt` / `workflow` from a PNG.
 * No network. The JSON is parsed and not evaluated. Anything else returns null.
 */
export function readWorkflowMeta(bytes: Uint8Array): WorkflowMeta | null {
  const text = readPngText(bytes)
  if (text === null) return null
  return metaFromText({
    parameters: text.get('parameters') ?? null,
    prompt: text.get('prompt') ?? null,
    workflow: text.get('workflow') ?? null
  })
}
