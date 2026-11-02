# Stash — handover (2026-11-02)

This document hands the Stash build to another AI. It is self-contained. When it names a file you cannot open, ask the user to paste it.

## What Stash is

Stash is a Windows desktop app (Electron 45 + TypeScript + React, built with electron-vite) for managing a user's files. Its first module, **Space & Cleanup v1**, is what is being built here:

- it scans a drive and shows what takes up space;
- it finds waste: duplicates, temp files and caches, old installers and stale files, and dev and creative leftovers;
- it moves what the user picks **to the Recycle Bin**. It never deletes anything permanently;
- History can restore a cleanup.

- **Repo:** https://github.com/Jbarn50/stash (public). The default branch is **`feat/space-cleanup`**; never work on `main`. On the user's PC it lives at `C:\Users\jorda\Software\stash`.
- **Screens (Tasks 15–18):** branch **`feat/space-cleanup-ui`** in the same repo: four commits on `ce64788`.
- **Spec (the authority):** `docs/superpowers/specs/2026-11-01-space-cleanup-design.md`
- **Plan (19 tasks):** `docs/superpowers/plans/2026-11-01-space-cleanup.md`
- **Inputs for the remaining tasks:** `docs/handover/`, holding `task-13-brief.md`, `task-13-decisions.md`, `task-14-brief.md`, `task-14-decisions.md` and `task-19-brief.md`. Where a task's decisions differ from its brief, the decisions win.
- **Decision record (the ledger):** kept on the user's PC only, not published. It is at `.superpowers/sdd/2026-11-01-space-cleanup/progress.md` and is git-ignored.
  - Every `Ruling:` line is a decision, with its cost if wrong.
  - `minor (deferred)` lines are small issues set aside for the final review.
  - `Note → Task N` lines are instructions carried to a later task.
  - If you need a past decision, ask the user to paste the relevant lines.

## Status

| Task                                            | State                                                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–11                                            | Done and reviewed.                                                                                                                                                                             |
| 12 Cleanup engine                               | Done and reviewed (built in a helper clone, cherry-picked as `1d93705`). Fix `307befd`: a kept duplicate counts only while it still matches the scan.                                          |
| 13 Restore engine + real Recycle Bin round trip | Committed `0ed91a3`. Tests pass: 65 unit tests, and the round trip ran once, 5/5, leaving the bin unchanged. **Its code review was cut off by an API spend limit, so it is still unreviewed.** |
| 14 IPC, preload, environment, elevation, wiring | **Not started**; the implementer stopped before writing anything. Its instructions are ready: `task-14-brief.md` and `task-14-decisions.md` (18 points plus amendments A–E).                   |
| 15–18 Screens (renderer)                        | Built on branch `feat/space-cleanup-ui`, commits `9c1e958 7fc7ac5 8f494e8 058091b` (on `ce64788`). Not yet brought in.                                                                         |
| 19 E2E, installer, manual checks                | Installer settings and `docs/manual-checks.md` are done (`7c6738c`). The e2e round trip and final verification remain.                                                                         |
| Final whole-branch review                       | Not started.                                                                                                                                                                                   |

The suite passes: 576 tests, plus the real-bin round trip (5). Typecheck is clean.

## Next steps, in order

1. **Review Task 13** (diff `307befd..0ed91a3`) against `task-13-brief.md` and `task-13-decisions.md`, which win where they differ.
   - Look hardest at:
     - whether `restoreBatch` can ever overwrite an existing file (Node's `rename` replaces a file on Windows) or be steered by an odd log entry;
     - `$I` handling: unlinked only after its `$R` moved back, ENOENT ignored;
     - the `restoredName` rules;
     - the round-trip test's `afterAll` safety net.
   - Fix any finding with a failing test first.
2. **Task 14:** implement it from `task-14-brief.md` and `task-14-decisions.md`.
   - `window.stash` must match the brief's `StashApi` block exactly.
   - Record lookups use the batched `findRecycledRecords`.
   - The Recycle Bin usage is cached, never computed per call.
   - `parseScanRoot` uses `isPlainDrivePath`.
   - Clean and scan never overlap.
   - The renderer receives all four rejection reasons, including `'incomplete-scan'`.
   - `npm run build` must emit both worker chunks (scan and hash) into `out/main`.
3. **Bring in Tasks 15–18.** Run `git fetch origin feat/space-cleanup-ui`, then cherry-pick the four commits.
   - On the `src/shared/ipc.ts` conflict, keep Task 14's version.
   - Delete `src/renderer/src/stash.d.ts`.
   - Remove the template's `window.electron`/`window.api` bridge, its `ping` handler and `components/Versions.tsx` (amendment A; spec §4.1 allows only `window.stash`).
   - Run `npx prettier --write` on cherry-picked files: `core.autocrlf=true` gives them CRLF.
   - Then run the tests, typecheck, lint, build and `npm run test:e2e`.
4. **Task 19:** follow `task-19-brief.md`.
   - The e2e round trip goes in `tests/e2e/app.spec.ts`. Its fixture lives in the git-ignored repo folder `.test-recycle`, not `os.tmpdir()`.
   - Rebuild the installer with `npm run build:win`.
   - The manual checks in `docs/manual-checks.md` need the user: installing, and the UAC prompt.
5. **Final whole-branch review** against the spec, the plan and the ledger's rulings.
   - Fix Critical and Important findings with a failing test first.
   - Merging, pushing and PRs are the user's decision.

## Rules that must not be broken

- **Nothing is deleted permanently.**
  - The only way Stash removes a user item is `shell.trashItem`, behind the `Recycler` interface.
  - Stash never empties the Recycle Bin. The sole exception: Restore deletes a `$I…` record after moving its `$R…` back.
  - A drive is cleaned only when its bin status is `'enabled'`.
- **Tests never touch the user's real files.**
  - The only test that uses the real Recycle Bin is `tests/integration/roundTrip.test.ts`. It recycles only files it creates under `.test-recycle\stash-roundtrip-*`, and puts them back in `afterAll`.
  - Leave it out of routine runs: `npx vitest run --exclude tests/integration/roundTrip.test.ts`.
- **Windows tools** run by absolute System32 path, through `execFile`, never through a shell. Under Git Bash, a bare `whoami` runs Git's coreutils.
- **Paths:** every comparison goes through `src/core/paths.ts`. Never call raw `startsWith` on paths.
- **Imports:** `src/core` and `src/shared` never import `electron`. The renderer imports only `src/shared` and its own files.
- **Test first:**
  - write a failing test, watch it fail, then implement;
  - before every commit, run the suite, `npm run typecheck`, `npx eslint` and `npx prettier --check`.
- **Commits:**
  - stage files by explicit path, never `git add -A`;
  - stay on `feat/space-cleanup`;
  - never push or merge without the user.
- **Running the app:** the Claude desktop app may redirect AppData/%TEMP% writes made from its shells (MSIX). Run installed-app checks from the user's own terminal.

## Commands

| Purpose                                         | Command                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| Unit + integration tests (without the real bin) | `npx vitest run --exclude tests/integration/roundTrip.test.ts`            |
| Types and lint                                  | `npm run typecheck`, `npx eslint <files>`, `npx prettier --check <files>` |
| Build the app                                   | `npm run build`                                                           |
| End-to-end (Playwright + Electron)              | `npm run test:e2e`                                                        |
| Installer                                       | `npm run build:win` → `dist\Stash-Setup-0.1.0.exe`                        |

## Where the decisions are

- **The remaining tasks' briefs and decisions:** `docs/handover/` in the repo.
- **The ledgers** (on the user's PC only, not published):
  - this repo's `.superpowers/sdd/2026-11-01-space-cleanup/progress.md`;
  - the helper clone's, covering Tasks 12 and 15–18, copied into the same folder as `progress-ahead-snapshot.md`.
  - Search them for `Ruling:`, `minor (deferred)` and `Note → Task`; ask the user to paste what you need.
- **The final report** to the user must list every ruling with its cost if wrong, and every deferred minor.
