import { expect, test } from 'vitest'
import { isBlocked } from '../../src/core/blocklist'
import { SAMPLE_ENV } from '../helpers/env'

test.each([
  'C:\\Windows\\System32\\x.dll',
  'c:\\program files\\app\\a.exe',
  'D:\\Program Files\\Steam\\x',
  'C:\\ProgramData\\Package Cache\\x',
  'D:\\$Recycle.Bin\\S-1\\$R1',
  'E:\\System Volume Information\\x',
  'C:\\pagefile.sys',
  'C:\\DumpStack.log.tmp',
  'C:\\Users\\other\\a.txt',
  'C:\\Users\\Public\\x',
  'C:\\Users\\jorda\\NTUSER.DAT',
  'C:\\Users\\jorda\\ntuser.dat.LOG1',
  'C:\\',
  'D:\\',
  'C:\\Users',
  'C:\\Users\\jorda',
  'C:\\Users\\jorda\\OneDrive',
  'C:\\Users\\jorda\\OneDrive\\Desktop\\',
  'c:/users/jorda/downloads',
  'C:\\Users\\jorda\\AppData\\Roaming\\Stash\\settings.json',
  // Every other protected entry, so dropping one from the list is caught.
  'C:\\Program Files (x86)\\Steam\\steam.exe',
  'C:\\Recovery\\WindowsRE\\winre.wim',
  'D:\\Boot\\BCD',
  'C:\\hiberfil.sys',
  'C:\\swapfile.sys',
  'C:\\DumpStack.log',
  'C:\\Users\\jorda\\OneDrive\\Documents',
  'C:\\Users\\jorda\\Pictures',
  'C:\\Users\\jorda\\Music',
  'C:\\Users\\jorda\\Videos',
  'C:\\Users\\jorda\\AppData\\Local\\Programs\\Stash\\Stash.exe',
  // Other spellings of a protected path.
  '\\\\?\\C:\\Windows\\System32\\x.dll',
  'C:\\Users\\jorda\\Projects\\..\\..\\..\\Windows\\System32',
  // Windows reads each of these as a protected folder, so they are refused too: it drops a trailing
  // dot or space, `...` is the folder itself, a colon names an NTFS stream, and PROGRA~1 is the
  // 8.3 short name of Program Files.
  'C:\\Users\\jorda\\Downloads.',
  'C:\\Users\\jorda\\Downloads ',
  'C:\\Users\\jorda\\Downloads\\...',
  'C:\\Windows.\\System32\\x.dll',
  'C:\\Users.\\jorda',
  'C:\\ProgramData.\\Package Cache\\x',
  'C:\\Windows::$INDEX_ALLOCATION\\System32\\x.dll',
  'C:\\PROGRA~1\\App\\x.exe',
  'C:\\PROGRA~3\\x',
  'C:\\Users\\jorda\\Documents\\notes.txt:secret',
  // Stash's own folders and the folders above them: recycling a parent would take them along.
  'C:\\Users\\jorda\\AppData',
  'C:\\Users\\jorda\\AppData\\Roaming',
  'C:\\Users\\jorda\\AppData\\Local',
  'C:\\Users\\jorda\\AppData\\Local\\Programs',
  'C:\\Users\\jorda\\AppData\\Local\\Temp'
])('blocks %s', (p) => expect(isBlocked(p, SAMPLE_ENV)).toBe(true))

test.each([
  'C:\\Users\\jorda\\Downloads\\setup.exe',
  'C:\\Users\\jorda\\AppData\\Local\\Temp\\x',
  'C:\\Users\\jorda\\OneDrive\\Desktop\\old.zip',
  'C:\\Users\\jorda\\Projects\\app\\node_modules',
  'C:\\Windows2\\x',
  'D:\\Games\\a.bin',
  // The protected names only apply at the top of a drive or the profile folder.
  'C:\\Users\\jorda\\Projects\\Windows\\x',
  'C:\\Users\\jorda\\Projects\\ntuser.dat',
  // Other spellings of an ordinary drive path are not mistaken for paths without a drive.
  'd:/Games/a.bin',
  '\\\\?\\D:\\Games\\a.bin',
  // Protecting Stash's folders must not spill over to what sits beside them, and a tilde that is
  // not an 8.3 short name is an ordinary name.
  'C:\\Users\\jorda\\AppData\\Local\\npm-cache',
  'C:\\Users\\jorda\\AppData\\Roaming\\SomeApp\\cache',
  'C:\\Users\\jorda\\Projects\\backup~old\\x'
])('allows %s', (p) => expect(isBlocked(p, SAMPLE_ENV)).toBe(false))

// The blocklist is the last guard before a file moves. A path that is not an absolute path on a
// drive cannot be judged by the rules above, so it is refused rather than let through.
test.each([
  'relative\\x',
  'x.txt',
  '\\Windows\\x',
  '\\\\server\\share\\x',
  '\\\\?\\UNC\\server\\share\\x',
  '',
  'C:x',
  'C:'
])('blocks %j, which is not an absolute path on a drive', (p) =>
  expect(isBlocked(p, SAMPLE_ENV)).toBe(true)
)

// Every WinEnv path the rules lean on has to be a plain drive path. One that is empty, relative or
// another spelling would switch its rule off without a sound, so everything is refused instead.
// D:\Games\a.bin is allowed with SAMPLE_ENV and is unaffected by any single bad entry, so only the
// check on the env itself can refuse it.
const ANOTHER_SPELLING = 'C:\\Users\\jorda\\Downloads.'

test.each([
  'systemRoot',
  'usersRoot',
  'userProfile',
  'localAppData',
  'temp',
  'downloads',
  'desktop',
  'documents',
  'pictures',
  'music',
  'videos',
  'oneDrive'
] as const)('refuses every path when env.%s is not a plain drive path', (field) =>
  expect(isBlocked('D:\\Games\\a.bin', { ...SAMPLE_ENV, [field]: ANOTHER_SPELLING })).toBe(true)
)

test.each([
  ['usersRoot is empty', { ...SAMPLE_ENV, usersRoot: '' }],
  ['oneDrive is empty rather than null', { ...SAMPLE_ENV, oneDrive: '' }],
  ['a stashDirs entry is relative', { ...SAMPLE_ENV, stashDirs: ['relative'] }],
  [
    'the last stashDirs entry is another spelling',
    { ...SAMPLE_ENV, stashDirs: [...SAMPLE_ENV.stashDirs, ANOTHER_SPELLING] }
  ]
])('refuses every path when %s', (_label, env) =>
  expect(isBlocked('D:\\Games\\a.bin', env)).toBe(true)
)

test('the OneDrive folder is protected even when Desktop and Documents live outside it', () => {
  const env = {
    ...SAMPLE_ENV,
    desktop: 'C:\\Users\\jorda\\Desktop',
    documents: 'C:\\Users\\jorda\\Documents'
  }
  expect(isBlocked('C:\\Users\\jorda\\OneDrive', env)).toBe(true)
  expect(isBlocked('C:\\Users\\jorda\\OneDrive\\old.zip', env)).toBe(false)
})

test('the profile folder is protected on its own, even when nothing else lives inside it', () => {
  const env = {
    ...SAMPLE_ENV,
    localAppData: 'D:\\AppData\\Local',
    temp: 'D:\\Temp',
    downloads: 'D:\\Downloads',
    desktop: 'D:\\Desktop',
    documents: 'D:\\Documents',
    pictures: 'D:\\Pictures',
    music: 'D:\\Music',
    videos: 'D:\\Videos',
    oneDrive: null,
    stashDirs: ['D:\\Stash']
  }
  expect(isBlocked('C:\\Users\\jorda', env)).toBe(true)
  expect(isBlocked('D:\\Downloads', env)).toBe(true)
  expect(isBlocked('D:\\Downloads\\setup.exe', env)).toBe(false)
})

test('AppData\\Local is protected on its own, even when %TEMP% and Stash live on another drive', () => {
  const env = { ...SAMPLE_ENV, temp: 'D:\\Temp', stashDirs: ['D:\\Stash'] }
  expect(isBlocked('C:\\Users\\jorda\\AppData', env)).toBe(true)
  expect(isBlocked('C:\\Users\\jorda\\AppData\\Local', env)).toBe(true)
  expect(isBlocked('D:\\Temp', env)).toBe(true)
  expect(isBlocked('D:\\Temp\\x', env)).toBe(false)
})

test('a profile without OneDrive is still protected, and still lets its folders be cleaned', () => {
  const env = { ...SAMPLE_ENV, oneDrive: null }
  expect(isBlocked('C:\\Users\\jorda\\Downloads', env)).toBe(true)
  expect(isBlocked('C:\\Users\\jorda\\Downloads\\setup.exe', env)).toBe(false)
})
