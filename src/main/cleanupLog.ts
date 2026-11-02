import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CleanupBatch, HistoryEntry, RestoreRecord } from '../shared/types'

type LogEntry = CleanupBatch | RestoreRecord

const FILE = 'cleanup-log.jsonl'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Enough of an entry's shape to list it and restore from it; anything else is a damaged line.
function isEntry(value: unknown): value is LogEntry {
  if (!isObject(value) || typeof value.batchId !== 'string' || !Array.isArray(value.items)) {
    return false
  }
  const itemsOk = value.items.every(
    (item) =>
      isObject(item) && typeof item.originalPath === 'string' && typeof item.status === 'string'
  )
  if (!itemsOk) return false
  if (value.type === 'cleanup') {
    return typeof value.startedAt === 'string' && typeof value.finishedAt === 'string'
  }
  return value.type === 'restore' && typeof value.at === 'string'
}

function parseLine(line: string): LogEntry | null {
  try {
    const value: unknown = JSON.parse(line)
    return isEntry(value) ? value : null
  } catch {
    return null
  }
}

/**
 * The append-only cleanup log, `<dir>\cleanup-log.jsonl`: one JSON object per line for each
 * cleanup batch and each restore. Lines that cannot be read back, such as one cut short by a
 * crash, are skipped.
 */
export class CleanupLog {
  private readonly dir: string
  private readonly file: string
  // Appends run one after another, so entries made at the same moment keep their own lines.
  private lastAppend: Promise<unknown> = Promise.resolve()

  constructor(dir: string) {
    this.dir = dir
    this.file = join(dir, FILE)
  }

  append(entry: LogEntry): Promise<void> {
    const write = this.lastAppend.then(async () => {
      await mkdir(this.dir, { recursive: true })
      // A line cut short by a crash is closed first, so this entry starts on a line of its own.
      const prefix = (await this.endsMidLine()) ? '\n' : ''
      await appendFile(this.file, `${prefix}${JSON.stringify(entry)}\n`)
    })
    this.lastAppend = write.catch(() => undefined)
    return write
  }

  async readAll(): Promise<LogEntry[]> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    return text.split(/\r?\n/).flatMap((line) => {
      const entry = line.trim() === '' ? null : parseLine(line)
      return entry ? [entry] : []
    })
  }

  /** Cleanup batches, newest first, each with its restore records in the order they happened. */
  async history(): Promise<HistoryEntry[]> {
    const entries = await this.readAll()
    const restores = entries.filter((e): e is RestoreRecord => e.type === 'restore')
    return entries
      .filter((e): e is CleanupBatch => e.type === 'cleanup')
      .reverse()
      .map((batch) => ({ batch, restores: restores.filter((r) => r.batchId === batch.batchId) }))
  }

  async getBatch(batchId: string): Promise<CleanupBatch | null> {
    const entries = await this.readAll()
    return (
      entries.find((e): e is CleanupBatch => e.type === 'cleanup' && e.batchId === batchId) ?? null
    )
  }

  // True when the log's last byte is not a newline, that is when the previous write was cut short.
  private async endsMidLine(): Promise<boolean> {
    let handle
    try {
      handle = await open(this.file, 'r')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw e
    }
    try {
      const { size } = await handle.stat()
      if (size === 0) return false
      const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1)
      return buffer[0] !== 0x0a
    } finally {
      await handle.close()
    }
  }
}
