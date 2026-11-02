import type { Settings } from '../shared/types'

/**
 * The settings Stash runs with, kept in memory, and the one way to change them: stored first, then
 * made live. The scan session reads `get()` when a scan starts and again when it ends.
 */
export class LiveSettings {
  constructor(
    private current: Settings,
    /** Validates and stores the settings, returning what was stored; rejects on invalid input. */
    private readonly store: (input: unknown) => Promise<Settings>
  ) {}

  get(): Settings {
    return this.current
  }

  async save(input: unknown): Promise<Settings> {
    const saved = await this.store(input)
    this.current = saved
    return saved
  }
}
