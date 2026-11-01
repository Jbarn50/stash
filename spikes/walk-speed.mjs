// Spike 3 (throwaway): how long does a read-only Node walk of C:\ take, and how much memory does it use?
// readdir + lstat per entry, 32 directory reads in flight, never descending into symlinks or junctions.
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function report(name, result) {
  const dir = join(tmpdir(), 'stash-spike-results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(result, null, 1))
  console.log(JSON.stringify(result))
}

app.whenReady().then(async () => {
  const start = Date.now()
  let entries = 0
  let folders = 0
  let errors = 0
  let peak = process.memoryUsage().rss
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 1000)

  const queue = ['C:\\']
  let active = 0

  async function visit(dir) {
    folders++
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      errors++
      return
    }
    for (const d of dirents) {
      entries++
      const full = dir.endsWith('\\') ? dir + d.name : `${dir}\\${d.name}`
      try {
        await lstat(full)
      } catch {
        errors++
      }
      if (d.isDirectory() && !d.isSymbolicLink()) queue.push(full)
    }
  }

  await new Promise((resolve) => {
    const pump = () => {
      while (active < 32 && queue.length > 0) {
        active++
        visit(queue.pop()).finally(() => {
          active--
          if (queue.length === 0 && active === 0) resolve()
          else pump()
        })
      }
    }
    pump()
  })

  clearInterval(sampler)
  peak = Math.max(peak, process.memoryUsage().rss)
  report('walk-speed', { entries, folders, errors, seconds: (Date.now() - start) / 1000, peakRssMB: Math.round(peak / 1_048_576) })
  app.exit(0)
}).catch((e) => {
  report('walk-speed', { error: String(e?.stack ?? e) })
  app.exit(1)
})
