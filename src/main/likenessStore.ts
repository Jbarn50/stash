import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDHash } from '../shared/dhash'

const FILE = 'likeness-hashes.json'
const MAX_HASHES = 24

interface HashRow {
  projectId: string
  hashes: string[]
}

interface HashFile {
  version: 1
  subjects: Record<string, HashRow>
}

function empty(): HashFile {
  return { version: 1, subjects: {} }
}

function isRow(value: unknown): value is HashRow {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as { projectId?: unknown; hashes?: unknown }
  return (
    typeof row.projectId === 'string' &&
    Array.isArray(row.hashes) &&
    row.hashes.every((hash) => typeof hash === 'string' && isDHash(hash))
  )
}

function isFile(value: unknown): value is HashFile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const file = value as { version?: unknown; subjects?: unknown }
  if (file.version !== 1 || typeof file.subjects !== 'object' || file.subjects === null)
    return false
  if (Array.isArray(file.subjects)) return false
  return Object.values(file.subjects as Record<string, unknown>).every(isRow)
}

/**
 * Per-subject difference hashes, in `<dir>\likeness-hashes.json`.
 * Hashes only: the pixels never land in this file.
 */
export class LikenessStore {
  private lastWrite: Promise<unknown> = Promise.resolve()

  constructor(private readonly dir: string) {}

  private get file(): string {
    return join(this.dir, FILE)
  }

  async all(): Promise<Record<string, string[]>> {
    const data = await this.read()
    return Object.fromEntries(
      Object.entries(data.subjects).map(([id, row]) => [id, [...row.hashes]])
    )
  }

  add(subjectId: string, projectId: string, hash: string): Promise<void> {
    if (!isDHash(hash)) return Promise.resolve()
    return this.change((current) => {
      const row = current.subjects[subjectId] ?? { projectId, hashes: [] }
      if (row.hashes.includes(hash) || row.hashes.length >= MAX_HASHES) return current
      return {
        version: 1,
        subjects: {
          ...current.subjects,
          [subjectId]: { projectId, hashes: [...row.hashes, hash] }
        }
      }
    }).then(() => undefined)
  }

  private change(edit: (current: HashFile) => HashFile): Promise<HashFile> {
    const run = this.lastWrite.then(async () => {
      const current = await this.read()
      const next = edit(current)
      if (next !== current) await this.write(next)
      return next
    })
    this.lastWrite = run.catch(() => undefined)
    return run
  }

  private async read(): Promise<HashFile> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty()
      throw e
    }
    try {
      const value: unknown = JSON.parse(text)
      if (!isFile(value)) {
        await this.quarantine()
        return empty()
      }
      return value
    } catch {
      await this.quarantine()
      return empty()
    }
  }

  private async write(data: HashFile): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(data, null, 2))
    await rename(tmp, this.file)
  }

  private async quarantine(): Promise<void> {
    await rename(this.file, `${this.file}.bad`).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
    })
  }
}
