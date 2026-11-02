import type { Bytes } from '../../../shared/types'

const UNITS = ['KB', 'MB', 'GB', 'TB']

/** Binary units: whole bytes below 1 KB, then one decimal (1.5 KB, 12.3 GB). */
export function formatBytes(bytes: Bytes): string {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`
  let value = bytes / 1024
  let unit = 0
  // Step up while the rounded value would read 1024.0, so 1 MB minus a byte shows as 1.0 MB, not 1024.0 KB.
  while (unit < UNITS.length - 1 && Number(value.toFixed(1)) >= 1024) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`
}

/** A short local date and time, for History and the Explore list. */
export function formatDate(ms: number | string): string {
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function formatPercent(part: number, whole: number): string {
  if (!whole || whole <= 0) return '0%'
  const pct = (part / whole) * 100
  return pct > 0 && pct < 0.1 ? '<0.1%' : `${pct.toFixed(1)}%`
}
