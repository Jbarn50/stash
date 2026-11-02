import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { driveOf, isPlainDrivePath, normalizePath } from '../core/paths'
import type { WinEnv } from '../shared/types'

/** The folders Electron knows by name, as `app.getPath` gives them. */
export interface KnownFolders {
  home: string
  desktop: string
  documents: string
  downloads: string
  pictures: string
  music: string
  videos: string
  userData: string
  exe: string
}

/** The environment variables WinEnv reads. */
export interface EnvVars {
  SystemRoot?: string
  LOCALAPPDATA?: string
  TEMP?: string
  OneDrive?: string
}

/**
 * `path` as the disk spells it, normalized: an 8.3 short name such as `C:\Users\JORDAN~1` expands,
 * because the blocklist refuses every path while one of the environment's paths is not plain. A path
 * that is not there is only normalized.
 */
export function canonicalPath(path: string): string {
  try {
    return normalizePath(realpathSync.native(path))
  } catch {
    return normalizePath(path)
  }
}

const present = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value

/**
 * The WinEnv for these folders and variables, every path through `canonical`. A missing SystemRoot,
 * LOCALAPPDATA or TEMP falls back to where Windows keeps it; a missing OneDrive is null.
 *
 * `systemRoot` is the root of the drive Windows is on (`C:\`), not the Windows folder that the
 * SystemRoot variable names: the rules say `%SYSTEMROOT%\Windows\Temp` and look for `hiberfil.sys`
 * directly in it. A SystemRoot with no drive letter is kept as it is, so the blocklist refuses
 * everything rather than trust it.
 */
export function winEnvFrom(
  folders: KnownFolders,
  vars: EnvVars,
  canonical: (path: string) => string = canonicalPath
): WinEnv {
  const userProfile = canonical(folders.home)
  const oneDrive = present(vars.OneDrive)
  const windowsDir = canonical(present(vars.SystemRoot) ?? 'C:\\Windows')
  const systemDrive = driveOf(windowsDir)
  return {
    systemRoot: systemDrive === '' ? windowsDir : `${systemDrive}\\`,
    usersRoot: normalizePath(dirname(userProfile)),
    userProfile,
    localAppData: canonical(present(vars.LOCALAPPDATA) ?? join(userProfile, 'AppData', 'Local')),
    temp: canonical(present(vars.TEMP) ?? tmpdir()),
    downloads: canonical(folders.downloads),
    desktop: canonical(folders.desktop),
    documents: canonical(folders.documents),
    pictures: canonical(folders.pictures),
    music: canonical(folders.music),
    videos: canonical(folders.videos),
    oneDrive: oneDrive === undefined ? null : canonical(oneDrive),
    stashDirs: [canonical(folders.userData), canonical(dirname(folders.exe))]
  }
}

/** The paths of `env` that are not plain drive paths, which make the blocklist refuse everything. */
export function unplainPaths(env: WinEnv): string[] {
  const paths = [
    env.systemRoot,
    env.usersRoot,
    env.userProfile,
    env.localAppData,
    env.temp,
    env.downloads,
    env.desktop,
    env.documents,
    env.pictures,
    env.music,
    env.videos,
    ...(env.oneDrive === null ? [] : [env.oneDrive]),
    ...env.stashDirs
  ]
  return paths.filter((p) => !isPlainDrivePath(p))
}

/** The user's Windows environment: Electron's known folders and the variables, canonicalized. */
export function buildWinEnv(): WinEnv {
  const env = winEnvFrom(
    {
      home: app.getPath('home'),
      desktop: app.getPath('desktop'),
      documents: app.getPath('documents'),
      downloads: app.getPath('downloads'),
      pictures: app.getPath('pictures'),
      music: app.getPath('music'),
      videos: app.getPath('videos'),
      userData: app.getPath('userData'),
      exe: app.getPath('exe')
    },
    {
      SystemRoot: process.env.SystemRoot,
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      TEMP: process.env.TEMP,
      OneDrive: process.env.OneDrive
    }
  )
  const odd = unplainPaths(env)
  if (odd.length > 0) {
    console.warn(
      `Stash will refuse to clean while these folders have unusual names: ${odd.join(', ')}`
    )
  }
  return env
}
