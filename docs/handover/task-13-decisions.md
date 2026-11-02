# Task 13 — controller decisions (binding; they settle what the brief leaves open)

1. **The real round trip never uses `os.tmpdir()`.** Its files live in a git-ignored, test-owned folder inside the repo: `<repo>/.test-recycle/`.
   - Add the line `.test-recycle` to `.gitignore` (stage `.gitignore` by explicit path).
   - Each run makes `mkdtempSync(join(<repo>/.test-recycle, 'stash-roundtrip-'))`, so every test item's path contains `stash-`.
   - Why: the Claude desktop app is MSIX-packaged, and a session shell's writes under `%TEMP%`/AppData may be redirected to a private folder. A redirected path would make the `$I` record's original path disagree with the path the test recycled. The Global Constraint's intent, "tests never touch the user's real files", still holds: only files the test created are recycled.
   - Find the repo root from the test file's location (`fileURLToPath(new URL('../..', import.meta.url))` or `process.cwd()`, which vitest sets to the repo root).
2. **Task 12's real interface wins over the brief's sample.** `CleanupDeps` has `findRecords` (batched), not `findRecord`. The round trip passes:
   - `findRecords: findRecycledRecords`
   - `binInfo: getRecycleBinInfo`
   - `recycler: psRecycler`
   - `env: realEnv()`
   - `now: Date.now`
   - `log`: a `CleanupLog` whose folder is inside the test-owned folder.
3. **Restore only what was recycled.**
   - Items whose status is `skipped` were never in the bin. They are left out of the `RestoreRecord` entirely, not listed as failed.
   - An item with status `recycled` but no `recycledAs` → `failed`, reason "Stash couldn't find it in the Recycle Bin".
   - Items are processed one at a time, in batch order.
4. **Paths inside the bin.** `$R` is `join(await deps.binDir(driveOf(originalPath)), recycledAs)`. `$I` is the same with the leading `$R` replaced by `$I` (`'$I' + recycledAs.slice(2)`).
   - If `binDir` rejects, every item on that drive → `failed` with the error message.
   - Use `node:path`'s `win32` functions for every path operation.
5. **Missing `$R`** means `lstat($R)` fails with ENOENT → `purged`, "no longer in the Recycle Bin". Then carry on with the next item. Any other `lstat` error → `failed` with its message.
6. **`restoredName(originalPath, kind, attempt)`:**
   - attempt 1 inserts ` (restored)`; attempt N ≥ 2 inserts ` (restored N)`.
   - Files: insert before the last extension (`photo.jpg` → `photo (restored).jpg`). A name with no dot, or whose only dot is the first character (`.gitignore`), gets the suffix at the end.
   - Folders always get the suffix at the end (`my.project` → `my.project (restored)`).
   - Only the last path segment changes.
7. **Taken target.**
   - The original path is taken when `lstat` succeeds on it, whatever the type.
   - Try `restoredName(…, 1)` … `restoredName(…, 99)` in order and use the first free one.
   - If all 99 are taken → `failed`, reason "couldn't find a free name to restore it to".
   - `restoredTo` is set on every `restored` item: the original path, or the `(restored)` name actually used.
8. **Moving back:**
   1. `mkdir(dirname(target), { recursive: true })`;
   2. `rename($R, target)`;
   3. `unlink($I)`, ignoring ENOENT only.
   - A failure in step 1 or 2 → `failed` with the error's message.
   - A failure in step 3 other than ENOENT → the item still counts as `restored` (its data is back), with `reason` set to "restored, but Stash couldn't remove its Recycle Bin record: <message>".
9. **Log.** Append exactly one `RestoreRecord` with:
   - `type: 'restore'`;
   - the batch's `batchId`;
   - `at = new Date(deps.now()).toISOString()`, taken after the last item;
   - the items in batch order.

   Only a failing `log.append` rejects `restoreBatch`; per-item failures never escape.
10. **`psRecycler`** (tests/helpers):
    - `execFile` the absolute path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, never a bare name and never a shell, with `-NoProfile -NonInteractive -Command <script>`.
    - Options: `windowsHide: true`, a 30 s timeout, and `env: { ...process.env, STASH_RECYCLE_PATH: path }`. The path travels only in that variable.
    - The script runs `Add-Type -AssemblyName Microsoft.VisualBasic`, then `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(...)` if `Test-Path -LiteralPath $env:STASH_RECYCLE_PATH -PathType Container`, else `DeleteFile(...)`, both with `'OnlyErrorDialogs', 'SendToRecycleBin'`.
    - A non-zero exit or any stderr output rejects with the stderr text.
11. **`realEnv()`** (tests/helpers) builds a `WinEnv` from `process.env`, with no Electron:
    - `systemRoot` from `SystemRoot`;
    - `userProfile` from `USERPROFILE`, and `usersRoot = dirname(userProfile)`;
    - `localAppData` and `temp` from `LOCALAPPDATA` and `TEMP`;
    - `downloads`, `desktop`, `documents`, `pictures`, `music` and `videos` as `join(userProfile, '<Name>')`;
    - `oneDrive` from `OneDrive` (else null);
    - `stashDirs: []`.

    Canonicalize every path that exists with `realpathSync.native`; an 8.3 `%TEMP%` such as `C:\Users\JORDAN~1\…` must expand.
12. **Round-trip safety.**
    - Before recycling, assert `getRecycleBinInfo('C:').status === 'enabled'`. If it isn't, the test fails with a clear message. It never silently skips.
    - `afterAll` is the safety net: for every test file that is missing, look its record up with `findRecycledRecords` (since the test's start minus 60 s), rename its `$R` back and unlink its `$I`. Then remove the test-owned folder.
    - A last assertion confirms no `$I` record in the user's bin has an original path inside the test folder.
    - Nothing ever empties the Recycle Bin.
13. **Wrap the integration test** in `describe.runIf(process.platform === 'win32')`. The unit test (`restore.test.ts`) may use `os.tmpdir()`, because it never touches the real bin. It writes its own `$R`/`$I` files using `tests/helpers/iRecord.ts`.
14. **Staging.** Stage only your own files, by explicit path. Never use `git add src tests`.
