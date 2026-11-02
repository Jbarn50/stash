import { useEffect, useState } from 'react'
import { branchHoldsPhotos, type BranchKind, type ProjectTree } from '../../../shared/projects'
import ConfirmDialog from '../components/ConfirmDialog'
import { api, errorText, maybeApi } from '../lib/api'

const BRANCH_LABEL: Record<BranchKind, string> = {
  inbox: 'Inbox',
  character: 'Character',
  lore: 'Lore',
  scenery: 'Scenery',
  location: 'Location'
}

/** The project tree, as a shell. It remembers names. It does not create folders or move files. */
export default function Projects(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectTree[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [subjectId, setSubjectId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<BranchKind, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<{
    projectId: string
    subjectId: string
    name: string
  } | null>(null)

  const replace = (tree: ProjectTree): void => {
    setProjects((list) => (list ?? []).map((item) => (item.id === tree.id ? tree : item)))
    setSelectedId(tree.id)
  }

  useEffect(() => {
    const stash = maybeApi()
    if (!stash) return
    let alive = true
    stash
      .getProjects()
      .then((list) => {
        if (!alive) return
        setProjects(list)
        setSelectedId((id) => id ?? list[0]?.id ?? null)
      })
      .catch((e) => alive && setError(errorText(e)))
    return () => {
      alive = false
    }
  }, [])

  const project = projects?.find((item) => item.id === selectedId) ?? null
  const subject =
    project?.branches.flatMap((branch) => branch.subjects).find((item) => item.id === subjectId) ??
    null
  const subjectBranch =
    project?.branches.find((branch) => branch.subjects.some((item) => item.id === subjectId)) ??
    null

  const create = (): void => {
    if (!rootPath) return
    setError(null)
    api()
      .createProject(name, rootPath)
      .then((tree) => {
        setProjects((list) => [...(list ?? []), tree])
        setSelectedId(tree.id)
        setName('')
        setRootPath(null)
      })
      .catch((e) => setError(errorText(e)))
  }

  const add = (kind: BranchKind): void => {
    if (!project) return
    const draft = drafts[kind]?.trim() ?? ''
    if (draft === '') return
    setError(null)
    api()
      .addSubject(project.id, kind, draft)
      .then((tree) => {
        replace(tree)
        setDrafts((current) => ({ ...current, [kind]: '' }))
        const subjects = tree.branches.find((branch) => branch.kind === kind)?.subjects ?? []
        const added = subjects[subjects.length - 1]
        if (added) setSubjectId(added.id)
      })
      .catch((e) => setError(errorText(e)))
  }

  return (
    <div className="screen">
      <h1>Projects</h1>
      <p className="muted">
        Stash remembers this tree. It does not create folders or move files yet.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="project-layout">
        <section className="card" aria-label="Your projects">
          <h2>Projects</h2>
          {(projects ?? []).map((item) => (
            <button
              key={item.id}
              className={item.id === selectedId ? 'primary' : ''}
              onClick={() => {
                setSelectedId(item.id)
                setSubjectId(null)
              }}
            >
              {item.name}
            </button>
          ))}
          {projects?.length === 0 && <p className="muted">No projects yet.</p>}
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <p className="muted">{rootPath ?? 'No folder chosen'}</p>
          <div className="row">
            <button
              onClick={() =>
                api()
                  .pickFolder()
                  .then((picked) => setRootPath(picked))
                  .catch((e) => setError(errorText(e)))
              }
            >
              Choose folder
            </button>
            <button
              className="primary"
              disabled={name.trim() === '' || rootPath === null}
              onClick={create}
            >
              Create project
            </button>
          </div>
        </section>

        <section className="card" aria-label="Tree">
          {!project && <p className="muted">Create a project to add names.</p>}
          {project && (
            <>
              <h2>{project.name}</h2>
              <p className="current-path">{project.rootPath}</p>
              <ul className="project-tree">
                {project.branches.map((branch) => (
                  <li key={branch.kind}>
                    <strong>{BRANCH_LABEL[branch.kind]}</strong>
                    {branch.kind === 'inbox' && <div className="muted">Not filed yet.</div>}
                    <ul>
                      {branch.subjects.map((item) => (
                        <li key={item.id}>
                          <button
                            className={item.id === subjectId ? 'primary' : 'link'}
                            onClick={() => setSubjectId(item.id)}
                          >
                            {item.name}
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="row">
                      <input
                        aria-label={`Add to ${BRANCH_LABEL[branch.kind]}`}
                        value={drafts[branch.kind] ?? ''}
                        onChange={(e) =>
                          setDrafts((current) => ({ ...current, [branch.kind]: e.target.value }))
                        }
                      />
                      <button onClick={() => add(branch.kind)}>Add</button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="card" aria-label="Selected name">
          {!subject && <p className="muted">Select a name to see it.</p>}
          {subject && subjectBranch && (
            <>
              <h2>{subject.name}</h2>
              <p className="muted">{BRANCH_LABEL[subjectBranch.kind]}</p>
              {branchHoldsPhotos(subjectBranch.kind) ? (
                <div className="photo-well" aria-label="Photos">
                  Photos for this {subjectBranch.kind === 'location' ? 'place' : 'look'} will show
                  here.
                </div>
              ) : (
                <p className="muted">Names on this branch do not hold photos.</p>
              )}
              <button
                onClick={() =>
                  project &&
                  setPendingRemove({
                    projectId: project.id,
                    subjectId: subject.id,
                    name: subject.name
                  })
                }
              >
                Remove from tree
              </button>
            </>
          )}
        </section>
      </div>
      {pendingRemove && (
        <ConfirmDialog
          message={`Remove ${pendingRemove.name} from the tree? This does not delete any files.`}
          confirmLabel="Remove"
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => {
            const pending = pendingRemove
            setPendingRemove(null)
            api()
              .removeSubject(pending.projectId, pending.subjectId)
              .then((tree) => {
                replace(tree)
                setSubjectId(null)
              })
              .catch((e) => setError(errorText(e)))
          }}
        />
      )}
    </div>
  )
}
