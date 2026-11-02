import { useEffect, useState } from 'react'
import { orderByLikeness } from '../../../shared/dhash'
import type {
  ConfirmedGroup,
  ImportFileInput,
  ImportPreview as ImportPreviewModel
} from '../../../shared/organize'
import { branchHoldsPhotos, type BranchKind, type ProjectTree } from '../../../shared/projects'
import ConfirmDialog from '../components/ConfirmDialog'
import ImportPreview, { type ImportDraft } from '../components/ImportPreview'
import { api, errorText, maybeApi } from '../lib/api'
import { inspectImage } from '../lib/dhash'

const BRANCH_LABEL: Record<BranchKind, string> = {
  inbox: 'Inbox',
  character: 'Character',
  lore: 'Lore',
  scenery: 'Scenery',
  location: 'Location'
}

/** The project tree. Import suggests groups; files move only after confirm. */
export default function Projects(): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectTree[] | null>(null)
  const [hashes, setHashes] = useState<Record<string, string[]>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [subjectId, setSubjectId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [rootPath, setRootPath] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<BranchKind, string>>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pendingRemove, setPendingRemove] = useState<{
    projectId: string
    subjectId: string
    name: string
  } | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [preview, setPreview] = useState<ImportPreviewModel | null>(null)
  const [previewProjectId, setPreviewProjectId] = useState<string | null>(null)
  const [importDrafts, setImportDrafts] = useState<Record<string, ImportDraft>>({})
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [fileHashes, setFileHashes] = useState<Record<string, string | null>>({})
  const [pendingMove, setPendingMove] = useState(false)
  const [pendingUndo, setPendingUndo] = useState(false)

  const replace = (tree: ProjectTree): void => {
    setProjects((list) => (list ?? []).map((item) => (item.id === tree.id ? tree : item)))
    setSelectedId(tree.id)
  }

  useEffect(() => {
    const stash = maybeApi()
    if (!stash) return
    let alive = true
    Promise.all([stash.getProjects(), stash.getSubjectHashes()])
      .then(([list, stored]) => {
        if (!alive) return
        setProjects(list)
        setHashes(stored)
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

  const startImport = (): void => {
    if (!project) return
    setError(null)
    setNotice(null)
    setImportBusy(true)
    const projectId = project.id
    api()
      .pickImages()
      .then(async (paths) => {
        if (paths === null || paths.length === 0) return
        const nextThumbs: Record<string, string> = {}
        const nextHashes: Record<string, string | null> = {}
        const files: ImportFileInput[] = []
        for (const path of paths) {
          const image = await api().readImportImage(path)
          let dhash: string | null = null
          if (image) {
            const inspected = await inspectImage(image.base64, image.mime)
            dhash = inspected.dhash
            if (inspected.thumb) nextThumbs[path] = inspected.thumb
          }
          nextHashes[path] = dhash
          files.push({ path, dhash })
        }
        const suggestion = await api().previewImport(projectId, files)
        const nextDrafts: Record<string, ImportDraft> = {}
        for (const group of suggestion.groups) {
          nextDrafts[group.id] = {
            branch: group.branch,
            folder: group.folder,
            useNearby: group.nearbySubjectId !== null
          }
        }
        setThumbs(nextThumbs)
        setFileHashes(nextHashes)
        setImportDrafts(nextDrafts)
        setPreviewProjectId(projectId)
        setPreview(suggestion)
      })
      .catch((e) => setError(errorText(e)))
      .finally(() => setImportBusy(false))
  }

  const moveCount = preview?.groups.reduce((sum, group) => sum + group.paths.length, 0) ?? 0

  const confirmMove = (): void => {
    if (!preview || previewProjectId === null) return
    const groups: ConfirmedGroup[] = preview.groups.map((group) => {
      const draft = importDrafts[group.id] ?? {
        branch: group.branch,
        folder: group.folder,
        useNearby: false
      }
      const useNearby = draft.useNearby && group.nearbySubjectId !== null
      return {
        branch: draft.branch,
        folder: useNearby ? '' : draft.folder,
        subjectId: useNearby ? group.nearbySubjectId : null,
        paths: group.paths,
        hashes: group.paths.map((path) => fileHashes[path] ?? null)
      }
    })
    setPendingMove(false)
    setError(null)
    setNotice(null)
    api()
      .confirmImport(previewProjectId, groups)
      .then(async (result) => {
        if (result.project) replace(result.project)
        setHashes(await api().getSubjectHashes())
        setPreview(null)
        setPreviewProjectId(null)
        const failed = result.moves.filter((move) => move.status === 'failed')
        const moved = result.moves.filter((move) => move.status === 'moved').length
        if (result.status === 'refused') setError(result.reason ?? 'Those files stayed put.')
        else if (failed.length > 0) {
          setError(`${moved} moved. ${failed.length} stayed put. ${failed[0]?.reason ?? ''}`.trim())
        } else setNotice(`Moved ${moved} ${moved === 1 ? 'file' : 'files'}.`)
      })
      .catch((e) => setError(errorText(e)))
  }

  return (
    <div className="screen">
      <h1>Projects</h1>
      <p className="muted">
        Import images and Stash suggests groups from the workflow and from how they look. Nothing
        moves until you confirm.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <p className="muted">{notice}</p>}
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
                setPreview(null)
                setPreviewProjectId(null)
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
              <div className="row">
                <button onClick={startImport} disabled={importBusy}>
                  {importBusy ? 'Reading images…' : 'Import images'}
                </button>
                <button onClick={() => setPendingUndo(true)}>Undo last organize</button>
              </div>
              <ul className="project-tree">
                {project.branches.map((branch) => (
                  <li key={branch.kind}>
                    <strong>{BRANCH_LABEL[branch.kind]}</strong>
                    {branch.kind === 'inbox' && <div className="muted">Not filed yet.</div>}
                    <ul>
                      {orderByLikeness(branch.subjects, hashes).map((item) => (
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
      {preview && project && (
        <ImportPreview
          groups={preview.groups}
          drafts={importDrafts}
          thumbs={thumbs}
          onDraft={(id, patch) =>
            setImportDrafts((current) => ({
              ...current,
              [id]: {
                branch: current[id]?.branch ?? 'inbox',
                folder: current[id]?.folder ?? '',
                useNearby: current[id]?.useNearby ?? false,
                ...patch
              }
            }))
          }
          onCancel={() => {
            setPreview(null)
            setPreviewProjectId(null)
          }}
          onMove={() => setPendingMove(true)}
        />
      )}
      {preview && preview.skipped.length > 0 && (
        <p className="muted">{preview.skipped.length} files could not be read and were left out.</p>
      )}
      {pendingMove && (
        <ConfirmDialog
          message={`Move ${moveCount} files into this project? Stash renames them inside the project folder and records each rename so it can be undone. This does not delete any files.`}
          confirmLabel="Move files"
          onCancel={() => setPendingMove(false)}
          onConfirm={confirmMove}
        />
      )}
      {pendingUndo && (
        <ConfirmDialog
          message="Put the last organize back? A file whose old path is taken stays where it is. This does not delete any files."
          confirmLabel="Undo organize"
          onCancel={() => setPendingUndo(false)}
          onConfirm={() => {
            setPendingUndo(false)
            setError(null)
            setNotice(null)
            api()
              .undoOrganize()
              .then((result) => {
                if (result.status === 'nothing') setError('There is no organize to undo.')
                else if (result.failed > 0) {
                  setError(`${result.movedBack} put back. ${result.failed} stayed where they are.`)
                } else
                  setNotice(
                    `Put ${result.movedBack} ${result.movedBack === 1 ? 'file' : 'files'} back.`
                  )
              })
              .catch((e) => setError(errorText(e)))
          }}
        />
      )}
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
