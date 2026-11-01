import type { WinEnv } from '../../src/shared/types'

// A fixed Windows environment for tests. OneDrive has taken over Desktop and Documents, as on a real
// Windows 11 profile, so those two sit under OneDrive while Downloads, Pictures, Music and Videos do not.
export const SAMPLE_ENV: WinEnv = {
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
}
