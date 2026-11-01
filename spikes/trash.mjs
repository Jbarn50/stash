// Spike 2 (throwaway): how does shell.trashItem behave, and can we find and undo what it recycled?
// (a) round trip on C: with a non-ASCII name; (b) a subst drive, which has no Recycle Bin.
// Only files this script creates are touched; anything it recycles is put back.
import { app, shell } from 'electron'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function report(name, result) {
  const dir = join(tmpdir(), 'stash-spike-results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(result, null, 1))
  console.log(JSON.stringify(result))
}

// Windows tools by absolute path: under Git Bash, a bare `whoami` resolves to Git's coreutils and fails.
const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

function userSid() {
  const line = execFileSync(join(SYSTEM32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).trim()
  return line.split('","')[1].replace(/"$/, '')
}

// $I layout (v2): int64 version | int64 size | int64 FILETIME | int32 path length (UTF-16 units incl. NUL) | UTF-16LE path
function parseI(buf) {
  const version = Number(buf.readBigInt64LE(0))
  const deletedAtMs = Number(buf.readBigUInt64LE(16) / 10_000n - 11_644_473_600_000n)
  const chars = buf.readInt32LE(24)
  const originalPath = buf.toString('utf16le', 28, 28 + chars * 2).replace(/\0+$/, '')
  return { version, deletedAtMs, originalPath }
}

// Finds $I records deleted since sinceMs whose original path satisfies match().
function findRecords(binDir, sinceMs, match) {
  const hits = []
  for (const name of readdirSync(binDir)) {
    if (!name.startsWith('$I')) continue
    const full = join(binDir, name)
    if (statSync(full).mtimeMs < sinceMs - 60_000) continue
    const rec = parseI(readFileSync(full))
    if (rec.deletedAtMs >= sinceMs - 2_000 && match(rec.originalPath.toLowerCase())) hits.push({ iName: name, ...rec })
  }
  return hits
}

function putBack(binDir, hit, target) {
  renameSync(join(binDir, '$R' + hit.iName.slice(2)), target)
  unlinkSync(join(binDir, hit.iName))
}

const result = {}
// A thrown error or a stuck call must never leave Electron running unseen.
setTimeout(() => {
  report('trash', { ...result, timedOut: true })
  app.exit(2)
}, 90_000)

app.whenReady().then(async () => {
  const binDir = `C:\\$Recycle.Bin\\${userSid()}`

  // (a) Round trip on C:
  {
    const start = Date.now()
    const dir = mkdtempSync(join(tmpdir(), 'stash-spike-'))
    const file = join(dir, 'naïve 📁.txt')
    writeFileSync(file, 'spike')
    await shell.trashItem(file)
    const hits = findRecords(binDir, start, (p) => p === file.toLowerCase())
    const found = hits.length === 1
    let restoredContentOk = false
    if (found) {
      putBack(binDir, hits[0], file)
      restoredContentOk = readFileSync(file, 'utf8') === 'spike'
    }
    rmSync(dir, { recursive: true, force: true })
    result.a = { found, iName: hits[0]?.iName ?? null, recordVersion: hits[0]?.version ?? null, restoredContentOk }
  }

  // (b) A subst drive (no Recycle Bin)
  {
    const start = Date.now()
    const letter = 'ZYXWVUTSRQPONMLKJIHGFED'.split('').find((l) => !existsSync(`${l}:\\`))
    const real = mkdtempSync(join(tmpdir(), 'stash-spike-subst-'))
    execFileSync(join(SYSTEM32, 'subst.exe'), [`${letter}:`, real])
    const onSubst = `${letter}:\\spike.txt`
    writeFileSync(onSubst, 'spike')
    let rejected = false
    let error = null
    try {
      await shell.trashItem(onSubst)
    } catch (e) {
      rejected = true
      error = String(e?.message ?? e)
    }
    const stillExists = existsSync(join(real, 'spike.txt'))
    // If Windows did recycle it after all, put it back so the user's bin is untouched.
    const hits = findRecords(binDir, start, (p) => p.includes('stash-spike-subst-') || p.startsWith(`${letter.toLowerCase()}:\\`))
    for (const hit of hits) putBack(binDir, hit, join(real, `recovered-${hit.iName}.txt`))
    execFileSync(join(SYSTEM32, 'subst.exe'), [`${letter}:`, '/D'])
    rmSync(real, { recursive: true, force: true })
    result.b = { letter, rejected, error, stillExists, recycledRecords: hits.length }
  }

  report('trash', result)
  app.exit(0)
}).catch((e) => {
  report('trash', { ...result, error: String(e?.stack ?? e) })
  app.exit(1)
})
