import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addSubject, emptyProject, isProjectTree, removeSubject } from '../core/projects/tree'
import type { BranchKind, ProjectTree } from '../shared/projects'
import type { WinEnv } from '../shared/types'

const FILE = 'projects.json'

/**
 * The project trees Stash remembers, in `<dir>\projects.json`.
 * This store writes that file only. It does not create the project's folders,
 * rename anything the user owns, or move anything to the Recycle Bin.
 */
export class ProjectsStore {
  private lastWrite: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dir: string,
    private readonly env: WinEnv,
    private readonly ids: () => string = randomUUID
  ) {}

  private get file(): string {
    return join(this.dir, FILE)
  }

  list(): Promise<ProjectTree[]> {
    return this.change((current) => current)
  }

  create(name: string, rootPath: string): Promise<ProjectTree> {
    return this.change((current) => {
      const tree = emptyProject({ id: this.ids(), name, rootPath }, this.env)
      if (tree === null) throw new Error("That name or folder can't be a project")
      return [...current, tree]
    }).then((trees) => {
      const created = trees[trees.length - 1]
      if (created === undefined) throw new Error("That name or folder can't be a project")
      return created
    })
  }

  addSubject(projectId: string, kind: BranchKind, name: string): Promise<ProjectTree> {
    return this.changeOne(projectId, (tree) => {
      const next = addSubject(tree, kind, name, this.ids())
      if (next === null) throw new Error("That name can't be a folder here")
      return next
    })
  }

  removeSubject(projectId: string, subjectId: string): Promise<ProjectTree> {
    return this.changeOne(projectId, (tree) => {
      const next = removeSubject(tree, subjectId)
      if (next === null) throw new Error('unknown name')
      return next
    })
  }

  private changeOne(
    projectId: string,
    edit: (tree: ProjectTree) => ProjectTree
  ): Promise<ProjectTree> {
    let edited: ProjectTree | null = null
    return this.change((current) => {
      const index = current.findIndex((tree) => tree.id === projectId)
      if (index < 0) throw new Error('unknown project')
      const next = edit(current[index])
      edited = next
      return current.map((tree, i) => (i === index ? next : tree))
    }).then(() => {
      if (edited === null) throw new Error('unknown project')
      return edited
    })
  }

  /** Reads, lets `edit` return the new list, and writes it. Writes run one at a time. */
  private change(edit: (current: ProjectTree[]) => ProjectTree[]): Promise<ProjectTree[]> {
    const run = this.lastWrite.then(async () => {
      const current = await this.read()
      const next = edit(current)
      if (next !== current) await this.write(next)
      return next
    })
    this.lastWrite = run.catch(() => undefined)
    return run
  }

  private async read(): Promise<ProjectTree[]> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      await this.quarantine()
      return []
    }
    if (!Array.isArray(value) || !value.every((item) => isProjectTree(item, this.env))) {
      await this.quarantine()
      return []
    }
    return value
  }

  private async write(trees: ProjectTree[]): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(trees, null, 2))
    await rename(tmp, this.file)
  }

  private async quarantine(): Promise<void> {
    await rename(this.file, `${this.file}.bad`).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e
    })
  }
}
