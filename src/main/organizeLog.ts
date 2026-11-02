import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathKey } from '../core/paths'

const FILE = 'organize-log.jsonl'

export interface OrganizeLogEntry {
  type: 'organize' | 'organize-undo'
  id: string
  at: string
  projectId: string
  from: string
  to: string
  /** Set on an undo line: the organize batch it reverses. */
  organizeId?: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEntry(value: unknown): value is OrganizeLogEntry {
  if (!isObject(value)) return false
  if (value.type !== 'organize' && value.type !== 'organize-undo') return false
  if (typeof value.id !== 'string' || typeof value.at !== 'string') return false
  if (typeof value.projectId !== 'string' || typeof value.from !== 'string') return false
  if (typeof value.to !== 'string') return false
  if (value.organizeId !== undefined && typeof value.organizeId !== 'string') return false
  return true
}

function parseLine(line: string): OrganizeLogEntry | null {
  try {
    const value: unknown = JSON.parse(line)
    return isEntry(value) ? value : null
  } catch {
    return null
  }
}

export interface PendingOrganize {
  organizeId: string
  projectId: string
  moves: { from: string; to: string }[]
}

/**
 * The append-only organize log, `<dir>\organize-log.jsonl`: one JSON object per rename.
 * It is not the cleanup log. Lines that cannot be read back are skipped.
 */
export class OrganizeLog {
  private readonly file: string
  private lastAppend: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string) {
    this.file = join(dir, FILE)
  }

  append(entry: OrganizeLogEntry): Promise<void> {
    const write = this.lastAppend.then(async () => {
      await mkdir(this.dir, { recursive: true })
      const prefix = (await this.endsMidLine()) ? '\n' : ''
      await appendFile(this.file, `${prefix}${JSON.stringify(entry)}\n`)
    })
    this.lastAppend = write.catch(() => undefined)
    return write
  }

  async readAll(): Promise<OrganizeLogEntry[]> {
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

  /** The newest organize batch that still has a rename which has not been undone. */
  async pending(): Promise<PendingOrganize | null> {
    const entries = await this.readAll()
    const undone = new Set<string>()
    for (const entry of entries) {
      if (entry.type !== 'organize-undo' || entry.organizeId === undefined) continue
      undone.add(`${entry.organizeId}\n${pathKey(entry.to)}\n${pathKey(entry.from)}`)
    }
    const batches = new Map<
      string,
      { projectId: string; at: string; moves: PendingOrganize['moves'] }
    >()
    for (const entry of entries) {
      if (entry.type !== 'organize') continue
      const key = `${entry.id}\n${pathKey(entry.from)}\n${pathKey(entry.to)}`
      if (undone.has(key)) continue
      const batch = batches.get(entry.id) ?? { projectId: entry.projectId, at: entry.at, moves: [] }
      batch.moves.push({ from: entry.from, to: entry.to })
      batches.set(entry.id, batch)
    }
    let best: (PendingOrganize & { at: string }) | null = null
    for (const [organizeId, batch] of batches) {
      if (batch.moves.length === 0) continue
      if (best === null || batch.at >= best.at) {
        best = { organizeId, projectId: batch.projectId, moves: batch.moves, at: batch.at }
      }
    }
    return best === null
      ? null
      : { organizeId: best.organizeId, projectId: best.projectId, moves: best.moves }
  }

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
