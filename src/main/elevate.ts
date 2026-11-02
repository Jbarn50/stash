import { execFile } from 'node:child_process'
import { join, resolve } from 'node:path'
import { app } from 'electron'

// Rescan as administrator: Stash starts itself again through a UAC prompt, with `--scan=<root>` so
// the new, elevated copy scans as soon as its window loads, and this copy quits.

const SCAN_ARG = '--scan='

// PowerShell takes the typographic single quotes as quotes too, so each is doubled like `'`.
const PS_QUOTES = /['\u2018\u2019\u201a\u201b]/g

/** `s` as a PowerShell single-quoted string, in which nothing is expanded. */
function psQuote(s: string): string {
  return `'${s.replace(PS_QUOTES, (q) => q + q)}'`
}

/**
 * One argument for a Windows command line, read back by the receiving program exactly as given:
 * wrapped in double quotes, with a `"` escaped and the backslashes before it, or before the closing
 * quote, doubled. Without that, `--scan=C:\` would end in `\"` and swallow the closing quote.
 */
export function quoteArg(arg: string): string {
  let quoted = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    if (ch === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"'
    } else {
      quoted += '\\'.repeat(backslashes) + ch
    }
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** The value of the first `--scan=` argument, or null when there is none. */
export function scanArgOf(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith(SCAN_ARG))
  return arg === undefined ? null : arg.slice(SCAN_ARG.length)
}

/**
 * The PowerShell command that starts `execPath` elevated with `argv` (the app's own arguments, any
 * earlier `--scan=` left out) and `--scan=<root>`:
 * `Start-Process -FilePath '<exe>' -ArgumentList '<args>' -Verb RunAs`, sent as `-EncodedCommand`
 * (UTF-16LE, base64) so no shell ever reads the path. `-ErrorAction Stop` makes a declined UAC prompt
 * end PowerShell with a non-zero exit code.
 */
export function buildElevationArgs(
  execPath: string,
  argv: string[],
  root: string
): { file: 'powershell.exe'; args: string[] } {
  const args = [...argv.filter((a) => !a.startsWith(SCAN_ARG)), `${SCAN_ARG}${root}`]
  const script =
    `Start-Process -FilePath ${psQuote(execPath)} ` +
    `-ArgumentList ${psQuote(args.map(quoteArg).join(' '))} -Verb RunAs -ErrorAction Stop`
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')
    ]
  }
}

/** PowerShell by absolute path, never a name looked up on PATH. */
function powershellPath(): string {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/**
 * The arguments this copy of Stash was started with, for the elevated copy. In development they
 * carry the app's folder, often as `.`, which an elevated process (started in System32) would not
 * find, so every argument that is not a switch is made absolute there.
 */
function ownArgs(): string[] {
  const args = process.argv.slice(1)
  return app.isPackaged ? args : args.map((a) => (a.startsWith('-') ? a : resolve(a)))
}

/**
 * Starts Stash again as administrator to scan `root`. Resolves false, and this copy keeps running,
 * when the UAC prompt is declined or PowerShell fails; resolves true and quits this copy once the
 * elevated one has started.
 */
export function relaunchElevated(root: string): Promise<boolean> {
  const { args } = buildElevationArgs(process.execPath, ownArgs(), root)
  return new Promise((done) => {
    execFile(powershellPath(), args, { windowsHide: true }, (error) => {
      if (error) {
        console.error('Rescan as administrator did not start:', error.message)
        done(false)
        return
      }
      app.quit()
      done(true)
    })
  })
}
