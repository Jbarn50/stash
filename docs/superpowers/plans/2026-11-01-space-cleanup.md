# Stash Space & Cleanup (v1) Implementation Plan

> **For agentic workers:** Each task's mode comes from the **Execution mode** table below. Re-read the task's row just before starting it, because the user can flip it at any time.
> - `subagent` rows: REQUIRED SUB-SKILL superpowers:subagent-driven-development.
> - `native` rows: REQUIRED SUB-SKILL superpowers:executing-plans.
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Stash app shell and its Space module:
- scan a drive and show where the space goes
- find four kinds of waste
- move selected items to the Recycle Bin, with a log and one-click restore

**Architecture:**
- **Decision logic** lives in `src/core` as plain TypeScript, unit-tested in Vitest without Electron: the scan tree, rules, detectors, blocklist, and `$I` parsing.
- **The main process** (`src/main`) is the only code that moves files.
  - It drives two `worker_threads` (scan and hash) through injectable runner interfaces.
  - It serves a typed preload API to a React renderer.
- **The renderer** sends finding IDs, never paths.

**Tech Stack:**
- Electron, pinned to an exact version
- electron-vite (React + TypeScript template)
- d3-hierarchy
- @tanstack/react-virtual
- Vitest
- Playwright (`_electron`)
- electron-builder (NSIS installer)
- Node built-ins only for `fs`, `crypto` and `child_process`

**Spec:** `docs/superpowers/specs/2026-11-01-space-cleanup-design.md`

## Global Constraints

**Platform and dependencies**
- Windows 10/11 x64 only. Every command runs in PowerShell from `C:\Users\jorda\Software\stash`.
- Work on branch `feat/space-cleanup`, never on `main`.
- No native (compiled) npm dependencies. After any `npm install`, `Get-ChildItem node_modules -Recurse -Filter binding.gyp` must print nothing.
- `electron` is pinned to an exact version, with no `^` or `~`.

**Security boundaries**
- **Renderer hardening:**
  - `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
  - keep the template's strict CSP meta tag
  - `setWindowOpenHandler` denies; `will-navigate` is prevented
- **Import boundaries:**
  - `src/core` and `src/shared` never import `electron`.
  - The renderer imports only `src/shared` and its own files.
- **Destructive IPC** (`clean`, `restoreBatch`) takes finding IDs or batch IDs only. IDs that are not from the latest completed scan are rejected.

**File-safety rules**
- The only way Stash removes a user item is `shell.trashItem`, behind the `Recycler` interface.
- Stash never empties the Recycle Bin.
  - The sole exception: Restore deletes a `$I…` record after moving its `$R…` back.
- Cleanup on a drive proceeds only when the registry confirms both that the Recycle Bin is on (`NukeOnDelete = 0`) and its `MaxCapacity`.
  - If the bin is disabled **or unconfirmed**, every item on that drive is refused.
- Tests never touch the user's real files.
  - Fixtures live under `os.tmpdir()`.
  - Anything a test sends to the real Recycle Bin is put back in `afterAll`.

**Scanning and sizes**
- **Size on disk** = `stats.blocks * 512`.
  - All totals use size on disk.
  - Recycle Bin capacity checks use logical size.
- **Tracked vs small files:**
  - A file is tracked individually when its logical size ≥ `trackFileMinBytes`.
  - Smaller files go to their folder's small-files bucket.
- **Cloud-only:** a tracked file with logical size > 0 and size on disk 0. It is never hashed and never opened.
- **Links:**
  - Junctions and symlinks are never followed.
  - Hard links (`nlink > 1`) count once per `${dev}:${ino}`, read with `fs.promises.stat(p, { bigint: true })`.
- **Defaults** (`DEFAULT_SETTINGS.thresholds`):
  - `trackFileMinBytes` 1,048,576
  - `staleMinBytes` 104,857,600
  - `staleAgeMonths` 6
  - `tempMinAgeHours` 24
  - `idleDays` 30
- **Fixed limits** (not user-editable): an image sequence needs ≥ 100 files and ≥ 524,288,000 bytes.
- **Paths:** every path comparison goes through `src/core/paths.ts`, which is case-insensitive and separator-normalized. Never call raw `startsWith` on paths.

**Data**
- The data folder is `%APPDATA%\Stash`, holding `settings.json` and `cleanup-log.jsonl`.
- `STASH_USER_DATA` overrides it, for tests only.
- Scan results are never written to disk.

**Fixed copy**
- **UI copy:** "Scan", "Cancel", "Rescan as administrator", "You could free about X GB", "+ Y GB Windows can clean itself", "Space is only freed when you empty the Recycle Bin.", "Clean selected", "These go to the Recycle Bin.", "Open in File Explorer", "Exclude from Stash", "Restore", "Open Disk Cleanup", "Open Storage settings", "Open Recycle Bin".
- **Skip and restore reasons:** "changed since scan", "protected", "too big for the Recycle Bin", "Recycle Bin is turned off on this drive", "Stash couldn't confirm this drive's Recycle Bin", "would remove every copy", "no longer in the Recycle Bin", "Stash couldn't find it in the Recycle Bin".
- **Restored-copy names:** `<name> (restored)<ext>`, then `<name> (restored 2)<ext>`, and so on.

## Review Focus

1. Paths that differ only in case, slash direction or a trailing separator must match the same blocklist, exclusion and scope entries, and `C:\Windows2` must not match `C:\Windows` → test in Task 3.
2. A file that vanishes or turns unreadable between listing and `lstat` (constant in `%TEMP%`) must be skipped without failing the scan or marking its folder unreadable → test in Task 5.
3. Paths longer than 260 characters (deep `node_modules`) must be scanned and sized → test in Task 5.
4. Non-ASCII names (accents, emoji, CJK) must survive `$I` parsing, record matching and restore → tests in Tasks 10 and 13.
5. A clean request carrying finding IDs from an earlier scan must be rejected, never resolved against the newer scan → test in Task 9.

## Decisions this plan adds to the spec

- **Unconfirmed Recycle Bin.** A drive whose bin status can't be confirmed (no volume ID, registry key, or `MaxCapacity`) is treated like a disabled bin, so all cleanup on it is refused.
- **Re-checking folders.** Before a folder is moved, Stash re-checks that it still exists, is still a real folder, and has the same *own* modified time. Re-measuring its size would mean walking it again.
- **Individual findings need tracked files.** Detectors flag individual files only when they are tracked (≥ 1 MB).
  - The scanner also remembers the names of small project "marker" files (`package.json`, `Cargo.toml`, `*.csproj`, `pyproject.toml`, `project.godot`, `pyvenv.cfg`, `*.uproject`), because the dev-leftover rules need them.
- **Image-sequence folders.** A folder counts as an image sequence only if it has no subfolders and the frames make up ≥ 90% of its size. This keeps a folder that also holds other work out of the bin.
- **Cancel.** Cancelling a scan skips duplicate hashing. The static findings for what was scanned are kept, marked incomplete.
- **Locked system files.** Locked files at a drive root, such as `pagefile.sys` and `hiberfil.sys`, are measured through one PowerShell `Get-Item` call. Node gets `EPERM` on them.

## Execution mode

Each task runs in one of two modes. This table holds the current setting for every task.

- **`subagent`:** a fresh subagent builds the task, then a separate reviewer checks it before the next task starts.
- **`native`:** the main session builds the task itself.
- **Whichever modes are used,** one whole-branch review runs after Task 19.

**Switching:** edit a row's mode here, or tell Claude, for example "task 8 subagent", "all native" or "all subagent". It works mid-build: a change applies from the next task that hasn't started.

**Defaults:** `subagent` for the tasks that decide what may be moved, refused or restored; `native` for everything else.

| Task | Mode | Why this default |
|---|---|---|
| 1. Scaffold and test tooling | native | setup |
| 2. Verification spikes | native | throwaway scripts |
| 3. Paths, settings, blocklist | subagent | decides what can never be cleaned |
| 4. Scan tree model | native | — |
| 5. Scanner and fixture | native | — |
| 6. Rules and static detectors | native | — |
| 7. Dev & creative leftovers | native | — |
| 8. Duplicates | native | — |
| 9. Workers and scan session | subagent | rejects finding IDs from old scans |
| 10. Recycle Bin info | subagent | decides whether a drive may be cleaned |
| 11. Settings and cleanup log | native | — |
| 12. Cleanup engine | subagent | the only code that moves files |
| 13. Restore engine | subagent | moves files back |
| 14. IPC and wiring | subagent | turns finding IDs into paths |
| 15. App shell and Overview | native | — |
| 16. Explore | native | — |
| 17. Cleanup screen | native | — |
| 18. History and Settings | native | — |
| 19. Round trip and installer | native | — |

---

## File Structure

```
src/shared/types.ts             cross-process types (Task 3)
src/shared/ipc.ts               StashApi + channel names (Task 14)
src/core/paths.ts               path normalization and comparison (Task 3)
src/core/settings.ts            DEFAULT_SETTINGS, validateSettings (Task 3)
src/core/blocklist.ts           isBlocked (Task 3)
src/core/tree.ts                ScanTree (Task 4)
src/core/rules/markers.ts       marker file names kept by the scanner (Task 5)
src/core/scan/fsDeps.ts         injectable fs layer (Task 5)
src/core/scan/lockedFiles.ts    PowerShell size fallback (Task 5)
src/core/scan/scanTree.ts       the walker (Task 5)
src/core/rules/catalog.ts       rule metadata (Task 6)
src/core/rules/pattern.ts       path patterns over the tree (Task 6)
src/core/detectors/context.ts   DetectorContext, Claims, finding factories (Task 6)
src/core/detectors/scope.ts     personal-folder scope (Task 6)
src/core/detectors/system.ts, tempCaches.ts, installersStale.ts, index.ts (Task 6)
src/core/detectors/devLeftovers.ts (Task 7)
src/core/detectors/duplicates.ts, src/core/hash.ts, src/core/keeper.ts (Task 8)
src/core/findings.ts            summaries (Task 6)
src/core/recycleBinInfo.ts      $I parser (Task 10)
src/core/view.ts                Explore view builder (Task 14)
src/workers/protocol.ts, scanWorker.ts, hashWorker.ts (Task 9)
src/main/session.ts, workerRunners.ts (Task 9)
src/main/recycleBin.ts (Task 10)   src/main/settings.ts, cleanupLog.ts (Task 11)
src/main/cleanup.ts (Task 12)      src/main/restore.ts (Task 13)
src/main/env.ts, ipc.ts, elevate.ts, systemActions.ts, overview.ts, index.ts (Task 14)
src/renderer/src/...            shell, screens, components, lib (Tasks 15–18)
tests/helpers/                  env, treeFrom, treeQueries, iRecord, psRecycler, realEnv
tests/fixtures/buildFixture.ts  on-disk fixture (Task 5)
spikes/                         throwaway verification scripts + RESULTS.md (Task 2)
```

Every Vitest task uses the same cycle:
1. Write the tests.
2. Run `npx vitest run <test files>`. Expect a FAIL for the missing module or export.
3. Implement.
4. Run again and expect a PASS.
5. Commit.

Integration tests are wrapped in `describe.runIf(process.platform === 'win32')`.

---

### Task 1: Scaffold the app, harden the window, add test tooling

**Files:**
- Create from the electron-vite `react-ts` template:
  - `package.json`, `electron.vite.config.ts`, `electron-builder.yml`, `tsconfig*.json`
  - `src/main/index.ts`, `src/preload/index.ts`, `src/preload/index.d.ts`
  - `src/renderer/index.html`, `src/renderer/src/*`, `resources/`, `build/`
- Create: `vitest.config.ts`, `playwright.config.ts`, plus `.gitignore` entries for `test-results/` and `playwright-report/`
- Test: `tests/e2e/security.spec.ts`

**Interfaces:**
- Produces these scripts:
  - `npm run dev`, `npm run build`, `npm run typecheck`
  - `npm test`: Vitest over `tests/unit/**/*.test.ts` and `tests/integration/**/*.test.ts`, Node environment, 60 s timeout
  - `npm run test:e2e`: `npm run build`, then Playwright on `tests/e2e`, 1 worker, 120 s timeout
- `app.getPath('userData')` is `STASH_USER_DATA` when set, otherwise `%APPDATA%\Stash`.

- [ ] **Step 1: Branch.** Run `git switch feat/space-cleanup`. The branch was created when this plan was committed.
- [ ] **Step 2: Scaffold outside the repo, then copy in.**
  - From `$env:TEMP`, run `npm create @quick-start/electron@latest stash-app -- --template react-ts`.
  - Answer **No** to the updater plugin and **No** to the download mirror.
  - Copy everything except `.git` into the repo. Never scaffold into the repo directly, because it already holds `docs/`.
- [ ] **Step 3: Identity, pins, dependencies.**
  - In `package.json`, set `"name": "stash"` and `"productName": "Stash"`. Set `electron` to the exact output of `npm view electron version`.
  - Add dependencies `d3-hierarchy` and `@tanstack/react-virtual`, and dev dependencies `vitest`, `@playwright/test` and `@types/d3-hierarchy`.
  - In `electron-builder.yml`, set `appId: local.stash.app` and `productName: Stash`.
  - Run `npm install`, then the `binding.gyp` check (expect no output).
- [ ] **Step 4: Write the failing test** `tests/e2e/security.spec.ts`:

```ts
test('window is hardened, titled Stash, and honours STASH_USER_DATA', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'stash-ud-'))
  const app = await electron.launch({ args: ['.'], env: { ...process.env, STASH_USER_DATA: userData } })
  const win = await app.firstWindow()
  expect(await win.title()).toBe('Stash')
  expect(await win.evaluate(() => typeof (window as any).require)).toBe('undefined')
  expect(await win.evaluate(() => typeof (window as any).process)).toBe('undefined')
  const prefs = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences())
  expect(prefs).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false })
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData)
  await app.close()
})
```

- [ ] **Step 5:** Run `npm run test:e2e`. Expect a FAIL: the title is still the template's and `sandbox` is false.
- [ ] **Step 6: Implement** in `src/main/index.ts`:
  - Before `app.whenReady()`, call `app.setPath('userData', process.env.STASH_USER_DATA ?? join(app.getPath('appData'), 'Stash'))`.
  - Set window `title: 'Stash'` and the webPreferences from Global Constraints. Deny `window.open`, and prevent navigation away from the app URL.
  - In `src/renderer/index.html`, set `<title>Stash</title>` and keep the template CSP.
  - Add `src/core/**`, `src/shared/**`, `src/workers/**` and `tests/**` to `tsconfig.node.json`, and `src/shared/**` to `tsconfig.web.json`.
- [ ] **Step 7:** Run `npm run test:e2e` and expect a PASS. Run `npm run typecheck` and expect no errors.
- [ ] **Step 8: Commit.** `git add -A; git commit -m "chore: scaffold Stash, harden window, add Vitest and Playwright"`

### Task 2: Verification spikes (throwaway; nothing in `src/` imports them)

**Files:** Create `spikes/blocks.mjs`, `spikes/trash.mjs`, `spikes/walk-speed.mjs` and `spikes/RESULTS.md`.

Each script:
- runs under Electron's Node via `npx electron spikes/<file>`
- awaits `app.whenReady()`
- prints one JSON object
- calls `app.quit()`

- [ ] **Step 1: `blocks.mjs`.**
  - In a fresh `os.tmpdir()` folder, write a 2,097,152-byte file and a 100-byte file.
  - Print `process.versions.node` and `blocks * 512` for each file.
  - Expected output: `2097152` and `0`.
  - **If the 2 MiB file does not print 2097152, stop and report to the user.** Spec §10 requires size on disk to be redesigned first.
- [ ] **Step 2: `trash.mjs`.**
  - **(a) Round trip on C:.**
    - Create `stash-spike-<random>\naïve 📁.txt` under `os.tmpdir()` and call `await shell.trashItem(p)`.
    - Find its `$I…` record in `C:\$Recycle.Bin\<SID>`. Get the SID from `whoami /user /fo csv /nh`, and parse the record using the layout in Task 10.
    - Print `{ found, iName }`.
    - Put the file back (rename `$R…`, delete `$I…`), check its content, then delete the spike folder.
  - **(b) A drive with no Recycle Bin.**
    - Take a free letter (Z downward) and run `subst <L>: <new temp folder>`.
    - Write a file on `<L>:` and call `shell.trashItem` on it.
    - Print `{ rejected, stillExists }`.
    - Run `subst <L>: /D` and delete the folder.
  - **Expected:** (a) `found: true`; (b) `rejected: true, stillExists: true`.
  - If (b) deleted the file, write that in RESULTS.md. Task 12's refusal of unconfirmed drives is then the only guard, and it is already required.
- [ ] **Step 3: `walk-speed.mjs`.**
  - Walk `C:\` read-only: `readdir(dir, { withFileTypes: true })` plus `lstat` per entry, 32 in flight, never descending into symlink dirents.
  - Sample `process.memoryUsage().rss` every second.
  - Print `{ entries, folders, errors, seconds, peakRssMB }`.
  - Run it in the background.
  - **Decision:**
    - under 300 s: continue
    - 300–600 s: continue, and note it in RESULTS.md
    - over 600 s: **pause and ask the user** before Task 5
- [ ] **Step 4:** Record all three outputs and the decisions in `spikes/RESULTS.md`.
- [ ] **Step 5: Commit.** `git add spikes; git commit -m "chore: record verification spikes"`

### Task 3: Shared types, path helpers, settings defaults, blocklist

**Files:**
- Create: `src/shared/types.ts`, `src/core/paths.ts`, `src/core/settings.ts`, `src/core/blocklist.ts`, `tests/helpers/env.ts`
- Test: `tests/unit/paths.test.ts`, `tests/unit/settings.test.ts`, `tests/unit/blocklist.test.ts`

**Interfaces — Produces** `src/shared/types.ts` (types only):

```ts
export type Bytes = number
export type SafetyRating = 'safe' | 'review' | 'info'
export type Category = 'duplicates' | 'tempCaches' | 'installersStale' | 'devLeftovers' | 'system'
export type RuleId = string
export interface WinEnv { systemRoot: string; usersRoot: string; userProfile: string; localAppData: string; temp: string;
  downloads: string; desktop: string; documents: string; pictures: string; music: string; videos: string;
  oneDrive: string | null; stashDirs: string[] }
export interface Thresholds { trackFileMinBytes: number; staleMinBytes: number; staleAgeMonths: number; tempMinAgeHours: number; idleDays: number }
export interface Settings { version: 1; exclusions: string[]; personalFolders: string[]; scanTargets: string[]; thresholds: Thresholds }
export interface Finding { id: string; scanId: string; ruleId: RuleId; category: Category; safety: SafetyRating;
  title: string; explanation: string; path: string; kind: 'file' | 'folder'; sizeOnDisk: Bytes; logicalSize: Bytes;
  mtimeMs: number; sizeUnknown?: boolean; groupId?: string; suggestedKeep?: boolean }
export interface ScanProgress { scanId: string; phase: 'scanning' | 'hashing'; foldersScanned: number; filesScanned: number;
  bytesSeen: Bytes; currentPath: string; topLevel: { name: string; sizeOnDisk: Bytes }[]; hashedBytes?: Bytes; hashTotalBytes?: Bytes }
export interface ScanSummary { scanId: string; root: string; incomplete: boolean; foldersScanned: number; filesScanned: number;
  totalSizeOnDisk: Bytes; unreadableFolders: number; reclaimable: Bytes; byCategory: Record<Category, Bytes>;
  windowsCanClean: Bytes; durationMs: number }
export type SessionState = 'idle' | 'scanning' | 'hashing' | 'ready'
export type SessionEvent = { type: 'progress'; progress: ScanProgress } | { type: 'done'; summary: ScanSummary } | { type: 'error'; message: string }
export interface ViewNode { kind: 'folder' | 'file' | 'small' | 'link' | 'other'; id: number | null; name: string;
  sizeOnDisk: Bytes; mtimeMs: number | null; unreadable?: boolean; children?: ViewNode[] }
export interface CleanupItemRecord { findingId: string; ruleId: RuleId; kind: 'file' | 'folder'; originalPath: string;
  sizeOnDisk: Bytes; mtime: string; status: 'recycled' | 'skipped'; reason?: string; tip?: string; recycledAs?: string }
export interface CleanupBatch { type: 'cleanup'; batchId: string; startedAt: string; finishedAt: string; items: CleanupItemRecord[] }
export interface RestoreItemRecord { originalPath: string; status: 'restored' | 'purged' | 'failed'; restoredTo?: string; reason?: string }
export interface RestoreRecord { type: 'restore'; batchId: string; at: string; items: RestoreItemRecord[] }
export type CleanOutcome =
  | { status: 'done'; batch: CleanupBatch }
  | { status: 'needsOverflowConfirm'; drive: string; batchBytes: Bytes; binUsedBytes: Bytes; binMaxBytes: Bytes }
  | { status: 'rejected'; reason: 'stale-scan' | 'busy' | 'unknown-finding' }
export interface HistoryEntry { batch: CleanupBatch; restores: RestoreRecord[] }
export interface DriveUsage { root: string; totalBytes: Bytes; freeBytes: Bytes }
export interface Overview { drives: DriveUsage[]; recycleBinUsedBytes: Bytes; lastScan: ScanSummary | null; state: SessionState }
```

**Paths and settings:**

```ts
// src/core/paths.ts
export function normalizePath(p: string): string  // win32 normalize, '/'→'\', strip '\\?\', upper-case drive letter, no trailing '\' except 'X:\'
export function pathKey(p: string): string        // normalizePath(p).toLowerCase()
export function isSameOrInside(child: string, parent: string): boolean
export function driveOf(p: string): string        // 'C:'
// src/core/settings.ts
export const MiB = 1_048_576
export const DEFAULT_SETTINGS: Settings             // scanTargets ['C:\\'], thresholds per Global Constraints, empty lists
export function validateSettings(input: unknown): Settings  // fills missing fields from defaults, normalizes paths,
                                                            // throws Error('Invalid settings: <field path>')
// src/core/blocklist.ts
export function isBlocked(p: string, env: WinEnv): boolean
// tests/helpers/env.ts
export const SAMPLE_ENV: WinEnv  // profile C:\Users\jorda; Desktop and Documents under C:\Users\jorda\OneDrive;
                                 // stashDirs [%APPDATA%\Stash, %LOCALAPPDATA%\Programs\Stash]
```

**`isBlocked` is true when the path:**
- is a drive root;
- is the same as or inside `<any drive>:\` + one of `Windows`, `Program Files`, `Program Files (x86)`, `ProgramData`, `$Recycle.Bin`, `System Volume Information`, `Recovery`, `Boot`;
- is `<any drive>:\pagefile.sys`, `hiberfil.sys` or `swapfile.sys`, or matches `<any drive>:\DumpStack.log*`;
- is inside `env.usersRoot` but not inside `env.userProfile`;
- is a direct child of `env.userProfile` whose name matches `/^ntuser\./i`;
- **is an ancestor of, or equal to,** `env.userProfile`, any of `env.downloads/desktop/documents/pictures/music/videos`, or `env.oneDrive`;
- is the same as or inside any `env.stashDirs` entry.

- [ ] **Step 1: Write the failing tests.**

```ts
test('isSameOrInside ignores case, slash style and trailing separators', () => {
  expect(isSameOrInside('c:/users/JORDA/desktop/', 'C:\\Users\\jorda\\Desktop')).toBe(true)
  expect(isSameOrInside('C:\\Users\\jorda\\Desktop\\a.txt', 'C:\\Users\\jorda\\Desktop\\')).toBe(true)
})
test('isSameOrInside rejects sibling prefixes', () => {
  expect(isSameOrInside('C:\\Windows2\\x.dll', 'C:\\Windows')).toBe(false)
  expect(isSameOrInside('C:\\Program Files Backup\\a', 'C:\\Program Files')).toBe(false)
})
test('normalizePath', () => {
  expect(normalizePath('\\\\?\\c:\\Temp\\..\\x\\')).toBe('C:\\x')
  expect(normalizePath('c:/')).toBe('C:\\')
})
test('defaults match the spec', () => expect(DEFAULT_SETTINGS.thresholds).toEqual(
  { trackFileMinBytes: 1048576, staleMinBytes: 104857600, staleAgeMonths: 6, tempMinAgeHours: 24, idleDays: 30 }))
test('validateSettings fills, normalizes and rejects', () => {
  expect(validateSettings({ exclusions: ['d:/games/'] }).exclusions).toEqual(['D:\\games'])
  expect(() => validateSettings({ thresholds: { idleDays: 0 } })).toThrow('Invalid settings: thresholds.idleDays')
  expect(() => validateSettings({ personalFolders: ['relative\\x'] })).toThrow('Invalid settings: personalFolders')
})
test.each([
  'C:\\Windows\\System32\\x.dll', 'c:\\program files\\app\\a.exe', 'D:\\Program Files\\Steam\\x',
  'C:\\ProgramData\\Package Cache\\x', 'D:\\$Recycle.Bin\\S-1\\$R1', 'E:\\System Volume Information\\x',
  'C:\\pagefile.sys', 'C:\\DumpStack.log.tmp', 'C:\\Users\\other\\a.txt', 'C:\\Users\\Public\\x',
  'C:\\Users\\jorda\\NTUSER.DAT', 'C:\\Users\\jorda\\ntuser.dat.LOG1', 'C:\\', 'D:\\', 'C:\\Users',
  'C:\\Users\\jorda', 'C:\\Users\\jorda\\OneDrive', 'C:\\Users\\jorda\\OneDrive\\Desktop\\',
  'c:/users/jorda/downloads', 'C:\\Users\\jorda\\AppData\\Roaming\\Stash\\settings.json',
])('blocks %s', p => expect(isBlocked(p, SAMPLE_ENV)).toBe(true))
test.each([
  'C:\\Users\\jorda\\Downloads\\setup.exe', 'C:\\Users\\jorda\\AppData\\Local\\Temp\\x',
  'C:\\Users\\jorda\\OneDrive\\Desktop\\old.zip', 'C:\\Users\\jorda\\Projects\\app\\node_modules',
  'C:\\Windows2\\x', 'D:\\Games\\a.bin',
])('allows %s', p => expect(isBlocked(p, SAMPLE_ENV)).toBe(false))
```

- [ ] **Step 2:** Run `npx vitest run tests/unit/paths.test.ts tests/unit/settings.test.ts tests/unit/blocklist.test.ts` → FAIL.
- [ ] **Step 3:** Implement the four source files and `tests/helpers/env.ts`.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `git add src/shared src/core tests; git commit -m "feat(core): shared types, path helpers, settings defaults, blocklist"`

### Task 4: Scan tree model

**Files:** Create `src/core/tree.ts`. Test `tests/unit/tree.test.ts`.

**Interfaces:**
- Consumes: `normalizePath`, `pathKey` (Task 3).
- Produces:

```ts
export interface FolderNode { id: number; parentId: number; name: string; mtimeMs: number; sizeOnDisk: Bytes;
  logicalSize: Bytes; fileCount: number; smallFilesCount: number; smallFilesSize: Bytes;
  directFilesNewestMtimeMs: number; newestMtimeMs: number; unreadable: boolean;
  childIds: number[]; fileIds: number[]; links: string[]; markers: string[]; unmeasured: string[] }
export interface FileEntry { id: number; folderId: number; name: string; sizeOnDisk: Bytes; logicalSize: Bytes;
  mtimeMs: number; cloudOnly: boolean; extraHardLink: boolean }
export interface AddFileInput { name: string; sizeOnDisk: Bytes; logicalSize: Bytes; mtimeMs: number; hardLinkKey: string | null }
export interface ScanTreeData { rootPath: string; trackFileMinBytes: number; folders: FolderNode[]; files: FileEntry[] }
export class ScanTree {
  readonly rootPath: string; readonly folders: FolderNode[]; readonly files: FileEntry[]
  constructor(rootPath: string, rootMtimeMs: number, trackFileMinBytes: number)  // folder 0 = root, parentId -1
  static fromData(d: ScanTreeData): ScanTree
  toData(): ScanTreeData
  addFolder(parentId: number, name: string, mtimeMs: number): number
  addFile(folderId: number, f: AddFileInput): void
  addLink(folderId: number, name: string): void
  addMarker(folderId: number, name: string): void
  addUnmeasured(folderId: number, name: string): void
  markUnreadable(folderId: number): void
  folderPath(id: number): string
  filePath(id: number): string
  findFolder(absPath: string): number | undefined
  childByName(folderId: number, name: string): number | undefined
  isInside(folderId: number, ancestorId: number): boolean          // true when equal
  newestMtimeExcluding(folderId: number, excludedChildIds: number[]): number
  get unreadableCount(): number
}
```

**Rules:**
- **Aggregates update incrementally.** Every add updates `sizeOnDisk`, `logicalSize`, `fileCount` and `newestMtimeMs` up the parent chain, so a partial tree is always consistent.
- **Tracked files:** a file is tracked when `logicalSize ≥ trackFileMinBytes`.
- **Cloud-only:** `cloudOnly` is true when the file is tracked, `logicalSize > 0`, and `sizeOnDisk === 0`.
- **Hard links:** when a non-null `hardLinkKey` repeats, the file adds 0 bytes to the aggregates. A tracked repeat also gets `extraHardLink: true`.
- **`newestMtimeExcluding(f, ex)`** returns the max of `f.mtimeMs`, `f.directFilesNewestMtimeMs`, and the `newestMtimeMs` of every child not in `ex`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('aggregates up the chain and splits tracked vs small files', () => {
  const t = new ScanTree('X:\\root', 1000, 1048576)
  const a = t.addFolder(0, 'a', 2000), b = t.addFolder(a, 'b', 3000)
  t.addFile(b, { name: 'big.bin', sizeOnDisk: 2097152, logicalSize: 2097152, mtimeMs: 5000, hardLinkKey: null })
  t.addFile(b, { name: 'small.txt', sizeOnDisk: 4096, logicalSize: 100, mtimeMs: 4000, hardLinkKey: null })
  expect(t.folders[0].sizeOnDisk).toBe(2101248)
  expect(t.folders[b]).toMatchObject({ smallFilesCount: 1, smallFilesSize: 4096, fileCount: 2 })
  expect(t.filePath(t.folders[b].fileIds[0])).toBe('X:\\root\\a\\b\\big.bin')
  expect(t.folders[0].newestMtimeMs).toBe(5000)
})
test('a hard-linked file counts once')            // same key '1:42' twice, 2 MiB → root 2097152; 2nd extraHardLink
test('a big file with nothing on disk is cloud-only and adds no size')  // logical 5 MiB, onDisk 0
test('newestMtimeExcluding ignores the excluded child')  // folder 1000, small file 1500, child newest 9000 → 1500
test('findFolder is case-insensitive and survives toData/fromData')
test('links add no size and are listed by name')
```

- [ ] **Step 2:** `npx vitest run tests/unit/tree.test.ts` → FAIL.
- [ ] **Step 3:** Implement `src/core/tree.ts`.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `git add src/core/tree.ts tests/unit/tree.test.ts; git commit -m "feat(core): scan tree model"`

### Task 5: Scanner walk and on-disk fixture

**Files:**
- Create: `src/core/rules/markers.ts`, `src/core/scan/fsDeps.ts`, `src/core/scan/lockedFiles.ts`, `src/core/scan/scanTree.ts`, `tests/fixtures/buildFixture.ts`, `tests/helpers/treeQueries.ts`
- Test: `tests/integration/scan.test.ts`

**Interfaces:**
- Consumes: `ScanTree` (Task 4); `ScanProgress`, `Settings`, `WinEnv`, `DEFAULT_SETTINGS`, `normalizePath` (Task 3).
- Produces:

```ts
// markers.ts — case-insensitive: package.json, pyproject.toml, cargo.toml, project.godot, pyvenv.cfg, *.csproj, *.uproject
export function isMarkerFile(name: string): boolean
// fsDeps.ts
export interface FsDeps {
  readdir(dir: string): Promise<Dirent[]>
  lstat(p: string): Promise<Stats>
  hardLinkKey(p: string): Promise<string>   // `${dev}:${ino}` from stat(p, { bigint: true })
  measureLocked(paths: string[]): Promise<Map<string, { size: number; mtimeMs: number }>>
}
export const nodeFsDeps: FsDeps
// lockedFiles.ts
export function measureLockedFiles(paths: string[]): Promise<Map<string, { size: number; mtimeMs: number }>>
// scanTree.ts
export type ScanProgressPayload = Omit<ScanProgress, 'scanId' | 'phase' | 'hashedBytes' | 'hashTotalBytes'>
export interface ScanOptions { root: string; trackFileMinBytes: number; concurrency?: number; progressIntervalMs?: number;
  signal?: AbortSignal; onProgress?: (p: ScanProgressPayload) => void }
export interface ScanResult { tree: ScanTree; incomplete: boolean; durationMs: number; foldersScanned: number; filesScanned: number }
export function scanTree(opts: ScanOptions, deps?: FsDeps): Promise<ScanResult>
// tests/helpers/treeQueries.ts
export function findFile(tree: ScanTree, absPath: string): FileEntry | undefined
// tests/fixtures/buildFixture.ts
export interface Fixture { root: string; env: WinEnv; settings: Settings; expectedSizeOnDisk: Bytes;
  p: Record<string, string>; dispose(): Promise<void> }
export function buildFixture(): Promise<Fixture>
```

**Walk rules:**
- **Defaults:** 32 directory reads in flight; progress every 250 ms.
- **Folder read errors:** `EPERM`/`EACCES`/`EBUSY` → `markUnreadable`. `ENOENT` → ignore.
- **Symlink dirents** are `lstat`ed first.
  - If it is still a symlink or junction → `addLink`. It is never followed.
  - Otherwise it is handled as whatever `lstat` says it is. This covers OneDrive and other reparse points.
- **Files:**
  - `lstat` each file. If `nlink > 1`, get its `hardLinkKey`. Then `addFile`.
  - A small file that passes `isMarkerFile` → `addMarker`.
  - An `ENOENT` from `lstat` → skip silently. `EPERM`/`EACCES`/`EBUSY` → `addUnmeasured`.
- **Locked files at a drive root:** when `root` is a drive root, after the walk send the root's `unmeasured` paths to `deps.measureLocked`. Add each result with `size` as both sizes.
- **Progress:** counts, `bytesSeen` = the root's `sizeOnDisk`, the current path, and `topLevel` = the root's 12 largest children.
- **Abort:** start no new reads, wait for in-flight reads, return `incomplete: true`.

**`measureLockedFiles`:**
- Runs one `powershell.exe -NoProfile -NonInteractive` call.
- Receives the paths as JSON in the `STASH_PATHS` environment variable, never interpolated into the script.
- Runs `Get-Item -Force -LiteralPath` on each path.
- Prints JSON `[{ path, length, lastWriteTimeUtc }]`. Missing items are left out.

**Fixture:** `buildFixture` creates a folder under `os.tmpdir()` and returns:
- **Env:** `env.systemRoot` = root, `env.usersRoot` = `root\Users`, `env.userProfile` = `root\Users\tester` (with standard known-folder subfolders).
- **Settings:** `{ ...DEFAULT_SETTINGS, thresholds: { trackFileMinBytes: 65536, staleMinBytes: 262144, staleAgeMonths: 6, tempMinAgeHours: 24, idleDays: 30 } }`.
- **Ages:** set with `fs.utimes`. "Old" means 400 days ago.
- **`p[key]`:** the file for file rows. For `webapp`, `active`, `unity`, `venv`, `frames` and `small`, it's the folder.
- **`expectedSizeOnDisk`:** Σ `blocks*512` over every file the builder created, from its own `lstat`s, counting the hard-linked pair once.

| key | path (under `Users\tester` unless it starts with `<root>`) | content and age |
|---|---|---|
| winTemp | `<root>\Windows\Temp\x.tmp` | 100 KiB |
| winUpdate | `<root>\Windows\SoftwareDistribution\Download\u.cab` | 100 KiB |
| tempOld | `AppData\Local\Temp\old-dir\a.bin` | 100 KiB, 2 days |
| tempFresh | `AppData\Local\Temp\fresh.bin` | 100 KiB, now |
| chromeCache | `AppData\Local\Google\Chrome\User Data\Default\Cache\data_0` | 100 KiB |
| npmCache | `AppData\Local\npm-cache\_cacache\x.bin` | 100 KiB |
| setupOld, setupNew | `Downloads\setup-old.exe` (40 days), `Downloads\setup-new.msi` (now) | 100 KiB each |
| zipOld | `Downloads\big-old.zip` | 300 KiB, 7 months |
| photo, photoCopy, gitCopy | `Documents\photo.jpg` (old), `Pictures\photo-copy.jpg` (now), `Documents\.git\objects\pack.bin` | identical 200 KiB |
| nearA, nearB | `Documents\near-a.bin`, `Documents\near-b.bin` | 300 KiB; same first and last 64 KiB, different middle |
| hard1, hard2 | `Documents\hard-1.bin`, and `fs.link` to `Documents\hard-2.bin` | 200 KiB |
| loop | `Documents\loop`, a junction to `Documents` | |
| oldVideo | `Documents\old-video.mp4` | 300 KiB, 8 months |
| webapp | `Projects\webapp\package.json` + `node_modules\lib\index.bin` (100 KiB) | all old |
| active | `Projects\active\package.json` (now) + `node_modules\x.bin` (old) | |
| unity | `Projects\game\Assets\a.txt`, `ProjectSettings\p.txt`, `Library\cache.bin` (100 KiB) | all old |
| venv | `Projects\py\pyproject.toml`, `.venv\pyvenv.cfg`, `.venv\lib\x.bin` (100 KiB) | all old |
| blend, blend1 | `Art\scene.blend` (now), `Art\scene.blend1` | 100 KiB each |
| frames | `Renders\shot\frame0001.png` … `frame0006.png` | 70 KiB each, 60 days |
| deep | a folder chain putting `deep.bin`'s full path over 260 characters | 100 KiB |
| small | `Small\s0.txt` … `s9.txt` | 1 KiB each |

- [ ] **Step 1: Write the failing tests** in `tests/integration/scan.test.ts`. A `beforeAll` builds the fixture, and an `afterAll` disposes it.

```ts
test('size on disk matches the fixture, counting the hard link once', async () => {
  const r = await scanTree({ root: fx.root, trackFileMinBytes: 65536 })
  expect(r.incomplete).toBe(false)
  expect(r.tree.folders[0].sizeOnDisk).toBe(fx.expectedSizeOnDisk)
})
test('the junction is a link and is not followed')       // links of Documents contain 'loop'; childByName(docs,'loop') undefined
test('small project manifests are kept as markers')      // markers of p.webapp contain 'package.json'
test('a path over 260 characters is scanned and sized', async () => {
  expect(fx.p.deep.length).toBeGreaterThan(260)
  expect(findFile(tree, fx.p.deep)?.sizeOnDisk).toBe(lstatSync(fx.p.deep).blocks * 512)
})
test('a file that vanishes before lstat is skipped without marking its folder unreadable', async () => {
  const deps: FsDeps = { ...nodeFsDeps, lstat: async p => {
    if (p === fx.p.tempFresh) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    return nodeFsDeps.lstat(p) } }
  const r = await scanTree({ root: fx.root, trackFileMinBytes: 65536 }, deps)
  expect(r.tree.unreadableCount).toBe(0)
  expect(findFile(r.tree, fx.p.tempFresh)).toBeUndefined()
})
test('an EPERM file is unmeasured, and measureLocked is not used below a drive root')
                                    // lstat throws EPERM for p.setupNew; unmeasured = ['setup-new.msi']; spy not called
test('abort returns partial results marked incomplete')  // progressIntervalMs 0, onProgress aborts
test('measureLockedFiles reads sizes through PowerShell', async () =>
  expect((await measureLockedFiles([fx.p.photo])).get(fx.p.photo)?.size).toBe(204800))
```

- [ ] **Step 2:** `npx vitest run tests/integration/scan.test.ts` → FAIL.
- [ ] **Step 3:** Implement the source files, the fixture and the helper.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `git add src/core tests; git commit -m "feat(core): scanner walk with fixture-backed tests"`

### Task 6: Rules catalog and static detectors

**Files:**
- Create:
  - `src/core/rules/catalog.ts`, `src/core/rules/pattern.ts`, `src/core/findings.ts`
  - `src/core/detectors/context.ts`, `scope.ts`, `system.ts`, `tempCaches.ts`, `installersStale.ts`, `index.ts`
  - `tests/helpers/treeFrom.ts`
- Test: `tests/unit/pattern.test.ts`, `tests/unit/detectors.static.test.ts`, `tests/unit/findings.test.ts`, `tests/integration/detectors.test.ts`

**Interfaces:**
- Consumes: `ScanTree` (Task 4); `isBlocked`, `isSameOrInside`, `pathKey`, types (Task 3); `buildFixture`, `scanTree`, `isMarkerFile` (Task 5).
- Produces:

```ts
// catalog.ts
export interface RuleDef { id: RuleId; category: Category; safety: SafetyRating; title: string; explanation: string }
export const RULES: Record<RuleId, RuleDef>   // every rule id in spec §6.3, plus 'duplicates'
export const DEFAULT_LIMITS: { imageSeqMinFiles: number; imageSeqMinBytes: number }   // 100, 524_288_000
// pattern.ts — tokens %SYSTEMROOT% %LOCALAPPDATA% %TEMP%; per-segment '*' and '{a,b}'; case-insensitive; returns folder ids
export function resolvePattern(tree: ScanTree, pattern: string, env: WinEnv): number[]
// context.ts
export interface Limits { imageSeqMinFiles: number; imageSeqMinBytes: number }
export class Claims { claimFolder(id: number): void; claimFile(id: number): void
  folderClaimed(id: number): boolean   /* itself or an ancestor */; fileClaimed(id: number): boolean /* itself or its folder chain */ }
export interface DetectorContext { scanId: string; tree: ScanTree; env: WinEnv; settings: Settings; now: number;
  limits: Limits; claims: Claims; nextId(ruleId: RuleId): string }   // ids `${scanId}:${ruleId}:${n}`
export function createDetectorContext(a: { scanId: string; tree: ScanTree; env: WinEnv; settings: Settings; now: number; limits?: Partial<Limits> }): DetectorContext
export function folderFinding(ctx: DetectorContext, ruleId: RuleId, folderId: number): Finding  // claims; own mtime; sizeUnknown if unreadable
export function fileFinding(ctx: DetectorContext, ruleId: RuleId, fileId: number): Finding      // claims
// scope.ts
export function inPersonalScope(path: string, env: WinEnv, settings: Settings): boolean  // in userProfile but not userProfile\AppData, or in a personalFolders entry
export function insideGitFolder(tree: ScanTree, folderId: number): boolean
// detectors
export function detectSystem(ctx: DetectorContext): Finding[]
export function detectTempCaches(ctx: DetectorContext): Finding[]
export function detectInstallersStale(ctx: DetectorContext): Finding[]
export function runStaticDetectors(ctx: DetectorContext): Finding[]
// findings.ts
export function summarizeFindings(fs: Finding[]): { reclaimable: Bytes; byCategory: Record<Category, Bytes>; windowsCanClean: Bytes }
export function buildSummary(a: { scanId: string; root: string; incomplete: boolean; foldersScanned: number;
  filesScanned: number; durationMs: number; tree: ScanTree; findings: Finding[] }): ScanSummary
// tests/helpers/treeFrom.ts — keys are root-relative paths; folders created implicitly; small files named like markers become markers
export type TreeEntry = { size: number; mtimeMs: number; onDisk?: number; hardLinkKey?: string }
  | { dir: true; mtimeMs?: number; unreadable?: boolean } | { link: true }
export function treeFrom(root: string, entries: Record<string, TreeEntry>, trackFileMinBytes?: number): ScanTree
```

**Rules:**
- **`runStaticDetectors`** runs `detectSystem`, then `detectTempCaches`, then `detectInstallersStale`. (Task 7 inserts `detectDevLeftovers` before `detectInstallersStale`.)
  - It then drops findings inside `settings.exclusions`, and non-info findings where `isBlocked`.
  - Every detector skips anything already claimed.
- **`detectSystem`** finds:
  - `%SYSTEMROOT%\Windows\Temp` → `sys-windows-temp`
  - `%SYSTEMROOT%\Windows\SoftwareDistribution\Download` → `sys-windows-update`
  - `%SYSTEMROOT%\Windows\Installer` and `%SYSTEMROOT%\ProgramData\Package Cache` → `sys-installer-cache`
  - `%SYSTEMROOT%\Windows\WinSxS` → `sys-component-store`
  - tracked files directly in `%SYSTEMROOT%`: `hiberfil.sys` → `sys-hiberfil`; `pagefile.sys` and `swapfile.sys` → `sys-pagefile`
- **`detectTempCaches`:**
  - `temp-user`: direct children of `%TEMP%` that are older than `tempMinAgeHours`. Use the folder's `newestMtimeMs` for folders and the file's `mtimeMs` for tracked files.
  - `browser-cache-chromium`: `%LOCALAPPDATA%\Google\Chrome\User Data\*\{Cache,Code Cache,GPUCache}` and `%LOCALAPPDATA%\Microsoft\Edge\User Data\*\{Cache,Code Cache,GPUCache}`
  - `browser-cache-firefox`: `%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\cache2`
  - `crash-dumps`, `pkg-cache-npm`, `pkg-cache-pip`, `pkg-cache-yarn`: the paths in the spec table
  - Zero-size folders are skipped.
- **`detectInstallersStale`:**
  - `downloads-installers`: tracked `.exe`, `.msi`, `.zip` or `.iso` files anywhere beneath `env.downloads`, older than `idleDays`.
  - `stale-large`: tracked files that are in personal scope, not in `.git`, not cloud-only, not an extra hard link, have `sizeOnDisk ≥ staleMinBytes`, and have an `mtimeMs` more than `staleAgeMonths` calendar months before `now`.
- **`summarizeFindings`:**
  - `reclaimable` and `byCategory` sum non-info findings, excluding those marked `suggestedKeep`.
  - `windowsCanClean` sums info findings, treating `sizeUnknown` as 0.
- **Titles and explanations:** each rule gets a short title and 1–2 sentences saying what it is and what happens if it's removed. Info rules name the Windows tool or setting that handles them.

- [ ] **Step 1: Write the failing tests** (unit tests use `now = Date.UTC(2026, 10, 1)` and `treeFrom`).

```ts
test('resolvePattern expands tokens, * and {a,b} case-insensitively')   // Default + "Profile 1" Cache/GPUCache found, Network not
test('resolvePattern returns nothing when the base is outside the scanned root')
test('temp-user flags only top-level temp items older than 24 hours')
  // top-level folder whose newest file is 25 h old → flagged; tracked file 1 h old → not;
  // an old subfolder inside a fresh top-level folder → not (only top-level items are candidates)
test('browser caches are safe and found per profile')
test('an old zip in Downloads is reported once, as an installer', () =>
  expect(findings.filter(f => f.path === zip).map(f => f.ruleId)).toEqual(['downloads-installers']))
test('stale-large ignores AppData, .git, cloud-only, extra hard links and recent files')
test('stale-large uses calendar months')    // now minus 6 months minus 1 day → stale; now minus 6 months plus 1 day → not
test('system areas are info-only; an unreadable one is size-unknown')
test('findings inside an exclusion are dropped')
test('every rule has a non-empty title and explanation', () =>
  Object.values(RULES).forEach(r => { expect(r.title).not.toBe(''); expect(r.explanation).not.toBe('') }))
test('summarizeFindings excludes keepers and info from reclaimable; windowsCanClean sums info')
// tests/integration/detectors.test.ts — scan the fixture, then runStaticDetectors(createDetectorContext({ ..., env: fx.env, settings: fx.settings }))
test('static detectors on the fixture')
  // dirname(p.tempOld) → 'temp-user'; p.tempFresh → none
  // Chrome Cache folder → 'browser-cache-chromium'; npm-cache folder → 'pkg-cache-npm'
  // p.setupOld and p.zipOld → 'downloads-installers'; p.setupNew → none
  // p.oldVideo → 'stale-large'
  // <root>\Windows\Temp → 'sys-windows-temp'; …\SoftwareDistribution\Download → 'sys-windows-update'
```

- [ ] **Step 2:** `npx vitest run tests/unit/pattern.test.ts tests/unit/detectors.static.test.ts tests/unit/findings.test.ts tests/integration/detectors.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `git add src/core tests; git commit -m "feat(core): rules catalog and system, temp, installer and stale detectors"`

### Task 7: Dev & creative leftovers

**Files:**
- Create: `src/core/detectors/devLeftovers.ts`
- Modify: `src/core/detectors/index.ts`, to run `detectDevLeftovers` after `detectTempCaches`
- Test: `tests/unit/devLeftovers.test.ts`; extend `tests/integration/detectors.test.ts`

**Interfaces:**
- Consumes: `DetectorContext`, `folderFinding`, `fileFinding`, `DEFAULT_LIMITS` (Task 6); `ScanTree.newestMtimeExcluding` (Task 4).
- Produces: `export function detectDevLeftovers(ctx: DetectorContext): Finding[]`.

**How folders are visited:**
- In id order (parents first), skipping claimed subtrees.
- A project is **idle** when `tree.newestMtimeExcluding(project, [leftover]) < now − idleDays`.
- The project folder is the leftover's parent.

| rule | leftover folder | parent (project) must have | idle |
|---|---|---|---|
| dev-node-modules | `node_modules` | marker `package.json` | yes |
| dev-build-output | `build` or `dist` | marker `package.json` or `pyproject.toml` | yes |
| dev-build-output | `target` | marker `Cargo.toml` | yes |
| dev-build-output | `bin` or `obj` | a `*.csproj` marker | yes |
| dev-python-venv | any folder holding marker `pyvenv.cfg` | nothing extra | yes |
| unity-library | `Library` | child folders `Assets` and `ProjectSettings` | yes |
| unreal-caches | `Intermediate`, `DerivedDataCache` | a `*.uproject` marker | yes |
| godot-cache | `.godot` | marker `project.godot` | yes |

- **`blender-backups`:** tracked files whose names match `/\.blend\d+$/i`. There is no idle check.
- **`image-sequences`:** a folder with no subfolders where all of these hold:
  - Tracked files are grouped by the regex `/^(.*?)(\d+)\.(png|jpe?g|exr|tiff?)$/i`, keying each group on prefix plus lower-cased extension.
  - The largest group has ≥ `limits.imageSeqMinFiles` files and ≥ `limits.imageSeqMinBytes` bytes on disk.
  - That group is ≥ 90% of the folder's `sizeOnDisk`.
  - The folder's `newestMtimeMs` is older than `idleDays`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('idle node_modules next to package.json is flagged; an active project is not')
test('a nested node_modules inside a flagged one is not reported again')
test('build output needs its manifest: target + Cargo.toml yes, target alone no')
test('bin and obj next to a .csproj are flagged')
test('a venv is found by pyvenv.cfg whatever its folder name')
test('Unity Library needs both Assets and ProjectSettings')
test('Unreal caches need a .uproject; .godot needs project.godot')
test('.blend1 and .blend12 are flagged; .blend is not')
test('image sequences: 100 frames of 6 MiB idle 31 days flagged; 99 frames not; a big non-frame file blocks it')
test('default limits', () => expect(DEFAULT_LIMITS).toEqual({ imageSeqMinFiles: 100, imageSeqMinBytes: 524288000 }))
test('stale-large skips a big old file inside a flagged node_modules')
// integration, limits { imageSeqMinFiles: 5, imageSeqMinBytes: 307200 }:
//   p.webapp\node_modules flagged, p.active\node_modules not
//   Library of p.unity, .venv of p.venv, p.blend1 and p.frames flagged
```

- [ ] **Step 2:** `npx vitest run tests/unit/devLeftovers.test.ts tests/integration/detectors.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS (Task 6 tests still pass).
- [ ] **Step 5: Commit** `git add src/core tests; git commit -m "feat(core): dev and creative leftover detectors"`

### Task 8: Duplicates

**Files:**
- Create: `src/core/hash.ts`, `src/core/keeper.ts`, `src/core/detectors/duplicates.ts`
- Test: `tests/unit/keeper.test.ts`, `tests/unit/duplicates.test.ts`, `tests/integration/hash.test.ts`; extend `tests/integration/detectors.test.ts`

**Interfaces:**
- Consumes: `DetectorContext`, `inPersonalScope`, `insideGitFolder` (Task 6); `ScanTree` (Task 4); `isBlocked`, `isSameOrInside` (Task 3).
- Produces:

```ts
// duplicates.ts
export interface SizeGroup { logicalSize: Bytes; fileIds: number[]; paths: string[] }
export interface HashGroup { hash: string; fileIds: number[] }
export function duplicateCandidates(ctx: DetectorContext): SizeGroup[]   // call after runStaticDetectors on the same ctx
export function buildDuplicateFindings(groups: HashGroup[], a: { scanId: string; tree: ScanTree; env: WinEnv }): Finding[]
// hash.ts
export function partialHash(path: string, size: Bytes): Promise<string>  // sha256 of first 65,536 + last 65,536 bytes; whole file if size ≤ 131,072
export function fullHash(path: string, signal?: AbortSignal): Promise<string>
export function hashGroups(groups: SizeGroup[], o?: { signal?: AbortSignal;
  onProgress?: (hashedBytes: Bytes, totalBytes: Bytes) => void }): Promise<HashGroup[]>
// keeper.ts
export interface Copy { path: string; mtimeMs: number }
export function suggestKeeper(copies: Copy[], env: WinEnv): number
export function groupsWithEveryCopySelected(selectedIds: ReadonlySet<string>, findings: Finding[]): string[]
```

**Rules:**
- **Candidates** are tracked files that pass all of these, grouped by `logicalSize` (groups of 2 or more):
  - in personal scope
  - not claimed
  - not in `.git`
  - not cloud-only
  - not an extra hard link
  - not inside an exclusion
  - not blocked
- **`hashGroups`:**
  - Partial hashes split each size group. Full hashes run only for files that share a partial hash.
  - Unreadable files are dropped.
  - `totalBytes` = Σ candidate sizes. Files settled at the partial stage add their size to `hashedBytes` at that point, so progress ends at exactly `totalBytes`.
  - An abort rejects with `AbortError`.
- **Findings:**
  - One finding per copy: `ruleId: 'duplicates'`, `category: 'duplicates'`, `safety: 'review'`.
  - Copies share a `groupId` of `${scanId}:dup:${n}`. Finding ids are `${scanId}:duplicates:${n}`.
  - Exactly one copy per group gets `suggestedKeep: true`.
- **`suggestKeeper`:**
  - Prefer copies not inside `env.downloads`, `env.temp` or `env.desktop`.
  - Among those, choose the smallest `mtimeMs`; break ties by shortest path, then by ordinal path order.
  - If every copy is in those folders, choose the oldest overall.

- [ ] **Step 1: Write the failing tests.**

```ts
const E = SAMPLE_ENV   // tests/helpers/env.ts (Task 3)
test('keeper: outside Downloads/Temp/Desktop first, then oldest', () => expect(suggestKeeper([
  { path: `${E.downloads}\\a.jpg`, mtimeMs: 1 }, { path: `${E.documents}\\a.jpg`, mtimeMs: 5 },
  { path: `${E.pictures}\\b.jpg`, mtimeMs: 3 }], E)).toBe(2))
test('keeper: ties break by shortest path')
test('keeper: all in Downloads/Temp/Desktop → oldest overall')
test('groupsWithEveryCopySelected flags only groups with every copy selected')
test('candidates exclude AppData, .git, cloud-only, extra hard links and claimed folders')
test('a lone file of a given size is not a candidate')
test('each duplicate group has exactly one suggested keeper')
// tests/integration/hash.test.ts (real temp files)
test('files sharing a partial hash but differing in the middle are not duplicates')
test('a file deleted before hashing is dropped without failing')
test('progress ends exactly at totalBytes')
// detectors integration: p.photo + p.photoCopy grouped and p.photo kept; p.gitCopy, nearA/nearB and hard2 not in any group
```

- [ ] **Step 2:** `npx vitest run tests/unit/keeper.test.ts tests/unit/duplicates.test.ts tests/integration/hash.test.ts tests/integration/detectors.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `git add src/core tests; git commit -m "feat(core): duplicate detection with two-stage hashing"`

### Task 9: Workers and the scan session

**Files:**
- Create: `src/workers/protocol.ts`, `src/workers/scanWorker.ts`, `src/workers/hashWorker.ts`, `src/main/workerRunners.ts`, `src/main/session.ts`
- Test: `tests/unit/session.test.ts`

**Interfaces:**
- Consumes:
  - `scanTree`, `ScanProgressPayload` (Task 5)
  - `createDetectorContext`, `runStaticDetectors`, `buildSummary`, `summarizeFindings` (Task 6)
  - `duplicateCandidates`, `buildDuplicateFindings`, `hashGroups`, `SizeGroup`, `HashGroup` (Task 8)
  - `ScanTree`, `ScanTreeData` (Task 4)
  - `isSameOrInside` and the types (Task 3)
- Produces:

```ts
// protocol.ts
export interface ScanJob { scanId: string; root: string; settings: Settings; env: WinEnv; now: number }
export interface ScanDone { tree: ScanTreeData; findings: Finding[]; candidates: SizeGroup[]; incomplete: boolean;
  durationMs: number; foldersScanned: number; filesScanned: number; error?: string }
export type ScanWorkerMessage = { type: 'progress'; progress: ScanProgressPayload } | ({ type: 'done' } & ScanDone) | { type: 'error'; message: string }
export type HashWorkerMessage = { type: 'progress'; hashedBytes: Bytes; totalBytes: Bytes } | { type: 'done'; groups: HashGroup[] } | { type: 'error'; message: string }
export type WorkerCommand = { type: 'cancel' }
// session.ts
export interface ScanRunner { run(job: ScanJob, onProgress: (p: ScanProgressPayload) => void, signal: AbortSignal): Promise<ScanDone> }
export interface HashRunner { run(groups: SizeGroup[], onProgress: (hashed: Bytes, total: Bytes) => void, signal: AbortSignal): Promise<HashGroup[]> }
export interface LatestScan { scanId: string; root: string; tree: ScanTree; findings: Finding[]; summary: ScanSummary }
export class ScanSession {
  constructor(deps: { scanRunner: ScanRunner; hashRunner: HashRunner; getSettings(): Settings; env: WinEnv;
    emit(e: SessionEvent): void; now?(): number })
  get state(): SessionState
  get latest(): LatestScan | null
  start(root: string): string                  // returns scanId (randomUUID); throws Error('busy') while scanning/hashing
  cancel(): void
  resolveFindings(ids: string[]): { ok: true; findings: Finding[] } | { ok: false; reason: 'stale-scan' | 'busy' | 'unknown-finding' }
  removeFindings(ids: string[]): void          // recomputes summary
  applyExclusions(settings: Settings): void    // drops findings inside exclusions; recomputes summary
}
// workerRunners.ts — import createScanWorker from '../workers/scanWorker?nodeWorker' (same for hash)
export function createScanRunner(): ScanRunner
export function createHashRunner(): HashRunner
```

**Rules:**
- **`start`:**
  - Sets state to `scanning` and emits `progress` events with `phase: 'scanning'`.
  - When the scan finishes, sets state to `hashing`, runs the hash runner on `candidates`, and emits `progress` with `phase: 'hashing'` plus `hashedBytes`/`hashTotalBytes`.
  - Then sets `latest` = tree + static findings + `buildDuplicateFindings`, emits `done` with `buildSummary`, and sets state to `ready`.
- **Cancel:**
  - During scanning: the partial tree and static findings are kept, hashing is skipped, and the result is `incomplete`.
  - During hashing: static findings are kept, no duplicate findings are produced, and the result is `incomplete`.
- **Exception inside the scan worker** (spec §9, "partial results kept"):
  - The worker catches it and posts `done` with the partial tree, `incomplete: true` and `error`.
  - The session keeps those partial results as `latest`, emits `error`, then emits `done`. Hashing is skipped.
- **Worker dies without posting `done`:** emits `error` and keeps the previous `latest`. State becomes `ready` if a previous `latest` exists, otherwise `idle`.
- **`resolveFindings`** returns:
  - `busy` while scanning or hashing
  - `stale-scan` if any id's scanId prefix (the text before the first `:`) is not `latest.scanId`
  - `unknown-finding` if any id is missing from `latest.findings`
- **`scanWorker.ts`:** reads the `ScanJob` from `workerData`, wires the `cancel` command to an `AbortController`, runs `scanTree`, then runs `runStaticDetectors` and `duplicateCandidates` on one context. It posts `done` with `tree.toData()`.
- **`hashWorker.ts`:** reads `{ groups }`, runs `hashGroups`, and posts `done`.

- [ ] **Step 1: Write the failing tests** (fake runners built from `treeFrom` trees and canned results).

```ts
test('scan, then hash, then done with duplicates included and state ready')
test('start while busy throws')
test('cancel during scan keeps partial static findings, skips hashing, marks incomplete')
test('cancel during hashing keeps static findings, adds no duplicates, marks incomplete')
test('resolveFindings rejects ids from an earlier scan as stale-scan', async () => {
  await runToDone(session); const oldId = session.latest!.findings[0].id
  await runToDone(session)
  expect(session.resolveFindings([oldId])).toEqual({ ok: false, reason: 'stale-scan' })
})
test('resolveFindings is busy while a scan runs')
test('removeFindings and applyExclusions update findings and summary')
test('a scan that fails midway keeps its partial results, marked incomplete, and reports the error')
                              // runner resolves ScanDone with error 'boom' → events include error and done; latest.summary.incomplete
test('a runner that rejects emits error and keeps the previous results')
```

- [ ] **Step 2:** `npx vitest run tests/unit/session.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Add the `electron-vite/node` types reference so the `?nodeWorker` imports typecheck.
- [ ] **Step 4:** Re-run → PASS. Then `npm run typecheck` and `npm run build` both exit 0, which proves the worker imports bundle.
- [ ] **Step 5: Commit** `git add src tests; git commit -m "feat(main): scan session with scan and hash workers"`

### Task 10: Recycle Bin info, `$I` records, record lookup

**Files:**
- Create: `src/core/recycleBinInfo.ts`, `src/main/recycleBin.ts`, `tests/helpers/iRecord.ts`
- Test: `tests/unit/recycleBinInfo.test.ts`, `tests/unit/recycleBin.test.ts`, `tests/integration/recycleBin.test.ts`

**Interfaces:**
- Consumes: `pathKey` (Task 3).
- Produces:

```ts
// core/recycleBinInfo.ts — layout: int64 version (2) | int64 size | int64 FILETIME | int32 path length in UTF-16 units incl. NUL | UTF-16LE path
export interface IRecord { version: 2; originalSize: bigint; deletedAtMs: number; originalPath: string }
export function parseIRecord(buf: Buffer): IRecord          // throws Error('Unsupported $I record')
// main/recycleBin.ts
export interface RecycleBinInfo { drive: string; status: 'enabled' | 'disabled' | 'unknown'; maxCapacityBytes: Bytes; usedBytes: Bytes }
export interface RecycledRecord { iName: string; rName: string; originalPath: string; deletedAtMs: number }
export function parseMountvol(text: string): string | null       // '{guid}'
export function parseRegDwords(text: string): Record<string, number>
export function parseWhoamiSid(text: string): string
export function getUserSid(): Promise<string>                    // whoami /user /fo csv /nh, cached
export function getRecycleBinInfo(drive: string): Promise<RecycleBinInfo>
export function recycleBinDir(drive: string): Promise<string>    // `${drive}\$Recycle.Bin\${sid}`
export function findRecycledRecord(drive: string, originalPath: string, sinceMs: number): Promise<RecycledRecord | null>
// tests/helpers/iRecord.ts
export function makeIRecord(r: { originalSize: bigint; deletedAtMs: number; path: string }): Buffer
```

**Rules:**
- **Status:**
  1. Get the volume GUID from `mountvol <drive> /L`.
  2. Run `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\<GUID>`.
  3. `NukeOnDelete` 0 with `MaxCapacity` present → `enabled`, with `maxCapacityBytes` = `MaxCapacity × 1,048,576`.
  4. `NukeOnDelete` 1 → `disabled`.
  5. Anything else, including any command failure → `unknown` (with `maxCapacityBytes` 0).
  - All child processes use `execFile`, never a shell.
- **`usedBytes`:** the recursive logical size of the `$R*` entries in `recycleBinDir`, or 0 if the folder is missing.
- **`findRecycledRecord`:**
  - Parses only `$I*` files whose fs mtime ≥ `sinceMs − 60_000`.
  - A record matches when its path equals `pathKey(originalPath)` and `deletedAtMs ≥ sinceMs − 2_000`. The newest match wins.
  - `rName = '$R' + iName.slice(2)`.
- **FILETIME to ms:** `Number(ft / 10_000n - 11_644_473_600_000n)`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('parses a version 2 record with a non-ASCII path', () => {
  const path = 'C:\\Users\\jorda\\Música\\naïve 📁 写真.txt'
  expect(parseIRecord(makeIRecord({ originalSize: 1234n, deletedAtMs: Date.UTC(2026, 10, 1), path })))
    .toEqual({ version: 2, originalSize: 1234n, deletedAtMs: Date.UTC(2026, 10, 1), originalPath: path })
})
test('rejects version 1 and truncated records')
test('parseMountvol', () => expect(parseMountvol('    \\\\?\\Volume{8b748fbd-2416-4233-9195-ff48d41241de}\\\r\n'))
  .toBe('{8b748fbd-2416-4233-9195-ff48d41241de}'))
test('parseRegDwords', () => expect(parseRegDwords(
  '\r\nHKEY_CURRENT_USER\\...\\{8b748fbd-2416-4233-9195-ff48d41241de}\r\n    MaxCapacity    REG_DWORD    0x66e7\r\n    NukeOnDelete    REG_DWORD    0x0\r\n'))
  .toEqual({ MaxCapacity: 26343, NukeOnDelete: 0 }))
test('parseWhoamiSid', () => expect(parseWhoamiSid('"desktop-1\\jorda","S-1-5-21-1-2-3-1001"\r\n')).toBe('S-1-5-21-1-2-3-1001'))
// integration (read-only)
test('C: has an enabled Recycle Bin with a capacity', async () => {
  const i = await getRecycleBinInfo('C:'); expect(i.status).toBe('enabled'); expect(i.maxCapacityBytes).toBeGreaterThan(0) })
test('a drive letter that does not exist is unknown')     // first letter from Z down with no existsSync(`${L}:\\`)
```

- [ ] **Step 2:** `npx vitest run tests/unit/recycleBinInfo.test.ts tests/unit/recycleBin.test.ts tests/integration/recycleBin.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `git add src tests; git commit -m "feat: Recycle Bin status, capacity, usage and \$I record lookup"`

### Task 11: Settings and cleanup-log persistence

**Files:**
- Create: `src/main/settings.ts`, `src/main/cleanupLog.ts`
- Test: `tests/unit/settingsStore.test.ts`, `tests/unit/cleanupLog.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_SETTINGS`, `validateSettings`, and the types (Task 3).
- Produces:

```ts
// settings.ts
export function loadSettings(dir: string): Promise<Settings>              // missing → defaults; invalid → renamed settings.json.bad, defaults
export function saveSettings(dir: string, s: unknown): Promise<Settings>  // validate, write settings.json.tmp, rename over settings.json
// cleanupLog.ts — file <dir>\cleanup-log.jsonl
export class CleanupLog {
  constructor(dir: string)
  append(entry: CleanupBatch | RestoreRecord): Promise<void>
  readAll(): Promise<(CleanupBatch | RestoreRecord)[]>   // malformed lines skipped
  history(): Promise<HistoryEntry[]>                     // batches newest first, each with its restore records
  getBatch(batchId: string): Promise<CleanupBatch | null>
}
```

- [ ] **Step 1: Write the failing tests.**

```ts
test('settings round-trip; a missing file gives defaults')
test('a corrupt settings file is set aside as settings.json.bad and defaults are used')
test('saveSettings rejects invalid input and leaves the old file untouched')
test('the log appends one line per entry and skips malformed lines')
test('history lists batches newest first with their restore records')
```

- [ ] **Step 2:** `npx vitest run tests/unit/settingsStore.test.ts tests/unit/cleanupLog.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `git add src/main tests; git commit -m "feat(main): settings and cleanup log persistence"`

### Task 12: Cleanup engine

**Files:** Create `src/main/cleanup.ts`. Test `tests/unit/cleanup.test.ts`.

**Interfaces:**
- Consumes: `isBlocked`, `driveOf` and the types (Task 3); `RecycleBinInfo`, `RecycledRecord` (Task 10); `CleanupLog` (Task 11).
- Produces:

```ts
export interface Recycler { trash(path: string): Promise<void> }
export interface CleanupDeps {
  recycler: Recycler
  binInfo(drive: string): Promise<RecycleBinInfo>
  findRecord(drive: string, originalPath: string, sinceMs: number): Promise<RecycledRecord | null>
  log: Pick<CleanupLog, 'append'>
  env: WinEnv
  now(): number
}
export function runCleanup(selected: Finding[], allFindings: Finding[], confirmOverflow: boolean, deps: CleanupDeps,
  onProgress?: (done: number, total: number) => void): Promise<CleanOutcome>
export function tipFor(path: string): string   // Chrome/Edge/Firefox paths → 'Close Chrome and retry' etc.; else 'Close any program using it and retry'
```

**Checks, in order.** The first one that applies decides the item. Reasons are the fixed strings from Global Constraints.
1. **Info findings:** `safety === 'info'` → skipped, "protected".
2. **Per drive** (from `driveOf`):
   - bin `disabled` → "Recycle Bin is turned off on this drive"
   - bin `unknown` → "Stash couldn't confirm this drive's Recycle Bin"
   - item `logicalSize > maxCapacityBytes` → "too big for the Recycle Bin"
3. **Overflow:** if the drive's remaining items' Σ `logicalSize` plus `usedBytes` exceeds `maxCapacityBytes`, and `confirmOverflow` is false, return `needsOverflowConfirm` for that drive. This happens **before anything is recycled or logged**.
4. **Per item, just before it moves:**
   - `isBlocked` → "protected".
   - **Duplicates:** if no other copy in the group (taken from `allFindings`) is both unselected and still exists → "would remove every copy".
   - **Re-check with `lstat`** → "changed since scan" when:
     - the item is missing, now a symlink or junction, or a different type;
     - for files, `size !== logicalSize` or `mtimeMs !== mtimeMs`;
     - for folders, its own `mtimeMs` has changed.
5. **Move it with `recycler.trash`.**
   - If that throws → skipped, `reason: "couldn't move it to the Recycle Bin: <message>"`, `tip: tipFor(path)`.
   - On success → `recycledAs = (await findRecord(drive, path, batchStartMs))?.rName`.
6. **Log it:** append exactly one `CleanupBatch` (`batchId = randomUUID()`) and return `done`.

- [ ] **Step 1: Write the failing tests.** These use a fake recycler that moves items into a temp "bin" folder, fake `binInfo` and `findRecord`, and real temp files for the re-checks.

```ts
test('recycles unchanged items and records recycledAs')
test('a file modified after the scan is skipped as "changed since scan"')
test('a folder replaced by a junction is skipped as "changed since scan"')
test('blocklisted and info findings are never recycled')
test('every item on a drive whose bin is off, or unconfirmed, is refused')
test('an item bigger than the bin is skipped as "too big for the Recycle Bin"')
test('overflow asks first and recycles and logs nothing', async () => {
  const out = await runCleanup(sel, sel, false, deps)
  expect(out.status).toBe('needsOverflowConfirm')
  expect(deps.recycler.trash).not.toHaveBeenCalled(); expect(deps.log.append).not.toHaveBeenCalled()
})
test('confirmOverflow proceeds')
test('duplicates are skipped when no other copy would remain, including when the unselected copy vanished')
test('a failed move is skipped with the reason and a Chrome tip')
  // path under …\Google\Chrome\User Data\Default\Cache, recycler throws Error('in use') →
  // { status: 'skipped', reason: "couldn't move it to the Recycle Bin: in use", tip: 'Close Chrome and retry' }
test('each run appends exactly one batch')
```

- [ ] **Step 2:** `npx vitest run tests/unit/cleanup.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `git add src/main/cleanup.ts tests; git commit -m "feat(main): cleanup engine with pre-flight and re-validation"`

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

### Task 15: App shell and Overview

**Files:**
- Modify: `src/renderer/src/App.tsx`, `src/renderer/src/main.tsx`
- Create: `src/renderer/src/styles.css`, `src/renderer/src/lib/format.ts`, `src/renderer/src/lib/overviewText.ts`, `src/renderer/src/lib/useSession.ts`, `src/renderer/src/screens/Overview.tsx`
- Test: `tests/unit/format.test.ts`, `tests/unit/overviewText.test.ts`; create `tests/e2e/app.spec.ts`

**Interfaces:**
- Consumes: `window.stash: StashApi` (Task 14); types (Task 3); `buildFixture` (Task 5).
- Produces:

```ts
export function formatBytes(bytes: Bytes): string   // binary units B/KB/MB/GB/TB, one decimal from KB up, '0 B'
export function freeLine(bytes: Bytes): string      // 'You could free about 12.3 GB'
export function windowsLine(bytes: Bytes): string   // '+ 32.6 GB Windows can clean itself'
export function binLine(bytes: Bytes): string       // 'Recycle Bin: 1.2 GB. Space is only freed when you empty the Recycle Bin.'
export function useSession(): { state: SessionState; progress: ScanProgress | null; summary: ScanSummary | null; error: string | null }
```

**App layout:**
- `App.tsx` has a sidebar with one module, **Space**, and tabs Overview · Explore · Cleanup · History · Settings. Tabs are local state; no router.
- `styles.css` defines color tokens on `:root`, with dark values under `@media (prefers-color-scheme: dark)`.

**Overview shows:**
- a usage bar per drive
- `freeLine` with a per-category breakdown
- `windowsLine` and `binLine`
- **Scan**, with a target picker from `settings.scanTargets`, or **Cancel** while busy
- live counts, the current path and top-level bars during a scan
- an "Incomplete scan" badge
- **Rescan as administrator** when `unreadableFolders > 0`
- errors inline

**`tests/e2e/app.spec.ts` setup (shared by Tasks 15–19):**
- Build the fixture.
- Create a temp `STASH_USER_DATA` folder and write `settings.json` there with `fx.settings`.
- Launch with `args: ['.', `--scan=${fx.root}`]`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('formatBytes', () => {
  expect(formatBytes(0)).toBe('0 B'); expect(formatBytes(1023)).toBe('1023 B'); expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(1048576)).toBe('1.0 MB'); expect(formatBytes(Math.round(12.3 * 2 ** 30))).toBe('12.3 GB')
})
test('overview copy', () => {
  expect(freeLine(Math.round(12.3 * 2 ** 30))).toBe('You could free about 12.3 GB')
  expect(windowsLine(Math.round(32.6 * 2 ** 30))).toBe('+ 32.6 GB Windows can clean itself')
  expect(binLine(Math.round(1.2 * 2 ** 30))).toBe('Recycle Bin: 1.2 GB. Space is only freed when you empty the Recycle Bin.')
})
// e2e
test('the startup scan of the fixture ends on Overview with a reclaimable line', async () =>
  await expect(page.getByText(/You could free about/)).toBeVisible({ timeout: 60_000 }))
```

- [ ] **Step 2:** `npx vitest run tests/unit/format.test.ts tests/unit/overviewText.test.ts` → FAIL. Then `npm run test:e2e -- tests/e2e/app.spec.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run both → PASS.
- [ ] **Step 5: Commit** `git add src/renderer tests; git commit -m "feat(ui): app shell and Overview"`

### Task 16: Explore

**Files:**
- Create: `src/renderer/src/lib/treemapLayout.ts`, `src/renderer/src/components/Treemap.tsx`, `src/renderer/src/components/ContextMenu.tsx`, `src/renderer/src/screens/Explore.tsx`
- Test: `tests/unit/treemapLayout.test.ts`; extend `tests/e2e/app.spec.ts`

**Interfaces:**
- Consumes: `getFolderView`, `showItem`, `excludeFolder` (Task 14); `formatBytes` (Task 15).
- Produces:

```ts
export interface TreemapRect { x0: number; y0: number; x1: number; y1: number; depth: number; node: ViewNode }
export function layoutTreemap(root: ViewNode, width: number, height: number): TreemapRect[]
// d3-hierarchy treemap + treemapSquarify; paddingInner 2; paddingTop 16 for depth-1 folders; zero-size nodes omitted
```

**Explore shows:**
- A breadcrumb starting at the scan root.
- A canvas treemap, two levels deep from `getFolderView(id, 2)`, sized to its container with `devicePixelRatio`.
  - Hovering shows a tooltip with name and size. Clicking a folder drills in.
  - Right-click offers **Open in File Explorer** and, for folders, **Exclude from Stash**.
- A sortable list of the current folder's children: name, size on disk, % of parent, modified.
  - Clicking a folder row also drills in.
- Unreadable folders are hatched and labelled "Can't read". Incomplete scans show the badge.

- [ ] **Step 1: Write the failing tests.**

```ts
test('rect areas follow sizes and stay inside the canvas')   // 1000×500, children 600/300/100 → area ratios within 2%
test('zero-size nodes get no rect')
test('children lie inside their parent rect')
// e2e
test('Explore lists the fixture folders and drills into Users')  // Explore tab → row "Users" → click → breadcrumb ends "Users"
```

- [ ] **Step 2:** Run the unit test and the e2e test → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run both → PASS.
- [ ] **Step 5: Commit** `git add src/renderer tests; git commit -m "feat(ui): Explore treemap and list"`

### Task 17: Cleanup screen

**Files:**
- Create: `src/renderer/src/lib/selection.ts`, `src/renderer/src/components/FindingList.tsx`, `src/renderer/src/components/ConfirmDialog.tsx`, `src/renderer/src/components/ResultSummary.tsx`, `src/renderer/src/screens/Cleanup.tsx`
- Test: `tests/unit/selection.test.ts`; extend `tests/e2e/app.spec.ts`

**Interfaces:**
- Consumes: `getFindings`, `clean`, `onCleanProgress`, `openDiskCleanup`, `openStorageSettings`, `openRecycleBin` (Task 14); `formatBytes` (Task 15).
- Produces:

```ts
export interface Selection { selected: ReadonlySet<string>; keepers: ReadonlyMap<string, string> }  // groupId → finding id
export function initialSelection(findings: Finding[]): Selection   // safe selected; review/info not; keepers from suggestedKeep
export function toggle(sel: Selection, f: Finding): Selection      // no-op for info and for its group's keeper
export function setKeeper(sel: Selection, f: Finding): Selection   // f becomes keeper and is deselected
export function selectCategory(sel: Selection, findings: Finding[], c: Category, on: boolean): Selection  // never info or keepers
export function selectedTotal(sel: Selection, findings: Finding[]): { count: number; bytes: Bytes }
```

**The screen:**
- **Category cards**, in order: "Duplicate files", "Temp files & caches", "Old installers & stale files", "Dev & creative leftovers".
  - Each card shows its total and has select all/none.
  - Each expands into a virtualized list (`@tanstack/react-virtual`) with a checkbox, path, size, safety badge and explanation.
  - Duplicate copies appear grouped, with a "Keep this one" control.
- **"Windows can clean these" card**, last:
  - Info findings with their explanations and sizes, or "size unknown".
  - **Open Disk Cleanup** and **Open Storage settings**.
  - No checkboxes.
- **Sticky footer:** the selected count and size, plus **Clean selected**. It is disabled while a scan runs or when nothing is selected.
- **Confirm dialog:** `${count} items, ${formatBytes(bytes)}. These go to the Recycle Bin.` with Cancel / Clean.
- **On `needsOverflowConfirm`**, show a second dialog: "This is more than your Recycle Bin has room for. Windows will permanently remove your oldest recycled items to make space." with Cancel / Continue anyway. Continue calls `clean(ids, true)`.
- **On `rejected` with `stale-scan`:** "Your results are out of date. Scan again before cleaning."
- **Result summary:**
  1. `Recycled ${n} items (${size}).`
  2. Skipped items, grouped by reason, with tips.
  3. "Space is only freed when you empty the Recycle Bin." and **Open Recycle Bin**.

- [ ] **Step 1: Write the failing tests.**

```ts
test('safe findings start selected; review and info do not')
test('a duplicate group never has every copy selected', () => {
  let s = selectCategory(initialSelection(group3), group3, 'duplicates', true)
  expect(s.selected.has(keeper.id)).toBe(false)
  expect(toggle(s, keeper).selected.has(keeper.id)).toBe(false)
  s = setKeeper(s, other); expect(s.selected.has(other.id)).toBe(false); expect(s.keepers.get(groupId)).toBe(other.id)
})
test('info findings cannot be selected')
test('selectedTotal sums selected findings only')
// e2e
test('Cleanup lists the fixture .blend1 under Dev & creative leftovers, unselected')
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `git add src/renderer tests; git commit -m "feat(ui): Cleanup screen with safe selection rules"`

### Task 18: History and Settings screens

**Files:**
- Create: `src/renderer/src/lib/historyStatus.ts`, `src/renderer/src/lib/settingsForm.ts`, `src/renderer/src/screens/History.tsx`, `src/renderer/src/screens/Settings.tsx`
- Test: `tests/unit/historyStatus.test.ts`, `tests/unit/settingsForm.test.ts`; extend `tests/e2e/app.spec.ts`

**Interfaces:**
- Consumes: `getHistory`, `restoreBatch`, `getSettings`, `saveSettings`, `pickFolder` (Task 14); `MiB`, `DEFAULT_SETTINGS` (Task 3).
- Produces:

```ts
export function batchStatus(e: HistoryEntry): 'recycled' | 'restored' | 'partly restored' | 'nothing recycled'
export interface SettingsForm { exclusions: string[]; personalFolders: string[]; scanTargets: string[];
  trackFileMinMB: number; staleMinMB: number; staleAgeMonths: number; tempMinAgeHours: number; idleDays: number }
export function toForm(s: Settings): SettingsForm
export function fromForm(f: SettingsForm): Settings   // MB × 1,048,576
```

**History:**
- Batches newest first. Each shows its date, item count, total size and `batchStatus`.
- **Restore** is hidden when nothing in the batch is restorable.
- Each batch expands into a per-item list showing status, reason, tip and restored-to path.
- Shows "No cleanups yet" when the log is empty.

**Settings:**
- Editable lists with **Add folder** (`pickFolder`) and remove.
- Number inputs with their units.
- **Save** shows any validation errors from `saveSettings`.

- [ ] **Step 1: Write the failing tests.**

```ts
test('batchStatus covers recycled, restored, partly restored and nothing recycled')
test('settings form round-trips and converts MB with 1048576', () => {
  expect(toForm(DEFAULT_SETTINGS).trackFileMinMB).toBe(1); expect(fromForm(toForm(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS) })
// e2e
test('History starts empty; a changed threshold survives a Save and reload')
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Re-run → PASS.
- [ ] **Step 5: Commit** `git add src/renderer tests; git commit -m "feat(ui): History and Settings screens"`

### Task 19: Full round trip, installer, manual checks

**Files:**
- Modify: `tests/e2e/app.spec.ts`, `electron-builder.yml`
- Create: `docs/manual-checks.md`

**Interfaces:**
- Consumes: the whole app; `findRecycledRecord` (Task 10) for the safety net.

- [ ] **Step 1: Write the round-trip e2e test.**

```ts
test('recycle the fixture .blend1, then restore it from History', async () => {
  const original = readFileSync(fx.p.blend1)
  // Cleanup → expand "Dev & creative leftovers" → tick scene.blend1 → Clean selected → Clean
  await expect(page.getByText(/Recycled 1 item/)).toBeVisible()
  expect(existsSync(fx.p.blend1)).toBe(false)
  // History → Restore
  await expect(page.getByText('restored')).toBeVisible()
  expect(readFileSync(fx.p.blend1)).toEqual(original)
})
test('a folder changed after the scan is skipped as "changed since scan"', async () => {
  writeFileSync(join(fx.p.webapp, 'node_modules', 'new.txt'), 'x')   // changes the folder's own mtime
  // Cleanup → tick the webapp node_modules finding → Clean selected → Clean
  await expect(page.getByText('changed since scan')).toBeVisible()
  expect(existsSync(join(fx.p.webapp, 'node_modules'))).toBe(true)
})
// afterAll: if p.blend1 is missing, move it back via findRecycledRecord; then fx.dispose()
```

- [ ] **Step 2:** Run `npm run test:e2e`. Expect a PASS. A failure points to wiring in Tasks 14–17; fix it there and re-run.
- [ ] **Step 3: Installer.**
  - In `electron-builder.yml`, set NSIS `oneClick: false`, `allowToChangeInstallationDirectory: true` and `artifactName: Stash-Setup-${version}.${ext}`, with no signing.
  - Run `npm run build:win`.
  - Expect `dist\Stash-Setup-<version>.exe` to exist.
- [ ] **Step 4: Write `docs/manual-checks.md`** with a results column. Checks 2–5 are read-only, so the implementer runs them and records the results. Cleanup is never run on real files.
  1. Install from `dist\`. SmartScreen will warn: choose **More info**, then **Run anyway**.
  2. Scan C:. The total should be within 5% of File Explorer's "Used space" for C:. Unreadable folders explain the gap, and **Rescan as administrator** narrows it.
  3. "Windows can clean these" lists `hiberfil.sys` and `pagefile.sys`, about 6.2 GB and 26.4 GB on this machine.
  4. A OneDrive file known to be cloud-only shows about 0 B in Explore.
  5. After **Rescan as administrator**, `C:\Windows\Temp` shows a size.
- [ ] **Step 5: Full verification.** Run `npm run typecheck`, `npm test` and `npm run test:e2e`. All pass.
- [ ] **Step 6: Commit** `git add -A; git commit -m "test: end-to-end recycle and restore; NSIS installer; manual checks"`
