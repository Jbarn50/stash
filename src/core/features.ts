// Gates for work beyond Space & Cleanup. Pure helpers do not consult these.
// A function that moves or creates the user's files, or sends an image, calls
// requireFeature first. The project screen only stores a tree, so it stays
// available while `organize` is off.

export const FEATURES = {
  /** One-click undo of the latest restorable cleanup. On in phase 1. */
  undo: true,
  /** Workflow import, folder creation, and visual labeling. Phases 3–5. */
  organize: false
} as const

export type FeatureName = keyof typeof FEATURES

/** Throws when `name` is off. Call this before any side effect of that feature. */
export function requireFeature(name: FeatureName): void {
  if (!FEATURES[name]) throw new Error(`feature off: ${name}`)
}
