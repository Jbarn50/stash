// Gates for work beyond Space & Cleanup. Pure helpers do not consult these.
// A function that moves or creates the user's files, or sends an image, calls
// requireFeature first.

export const FEATURES = {
  /** One-click undo of the latest restorable cleanup. On in phase 1. */
  undo: true,
  /**
   * Same-volume renames that file images into a project after the user confirms.
   * On in the same change as those moves. Remote naming stays off.
   */
  organize: true
} as const

export type FeatureName = keyof typeof FEATURES

/** Throws when `name` is off. Call this before any side effect of that feature. */
export function requireFeature(name: FeatureName): void {
  if (!FEATURES[name]) throw new Error(`feature off: ${name}`)
}
