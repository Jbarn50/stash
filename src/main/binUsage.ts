import type { Bytes } from '../shared/types'
import type { RecycleBinInfo } from './recycleBin'

/**
 * How much the Recycle Bins of the scan targets' drives hold, kept between refreshes. Measuring walks
 * every bin in full (about 12 s at 100,000 entries), so the Overview reads this cached figure and
 * never waits for a measure. It is 0 until the first refresh finishes.
 */
export class BinUsageCache {
  private bytes: Bytes = 0
  private running: Promise<void> | null = null
  private queued: Promise<void> | null = null

  constructor(
    /** The drives to measure, as `C:`. Read at each refresh, so changed scan targets count. */
    private readonly drives: () => string[],
    private readonly binInfo: (drive: string) => Promise<RecycleBinInfo>
  ) {}

  get usedBytes(): Bytes {
    return this.bytes
  }

  /**
   * Measures again in the background. A refresh asked for while one runs is done once more after
   * it, so a change made meanwhile is never missed; several such asks share that one run. Never
   * rejects.
   */
  refresh(): Promise<void> {
    if (this.running === null) {
      this.running = this.measure().finally(() => {
        this.running = null
      })
      return this.running
    }
    this.queued ??= this.running.then(() => {
      this.queued = null
      return this.refresh()
    })
    return this.queued
  }

  private async measure(): Promise<void> {
    const drives = [...new Set(this.drives().map((d) => d.toUpperCase()))]
    let total = 0
    for (const drive of drives) {
      try {
        total += (await this.binInfo(drive)).usedBytes
      } catch (e) {
        console.error(`Couldn't measure the Recycle Bin on ${drive}:`, e)
      }
    }
    this.bytes = total
  }
}
