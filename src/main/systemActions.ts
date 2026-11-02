import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { shell } from 'electron'

// Windows tools are started by absolute path, never by a name looked up on PATH, and never through
// a shell.
const systemRoot = (): string => process.env.SystemRoot ?? 'C:\\Windows'

function startDetached(file: string, args: string[]): void {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', (e) => console.error(`Couldn't start ${file}:`, e.message))
  child.unref()
}

/** Opens File Explorer with the item selected. */
export function showItem(path: string): void {
  shell.showItemInFolder(path)
}

/** Starts Windows Disk Cleanup, which runs on its own. */
export function openDiskCleanup(): void {
  startDetached(join(systemRoot(), 'System32', 'cleanmgr.exe'), [])
}

/** Opens Storage settings (Storage Sense). */
export function openStorageSettings(): Promise<void> {
  return shell.openExternal('ms-settings:storagesense')
}

/** Opens the Recycle Bin in File Explorer. */
export function openRecycleBin(): void {
  startDetached(join(systemRoot(), 'explorer.exe'), ['shell:RecycleBinFolder'])
}
