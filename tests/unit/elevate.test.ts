import { expect, test } from 'vitest'
import { buildElevationArgs, quoteArg, scanArgOf } from '../../src/main/elevate'

const decode = (args: string[]): string =>
  Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')

test('elevation runs Start-Process -Verb RunAs with a safely quoted scan root', () => {
  const { file, args } = buildElevationArgs(
    'C:\\Program Files\\Stash\\Stash.exe',
    [],
    "C:\\Users\\o'neil\\My Folder"
  )
  const script = decode(args)
  expect(file).toBe('powershell.exe')
  expect(args).toContain('-NoProfile')
  expect(script).toContain('-Verb RunAs')
  expect(script).toContain("Start-Process -FilePath 'C:\\Program Files\\Stash\\Stash.exe'")
  expect(script).toContain(`"--scan=C:\\Users\\o''neil\\My Folder"`)
})

test('elevation keeps the app arguments, drops an old --scan= and adds the new one last', () => {
  const { args } = buildElevationArgs(
    'C:\\e\\electron.exe',
    ['C:\\dev\\stash', '--scan=D:\\old', '--inspect'],
    'D:\\games'
  )
  expect(decode(args)).toContain(
    `-ArgumentList '"C:\\dev\\stash" "--inspect" "--scan=D:\\games"' -Verb RunAs`
  )
})

test('elevation doubles typographic single quotes too, which PowerShell also reads as quotes', () => {
  const { args } = buildElevationArgs('C:\\Stash.exe', [], 'C:\\Users\\o\u2019neil')
  expect(decode(args)).toContain('"--scan=C:\\Users\\o\u2019\u2019neil"')
})

test('a drive root keeps its backslash: the closing quote is not escaped by it', () => {
  expect(quoteArg('--scan=C:\\')).toBe('"--scan=C:\\\\"')
  expect(quoteArg('a "b"')).toBe('"a \\"b\\""')
  expect(quoteArg('C:\\a\\b')).toBe('"C:\\a\\b"')
  expect(quoteArg('x\\"y')).toBe('"x\\\\\\"y"')
})

test('scanArgOf reads the first --scan= value', () => {
  expect(scanArgOf(['stash.exe', '--scan=D:\\games', '--scan=E:\\'])).toBe('D:\\games')
  expect(scanArgOf(['stash.exe'])).toBeNull()
})
