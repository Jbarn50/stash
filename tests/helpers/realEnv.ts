import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { WinEnv } from '../../src/shared/types'

/**
 * `path` as the disk spells it: an 8.3 short name such as `C:\Users\JORDAN~1\AppData\Local\Temp`
 * expands, which the blocklist needs, because it refuses every path when one of the environment's
 * paths is not plain. A path that is not there is kept as it is.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`${name} is not set`)
  return value
}

/**
 * The environment of the user running the tests, read from `process.env` and nothing else: the
 * same shape the app builds with Electron's help, for tests that use the real machine. Personal
 * folders are taken to be under the profile, and none of Stash's own folders are listed.
 */
export function realEnv(): WinEnv {
  const userProfile = canonical(required('USERPROFILE'))
  const personal = (name: string): string => canonical(join(userProfile, name))
  const oneDrive = process.env.OneDrive
  return {
    systemRoot: canonical(required('SystemRoot')),
    usersRoot: dirname(userProfile),
    userProfile,
    localAppData: canonical(required('LOCALAPPDATA')),
    temp: canonical(required('TEMP')),
    downloads: personal('Downloads'),
    desktop: personal('Desktop'),
    documents: personal('Documents'),
    pictures: personal('Pictures'),
    music: personal('Music'),
    videos: personal('Videos'),
    oneDrive: oneDrive === undefined || oneDrive === '' ? null : canonical(oneDrive),
    stashDirs: []
  }
}
