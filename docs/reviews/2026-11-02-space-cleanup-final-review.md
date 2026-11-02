# Space & Cleanup — final review

Reviewed `feat/space-cleanup` at `94c3ba9` against the design spec, the 19-task plan, and `docs/handover/`. There is no `main` branch on the remote. `origin/HEAD` is `feat/space-cleanup`, and the history starts at the design spec (`17b7f4f`), so this is a review of the whole product, not a diff against an older app.

The git-ignored decision ledger (`.superpowers/sdd/2026-11-01-space-cleanup/progress.md`) is not in this tree. Rulings and `minor (deferred)` lines from that file are not in this review. Paste them if a ruling audit is still required.

`docs/handover.md` still describes Task 14 as not started and Tasks 15–18 as unmerged. That was true when the handover was written. The branch has since landed `3098725` (Task 14), pull request #1 (`bba1707`, Tasks 15–18), the e2e round trip (`6917c9b`), and the scan-size fixes through `94c3ba9`.

Icon and shortcut work that landed with this review is described in `docs/installer.md`. It is not one of the findings below.

## What is done

Tasks 1–18 are implemented.

| Area                                          | Where it lives                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Window hardening, CSP, Vitest, Playwright     | `src/main/index.ts`, `src/renderer/index.html`, `tests/e2e/security.spec.ts`        |
| Paths, settings, blocklist                    | `src/core/paths.ts`, `src/core/settings.ts`, `src/core/blocklist.ts`                |
| Scan tree, walker, locked root files          | `src/core/tree.ts`, `src/core/scan/`                                                |
| Four waste detectors plus duplicates          | `src/core/detectors/`, `src/core/hash.ts`, `src/core/keeper.ts`                     |
| Scan and hash workers, session                | `src/workers/`, `src/main/session.ts`                                               |
| Recycle Bin status, capacity, `$I` lookup     | `src/core/recycleBinInfo.ts`, `src/main/recycleBin.ts`                              |
| Settings and cleanup log                      | `src/main/settings.ts`, `src/main/cleanupLog.ts`                                    |
| Cleanup, only through `shell.trashItem`       | `src/main/cleanup.ts`, wired in `src/main/index.ts`                                 |
| Restore                                       | `src/main/restore.ts` (files come back by hard link, `0c810b0`)                     |
| IPC, preload, elevation, environment          | `src/main/ipc.ts`, `src/preload/index.ts`, `src/main/elevate.ts`, `src/main/env.ts` |
| Overview, Explore, Cleanup, History, Settings | `src/renderer/src/screens/`                                                         |

Task 19 is partly done. The e2e round trip is in `tests/e2e/app.spec.ts`. NSIS settings and `docs/manual-checks.md` are in the tree. Nobody has recorded a result for the manual checks, and this review did not build `Stash-Setup-0.1.0.exe` (that needs Windows).

## Safety

No production path permanently deletes a user's file or empties the Recycle Bin.

- The only removal of a user item is `shell.trashItem`, behind `Recycler`, in `src/main/index.ts`.
- Cleanup refuses a drive whose bin is disabled or unconfirmed, refuses items larger than the bin, and re-checks each path immediately before the move (`src/main/cleanup.ts`).
- The blocklist is applied in the main process at move time, not only in the renderer.
- Restore's only `unlink` calls are the `$R` name after a hard link (the bytes stay at the restored path) and the `$I` record after the data is back. `ENOENT` on either is ignored. A failed `$I` removal still counts as restored.
- A file is restored with `link()`, which fails with `EEXIST` rather than replacing anything. A drive that cannot hard-link fails the item and leaves it in the bin.
- `clean` takes finding ids. `restoreBatch` takes a batch id. Bad arguments throw. A clean and a scan cannot overlap. An incomplete or stale scan cannot be cleaned.
- `src/core` and `src/shared` do not import `electron`. The preload exposes `window.stash` only.

The test helper `tests/helpers/psRecycler.ts` can permanently delete if the bin is off or the file is too big. The app does not use it. The real-bin tests preflight `status === 'enabled'` and only recycle files they created under `.test-recycle`.

## Findings to act on

Nothing here is a "Stash deleted it" bug. The first three are the ones worth a decision before calling v1 finished.

### Important

1. **A scan can start while a restore is running.** `startScan` in `src/main/ipc.ts` only refuses while `working === 'clean'`. Restore sets `working` to `'restore'`, and `clean` already refuses any `working` value, but `startScan` does not. A new scan can replace `session.latest` mid-restore. The bin itself is not corrupted. `tests/unit/ipcHandlers.test.ts` covers "scan during clean" and not "scan during restore". Task 14 decision 7 only required the clean/scan rule, so this is an extension, not a missed requirement. Recommended: treat restore like clean, with a failing test first.

2. **Restore trusts the cleanup log's original path.** `restorablePath` in `src/main/restore.ts` rejects relative paths, NTFS streams, and anything inside `$Recycle.Bin`. It does not re-apply the blocklist. Cleanup will not log a successful recycle of a blocklisted path. A hand-edited `cleanup-log.jsonl` could still name a free path such as somewhere under `C:\Windows`, and a file restore would create a new file there (it would not overwrite). Decide whether a local user editing their own log is in the threat model. If it is, refuse blocklisted targets and test it.

3. **Folder restore can still replace a file created in a tiny window.** Files use the hard link, so nothing can land in between. Folders cannot be hard-linked. `restore.ts` checks the target, then `rename`s. The race is documented at the top of that file. Leaving it is reasonable. Do not "fix" it by falling back to `rename` for files.

4. **If the cleanup log cannot be written, the items are already in the bin and History has no batch.** `runCleanup` appends only after the moves. The IPC call then rejects, and `session.removeFindings` does not run. The user has to restore from Explorer. The code comments say this on purpose. The gap is the message: the UI gets a thrown error, not a sentence that says the items are in the bin and were not logged. Worth a dedicated outcome if History is how people expect to undo.

### Minor

5. **"Stash couldn't measure it"** is a real skip reason (`cleanup.ts`, unreadable folders) and is tested, but it is not in the plan's fixed-copy list. Say so in the spec or treat the code as the list.

6. **`startScan` reports busy by throwing `Error('busy')`.** `clean` returns `{ status: 'rejected', reason: 'busy' }`. The renderer has to handle both shapes.

7. **`tests/e2e/security.spec.ts` does not assert that `window.electron` is absent.** The preload is correct. A one-line assertion would lock the spec §4.1 rule.

8. **macOS camera/microphone usage strings and Linux AppImage/snap/deb targets are still in `electron-builder.yml`.** They are electron-vite leftovers. Harmless for a Windows-only ship. Delete them when the config is next touched for packaging, not as a drive-by.

## Test coverage

Safety rules that have tests:

| Rule                                                        | Tests                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Blocklist, including path aliases                           | `tests/unit/blocklist.test.ts`, `tests/unit/cleanup.test.ts`                       |
| Bin off, unconfirmed, too big, overflow confirm             | `tests/unit/cleanup.test.ts`, `tests/unit/recycleBin.test.ts`                      |
| Changed since scan, duplicate keeper                        | `tests/unit/cleanup.test.ts`, e2e in `tests/e2e/app.spec.ts`                       |
| Stale and incomplete scan ids                               | `tests/unit/session.test.ts`, `tests/unit/ipcHandlers.test.ts`                     |
| File restore does not overwrite; no hard links fails closed | `tests/unit/restore.test.ts`                                                       |
| `$I` removed only after the data is back; `ENOENT` ignored  | `tests/unit/restore.test.ts`                                                       |
| Real Recycle Bin round trip                                 | `tests/integration/roundTrip.test.ts` (Windows only; leave it out of routine runs) |
| UI recycle and restore, and the changed-folder skip         | `tests/e2e/app.spec.ts`                                                            |
| IPC argument checks, elevation quoting                      | `tests/unit/ipcValidation.test.ts`, `tests/unit/elevate.test.ts`                   |

Not covered, matching the findings above: scan during restore, restore of a blocklisted target, the folder rename race under concurrency, and the wording when the log append fails.

Windows-only integration tests are wrapped in `describe.runIf(process.platform === 'win32')`. The e2e file is not. On Linux, `npm run test:e2e` will launch Electron and the recycle/restore cases will not exercise the Windows bin. Do not paper over that by deleting assertions.

The handover's "576 tests" figure is a Windows run. A Linux run of `npx vitest run --exclude tests/integration/roundTrip.test.ts` on 2026-11-02 reported **539 passed, 27 skipped, 108 failed**. The failures are Windows assumptions, not regressions from the icon work, and they should not be weakened to go green here:

- `tests/unit/restore.test.ts` (76). The sandbox allows a path only when it starts with the temp folder plus a backslash. On Linux the temp folder is `/tmp/...`, so every `mkdir` is reported as outside the sandbox, including the test's own bin.
- `tests/unit/cleanup.test.ts` (26). Fixture paths under `/tmp` have no drive letter, so the blocklist fails closed and the items come back `protected` instead of recycled.
- `tests/unit/env.test.ts` (3). `dirname` of a `C:\Users\...` path uses the Linux `path` module.
- One each in `overview.test.ts` (no Windows drive for `statfs`), `psRecycler.test.ts`, and `recycleBin.test.ts` (absolute `System32` paths).

`npm run typecheck` is clean on this tree.

## Installer readiness

Configured and documented in `docs/installer.md`:

- Assisted NSIS, user-chosen directory, artifact name `Stash-Setup-${version}.exe`.
- Desktop shortcut `always`, Start menu shortcut on, both using the exe icon.
- `build/icon.ico` is a 10-size icon, explicitly set as `win.icon`, `installerIcon`, and `uninstallerIcon`.
- Docs, tests, spikes, and `scripts/` are excluded from the package.
- `npm run build` emits both worker chunks once `src/main/index.ts` imports the runners. That import is in place.

Not done, and blocking a real ship:

- No Authenticode certificate. SmartScreen will warn. `docs/manual-checks.md` row 1 says so, and its Result column is empty.
- Rows 2–5 (C: scan within 5% of Explorer, `hiberfil.sys` / `pagefile.sys`, a cloud-only OneDrive file, `C:\Windows\Temp` after an admin rescan) need a person at the machine. Do not run Cleanup on real files to complete them.
- `npm run build:win` was not run here.

## Recommended order

1. On Windows: `npx vitest run --exclude tests/integration/roundTrip.test.ts`, `npm run typecheck`, `npm run test:e2e`, then `npm run build:win`.
2. Install `dist\Stash-Setup-0.1.0.exe` and fill `docs/manual-checks.md`, including that the desktop shortcut shows the new icon.
3. Decide findings 1, 2, and 4. Fix 1 with a failing test first if the answer is "block it".
4. Paste the ledger's `Ruling:` and `minor (deferred)` lines and check this review against them.
5. Merging to `main` stays a user decision. There is no `main` branch to merge to yet.
