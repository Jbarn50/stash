# Instructions for AI agents working on Stash

Read `docs/handover.md` first. It has the status, the next steps in order, and the rules below in full.

- **Where things are:**
  - The remaining tasks' briefs and decisions are in `docs/handover/`. Where a task's decisions differ from its brief, the decisions win.
  - The spec is in `docs/superpowers/specs/`, and the plan in `docs/superpowers/plans/`.
  - The decision ledger is `.superpowers/sdd/2026-11-01-space-cleanup/progress.md`: on this PC only, git-ignored. Search it for `Ruling:`, `minor (deferred)` and `Note → Task`.
- **Next steps:**
  1. Review Task 13 (`307befd..0ed91a3`).
  2. Task 14.
  3. Bring in Tasks 15–18 from branch `feat/space-cleanup-ui`.
  4. Task 19.
  5. The final review.
- **Working copy:** work on branch `feat/space-cleanup`. One agent writes here at a time; Claude has stopped writing as of 2026-11-02.
  - The GitHub remote `origin` is https://github.com/Jbarn50/stash (public).
  - Never push or merge without the user.
- **Never delete permanently.** Stash only ever moves user items to the Recycle Bin, through `shell.trashItem` behind the `Recycler` interface. It never empties the bin; the sole exception is Restore deleting a `$I…` record after moving its `$R…` back.
- **Tests never touch the user's real files.** The only test that uses the real Recycle Bin is `tests/integration/roundTrip.test.ts`. Leave it out of routine runs: `npx vitest run --exclude tests/integration/roundTrip.test.ts`.
- **Test first:**
  - write a failing test, watch it fail, then implement;
  - before each commit, run the suite, `npm run typecheck`, `npx eslint <files>` and `npx prettier --check <files>`.
- **Commits:** stage by explicit path, never `git add -A`. Git uses `core.autocrlf=true`, so run `npx prettier --write` on files git checked out before you lint them.
- **Code rules:**
  - Windows tools run by absolute System32 path through `execFile`, never through a shell.
  - Every path comparison goes through `src/core/paths.ts`.
  - `src/core` and `src/shared` never import `electron`.
