import type { Bytes, Category } from '../../../shared/types'
import { formatBytes } from './format'

/** Card and breakdown order for the four kinds of waste the user can clean. */
export const CLEANABLE_CATEGORIES = [
  'duplicates',
  'tempCaches',
  'installersStale',
  'devLeftovers'
] as const
export type CleanableCategory = (typeof CLEANABLE_CATEGORIES)[number]

export const CATEGORY_LABELS: Record<Category, string> = {
  duplicates: 'Duplicate files',
  tempCaches: 'Temp files & caches',
  installersStale: 'Old installers & stale files',
  devLeftovers: 'Dev & creative leftovers',
  system: 'Windows can clean these'
}

export function freeLine(bytes: Bytes): string {
  return `You could free about ${formatBytes(bytes)}`
}

export function windowsLine(bytes: Bytes): string {
  return `+ ${formatBytes(bytes)} Windows can clean itself`
}

export function binLine(bytes: Bytes): string {
  return `Recycle Bin: ${formatBytes(bytes)}. Space is only freed when you empty the Recycle Bin.`
}

export interface BreakdownRow {
  category: CleanableCategory
  label: string
  bytes: Bytes
}

/** The categories behind freeLine, in card order, leaving out empty ones and the Windows-only (system) total. */
export function categoryBreakdown(byCategory: Record<Category, Bytes>): BreakdownRow[] {
  return CLEANABLE_CATEGORIES.filter((c) => (byCategory[c] ?? 0) > 0).map((c) => ({
    category: c,
    label: CATEGORY_LABELS[c],
    bytes: byCategory[c]
  }))
}
