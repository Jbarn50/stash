# Task 14 — controller decisions (binding; they settle what the brief leaves open)

The renderer for Tasks 15–18 is already written against the plan's `StashApi` block. It goes on top of this task's commit, so this task's `window.stash` must behave exactly as that block says.

## Wiring that is already decided
1. **Cleanup deps** (Tasks 10 and 12):
   - `recycler: { trash: (p) => shell.trashItem(p) }`
   - `binInfo: getRecycleBinInfo`
   - `findRecords: findRecycledRecords` (the batched lookup, not `findRecycledRecord`)
   - `log`
   - `env`
   - `now: Date.now`

   Pass `session.latest.findings` as `runCleanup`'s `allFindings`, never anything that came from the renderer.
2. **Restore deps** (Task 13): `{ binDir: recycleBinDir, log, now: Date.now }`.
   - Before calling `restoreBatch`, leave out every item an earlier restore record for that batch already restored. Read them from `log.history()`; match by `pathKey(originalPath)`, where the earlier record's item status is `'restored'`.
   - Otherwise a second Restore on a partly restored batch would record those items as "no longer in the Recycle Bin".
   - `log.getBatch(batchId)` throws for an unknown batch. Let that reject the IPC call.
3. **Session** (Task 9):
   - `new ScanSession({ scanRunner: createScanRunner(), hashRunner: createHashRunner(), getSettings: () => liveSettings, env, emit })`
   - `emit` forwards each `SessionEvent` to the window on the `stash:session-event` channel.
   - The forwarder never throws: skip it when there's no window or the window is destroyed, and catch and log everything.
4. **Settings** (Task 11):
   - Load once at startup with `loadSettings(userData)`. If that rejects (an unreadable `settings.json`), call `dialog.showErrorBox('Stash couldn't read its settings', <file path + message + "Fix or move the file, then start Stash again.">)` and `app.quit()`. Never fall back to defaults, because a later save would overwrite the user's file.
   - `getSettings` returns the live in-memory settings.
   - `saveSettings(s)`: `saveSettings(userData, s)` first (it validates and throws readable errors), then update the live settings, then `session.applyExclusions(saved)`. Return what was saved. The store must be saved before `applyExclusions` runs.
5. **Exclude** (`excludeFolder`):
   1. Take the folder's path from the latest tree.
   2. Append it to `exclusions`, unless the same `pathKey` is already there.
   3. Save as in decision 4.
   4. Return the saved settings.

## Validation and serialization
6. **Validate every handler's arguments in `main/ipc.ts`; a bad argument throws `Error('invalid argument')`.**
   - `parseFindingIds`: an array of 1–100,000 strings, each ≤ 200 characters. De-duplicate, keeping first occurrences.
   - `parseFolderId(x, tree)`: a safe integer, 0 ≤ id < the tree's folder count. A missing tree → throw.
   - `parseScanRoot(x)`: a string, normalized with `normalizePath`, accepted only if `isPlainDrivePath` (from `src/core/paths.ts`) holds.
   - `confirmOverflow` must be a boolean.
   - `restoreBatch`'s id must be a non-empty string ≤ 200 characters.
   - `showItem`'s ref must be `{ kind: 'folder' | 'file', id: safe integer }`, and the id must exist in the latest tree.
7. **Clean and scan never overlap.**
   - A module-level flag marks a clean in progress.
   - `startScan` rejects with `Error('busy')` while a clean runs.
   - `clean` returns `{ status: 'rejected', reason: 'busy' }` while another clean runs.
   - `session.resolveFindings` already refuses while a scan runs, for stale ids, and for an incomplete scan. Return its reason as `{ status: 'rejected', reason }`. The renderer handles all four reasons, including 'incomplete-scan'.
8. **After a `done` cleanup,** call `session.removeFindings` with the ids of the recycled items only, then refresh the Recycle Bin usage cache (decision 9).

## Overview
9. **`recycleBinUsedBytes` is never computed per call.** `getRecycleBinInfo` walks the whole bin, which takes about 12 s at 100k entries.
   - Keep a cached Σ `usedBytes` over the scan targets' drives, de-duplicated by drive letter.
   - Refresh it in the background at startup, after every cleanup, and after every restore.
   - `getOverview` returns the cached value, 0 until the first refresh finishes.
10. **`getOverview.drives`:** `getDriveUsage` over the scan targets' drive roots, de-duplicated by drive letter, where each `root` is like `C:\`.
    - `fs.statfs`: total = `blocks * bsize`, free = `bavail * bsize`.
    - A drive whose `statfs` fails is left out.

## Channels and preload
11. **Channels.** `CHANNELS[name] = 'stash:' + name` for every invoke method. The two subscriptions use event channels:
    - `CHANNELS.onSessionEvent = 'stash:session-event'`
    - `CHANNELS.onCleanProgress = 'stash:clean-progress'` (the plan names that channel for progress)
12. **Preload** exposes `window.stash` with `contextBridge.exposeInMainWorld('stash', api)`.
    - Each method calls `ipcRenderer.invoke(CHANNELS.x, ...args)`.
    - Each `on*` registers a wrapper listener `(_e, ...args) => cb(...args)` and returns a function that removes exactly that listener.
    - Never expose `ipcRenderer` itself.
    - Add `stash: StashApi` to `src/preload/index.d.ts`.
    - Leave the template's existing `window.electron` / `window.api` exposure as it is; removing it is outside this task.

## System actions, elevation, environment, startup
13. **System actions.**
    - Spawn processes by absolute path: `%SystemRoot%\System32\cleanmgr.exe` (detached, `stdio: 'ignore'`, `unref()`), and `%SystemRoot%\explorer.exe` with the single argument `shell:RecycleBinFolder`.
    - `openStorageSettings`: `shell.openExternal('ms-settings:storagesense')`.
    - `showItem(path)`: `shell.showItemInFolder`.
14. **Elevation.** `buildElevationArgs` exactly as the plan's test states. In development, `process.argv` carries the app path, so the relaunch passes the app's own arguments, minus any old `--scan=`, plus `--scan=<root>`.
    - `relaunchElevated(root)` runs `powershell.exe` by absolute path with those args.
    - A non-zero exit (UAC declined: Start-Process throws "The operation was canceled by the user") resolves `false`, and the app keeps running.
    - Success calls `app.quit()` and resolves `true`.
    - `rescanAsAdmin()` uses the latest scan's root, or else the first scan target. It resolves either way.
15. **`buildWinEnv()`:**
    - `app.getPath` for home, desktop, documents, downloads, pictures, music and videos;
    - `process.env` for `SystemRoot`, `LOCALAPPDATA`, `TEMP` and `OneDrive`;
    - `usersRoot = dirname(userProfile)`;
    - `stashDirs = [app.getPath('userData'), dirname(app.getPath('exe'))]`.

    Canonicalize every path that exists with `realpathSync.native`; an 8.3 `%TEMP%` must expand.
16. **Startup.**
    - Keep the existing hardening and the `STASH_USER_DATA` override.
    - After the window's first `did-finish-load`: if `process.argv` has `--scan=<root>` and `parseScanRoot` accepts it, start that scan once. An invalid value is logged and ignored.
    - Start the Recycle Bin usage refresh in the background.
    - `npm run build` must put both worker chunks (scan and hash) in `out/`. This happens once `src/main/index.ts` imports the worker runners. Check it and say so in the report.
17. **`buildFolderView`** (core/view.ts), exactly as the brief's rules state:
    - Children are subfolders, tracked files, one `small` node "(N small files)" when the bucket is non-empty, and link entries (`kind: 'link'`, size 0).
    - Sort them by `sizeOnDisk`, largest first.
    - Anything beyond `cap` (default 100) merges into one `other` node, "(N smaller items)".
    - Clamp `depth` to 1–3.
    - A folder's `mtimeMs` is its newest mtime.
    - Unreadable folders keep `unreadable: true`.
    - Read `src/core/tree.ts` for the tree's API.

## Done when
18. **Done when:**
    - the brief's tests pass;
    - the full suite passes;
    - `npm run typecheck` is clean;
    - eslint shows 0 errors on the changed files;
    - `npm run build` works and both worker chunks are in `out/`;
    - `npm run test:e2e -- tests/e2e/security.spec.ts` still passes.

    Stage only your own files, by explicit path. Never use `git add src tests`.

## Controller amendments (2026-11-02, binding over the points above)
A. **Decision 12, the template bridge.** Spec §4.1 says the preload "exposes a small, typed `window.stash` API. Nothing else crosses the bridge."
   - The template's `window.electron` / `window.api` exposure, the `ping` IPC handler and `components/Versions.tsx` are therefore removed when the renderer (Tasks 15–18) is integrated, because the template's renderer still uses them until then.
   - Task 14 leaves them in place, but must add no new use of them.
   - Everything Task 14 adds goes through `window.stash` only.
B. **Decision 14, absolute PowerShell path.** `buildElevationArgs` returns `file: 'powershell.exe'`, exactly as the brief's test states. `relaunchElevated` resolves it to the absolute path `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` before spawning: never a bare name, never a shell (the Task 2 ruling).
C. **`onCleanProgress`** uses the same never-throw forwarder as session events (decision 3).
D. **Restores refresh the bin usage too.** A restore also refreshes the bin usage cache (decision 9).
E. **What the brief's Task 10 names mean.** The brief's `findRecord = findRecycledRecord` and Σ-per-call `getOverview` are superseded by decisions 1 and 9: the batched `findRecycledRecords`, and the cached usage.
