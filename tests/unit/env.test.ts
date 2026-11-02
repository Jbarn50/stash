import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { canonicalPath, unplainPaths, winEnvFrom, type KnownFolders } from '../../src/main/env'

const FOLDERS: KnownFolders = {
  home: 'C:\\Users\\JORDAN~1',
  desktop: 'C:\\Users\\jorda\\OneDrive\\Desktop',
  documents: 'C:\\Users\\jorda\\OneDrive\\Documents',
  downloads: 'C:\\Users\\jorda\\Downloads',
  pictures: 'C:\\Users\\jorda\\Pictures',
  music: 'C:\\Users\\jorda\\Music',
  videos: 'C:\\Users\\jorda\\Videos',
  userData: 'C:\\Users\\jorda\\AppData\\Roaming\\Stash',
  exe: 'C:\\Users\\jorda\\AppData\\Local\\Programs\\Stash\\Stash.exe'
}

// What realpathSync.native does for an 8.3 name: it gives the long one.
const expand = (p: string): string => p.replace('JORDAN~1', 'jorda')

test('builds WinEnv from the known folders and the variables, canonicalized', () => {
  const env = winEnvFrom(
    FOLDERS,
    {
      SystemRoot: 'C:\\WINDOWS',
      LOCALAPPDATA: 'C:\\Users\\JORDAN~1\\AppData\\Local',
      TEMP: 'C:\\Users\\JORDAN~1\\AppData\\Local\\Temp',
      OneDrive: 'C:\\Users\\jorda\\OneDrive'
    },
    expand
  )
  expect(env).toEqual({
    // The system drive's root, not the Windows folder: the rules say %SYSTEMROOT%\\Windows\\Temp
    // and look for hiberfil.sys directly in %SYSTEMROOT%.
    systemRoot: 'C:\\',
    usersRoot: 'C:\\Users',
    userProfile: 'C:\\Users\\jorda',
    localAppData: 'C:\\Users\\jorda\\AppData\\Local',
    temp: 'C:\\Users\\jorda\\AppData\\Local\\Temp',
    downloads: 'C:\\Users\\jorda\\Downloads',
    desktop: 'C:\\Users\\jorda\\OneDrive\\Desktop',
    documents: 'C:\\Users\\jorda\\OneDrive\\Documents',
    pictures: 'C:\\Users\\jorda\\Pictures',
    music: 'C:\\Users\\jorda\\Music',
    videos: 'C:\\Users\\jorda\\Videos',
    oneDrive: 'C:\\Users\\jorda\\OneDrive',
    stashDirs: [
      'C:\\Users\\jorda\\AppData\\Roaming\\Stash',
      'C:\\Users\\jorda\\AppData\\Local\\Programs\\Stash'
    ]
  })
  expect(unplainPaths(env)).toEqual([])
})

test('a missing OneDrive is null, and a short name left as it is gets reported', () => {
  const env = winEnvFrom(FOLDERS, { SystemRoot: 'C:\\Windows', OneDrive: '' }, (p) => p)
  expect(env.oneDrive).toBeNull()
  expect(env.localAppData).toBe('C:\\Users\\JORDAN~1\\AppData\\Local')
  expect(unplainPaths(env)).toContain('C:\\Users\\JORDAN~1')
})

test('systemRoot is the root of the drive Windows is on, C:\\ when SystemRoot is missing', () => {
  expect(winEnvFrom(FOLDERS, { SystemRoot: 'D:\\Windows' }, (p) => p).systemRoot).toBe('D:\\')
  expect(winEnvFrom(FOLDERS, { SystemRoot: 'c:\\windows\\' }, (p) => p).systemRoot).toBe('C:\\')
  expect(winEnvFrom(FOLDERS, {}, (p) => p).systemRoot).toBe('C:\\')
})

// A folder of the test's own, so nothing of the user's is read.
const scratch = mkdtempSync(join(tmpdir(), 'stash-env-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

test('canonicalPath gives the spelling on disk and keeps a missing path as it is', () => {
  const dir = join(scratch, 'Mixed Case')
  mkdirSync(dir)
  expect(canonicalPath(join(scratch, 'mixed case'))).toBe(realpathSync.native(dir))
  expect(canonicalPath(join(scratch, 'mixed case'))).toMatch(/Mixed Case$/)
  expect(canonicalPath('Q:\\does\\not\\exist\\')).toBe('Q:\\does\\not\\exist')
})
