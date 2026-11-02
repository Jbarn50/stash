# Stash — Undo and project trees plan

**Date:** 2026-11-02
**Spec:** `docs/superpowers/specs/2026-11-02-organize-and-undo-design.md`. Where they differ, the spec wins.

The decisions below are the ones that are easy to undo wrong. Follow them.

- Test first: a failing test, then the code.
- Before a commit: `npx vitest run --exclude tests/integration/roundTrip.test.ts`, `npm run typecheck`, `npx eslint` on the files, `npx prettier --check` on the files.
- Stage by path. Do not `git add -A`.
- `src/core` and `src/shared` do not import `electron`.
- Path checks go through `src/core/paths.ts`.
- No native npm dependencies.

## Phase 1 — Undo (done in this change)

Shipped:

- `latestUndoTarget` and `undoLatest`
- Undo bar, the result-summary Undo, and an Undo label on that batch in History
- Confirm copy that says Stash does not delete and does not empty the bin
- `startScan` refuses while a restore runs
- A failed cleanup-log write names the gap: the items are in the bin and Undo cannot see them

Left for a follow-up, not required to use Undo:

- Per-item undo: pass one finding id, filter the batch, call the same `restoreBatch`. Still no new movement code.
- Putting the unlogged cleanup into History. Today the user is told to use Explorer. Do not "fix" it by deleting the items.

## Phase 2 — project shell (done as a shell)

Shipped: the data model, `projects.json`, and the Projects screen. Photo wells on scenery and location are empty on purpose.

Not shipped, and not allowed while `FEATURES.organize` is false:

- `mkdir` of `rootPath` or of `character\Mara`
- any rename of a user file

When folder creation is built, `requireFeature('organize')` is the first line of that function, the flag flips in that same change, and a test proves a blocked root still creates nothing.

## Phase 3 — workflow import

1. Failing test: a hand-built PNG with an A1111 `parameters` chunk and a ComfyUI `prompt` chunk. `readWorkflowMeta` returns the prompt and, for ComfyUI, a workflow hash. A file with neither returns null. Do not execute the JSON.
2. Group with `likenessKey`. Two seeds of one prompt are one group. Two prompts are two groups.
3. Preview only. No moves.
4. Behind the flag: same-volume rename into the project, no overwrite, `organize-log.jsonl`, undo renames back. A test uses a throwaway directory and never a real user folder.

## Phase 4 — local hashes

1. dHash in the renderer. No `sharp`.
2. Distance suggests a subject. The person confirms. Nothing moves on its own.
3. Thumbnails through a named local scheme. CSP stays closed to the network.

## Phase 5 — remote names

Off until a person asks. One confirm per send. Thumbnails only. No vendor is hard-coded. A down network leaves phases 3 and 4 working.

## Do not

- Empty the Recycle Bin from any of these phases.
- Start phase 3 by turning `FEATURES.organize` on with no rename tests.
- Parse workflow JSON by evaluating it.
