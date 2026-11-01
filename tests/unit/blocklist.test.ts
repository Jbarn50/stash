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
  'C:\\Users\\jorda\\Projects\\..\\..\\..\\Windows\\System32'
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
  'C:\\Users\\jorda\\Projects\\ntuser.dat'
])('allows %s', (p) => expect(isBlocked(p, SAMPLE_ENV)).toBe(false))

test('the OneDrive folder is protected even when Desktop and Documents live outside it', () => {
  const env = {
    ...SAMPLE_ENV,
    desktop: 'C:\\Users\\jorda\\Desktop',
    documents: 'C:\\Users\\jorda\\Documents'
  }
  expect(isBlocked('C:\\Users\\jorda\\OneDrive', env)).toBe(true)
  expect(isBlocked('C:\\Users\\jorda\\OneDrive\\old.zip', env)).toBe(false)
})

test('the profile folder is protected even when every personal folder was moved to another drive', () => {
  const env = {
    ...SAMPLE_ENV,
    downloads: 'D:\\Downloads',
    desktop: 'D:\\Desktop',
    documents: 'D:\\Documents',
    pictures: 'D:\\Pictures',
    music: 'D:\\Music',
    videos: 'D:\\Videos',
    oneDrive: null
  }
  expect(isBlocked('C:\\Users\\jorda', env)).toBe(true)
  expect(isBlocked('D:\\Downloads', env)).toBe(true)
  expect(isBlocked('D:\\Downloads\\setup.exe', env)).toBe(false)
})

test('a profile without OneDrive is still protected, and still lets its folders be cleaned', () => {
  const env = { ...SAMPLE_ENV, oneDrive: null }
  expect(isBlocked('C:\\Users\\jorda\\Downloads', env)).toBe(true)
  expect(isBlocked('C:\\Users\\jorda\\Downloads\\setup.exe', env)).toBe(false)
})
