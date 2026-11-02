### Task 13: Restore engine and the real round trip

**Files:**
- Create: `src/main/restore.ts`, `tests/helpers/psRecycler.ts`, `tests/helpers/realEnv.ts`
- Test: `tests/unit/restore.test.ts`, `tests/integration/roundTrip.test.ts`

**Interfaces:**
- Consumes: `runCleanup`, `Recycler` (Task 12); `getRecycleBinInfo`, `findRecycledRecord`, `recycleBinDir` (Task 10); `CleanupLog` (Task 11).
- Produces:

```ts
// restore.ts
export interface RestoreDeps { binDir(drive: string): Promise<string>; log: Pick<CleanupLog, 'append'>; now(): number }
export function restoreBatch(batch: CleanupBatch, deps: RestoreDeps): Promise<RestoreRecord>
export function restoredName(originalPath: string, kind: 'file' | 'folder', attempt: number): string
// tests/helpers/psRecycler.ts — powershell.exe (5.1): Microsoft.VisualBasic.FileIO.FileSystem DeleteFile/DeleteDirectory
//   with 'OnlyErrorDialogs','SendToRecycleBin'; the path travels in env var STASH_RECYCLE_PATH
export const psRecycler: Recycler
// tests/helpers/realEnv.ts — from process.env (USERPROFILE, LOCALAPPDATA, TEMP, OneDrive); no Electron
export function realEnv(): WinEnv
```

**Rules:**
- **Only restorable items:** an item must have status `recycled` and a `recycledAs`. Any other item → `failed`, "Stash couldn't find it in the Recycle Bin".
- **Missing `$R`** → `purged`, "no longer in the Recycle Bin".
- **Taken target:** if the original path is taken, try `restoredName(..., 1..99)` until one is free.
- **Moving it back:**
  - Create the parent folder recursively.
  - `rename($R, target)`.
  - `unlink($I)`, ignoring `ENOENT`.
  - Any other error → `failed` with its message.
- **Log it:** append one `RestoreRecord`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('restoredName', () => {
  expect(restoredName('C:\\a\\photo.jpg', 'file', 1)).toBe('C:\\a\\photo (restored).jpg')
  expect(restoredName('C:\\a\\photo.jpg', 'file', 2)).toBe('C:\\a\\photo (restored 2).jpg')
  expect(restoredName('C:\\a\\my.project', 'folder', 1)).toBe('C:\\a\\my.project (restored)')
})
// restore.test.ts uses a temp folder as the bin, with $R/$I files written by the test (makeIRecord)
test('moves $R back, removes $I and logs restored')
test('restores as "(restored)" when the original path is taken')
test('recreates a missing parent folder')
test('reports "no longer in the Recycle Bin" when $R is gone, and carries on')
// roundTrip.test.ts — real Recycle Bin, test files only
test('recycle and restore real files, including a non-ASCII name', async () => {
  // 'plain.bin' and 'naïve 📁 写真.bin' under mkdtemp; Findings built from lstat
  const out = await runCleanup(findings, findings, false, { recycler: psRecycler, binInfo: getRecycleBinInfo,
    findRecord: findRecycledRecord, log, env: realEnv(), now: Date.now })
  // expect status 'done', every item recycled with recycledAs, files gone
  const rec = await restoreBatch(batch, { binDir: recycleBinDir, log, now: Date.now })
  // expect ['restored', 'restored'] and byte-identical contents
})
// afterAll: any test file still missing → findRecycledRecord and move it back; then delete the temp folder
```

- [ ] **Step 2:** `npx vitest run tests/unit/restore.test.ts tests/integration/roundTrip.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS. Confirm the Recycle Bin holds no `stash-` test items afterwards.
- [ ] **Step 5: Commit** `git add src/main/restore.ts tests; git commit -m "feat(main): restore engine and real recycle round trip"`

