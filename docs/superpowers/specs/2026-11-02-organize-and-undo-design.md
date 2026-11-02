# Stash — Undo and project trees

**Date:** 2026-11-02
**Status:** Phase 1 is in the tree. Later phases are specified and not built.
**Builds on:** `docs/superpowers/specs/2026-11-01-space-cleanup-design.md`

Space & Cleanup stays as it is. This spec adds a one-click Undo, and the shell of a project tree. It does not add scheduled cleaning, permanent delete, or emptying the Recycle Bin.

## 1. What was asked for

| Ask                                                                                             | This spec                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| One-click Undo after an accidental clean                                                        | Phase 1. Reuses History's restore. Shipped.                                                                 |
| Auto-create folders from AI-tool workflow metadata                                              | Phase 3. A hook returns null. Not built.                                                                    |
| Visual recognition so like folders stay with like folders                                       | Phase 4 local hashes, phase 5 optional naming. A hook returns no labels. Not built.                         |
| Tree: Project → character, lore, scenery, location → names, with photos on scenery and location | Phase 2 shell. The screen remembers the tree. It does not create folders or move files. Shipped as a shell. |

## 2. Safety

These rules are unchanged, and the new code follows them:

- The only way Stash removes a user's file is `shell.trashItem`, behind `Recycler`. Undo does not call it.
- Stash never empties the Recycle Bin. Restore's only removals are the `$R` name after a hard link (the bytes stay at the restored path) and the `$I` record after the data is back.
- Undo calls the same `putBack` path as History's Restore. The renderer sends no path. The main process picks the batch id with `latestUndoTarget`, then `restoreBatch`.
- A drive is still cleaned only when its bin status is `'enabled'`.
- Organize, when it is built, will not delete. Moves will be same-volume renames inside a project the user chose, logged, and reversible by renaming back. If the old path is taken, that item fails and stays where it is. No overwrite, no recycle, no `unlink` of a user file. Cross-volume imports are refused. `FEATURES.organize` stays `false` until that phase, and any function that creates folders or moves files calls `requireFeature('organize')` first.
- The project screen writes `%APPDATA%\Stash\projects.json` only. It does not create the project's folders.

## 3. Undo

### 3.1 What "last cleanup" means

`latestUndoTarget` (`src/shared/undoTarget.ts`) reads History and returns the batch with the newest `startedAt` that `restorableCount` would still offer to Restore:

- status `recycled`
- not already `restored`
- not `purged` ("no longer in the Recycle Bin")
- a `failed` put-back can be tried again

Skipped items are not part of the count. The function returns a batch id and a count. It does not return paths.

The count is locked to `restorableCount` in `src/renderer/src/lib/historyStatus.ts` by a unit test. If those two diverge, Undo and the History button disagree.

### 3.2 Where the button is

- A bar on every screen, when there is something to put back. Confirm defaults to Cancel, same as Clean.
- The cleanup result summary has its own Undo for the batch just finished. It calls the same `undoLatest`.
- On History, that same batch's button is labeled Undo. Older batches stay Restore. Both still call `restoreBatch`.

Confirm copy states that items go back and that Stash does not delete them and does not empty the Recycle Bin.

### 3.3 What Undo does not do

- It does not put back a single file out of a batch. That is a later cut: filter the batch, then call the same `restoreBatch`. No new movement code.
- It cannot see a cleanup whose log line never got written. `runCleanup` still moves first and appends after. If the append throws, the error now says the items are in the Recycle Bin and Undo cannot see them, and to restore them from Explorer.
- After a successful undo, the in-memory scan is not rewritten. Scan again to see the files.
- A scan cannot start while a restore or a clean is running. `startScan` used to allow a scan during restore. It now refuses with `busy`, matching clean.

### 3.4 IPC

`undoLatest(): Promise<UndoOutcome>` takes no arguments.

| Status    | Meaning                                                  |
| --------- | -------------------------------------------------------- |
| `nothing` | No batch still has items in the bin. Nothing is logged.  |
| `busy`    | A clean or a restore is already running.                 |
| `done`    | `record` is the same `RestoreRecord` History would show. |

`FEATURES.undo` is `true`. `undoLatest` calls `requireFeature('undo')` before it does anything.

## 4. Project tree

### 4.1 Shape

Stored as `projects.json` next to `settings.json` and `cleanup-log.jsonl`. One object per project:

```json
{
  "version": 1,
  "id": "<id>",
  "name": "Ashfen",
  "rootPath": "D:\\Stories\\Ashfen",
  "branches": [
    { "kind": "inbox", "subjects": [] },
    { "kind": "character", "subjects": [{ "id": "<id>", "name": "Mara", "folder": "Mara" }] },
    { "kind": "lore", "subjects": [] },
    { "kind": "scenery", "subjects": [] },
    { "kind": "location", "subjects": [] }
  ]
}
```

Branch order is fixed: inbox, character, lore, scenery, location. Inbox is the holding branch for a later import that has no name yet. The four branches Jordan named follow it.

A subject's `folder` is a single Windows folder segment (`folderSegment` in `src/core/projects/tree.ts`): no `..`, no reserved device name, no trailing dot or space, 80 characters at most. `name` and `folder` are the same string. The same folder may exist on two branches (`character\Mara` and `location\Mara`). It may not exist twice on one branch; Windows ignores case.

`rootPath` has to be a plain drive path (`isPlainDrivePath`) and not blocked (`isBlocked`). A folder inside Documents is allowed. Documents itself, `C:\Windows`, another user's profile, and Stash's own folders are not. The shell records the path. It does not create it.

Scenery and location subjects show an empty photo well ("Photos for this look / place will show here"). Character, lore, and inbox do not. Nothing is decoded and nothing is sent anywhere.

Removing a name edits `projects.json` only, after a confirm that says no files are deleted.

A file that is not valid JSON, or that fails `isProjectTree`, is renamed `projects.json.bad` and the list starts empty. Same idea as a bad `settings.json`.

### 4.2 IPC

| Method                                | Effect                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| `getProjects`                         | The stored trees.                                                 |
| `createProject(name, rootPath)`       | Appends one empty tree, or throws if the name or root is refused. |
| `addSubject(projectId, kind, name)`   | Appends one subject.                                              |
| `removeSubject(projectId, subjectId)` | Drops one subject from the record.                                |

Arguments are checked in the main process. A bad id is `invalid argument`.

### 4.3 Flag

`FEATURES.organize` is `false`. The shell does not consult it, because the shell does not touch the user's files. The first function that creates a project folder or moves a file must call `requireFeature('organize')` and must not ship until that flag is turned on in the same change.

## 5. Later phases

Do not start these until the phase above them is in and tested. Vision and workflow parsing stay behind the hooks in `src/core/projects/hooks.ts`.

### Phase 3 — workflow metadata

Read PNG text chunks locally (`parameters`, ComfyUI `prompt` / `workflow`). No network. `readWorkflowMeta` is the hook; it returns null.

Group with `likenessKey` (`src/core/projects/likeness.ts`):

- a workflow hash groups together, whatever the seed
- otherwise the normalized prompt and model
- seed is not part of the key
- no prompt and no workflow hash means the file is not grouped (`null`) and stays in Inbox until a person names it

Show a preview. Create folders and rename only after confirm, only on the same volume, only inside the project root, only when `FEATURES.organize` is on. Log each rename in a new `organize-log.jsonl`, not in the cleanup log. Undo of that log is a rename back. Never overwrite.

Suggested folder names come from `folderSegment`, not from the raw prompt. The person can edit the name before anything moves.

### Phase 4 — local likeness

Difference hash in the renderer, where Chromium already decodes png, jpeg, webp, and gif. No native addon (`sharp` stays out; the Space spec forbids compiled npm dependencies). The main process stores hashes, not pixels.

Hamming distance suggests "same look" and which existing subject is nearby. Suggestions only. Like-with-like ordering of subjects uses those hashes; alphabetical order remains the fallback. `proposeVisionLabels` stays empty in this phase: a hash is not a name.

Thumbnails, when they are shown, need a CSP change that names a local scheme. Do not open `img-src` to `https:` or `file:`. Today it is `'self' data:`.

### Phase 5 — optional remote names

Off. A provider key stays in the main process and is never written to the cleanup log. Each send is a confirm that says how many thumbnails and which host. One small JPEG per cluster, not the original. The reply may suggest a branch and a name. Low confidence stays in Inbox. If the network is down, phases 3 and 4 still work.

The Space spec named Claude as a fallback for a future Projects module. This spec does not hard-code a vendor.

## 6. Out of scope

- Emptying the Recycle Bin, or deleting a file permanently.
- Per-item undo (a small follow-up on the same restore path).
- Scheduled or automatic organize.
- Scanning the whole drive for images.
- The Icons and Security modules.
- Replacing the Explore treemap. That view is disk space. This tree is a project.

## 7. Tests that lock the safety

| Rule                                                                       | Test                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Undo picks the newest restorable batch and no other                        | `tests/unit/undoTarget.test.ts`, `tests/unit/ipcHandlers.test.ts` (`undoLatest`) |
| Undo does not call `trash`, and the only `unlink` paths are inside the bin | `undoLatest` in `tests/unit/ipcHandlers.test.ts`                                 |
| A fully restored batch logs nothing                                        | same                                                                             |
| Undo is busy while a clean runs                                            | same                                                                             |
| A scan is refused while a restore runs                                     | `restoreBatch` in `tests/unit/ipcHandlers.test.ts`                               |
| A failed History write says Undo cannot see the items                      | `tests/unit/cleanup.test.ts`                                                     |
| A project root under Windows is refused and no file is written             | `tests/unit/projectsStore.test.ts`                                               |
| Creating a project writes `projects.json` only                             | same                                                                             |
| Removing a name does not create folders                                    | same                                                                             |
| Vision and workflow hooks return nothing                                   | `tests/unit/projectHooks.test.ts`                                                |
