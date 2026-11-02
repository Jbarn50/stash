import type { WorkflowMeta } from './likeness'

// Empty hooks for later phases. They do not read files, call a network, or move anything.

export interface VisionLabel {
  branch: 'character' | 'lore' | 'scenery' | 'location'
  name: string
  confidence: number
}

/** Phase 4. No image is hashed or labeled yet. The argument is the hook's input. */
export function proposeVisionLabels(hashes: readonly string[]): VisionLabel[] {
  void hashes
  return []
}

/** Phase 3. Workflow bytes are not parsed yet. The argument is the hook's input. */
export function readWorkflowMeta(bytes: Uint8Array): WorkflowMeta | null {
  void bytes
  return null
}
