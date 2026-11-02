import { execFile } from 'node:child_process'
import { join } from 'node:path'

// By absolute path: a bare `powershell` could resolve to something else on PATH.
const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

// The paths arrive as JSON in STASH_PATHS and are never written into the script itself.
// Get-Item reads sizes from the directory listing, which works for files Node cannot open,
// such as pagefile.sys and hiberfil.sys.
const SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$out = @(foreach ($p in ($env:STASH_PATHS | ConvertFrom-Json)) {',
  '  $item = Get-Item -Force -LiteralPath $p',
  '  if ($item -and -not $item.PSIsContainer) {',
  "    [pscustomobject]@{ path = $p; length = $item.Length; lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString('o') }",
  '  }',
  '})',
  'ConvertTo-Json -InputObject $out -Compress'
].join('\n')
const ENCODED_SCRIPT = Buffer.from(SCRIPT, 'utf16le').toString('base64')

interface Measured {
  path: string
  length: number
  lastWriteTimeUtc: string
}

/**
 * Sizes of files that Node cannot stat, keyed by the exact strings passed in. Paths that do not
 * exist are left out. Meant for the handful of locked files at a drive root.
 */
export function measureLockedFiles(
  paths: string[]
): Promise<Map<string, { size: number; mtimeMs: number }>> {
  if (paths.length === 0) return Promise.resolve(new Map())
  return new Promise((resolve, reject) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', ENCODED_SCRIPT],
      {
        env: { ...process.env, STASH_PATHS: JSON.stringify(paths) },
        windowsHide: true,
        timeout: 30_000
      },
      (error, stdout) => {
        if (error) return reject(error)
        const text = stdout.trim()
        const parsed: Measured | Measured[] = text === '' ? [] : JSON.parse(text)
        const sizes = new Map<string, { size: number; mtimeMs: number }>()
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
          sizes.set(m.path, { size: m.length, mtimeMs: Date.parse(m.lastWriteTimeUtc) })
        }
        resolve(sizes)
      }
    )
  })
}
