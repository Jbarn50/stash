import type { RestoreRecord } from '../../../shared/types'

/** The confirm line for Undo. It says what will happen, and what will not. */
export function undoConfirmText(count: number): string {
  if (count === 1) {
    return 'Put 1 item back where it was. Stash does not delete it, and it does not empty the Recycle Bin.'
  }
  return `Put ${count} items back where they were. Stash does not delete them, and it does not empty the Recycle Bin.`
}

/** What an undo put back, in the same words History uses for a restore. */
export function undoResultText(record: RestoreRecord): string {
  if (record.items.length === 0) return 'Nothing left to put back.'
  const back = record.items.filter((item) => item.status === 'restored').length
  const gone = record.items.filter((item) => item.status === 'purged').length
  const failed = record.items.filter((item) => item.status === 'failed').length
  const parts = [`Put ${back} item${back === 1 ? '' : 's'} back`]
  if (gone > 0) parts.push(`${gone} no longer in the Recycle Bin`)
  if (failed > 0) parts.push(`${failed} couldn't be put back`)
  return parts.join('. ') + '.'
}
