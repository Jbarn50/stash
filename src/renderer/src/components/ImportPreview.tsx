import type { GroupReason, ProposedGroup } from '../../../shared/organize'
import type { BranchKind } from '../../../shared/projects'

const BRANCH_LABEL: Record<BranchKind, string> = {
  inbox: 'Inbox',
  character: 'Character',
  lore: 'Lore',
  scenery: 'Scenery',
  location: 'Location'
}

const REASON: Record<GroupReason, string> = {
  workflow: 'Same workflow',
  look: 'Same look',
  inbox: 'No shared name yet'
}

export interface ImportDraft {
  branch: BranchKind
  folder: string
  useNearby: boolean
}

function baseName(path: string): string {
  const parts = path.split('\\')
  return parts[parts.length - 1] || path
}

/** The groups Stash would file. Editing a name or a branch changes nothing until Move. */
export default function ImportPreview({
  groups,
  drafts,
  thumbs,
  onDraft,
  onCancel,
  onMove
}: {
  groups: ProposedGroup[]
  drafts: Record<string, ImportDraft>
  thumbs: Record<string, string>
  onDraft: (id: string, patch: Partial<ImportDraft>) => void
  onCancel: () => void
  onMove: () => void
}): React.JSX.Element {
  const count = groups.reduce((sum, group) => sum + group.paths.length, 0)
  return (
    <section className="card import-preview" aria-label="Import preview">
      <h2>Preview</h2>
      <p className="muted">
        {count} {count === 1 ? 'file' : 'files'} grouped. Change a name or a branch, then move them.
        Nothing has been renamed.
      </p>
      {groups.map((group) => {
        const draft = drafts[group.id] ?? {
          branch: group.branch,
          folder: group.folder,
          useNearby: group.nearbySubjectId !== null
        }
        const locked = draft.useNearby && group.nearbySubjectId !== null
        return (
          <article key={group.id} className="import-group">
            <p>
              <strong>{REASON[group.reason]}</strong>
              {group.folder !== '' && <span className="muted"> · suggested “{group.folder}”</span>}
            </p>
            <div className="import-thumbs">
              {group.paths.map((path) =>
                thumbs[path] ? (
                  <img key={path} src={thumbs[path]} alt={baseName(path)} />
                ) : (
                  <span key={path} className="import-file">
                    {baseName(path)}
                  </span>
                )
              )}
            </div>
            {group.nearbySubjectId !== null && (
              <label className="import-nearby">
                <input
                  type="checkbox"
                  checked={draft.useNearby}
                  onChange={(e) => onDraft(group.id, { useNearby: e.target.checked })}
                />
                File with {group.nearbyName} (same look)
              </label>
            )}
            <div className="row">
              <label>
                Branch
                <select
                  aria-label={`Branch for ${group.folder || 'inbox group'}`}
                  value={draft.branch}
                  disabled={locked}
                  onChange={(e) => onDraft(group.id, { branch: e.target.value as BranchKind })}
                >
                  {(Object.keys(BRANCH_LABEL) as BranchKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {BRANCH_LABEL[kind]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Folder name
                <input
                  aria-label={`Folder name for group ${group.id}`}
                  value={draft.folder}
                  disabled={locked}
                  onChange={(e) => onDraft(group.id, { folder: e.target.value })}
                />
              </label>
            </div>
            {draft.branch !== 'inbox' && draft.folder.trim() === '' && !locked && (
              <p className="muted">Add a folder name, or leave the branch on Inbox.</p>
            )}
          </article>
        )
      })}
      <div className="row">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={onMove} disabled={count === 0}>
          Move into project
        </button>
      </div>
    </section>
  )
}
