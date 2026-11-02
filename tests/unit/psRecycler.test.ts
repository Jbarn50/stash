import { isAbsolute, join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { psRecycler } from '../helpers/psRecycler'

// `execFile` is faked: no PowerShell starts here and nothing reaches the Recycle Bin. The tests pin
// how the helper starts Windows PowerShell and what it makes of the answer. Moving a file to the
// real bin is the round-trip test's job.
type Callback = (error: Error | null, stdout: string, stderr: string) => void
const execFile = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile }))

const POWERSHELL = join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
)

/** What the next `execFile` call reports when it finishes. */
function finishes(error: Error | null, stderr = ''): void {
  execFile.mockImplementationOnce(
    (_file: string, _args: string[], _options: object, callback: Callback) =>
      callback(error, '', stderr)
  )
}

/** The arguments of the one `execFile` call the helper made. */
function started(): { file: string; args: string[]; options: Record<string, unknown> } {
  expect(execFile).toHaveBeenCalledTimes(1)
  const [file, args, options] = execFile.mock.calls[0] as [
    string,
    string[],
    Record<string, unknown>
  ]
  return { file, args, options }
}

beforeEach(() => {
  execFile.mockReset()
})

describe('how Windows PowerShell is started', () => {
  test('by its absolute path in System32, never a bare name, and never through a shell', async () => {
    finishes(null)

    await psRecycler.trash('C:\\work\\a.bin')

    const { file, options } = started()
    expect(file).toBe(POWERSHELL)
    expect(isAbsolute(file)).toBe(true)
    expect(file.toLowerCase()).toContain('\\system32\\windowspowershell\\v1.0\\powershell.exe')
    expect(options).not.toHaveProperty('shell')
  })

  test('with no profile, no prompts, the script as -Command, a hidden window and a 30 s limit', async () => {
    finishes(null)

    await psRecycler.trash('C:\\work\\a.bin')

    const { args, options } = started()
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(args).toHaveLength(4)
    expect(options.windowsHide).toBe(true)
    expect(options.timeout).toBe(30_000)
  })

  test('the path travels in STASH_RECYCLE_PATH and nowhere else, whatever characters it has', async () => {
    finishes(null)
    const path = `C:\\work\\it's "odd" $(whoami) \`n; na\u00efve \u{1F4C1}.bin`

    await psRecycler.trash(path)

    const { args, options } = started()
    expect(options.env).toEqual({ ...process.env, STASH_RECYCLE_PATH: path })
    for (const arg of args) {
      expect(arg).not.toContain('whoami')
      expect(arg).not.toContain('naïve')
    }
  })
})

describe('what the script does', () => {
  async function scriptOf(): Promise<string> {
    finishes(null)
    await psRecycler.trash('C:\\work\\a.bin')
    return started().args[3]
  }

  test('sends a folder or a file to the Recycle Bin, with dialogs only for errors', async () => {
    const script = await scriptOf()

    expect(script).toContain('Add-Type -AssemblyName Microsoft.VisualBasic')
    expect(script).toContain(
      'if (Test-Path -LiteralPath $env:STASH_RECYCLE_PATH -PathType Container) {' +
        " [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:STASH_RECYCLE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin') }" +
        " else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:STASH_RECYCLE_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin') }"
    )
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
  })

  test('has no way to delete for good', async () => {
    const script = await scriptOf()

    expect(script).not.toMatch(/DeletePermanently|Remove-Item|\bdel\b|\brd\b|\brm\b/i)
    expect(script.match(/SendToRecycleBin/g)).toHaveLength(2) // both Delete calls
    expect(script.match(/Delete(File|Directory)\(/g)).toHaveLength(2)
  })
})

describe('what it makes of the answer', () => {
  test('resolves when PowerShell ends cleanly and says nothing on stderr', async () => {
    finishes(null)

    await expect(psRecycler.trash('C:\\work\\a.bin')).resolves.toBeUndefined()
  })

  test('rejects with what PowerShell wrote to stderr', async () => {
    finishes(
      Object.assign(new Error('Command failed: powershell.exe'), { code: 1 }),
      '  Could not find file\n'
    )

    await expect(psRecycler.trash('C:\\work\\a.bin')).rejects.toThrow(/^Could not find file$/)
  })

  test('rejects on stderr output even when the exit code is zero', async () => {
    finishes(null, 'warning: the shell was slow\n')

    await expect(psRecycler.trash('C:\\work\\a.bin')).rejects.toThrow('warning: the shell was slow')
  })

  test('rejects with the error itself when it failed without a word on stderr', async () => {
    finishes(Object.assign(new Error('Command failed: timed out'), { killed: true }))

    await expect(psRecycler.trash('C:\\work\\a.bin')).rejects.toThrow('Command failed: timed out')
  })

  test('a failure to start rejects too', async () => {
    execFile.mockImplementationOnce(
      (_file: string, _args: string[], _options: object, callback: Callback) =>
        callback(
          Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }),
          '',
          ''
        )
    )

    await expect(psRecycler.trash('C:\\work\\a.bin')).rejects.toThrow('spawn powershell.exe ENOENT')
  })
})
