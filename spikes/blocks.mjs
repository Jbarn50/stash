// Spike 1 (throwaway): does Electron's Node report size on disk through stats.blocks?
import { app } from 'electron'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function report(name, result) {
  const dir = join(tmpdir(), 'stash-spike-results')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(result, null, 1))
  console.log(JSON.stringify(result))
}

app.whenReady().then(() => {
  const dir = mkdtempSync(join(tmpdir(), 'stash-spike-'))
  const big = join(dir, 'big.bin')
  const tiny = join(dir, 'tiny.txt')
  writeFileSync(big, Buffer.alloc(2_097_152, 1))
  writeFileSync(tiny, Buffer.alloc(100, 120))
  const result = {
    node: process.versions.node,
    electron: process.versions.electron,
    bigOnDisk: statSync(big).blocks * 512,
    tinyOnDisk: statSync(tiny).blocks * 512
  }
  rmSync(dir, { recursive: true, force: true })
  report('blocks', result)
  app.quit()
})
