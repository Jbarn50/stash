# Stash — Space & Cleanup (v1) Design

**Date:** 2026-11-01
**Status:** Approved in brainstorming; awaiting written-spec review
**Project:** `C:\Users\jorda\Software\stash`

## 1. Context

Stash is a personal Windows 11 app for managing files and documents. It is planned as four modules, each built as its own sub-project:

| Order | Module | Summary |
|---|---|---|
| 1 | **Space** (this spec) | See what uses disk space, find waste, clean it up safely |
| 2 | Icons | Turn any file or folder into a desktop shortcut; generate icons from text prompts with AI 2D art |
| 3 | Security | Corrupt-file checks and malware scanning via Windows Defender and hash reputation; AI only explains results |
| 4 | Projects | Predict which project a file belongs to (local embeddings classifier; Claude as fallback for low-confidence files) |

Space goes first because it is immediately useful and low risk. On 2026-11-01, drive C: had 402.7 GB used and 71.8 GB free (about 85% full).

This spec covers **only the Space module and the app shell it lives in**.

## 2. Goals and success criteria

1. Scan C: (or any chosen drive or folder) and show where the space goes, without freezing the window, with a working Cancel.
2. Find waste in four categories. Each finding has a size, a plain-English explanation, and a safety rating.
3. Cleanup moves only items that are selected, unchanged since the scan, and not blocklisted, and it moves them only to the Recycle Bin. Stash never permanently deletes anything.
4. Every cleanup batch is logged and can be restored from the History screen.
5. Automated tests prove scan accuracy, detector behavior, and the safety rules, using throwaway test files only.

## 3. Decisions made during brainstorming

| Topic | Decision |
|---|---|
| Cleanup level | Preview, then Recycle Bin. No automatic or scheduled cleaning |
| Waste categories | All four: duplicates, temp & caches, old installers & stale files, dev & creative leftovers |
| Stack | Electron + TypeScript + React |
| AI | None in this module; the "smart" part is a rules catalog with plain-English explanations |

**Why Electron:**
- Node 26 is already installed. Rust and the C++ Build Tools are not, and Tauri would need about 7–8 GB of new tooling on a nearly full disk.
- Electron has built-in Windows APIs this app needs: `shell.trashItem` for the Recycle Bin, and `shell.writeShortcutLink` for the later Icons module.

**Constraint:** no native (compiled) npm dependencies, since this machine has no C++ build tools. Windows-specific information comes from Node built-ins, Electron APIs, or built-in Windows tools (`reg.exe`, `mountvol`, PowerShell).

## 4. Architecture

### 4.1 Processes

```
┌──────────────────────────┐   typed IPC (preload)   ┌──────────────────────────────┐
│ Renderer (React UI)      │ ──────────────────────▶ │ Main process ("app core")    │
│ no Node, no file access  │ ◀────────────────────── │ cleanup, restore, log,       │
└──────────────────────────┘   progress / results    │ settings, blocklist          │
                                                     └──────────────┬───────────────┘
                                                                    │ worker_threads
                                                     ┌──────────────┴───────────────┐
                                                     │ scanWorker       hashWorker  │
                                                     │ (walks disk)     (hashes)    │
                                                     └──────────────────────────────┘
```

- **Renderer:**
  - Electron hardening is on: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`.
  - A strict Content-Security-Policy is set, and no remote content is loaded.
- **Preload:** exposes a small, typed `window.stash` API. Nothing else crosses the bridge.
- **Main process:** the only code that moves files.
  - **Cleanup requests carry finding IDs from the latest scan, never raw paths.** The main process looks up the paths itself, so the UI cannot ask it to delete arbitrary files.
- **Workers:** Node `worker_threads` started by the main process, so the UI stays responsive.
  - A worker crash surfaces as an error in the main process.
  - Partial results are kept and marked incomplete.

### 4.2 Code layout

```
stash/
  src/
    core/              pure logic, no Electron imports (unit-testable)
      tree.ts            scan tree model and aggregation
      rules/             rules catalog (data) and matchers
      detectors/         duplicates, tempCaches, installersStale, devLeftovers
      keeper.ts          duplicate keep-suggestion and "never every copy" check
      blocklist.ts       paths that can never be cleaned
      recycleBinInfo.ts  $I record parsing
    workers/
      scanWorker.ts
      hashWorker.ts
    main/
      index.ts           window and app lifecycle
      ipc.ts             IPC handlers with input validation
      cleanup.ts         re-validate, recycle, log
      restore.ts         restore a batch from the Recycle Bin
      recycleBin.ts      capacity, NukeOnDelete, current usage
      cleanupLog.ts      append-only JSONL log
      settings.ts
      elevate.ts         "Rescan as administrator"
    preload/index.ts
    renderer/
      screens/           Overview, Explore, Cleanup, History, Settings
      components/        Treemap (canvas), FindingList (virtualized), ...
  tests/
    fixtures/          builder that creates throwaway folder trees
    unit/  integration/  e2e/
  docs/superpowers/specs/
```

### 4.3 Tooling

- Scaffolded from the **electron-vite** React + TypeScript template.
- Packaged with **electron-builder** as an NSIS installer.
- Tests use **Vitest** for unit and integration tests and **Playwright** (Electron mode) for the smoke test.
- Electron is pinned to an exact current stable version at implementation time.
- The installer is unsigned, so SmartScreen warns on first launch ("More info → Run anyway").

### 4.4 Persisted data (`%APPDATA%\Stash`)

- `settings.json`: exclusions, personal folders, thresholds, scan targets.
- `cleanup-log.jsonl`: an append-only log with one JSON object per cleanup batch.
- Scan results are **not** saved. They live in memory, so each launch starts with a fresh scan.

## 5. Scanning

- **Input:** a drive or folder. The default is C:.
- **Walk:** asynchronous directory reads with bounded concurrency, tuned during implementation.
  - Progress batches go to the UI about every 250 ms: folders and files scanned, bytes seen, the current path, and tree updates.
  - Cancel stops the walk and keeps partial results, marked incomplete.
- **Sizes:**
  - Logical size is `stats.size`.
  - **Size on disk** is `stats.blocks × 512`; on Windows, libuv derives `blocks` from the file's allocation size. All totals use size on disk.
- **Cloud-only files:** a tracked file (≥ 1 MB) with logical size > 0 and size on disk of 0 counts as cloud-only, for example an OneDrive placeholder. Files this large cannot be stored inside the MFT, so 0 bytes on disk reliably means the data is in the cloud.
- **Kept in memory:**
  - **Every folder:** name, parent, aggregate size on disk, file count, a "small files" bucket (count and size), its own modified time, and the **newest modified time anywhere beneath it**, which is used for "idle" checks.
  - **Files ≥ 1 MB individually:** name, size on disk, logical size, modified time, `ino`, `nlink`, and the cloud-only flag.
  - **Smaller files:** counted only, inside their folder's small-files bucket.
- **Links:**
  - Junctions and symlinks are recorded as zero-size link entries and are **never followed**.
  - A file with `nlink > 1` counts once per `(dev, ino)`. Later links count 0 and are never treated as duplicates.
- **Unreadable folders** (access denied, busy) are marked unreadable and tallied, and the scan continues.
- **Rescan as administrator** relaunches Stash elevated, through a UAC prompt, to rescan. Cleanup rules do not change when elevated.
- **Performance target:** a full scan of C: on this machine finishes in under 5 minutes, with the UI staying responsive. If this is badly missed, the scanner can be replaced behind the same worker interface, for example with a native scanner or an MFT reader, without changing anything else.

## 6. Finding waste

### 6.1 Rules catalog

Detectors are driven by a catalog. Each rule is data with these fields:

- id
- category
- matcher
- conditions (age, size)
- safety rating
- title
- explanation: what the item is, and what happens if it's removed

| Rating | Meaning | Pre-selected | Stash can clean it |
|---|---|---|---|
| **Safe** | Rebuilds itself automatically (caches, temp files) | Yes | Yes |
| **Review** | Probably fine to remove, but the user's call | No | Yes |
| **Info only** | System areas that Windows manages | n/a | **No.** Stash explains them and opens Disk Cleanup (`cleanmgr.exe`) or Storage settings (`ms-settings:storagesense`) |

### 6.2 Scopes

- **Personal folders** are the current user's profile folder (`C:\Users\<user>`) **excluding `AppData`**, plus any folders the user adds in Settings.
- **Duplicates** and **stale files** are searched only in personal folders, minus `.git` folders and folders matched by dev-leftover rules. Deleting a "duplicate" inside an app or game folder can break that app.
- The temp, cache, installer, and dev-leftover detectors match their own paths and patterns.
- The blocklist (§7.4) applies everywhere.
- User **exclusions** are still scanned for size (they appear in Explore), but no detector flags anything inside them.

### 6.3 Detectors and initial rules

**Duplicates** (Review)
1. **Candidates:** files ≥ 1 MB in personal folders, not cloud-only, grouped by identical size.
2. **Partial hash:** SHA-256 of the first and last 64 KB. Groups that no longer match are dropped.
3. **Full hash:** SHA-256 of the whole file, only for the remaining candidates. This runs in `hashWorker`, with progress and Cancel.
4. **Keep suggestion:**
   - Prefer copies not under Downloads, `%TEMP%` or Desktop.
   - Among those, keep the oldest by modified time. On a tie, keep the shortest path.
   - If every copy is in those folders, keep the oldest copy overall.
5. **Invariant: a group can never have every copy selected.** The UI enforces this, and the main process enforces it again at cleanup time.
6. **Reclaimable space:** for a duplicate group, this is the size of every copy except the keeper.

**Temp & caches** (Safe)

| Rule | Matches |
|---|---|
| `temp-user` | Top-level items in `%TEMP%` whose newest modified time is more than 24 hours old |
| `browser-cache-chromium` | `%LOCALAPPDATA%\{Google\Chrome,Microsoft\Edge}\User Data\*\{Cache,Code Cache,GPUCache}` |
| `browser-cache-firefox` | `%LOCALAPPDATA%\Mozilla\Firefox\Profiles\*\cache2` |
| `crash-dumps` | `%LOCALAPPDATA%\CrashDumps` |
| `pkg-cache-npm` | `%LOCALAPPDATA%\npm-cache` |
| `pkg-cache-pip` | `%LOCALAPPDATA%\pip\Cache` |
| `pkg-cache-yarn` | `%LOCALAPPDATA%\Yarn\Cache` |

**Old installers & stale files** (Review)

| Rule | Matches |
|---|---|
| `downloads-installers` | `.exe`, `.msi`, `.zip` and `.iso` files in `%USERPROFILE%\Downloads` modified more than 30 days ago |
| `stale-large` | Files ≥ 100 MB in personal folders not **modified** in 6+ months. Windows does not reliably record when a file was last opened, so "stale" means not modified |

**Dev & creative leftovers** (Review). A project is "idle" when the newest modified time in the project, ignoring the leftover folder itself, is more than 30 days old.

| Rule | Matches |
|---|---|
| `dev-node-modules` | `node_modules` next to a `package.json`, project idle |
| `dev-build-output` | `build` or `dist` next to `package.json` or `pyproject.toml`; `target` next to `Cargo.toml`; `bin` or `obj` next to a `*.csproj`; project idle |
| `dev-python-venv` | A folder containing `pyvenv.cfg`, project idle |
| `blender-backups` | Files matching `*.blend<digits>`, for example `.blend1` and `.blend2` |
| `unity-library` | `Library` next to both `Assets` and `ProjectSettings`, project idle |
| `unreal-caches` | `Intermediate` and `DerivedDataCache` next to a `*.uproject`, project idle |
| `godot-cache` | `.godot` next to `project.godot`, project idle |
| `image-sequences` | A folder with ≥ 100 tracked (≥ 1 MB) files named as a prefix plus a frame number with a png, jpg, exr or tif extension, totaling ≥ 500 MB, not modified in 30+ days |

**Info only**

| Rule | Matches |
|---|---|
| `sys-windows-temp` | `C:\Windows\Temp` |
| `sys-windows-update` | `C:\Windows\SoftwareDistribution\Download` |
| `sys-installer-cache` | `C:\Windows\Installer`, `C:\ProgramData\Package Cache`. These must never be deleted by hand |
| `sys-component-store` | `C:\Windows\WinSxS` |
| `sys-hiberfil` / `sys-pagefile` | `C:\hiberfil.sys`, `C:\pagefile.sys`, `C:\swapfile.sys` |

All thresholds (1 MB, 100 MB, 24 hours, 30 days, 6 months) can be changed in Settings.

## 7. Cleanup and restore

### 7.1 Flow

1. The user ticks findings and clicks **Clean selected**.
2. A confirmation dialog shows the item count, the total size, and "These go to the Recycle Bin."
3. The renderer sends the **finding IDs** to the main process.
4. The main process runs the pre-flight checks (§7.2), then re-validates (§7.3) and recycles each item one by one, with progress shown.
5. A result summary shows what was recycled (count and size) and what was skipped, grouped by reason.
6. The batch is appended to the cleanup log (§7.5).

### 7.2 Pre-flight checks (per drive)

- **Recycle Bin disabled:** if the drive's Recycle Bin is turned off (`NukeOnDelete = 1` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket\Volume\{GUID}`), **all cleanup on that drive is refused**. Recycling there would permanently delete.
- **Item too big for the bin:** an item larger than the bin's `MaxCapacity` is skipped, with the reason "too big for the Recycle Bin."
- **Overflow warning:** if the batch total plus the bin's current usage would exceed `MaxCapacity`, Stash warns that Windows will purge older recycled items, and the user must confirm.
- **Sources:**
  - Current usage is the sum of the user's own `C:\$Recycle.Bin\<SID>` folder.
  - Registry values are read with `reg.exe query`.
  - The volume GUID comes from `mountvol` or PowerShell `Get-CimInstance Win32_Volume`.

### 7.3 Per-item checks, immediately before recycling

- **Unchanged:** the path still exists with the same size and modified time as in the scan. Otherwise it is skipped as "changed since scan."
- **Not blocklisted** (§7.4). Otherwise it is skipped as "protected."
- **Duplicates:** at least one copy in the group stays unselected and still exists. Otherwise the item is skipped.
- **Recycle:** the item is moved with `shell.trashItem`.
  - If that fails (in use, locked, no permission), the item is skipped with the reason.
  - A tip is added where one is known, for example "Close Chrome and retry."

### 7.4 Blocklist (hard-coded, enforced in the main process)

These can never be cleaned, whatever is selected:

- System locations:
  - `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`
  - `C:\$Recycle.Bin`, `C:\System Volume Information`, `C:\Recovery`, `C:\Boot`
  - root system files: `pagefile.sys`, `hiberfil.sys`, `swapfile.sys`, `DumpStack.log*`
- Other users' profile folders.
- The current user's `NTUSER.DAT*` and `ntuser.*` files.
- Any path that **is, or contains**, a drive root, the user profile folder, or a Windows known folder: Desktop, Documents, Downloads, Pictures, Music, Videos, or the OneDrive root. Their contents can be cleaned, but the folders themselves cannot.
- Stash's own install and data folders.

### 7.5 Cleanup log

`%APPDATA%\Stash\cleanup-log.jsonl` holds one line per batch, in this shape:

```json
{"batchId":"<uuid>","startedAt":"<ISO time>","finishedAt":"<ISO time>",
 "items":[{"findingId":"<id>","ruleId":"<rule>","originalPath":"<path>","sizeOnDisk":0,
           "mtime":"<ISO time>","status":"recycled or skipped","reason":"<text>",
           "recycledAs":"<$R name>"}]}
```

After each successful recycle, Stash finds the matching `$I…` record in `C:\$Recycle.Bin\<SID>` and stores the paired `$R…` name. A record matches when its original path equals the item's path and its deletion time is at or after the batch start.

### 7.6 Restore

- History lists the batches. **Restore** works on a whole batch.
- For each item, Stash moves `$R…` back to its original path and removes the paired `$I…` record. This is what Explorer's own Restore does.
- If the original path is now taken, the item is restored as `<name> (restored)<ext>`. If the original parent folder no longer exists, it is recreated.
- If Windows has already removed an item from the bin, Stash reports "no longer in the Recycle Bin" for that item and carries on.
- **`$I` record format (Windows 10/11, version 2):**
  - 8-byte version
  - 8-byte original size
  - 8-byte deletion FILETIME
  - 4-byte path length in characters
  - the path, in UTF-16LE

### 7.7 Freed-space messaging

The Overview and result screens state that **space is freed only when the Recycle Bin is emptied**, and they show the bin's current size. Stash never empties the bin itself.

## 8. Screens

- **Overview:**
  - a drive usage bar
  - "You could free about **X GB**," broken down by category (Safe and Review)
  - "+ Y GB Windows can clean itself" (Info only)
  - the Recycle Bin size
  - the **Scan** button and scan progress
- **Explore:**
  - A squarified treemap drawn on `<canvas>` (layout from `d3-hierarchy`), with two or three levels visible at a time, a breadcrumb, and click to drill in.
  - A sortable largest-items list: name, size on disk, % of parent, modified.
  - Right-click: **Open in File Explorer** (`shell.showItemInFolder`) and **Exclude from Stash**.
  - Unreadable folders and incomplete scans are marked.
- **Cleanup:**
  - One card per category, with its total.
  - Each card expands into a virtualized list of findings: checkbox, path, size, safety badge, explanation.
  - Select all/none per category, and per-group "keep this one" controls for duplicates.
  - A sticky footer with the selected total and **Clean selected**.
- **History:** batches (date, item count, size, status) with **Restore**, and per-item statuses.
- **Settings:** exclusions, personal folders, thresholds, scan targets.
- **Theme:** follows Windows light or dark mode.

## 9. Error handling

| Situation | Behavior |
|---|---|
| Folder access denied or busy | Skipped, tallied, marked in Explore; "Rescan as administrator" offered |
| Junction or symlink | Not followed; recorded as a zero-size link entry |
| Hard links | Counted once per `(dev, ino)`; never listed as duplicates |
| Cloud-only file | Counted at size on disk (about 0); never hashed |
| Worker crash | Error shown; partial results kept and marked incomplete |
| Item changed since scan | Skipped ("changed since scan") |
| Item in use or locked | Skipped with a reason and a tip |
| Recycle Bin disabled on the drive | All cleanup on that drive refused, with an explanation |
| Item too big for the bin | Skipped with an explanation |
| Batch would overflow the bin | Warning; the user must confirm |
| Blocklisted path | Skipped ("protected"); never recycled |
| Restore target already taken | Restored as `<name> (restored)<ext>` |
| Item already purged from the bin | Reported per item; the restore continues |

## 10. Testing

- **Unit tests (Vitest, `src/core`):**
  - rule matchers and thresholds
  - tree aggregation and newest-modified propagation
  - duplicate grouping and the keep suggestion
  - the "never every copy" invariant
  - the blocklist, including the ancestor-of-known-folder cases
  - `$I` parsing, using handcrafted buffers
- **Integration tests (Vitest, Windows):** a fixture builder creates a throwaway tree under the OS temp folder containing:
  - duplicates of 1 MB or more
  - a hard link (`fs.link`)
  - a junction (`fs.symlink(..., 'junction')`, which needs no admin rights)
  - a `node_modules` folder next to a `package.json` with old modified times (set with `fs.utimes`)
  - `.blend1` files
  - an image sequence
  - old installers in a Downloads-like folder

  The scanner worker and the detectors run against this tree. Results are checked against totals the builder computes independently.
- **Recycle round trip (inside Electron, test files only):** recycle fixture files, check the logged `$R`/`$I` pairing, restore them, and confirm the contents are back. A second case checks the "changed since scan" skip.
- **E2E smoke test (Playwright, Electron):** launch the app, scan the fixture folder, and see the treemap and findings.
- **Early verification spikes, the first implementation tasks:**
  1. Confirm `fs.Stats.blocks` is populated on Windows under Electron's Node. Size on disk and cloud-only detection depend on it. If it is not, redesign that part before building on it.
  2. Check `shell.trashItem` behavior when the bin can't take an item. The pre-flight checks must prevent permanent deletion either way.
  3. Measure scan speed and memory use on the real C:. This is read-only.
- **Manual checks:**
  - Scan the real C: (read-only) and compare the totals with File Explorer's drive properties.
  - If OneDrive Files On-Demand is in use, confirm cloud-only files show about 0 on disk.
- **Tests never touch the user's real files.**

## 11. Out of scope for v1

- The Projects (AI prediction), Icons, and Security modules.
- AI explanations of unknown folders. These arrive with Projects, which brings the AI plumbing.
- Remembering scans between launches, and "what grew" history.
- Scheduled or automatic cleanup.
- Permanent deletion, or emptying the Recycle Bin.
- Network drives.
- Raw-disk (MFT) scanning.
- Code signing.

## 12. Risks

| Risk | Mitigation |
|---|---|
| Node directory walking is too slow for 1M+ files | Measure early (spike 3); the scanner is replaceable behind its worker interface |
| `blocks` unavailable on Windows | Spike 1; redesign size on disk before building on it |
| Recycling permanently deletes in an edge case | `NukeOnDelete` and capacity pre-flight checks, plus spike 2 |
| Large scans use too much memory | Files under 1 MB are aggregated per folder; measured in spike 3 |
