# Verification spikes — results (2026-11-01)

These are throwaway scripts, run under Electron 45.2.1 (Node 24.22.1) with `npx electron spikes/<file>`. Nothing in `src/` imports them.

## 1. Size on disk (`blocks.mjs`)

```json
{"node":"24.22.1","electron":"45.2.1","bigOnDisk":2097152,"tinyOnDisk":0}
```

**Decision: pass.** `stats.blocks × 512` reports size on disk under Electron's Node. The 100-byte file reports 0 because NTFS stores a file that small inside its MFT record. The size-on-disk design stands.

## 2. Recycle Bin behaviour (`trash.mjs`)

```json
{"a":{"found":true,"iName":"$I1P2AAH.txt","recordVersion":2,"restoredContentOk":true},
 "b":{"letter":"Z","rejected":true,"error":"Failed to perform delete operation","stillExists":true,"recycledRecords":0}}
```

- **(a) Round trip on C:** `shell.trashItem` produced a version-2 `$I` record whose path matched the non-ASCII file name (`naïve 📁.txt`). Renaming `$R…` back and deleting `$I…` restored the file with its content. The approach planned for Tasks 10 and 13 works.
- **(b) A drive with no Recycle Bin (a subst drive):** `shell.trashItem` rejected with "Failed to perform delete operation" and left the file in place. It does not fall back to a permanent delete. Task 12's refusal of unconfirmed drives stays as a second guard.

Found along the way:
- Under Git Bash, a bare `whoami` resolves to Git's coreutils and fails. Windows tools must be called by absolute path under `%SystemRoot%\System32`.
- An unhandled error in an Electron main script left the process running with no visible window. The spikes now exit through `.catch()` plus a watchdog.

## 3. Walk speed (`walk-speed.mjs`)

```json
{"entries":1111080,"folders":190611,"errors":348,"seconds":130.24,"peakRssMB":170}
```

**Decision: 130 s is under 300 s, so continue as planned.**
- About 8,500 entries per second, with 32 directory reads in flight and one `lstat` per entry.
- 348 entries could not be read (system folders).
- 170 MB peak memory for the walk alone. The real scan also keeps the tree.
