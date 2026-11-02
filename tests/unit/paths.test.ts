import { expect, test } from 'vitest'
import { driveOf, isPlainDrivePath, isSameOrInside, normalizePath } from '../../src/core/paths'

test('isSameOrInside ignores case, slash style and trailing separators', () => {
  expect(isSameOrInside('c:/users/JORDA/desktop/', 'C:\\Users\\jorda\\Desktop')).toBe(true)
  expect(isSameOrInside('C:\\Users\\jorda\\Desktop\\a.txt', 'C:\\Users\\jorda\\Desktop\\')).toBe(
    true
  )
})

test('isSameOrInside rejects sibling prefixes', () => {
  expect(isSameOrInside('C:\\Windows2\\x.dll', 'C:\\Windows')).toBe(false)
  expect(isSameOrInside('C:\\Program Files Backup\\a', 'C:\\Program Files')).toBe(false)
})

test('isSameOrInside treats a drive root as the parent of everything on that drive only', () => {
  expect(isSameOrInside('C:\\Users', 'C:\\')).toBe(true)
  expect(isSameOrInside('c:/', 'C:\\')).toBe(true)
  expect(isSameOrInside('D:\\Users', 'C:\\')).toBe(false)
})

test('normalizePath', () => {
  expect(normalizePath('\\\\?\\c:\\Temp\\..\\x\\')).toBe('C:\\x')
  expect(normalizePath('c:/')).toBe('C:\\')
})

test('driveOf gives the upper-case drive letter whatever the path style', () => {
  expect(driveOf('c:/Users/jorda')).toBe('C:')
  expect(driveOf('\\\\?\\d:\\x\\y')).toBe('D:')
})

test.each([
  'C:\\',
  'D:\\Games\\a.bin',
  'c:/users/jorda/desktop/',
  '\\\\?\\D:\\Games\\a.bin',
  // Spaces, brackets and a leading dot are ordinary parts of a name.
  'C:\\Program Files (x86)\\Steam',
  'C:\\Users\\jorda\\.config\\app',
  // A tilde is only an 8.3 short name as 1-6 characters, then ~ and digits, then at most a
  // 3-character extension.
  'C:\\Users\\jorda\\Projects\\backup~old\\x',
  'C:\\Users\\jorda\\Projects~1\\x',
  'C:\\Users\\jorda\\notes~1.backup',
  'C:\\Users\\jorda\\AppData\\Local\\Temp\\~WRL0001.tmp'
])('isPlainDrivePath accepts %j', (p) => expect(isPlainDrivePath(p)).toBe(true))

test.each([
  // Not an absolute path on a drive.
  '',
  'x.txt',
  'relative\\x',
  '\\Windows\\x',
  '\\\\server\\share\\x',
  'C:',
  'C:x',
  // Windows drops a trailing dot or space from every name, so each is another spelling of the
  // folder without it. The last name, a middle name and a name of only dots all count.
  'C:\\Users\\jorda\\Downloads.',
  'C:\\Users\\jorda\\Downloads ',
  'C:\\Users\\jorda\\Downloads\\...',
  'C:\\Windows.\\System32\\x.dll',
  'C:\\Windows \\System32',
  // A colon after the drive letter names an NTFS stream of the folder or file before it.
  'C:\\Users\\jorda\\Documents\\notes.txt:secret',
  'C:\\Windows::$INDEX_ALLOCATION\\System32\\x.dll',
  // 8.3 short names, in the first name, in the last name, and with an extension.
  'C:\\PROGRA~1\\App\\x.exe',
  'C:\\PROGRA~3',
  'C:\\Users\\jorda\\LONGFI~1.TXT'
])('isPlainDrivePath rejects %j', (p) => expect(isPlainDrivePath(p)).toBe(false))
