### Task 14: IPC, preload API, environment, elevation, main wiring

**Files:**
- Create: `src/shared/ipc.ts`, `src/core/view.ts`, `src/main/env.ts`, `src/main/ipc.ts`, `src/main/elevate.ts`, `src/main/systemActions.ts`, `src/main/overview.ts`
- Modify: `src/preload/index.ts` (expose `window.stash`), `src/preload/index.d.ts`, `src/main/index.ts`
- Test: `tests/unit/view.test.ts`, `tests/unit/ipcValidation.test.ts`, `tests/unit/elevate.test.ts`

**Interfaces:**
- Consumes:
  - `ScanSession`, `createScanRunner`, `createHashRunner` (Task 9)
  - `runCleanup`, `Recycler` (Task 12)
  - `restoreBatch` (Task 13)
  - `CleanupLog`, `loadSettings`, `saveSettings` (Task 11)
  - `getRecycleBinInfo`, `findRecycledRecord`, `recycleBinDir` (Task 10)
  - `ScanTree` (Task 4) and the types (Task 3)
- Produces:

```ts
// shared/ipc.ts
export interface StashApi {
  getOverview(): Promise<Overview>
  startScan(root: string): Promise<{ scanId: string }>
  cancelScan(): Promise<void>
  onSessionEvent(cb: (e: SessionEvent) => void): () => void
  getFolderView(folderId: number, depth: number): Promise<ViewNode | null>
  getFindings(): Promise<Finding[]>
  clean(findingIds: string[], confirmOverflow: boolean): Promise<CleanOutcome>
  onCleanProgress(cb: (done: number, total: number) => void): () => void
  getHistory(): Promise<HistoryEntry[]>
  restoreBatch(batchId: string): Promise<RestoreRecord>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>
  pickFolder(): Promise<string | null>
  excludeFolder(folderId: number): Promise<Settings>
  showItem(ref: { kind: 'folder' | 'file'; id: number }): Promise<void>
  openDiskCleanup(): Promise<void>
  openStorageSettings(): Promise<void>
  openRecycleBin(): Promise<void>
  rescanAsAdmin(): Promise<void>
}
export const CHANNELS: Record<keyof StashApi, string>   // 'stash:<name>'
// core/view.ts
export function buildFolderView(tree: ScanTree, folderId: number, depth: number, cap?: number): ViewNode   // cap 100
// main/ipc.ts — validators exported for tests
export function parseFindingIds(x: unknown): string[]                     // 1..100000 strings, each ≤ 200 chars
export function parseFolderId(x: unknown, tree: ScanTree | null): number
export function parseScanRoot(x: unknown): string                         // normalized, must match /^[A-Z]:\\/
export function registerIpc(deps: { session: ScanSession; log: CleanupLog; settingsDir: string; env: WinEnv;
  recycler: Recycler; window(): BrowserWindow | null }): void
// main/env.ts — app.getPath for known folders; process.env for the rest;
//   stashDirs = [userData, dirname(app.getPath('exe'))]; usersRoot = dirname(userProfile)
export function buildWinEnv(): WinEnv
// main/elevate.ts
export function buildElevationArgs(execPath: string, argv: string[], root: string): { file: 'powershell.exe'; args: string[] }
export function relaunchElevated(root: string): Promise<boolean>   // false when UAC is declined; quits the app on success
// main/systemActions.ts — shell.showItemInFolder; detached cleanmgr.exe;
//   shell.openExternal('ms-settings:storagesense'); explorer.exe shell:RecycleBinFolder
export function showItem(path: string): void
export function openDiskCleanup(): void
export function openStorageSettings(): Promise<void>
export function openRecycleBin(): void
// main/overview.ts
export function getDriveUsage(roots: string[]): Promise<DriveUsage[]>   // fs.statfs: blocks*bsize, bavail*bsize
```

**Rules:**
- **`buildFolderView`:**
  - Children are:
    - subfolders
    - tracked files
    - one `small` node named "(N small files)" when the bucket is non-empty
    - link entries (`kind: 'link'`, size 0)
  - Children are sorted by `sizeOnDisk`, largest first. Anything beyond `cap` merges into one `other` node named "(N smaller items)".
  - `depth` is clamped to 1–3. A folder's `mtimeMs` is its `newestMtimeMs`.
- **`clean` handler:**
  1. Call `session.resolveFindings`. If that fails, return `{ status: 'rejected', reason }`.
  2. Call `runCleanup` with:
     - the resolved findings as `selected`, and `session.latest.findings` as `allFindings`
     - `recycler = { trash: p => shell.trashItem(p) }`
     - `binInfo = getRecycleBinInfo` and `findRecord = findRecycledRecord`

     Progress goes out on `stash:clean-progress`.
  3. Call `session.removeFindings` for the recycled ids.
- **`restoreBatch` handler:** `log.getBatch`, which throws if the batch is unknown, then `restoreBatch` with `binDir = recycleBinDir`.
- **`excludeFolder`:** take the folder's path from the latest tree, append it to `settings.exclusions`, call `saveSettings`, then `session.applyExclusions`.
- **`getOverview`** returns:
  - `drives`: `getDriveUsage(settings.scanTargets)`
  - `recycleBinUsedBytes`: Σ `getRecycleBinInfo(drive).usedBytes` over those drives
  - `lastScan`: `session.latest?.summary ?? null`
  - `state`
- **Startup:** if `process.argv` contains `--scan=<root>`, start that scan once the window has loaded.
- **Elevation:**
  - The script is `Start-Process -FilePath '<exe>' -ArgumentList '<args>' -Verb RunAs`, sent with `-NoProfile -EncodedCommand` (UTF-16LE base64).
  - Each argument is wrapped as `"<arg>"`, with single quotes doubled for PowerShell. `"--scan=<root>"` is appended.

- [ ] **Step 1: Write the failing tests.**

```ts
test('buildFolderView caps children at 100 and merges the rest into one "other" node')
test('buildFolderView shows small files as one block and clamps depth to 3')
test('parseFindingIds accepts 1 to 100000 strings only')
test('parseFolderId rejects negatives, fractions and ids beyond the tree')
test('parseScanRoot accepts drive-rooted paths only', () => {
  expect(parseScanRoot('d:/games')).toBe('D:\\games'); expect(() => parseScanRoot('\\\\server\\share')).toThrow() })
test('elevation runs Start-Process -Verb RunAs with a safely quoted scan root', () => {
  const { file, args } = buildElevationArgs('C:\\Program Files\\Stash\\Stash.exe', [], "C:\\Users\\o'neil\\My Folder")
  const script = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  expect(file).toBe('powershell.exe'); expect(script).toContain('-Verb RunAs')
  expect(script).toContain(`"--scan=C:\\Users\\o''neil\\My Folder"`)
})
```

- [ ] **Step 2:** `npx vitest run tests/unit/view.test.ts tests/unit/ipcValidation.test.ts tests/unit/elevate.test.ts` → FAIL.
- [ ] **Step 3:** Implement and wire `src/main/index.ts`: env, settings, log, session and runners, `registerIpc`, and the `--scan` startup argument.
- [ ] **Step 4:** Re-run → PASS. `npm run typecheck` passes, and `npm run test:e2e` still passes (Task 1).
- [ ] **Step 5: Commit** `git add src tests; git commit -m "feat(main): typed IPC, environment, elevation and wiring"`

