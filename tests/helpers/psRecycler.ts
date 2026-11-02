import { execFile } from 'node:child_process'
import { join } from 'node:path'
import type { Recycler } from '../../src/main/cleanup'

// Windows PowerShell 5.1 by absolute path, never a bare name, and never through a shell.
const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

// What the real Stash does with Electron's `shell.trashItem`, done with Windows' own API so that a
// test can run without Electron: the shell's delete with 'SendToRecycleBin', which writes the `$R`
// and `$I` entries the same way. The path is in the environment of the process, not in the script
// or on the command line, so no character in it can change what the script does. The dialogs are
// switched off except for errors.
const sendToRecycleBin = (method: 'DeleteDirectory' | 'DeleteFile'): string =>
  `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}($env:STASH_RECYCLE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')`

const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type -AssemblyName Microsoft.VisualBasic',
  `if (Test-Path -LiteralPath $env:STASH_RECYCLE_PATH -PathType Container) { ${sendToRecycleBin('DeleteDirectory')} } else { ${sendToRecycleBin('DeleteFile')} }`
].join('; ')

/**
 * Sends a file or folder to the real Recycle Bin through Windows PowerShell. For tests only: the
 * round-trip test uses it on files it made itself. A non-zero exit, a timeout, or anything written
 * to stderr rejects with the error text.
 */
export const psRecycler: Recycler = {
  trash(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(
        POWERSHELL,
        ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
        {
          windowsHide: true,
          timeout: 30_000,
          env: { ...process.env, STASH_RECYCLE_PATH: path }
        },
        (error, _stdout, stderr) => {
          const text = stderr.trim()
          if (error || text !== '') return reject(new Error(text || (error?.message ?? 'failed')))
          resolve()
        }
      )
    })
  }
}
