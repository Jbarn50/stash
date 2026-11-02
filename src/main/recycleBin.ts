import { execFile } from 'node:child_process'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pathKey } from '../core/paths'
import { parseIRecord } from '../core/recycleBinInfo'
import type { Bytes } from '../shared/types'

/**
 * What the Recycle Bin of one drive will do with a deletion. `maxCapacityBytes` and `usedBytes` are
 * 0 unless the status is `enabled`. `disabled` and `unknown` both mean the cleanup must not touch
 * the drive: Windows would delete for good, or Stash cannot tell that it would not.
 */
export interface RecycleBinInfo {
  drive: string
  status: 'enabled' | 'disabled' | 'unknown'
  maxCapacityBytes: Bytes
  usedBytes: Bytes
}

/** A recycled item's `$I` record, with the name of the `$R` entry beside it that holds the item. */
export interface RecycledRecord {
  iName: string
  rName: string
  originalPath: string
  deletedAtMs: number
}

// By absolute path, never a bare name: under Git Bash a bare `whoami` is GNU coreutils', and a tool
// found on PATH could be anything. None of them goes through a shell.
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const MOUNTVOL = join(SYSTEM32, 'mountvol.exe')
const REG = join(SYSTEM32, 'reg.exe')
const WHOAMI = join(SYSTEM32, 'whoami.exe')

const CURRENT_VERSION = 'Software\\Microsoft\\Windows\\CurrentVersion'
const BITBUCKET_VOLUMES = `HKCU\\${CURRENT_VERSION}\\Explorer\\BitBucket\\Volume`
// Group Policy, per user and per machine, holds two values in this one key: NoRecycleFiles ("Do not
// move deleted files to the Recycle Bin") and RecycleBinSize ("Maximum allowed Recycle Bin size").
const POLICY_KEYS = ['HKCU', 'HKLM'].map(
  (hive) => `${hive}\\${CURRENT_VERSION}\\Policies\\Explorer`
)

const BYTES_PER_MB = 1_048_576
// A `$I` file last written longer than this before the batch started is not a record of the batch.
const RECORD_WRITTEN_WINDOW_MS = 60_000
// The deletion time inside a record may fall this much before the batch start (clock rounding).
const RECORD_DELETED_SLACK_MS = 2_000

const DRIVE = /^[A-Za-z]:$/

/** `C:` for `c:`. Null for anything that is not a drive letter and a colon: `''`, `C:\`, a network path. */
function asDrive(drive: string): string | null {
  return DRIVE.test(drive) ? drive.toUpperCase() : null
}

/** Runs a Windows tool and resolves with what it printed. A failure, a non-zero exit or a timeout rejects. */
function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (error) return reject(error)
      resolve(stdout)
    })
  })
}

/** The `{guid}` of the `\\?\Volume{guid}\` line that `mountvol <drive> /L` prints, as printed; null if none. */
export function parseMountvol(text: string): string | null {
  const guid = /\\\\\?\\Volume(\{[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\})/i.exec(text)
  return guid ? guid[1] : null
}

/** The REG_DWORD values in `reg query` output, by name. Other kinds of value and other lines are ignored. */
export function parseRegDwords(text: string): Record<string, number> {
  const values: [string, number][] = []
  for (const line of text.split(/\r?\n/)) {
    const value = /^\s+(.+?)\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/i.exec(line)
    if (value) values.push([value[1], parseInt(value[2], 16)])
  }
  return Object.fromEntries(values)
}

/** The SID in `whoami /user /fo csv /nh` output, its last field: `"DOMAIN\user","S-1-5-21-…"`. */
export function parseWhoamiSid(text: string): string {
  const sid = (text.trim().split(',').at(-1) ?? '').replace(/^"|"$/g, '')
  if (!/^S-1-\d+(-\d+)+$/.test(sid)) throw new Error('Unexpected whoami output')
  return sid
}

let userSid: string | undefined

/**
 * The SID of the user running Stash, which names their folder inside each drive's `$Recycle.Bin`.
 * Asked of `whoami` once and remembered. A failure is not remembered: the next call asks again.
 */
export async function getUserSid(): Promise<string> {
  userSid ??= parseWhoamiSid(await run(WHOAMI, ['/user', '/fo', 'csv', '/nh']))
  return userSid
}

/** What Group Policy says about the Recycle Bin, taking the user and the machine hive together. */
export interface RecyclePolicy {
  /** NoRecycleFiles is set: Explorer deletes for good. */
  noRecycleFiles: boolean
  /** RecycleBinSize is set, to any value: a policy caps the bin, perhaps below MaxCapacity. */
  sizeCapped: boolean
}

/**
 * The DWORD called `name` in `values`, or undefined if there is none or `values` is null. Registry
 * value names are case-insensitive and reg.exe prints them as they are stored, so `norecyclefiles`
 * is NoRecycleFiles: missing it would read a policy as not set.
 */
function dwordNamed(values: Record<string, number> | null, name: string): number | undefined {
  if (values === null) return undefined
  const wanted = name.toLowerCase()
  const stored = Object.keys(values).find((key) => key.toLowerCase() === wanted)
  return stored === undefined ? undefined : values[stored]
}

/**
 * Whether files deleted on a drive go to its Recycle Bin, and how much the bin may hold.
 * `volume` is the drive's BitBucket values from the registry, or null when they could not be read.
 * `policy` is Group Policy. NoRecycleFiles makes Explorer delete for good and overrides the volume.
 * A volume that is itself off is disabled whatever else is set, which is the truer thing to say.
 * Otherwise a size policy may cap the bin below MaxCapacity, so that capacity cannot be trusted:
 * unknown. Only a bin that is plainly on counts as enabled: anything unclear is unknown, because
 * Windows silently purges or permanently deletes what does not fit. `maxCapacityBytes` is 0 unless
 * enabled.
 */
export function binStatus(
  volume: Record<string, number> | null,
  policy: RecyclePolicy
): Pick<RecycleBinInfo, 'status' | 'maxCapacityBytes'> {
  const nukeOnDelete = dwordNamed(volume, 'NukeOnDelete')
  if (policy.noRecycleFiles) return { status: 'disabled', maxCapacityBytes: 0 }
  if (nukeOnDelete === 1) return { status: 'disabled', maxCapacityBytes: 0 }
  if (policy.sizeCapped) return { status: 'unknown', maxCapacityBytes: 0 }
  const maxCapacity = dwordNamed(volume, 'MaxCapacity')
  if (nukeOnDelete === 0 && maxCapacity !== undefined) {
    // MaxCapacity is in megabytes.
    return { status: 'enabled', maxCapacityBytes: maxCapacity * BYTES_PER_MB }
  }
  return { status: 'unknown', maxCapacityBytes: 0 }
}

/** The BitBucket values of the drive's volume (found through its GUID), or null if any step fails. */
async function readVolumeValues(drive: string): Promise<Record<string, number> | null> {
  try {
    const guid = parseMountvol(await run(MOUNTVOL, [drive, '/L']))
    if (guid === null) return null
    return parseRegDwords(await run(REG, ['query', `${BITBUCKET_VOLUMES}\\${guid}`]))
  } catch {
    return null
  }
}

// reg.exe exits with code 1 when a key is not there, which is the normal case on a machine without
// that policy. A tool that was killed (a timeout), could not be started, or exited with any other
// code has not answered, and says nothing about the policy.
function keyIsAbsent(e: unknown): boolean {
  const { code, killed } = e as { code?: unknown; killed?: boolean }
  return code === 1 && !killed
}

/**
 * What Group Policy says about the Recycle Bin, from one query of each hive's Policies\Explorer key.
 * A hive without the key says nothing. A query that fails any other way rejects: the policy is then
 * unread, and nobody can tell that it is not set. NoRecycleFiles counts with any non-zero value;
 * RecycleBinSize counts with any value at all.
 */
async function readRecyclePolicy(): Promise<RecyclePolicy> {
  const hives = await Promise.all(
    POLICY_KEYS.map(async (key): Promise<Record<string, number>> => {
      try {
        return parseRegDwords(await run(REG, ['query', key]))
      } catch (e) {
        if (keyIsAbsent(e)) return {}
        throw e
      }
    })
  )
  return {
    noRecycleFiles: hives.some((values) => (dwordNamed(values, 'NoRecycleFiles') ?? 0) !== 0),
    sizeCapped: hives.some((values) => dwordNamed(values, 'RecycleBinSize') !== undefined)
  }
}

// The logical size of `path`: a file's own size, or the sum over a folder's contents. Uses lstat
// throughout and never follows a junction or symlink, which counts as itself. Whatever disappears
// while the walk runs counts as nothing; any other error is thrown.
async function treeBytes(path: string): Promise<Bytes> {
  let stats
  try {
    stats = await lstat(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw e
  }
  if (!stats.isDirectory()) return stats.size
  let names: string[]
  try {
    names = await readdir(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw e
  }
  let total = 0
  for (const name of names) total += await treeBytes(join(path, name))
  return total
}

// A `$R` entry's size. If it cannot be measured in full, the size Windows noted in the `$I` record
// beside it stands in for it; if that cannot be read either, this throws, because guessing low
// would let an overflowing batch pass.
async function entryBytes(rPath: string, iPath: string): Promise<Bytes> {
  try {
    return await treeBytes(rPath)
  } catch {
    return Number(parseIRecord(await readFile(iPath)).originalSize)
  }
}

/**
 * How much the Recycle Bin folder `dir` holds: the logical size of its `$R*` entries, which are the
 * recycled files and folders. A folder that does not exist holds nothing; one that cannot be read,
 * or an entry that cannot be measured, rejects.
 */
export async function recycledBytes(dir: string): Promise<Bytes> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw e
  }
  let total = 0
  for (const name of names) {
    if (name.startsWith('$R')) {
      total += await entryBytes(join(dir, name), join(dir, `$I${name.slice(2)}`))
    }
  }
  return total
}

/**
 * The user's Recycle Bin folder on a drive given as `C:`, in any case: `C:\$Recycle.Bin\<SID>`.
 * Rejects `Invalid drive` for anything else, and when the SID cannot be found.
 */
export async function recycleBinDir(drive: string): Promise<string> {
  const letter = asDrive(drive)
  if (letter === null) throw new Error('Invalid drive')
  return `${letter}\\$Recycle.Bin\\${await getUserSid()}`
}

/**
 * Whether deleting on a drive recycles, how much the bin may hold, and how much it holds now.
 * Never rejects: whatever cannot be established, a Group Policy that could not be read included, is
 * `unknown` with zeros, which the cleanup treats like a bin that is off. A drive that is not exactly
 * a letter and a colon starts no process. `usedBytes` is measured only for an enabled bin.
 */
export async function getRecycleBinInfo(drive: string): Promise<RecycleBinInfo> {
  const letter = asDrive(drive)
  if (letter === null) return { drive, status: 'unknown', maxCapacityBytes: 0, usedBytes: 0 }
  try {
    const [volume, policy] = await Promise.all([readVolumeValues(letter), readRecyclePolicy()])
    const { status, maxCapacityBytes } = binStatus(volume, policy)
    const usedBytes = status === 'enabled' ? await recycledBytes(await recycleBinDir(letter)) : 0
    return { drive: letter, status, maxCapacityBytes, usedBytes }
  } catch {
    return { drive: letter, status: 'unknown', maxCapacityBytes: 0, usedBytes: 0 }
  }
}

/**
 * The newest record for each of `originalPaths` in the Recycle Bin folder `dir` that Windows wrote
 * for a deletion since `sinceMs`, keyed by `pathKey` of the requested path, so that `C:\A` and `c:/a`
 * are one entry. A path with no record is left out. The folder is listed once and each `$I` file is
 * read at most once, however many paths are asked for. Only `$I` files last written within a minute
 * before `sinceMs` are read, and only records deleted no more than two seconds before it match.
 * Unreadable and malformed `$I` files are skipped; a folder that cannot be read gives an empty map.
 */
export async function findRecordsIn(
  dir: string,
  originalPaths: string[],
  sinceMs: number
): Promise<Map<string, RecycledRecord>> {
  const found = new Map<string, RecycledRecord>()
  const wanted = new Set(originalPaths.map(pathKey))
  if (wanted.size === 0) return found
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return found
  }
  for (const iName of names) {
    if (!iName.startsWith('$I')) continue
    try {
      const file = join(dir, iName)
      if ((await stat(file)).mtimeMs < sinceMs - RECORD_WRITTEN_WINDOW_MS) continue
      const record = parseIRecord(await readFile(file))
      if (record.deletedAtMs < sinceMs - RECORD_DELETED_SLACK_MS) continue
      const key = pathKey(record.originalPath)
      if (!wanted.has(key)) continue
      const newest = found.get(key)
      if (newest === undefined || record.deletedAtMs > newest.deletedAtMs) {
        found.set(key, {
          iName,
          rName: `$R${iName.slice(2)}`,
          originalPath: record.originalPath,
          deletedAtMs: record.deletedAtMs
        })
      }
    } catch {
      // Unreadable, malformed, or removed since the listing: not a record that can be used.
    }
  }
  return found
}

/** `findRecordsIn` for one path: its newest record in `dir`, or null. */
export async function findRecordIn(
  dir: string,
  originalPath: string,
  sinceMs: number
): Promise<RecycledRecord | null> {
  return (await findRecordsIn(dir, [originalPath], sinceMs)).get(pathKey(originalPath)) ?? null
}

/**
 * Finds the records Windows wrote when `originalPaths` were recycled from `drive` since `sinceMs`,
 * to pair each item with its `$R` entry: `recycleBinDir` and `findRecordsIn`, so one pass over the
 * bin serves a whole batch. Look a path up with `pathKey`. Never rejects: whatever goes wrong,
 * including an invalid drive, gives an empty map.
 */
export async function findRecycledRecords(
  drive: string,
  originalPaths: string[],
  sinceMs: number
): Promise<Map<string, RecycledRecord>> {
  try {
    return await findRecordsIn(await recycleBinDir(drive), originalPaths, sinceMs)
  } catch {
    return new Map()
  }
}

/** `findRecycledRecords` for one path. Never rejects: whatever goes wrong is null. */
export async function findRecycledRecord(
  drive: string,
  originalPath: string,
  sinceMs: number
): Promise<RecycledRecord | null> {
  try {
    return (
      (await findRecycledRecords(drive, [originalPath], sinceMs)).get(pathKey(originalPath)) ?? null
    )
  } catch {
    return null
  }
}
