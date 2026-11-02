import { randomBytes } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { link, mkdir, mkdtemp, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS } from '../../src/core/settings'
import type { Bytes, Settings, WinEnv } from '../../src/shared/types'

const KiB = 1024
const DAY = 86_400_000

export interface Fixture {
  root: string
  env: WinEnv
  settings: Settings
  expectedSizeOnDisk: Bytes
  /** The file for file rows; the folder for webapp, active, unity, venv, frames and small. */
  p: Record<string, string>
  dispose(): Promise<void>
}

/**
 * A throwaway folder tree under the OS temp folder that holds one example of everything the scanner
 * and detectors must handle. Each file gets its own random bytes unless a row says otherwise, so the
 * only duplicates are the ones meant to be.
 */
export async function buildFixture(): Promise<Fixture> {
  const now = Date.now()
  const old = now - 400 * DAY
  const monthsAgo = (n: number): number => {
    const d = new Date(now)
    d.setMonth(d.getMonth() - n)
    return d.getTime()
  }

  // realpath expands an 8.3 temp folder (C:\Users\RUNNER~1\...) so every env path stays plain.
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'stash-fx-')))
  const profile = join(root, 'Users', 'tester')
  const local = join(profile, 'AppData', 'Local')
  const env: WinEnv = {
    systemRoot: root,
    usersRoot: join(root, 'Users'),
    userProfile: profile,
    localAppData: local,
    temp: join(local, 'Temp'),
    downloads: join(profile, 'Downloads'),
    desktop: join(profile, 'Desktop'),
    documents: join(profile, 'Documents'),
    pictures: join(profile, 'Pictures'),
    music: join(profile, 'Music'),
    videos: join(profile, 'Videos'),
    oneDrive: null,
    stashDirs: [join(profile, 'AppData', 'Roaming', 'Stash')]
  }
  for (const folder of [
    env.desktop,
    env.documents,
    env.downloads,
    env.pictures,
    env.music,
    env.videos
  ]) {
    await mkdir(folder, { recursive: true })
  }

  const files: string[] = []
  // Ages are applied once everything exists: creating a file resets its folder's modified time.
  const ages: [string, number][] = []
  const put = async (path: string, content: Buffer | number, mtimeMs?: number): Promise<string> => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, typeof content === 'number' ? randomBytes(content) : content)
    files.push(path)
    if (mtimeMs !== undefined) ages.push([path, mtimeMs])
    return path
  }
  const age = (mtimeMs: number, ...folders: string[]): void => {
    for (const folder of folders) ages.push([folder, mtimeMs])
  }

  const p: Record<string, string> = {}
  p.winTemp = await put(join(root, 'Windows', 'Temp', 'x.tmp'), 100 * KiB)
  p.winUpdate = await put(
    join(root, 'Windows', 'SoftwareDistribution', 'Download', 'u.cab'),
    100 * KiB
  )
  p.tempOld = await put(join(env.temp, 'old-dir', 'a.bin'), 100 * KiB, now - 2 * DAY)
  age(now - 2 * DAY, join(env.temp, 'old-dir'))
  p.tempFresh = await put(join(env.temp, 'fresh.bin'), 100 * KiB)
  p.chromeCache = await put(
    join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache', 'data_0'),
    100 * KiB
  )
  p.npmCache = await put(join(local, 'npm-cache', '_cacache', 'x.bin'), 100 * KiB)
  p.setupOld = await put(join(env.downloads, 'setup-old.exe'), 100 * KiB, now - 40 * DAY)
  p.setupNew = await put(join(env.downloads, 'setup-new.msi'), 100 * KiB)
  p.zipOld = await put(join(env.downloads, 'big-old.zip'), 300 * KiB, monthsAgo(7))

  const photo = randomBytes(200 * KiB)
  p.photo = await put(join(env.documents, 'photo.jpg'), photo, old)
  p.photoCopy = await put(join(env.pictures, 'photo-copy.jpg'), photo)
  p.gitCopy = await put(join(env.documents, '.git', 'objects', 'pack.bin'), photo)

  const near = randomBytes(300 * KiB)
  const nearB = Buffer.from(near)
  nearB[150 * KiB] ^= 0xff // same first and last 64 KiB, different middle
  p.nearA = await put(join(env.documents, 'near-a.bin'), near)
  p.nearB = await put(join(env.documents, 'near-b.bin'), nearB)

  p.hard1 = await put(join(env.documents, 'hard-1.bin'), 200 * KiB)
  p.hard2 = join(env.documents, 'hard-2.bin')
  await link(p.hard1, p.hard2)
  files.push(p.hard2)
  p.loop = join(env.documents, 'loop')
  await symlink(env.documents, p.loop, 'junction')
  p.oldVideo = await put(join(env.documents, 'old-video.mp4'), 300 * KiB, monthsAgo(8))

  p.webapp = join(profile, 'Projects', 'webapp')
  await put(join(p.webapp, 'package.json'), Buffer.from('{"name":"webapp"}'), old)
  await put(join(p.webapp, 'node_modules', 'lib', 'index.bin'), 100 * KiB, old)
  age(old, p.webapp, join(p.webapp, 'node_modules'), join(p.webapp, 'node_modules', 'lib'))

  p.active = join(profile, 'Projects', 'active')
  await put(join(p.active, 'package.json'), Buffer.from('{"name":"active"}'))
  await put(join(p.active, 'node_modules', 'x.bin'), 100 * KiB, old)
  age(old, join(p.active, 'node_modules'))

  p.unity = join(profile, 'Projects', 'game')
  await put(join(p.unity, 'Assets', 'a.txt'), Buffer.from('asset'), old)
  await put(join(p.unity, 'ProjectSettings', 'p.txt'), Buffer.from('settings'), old)
  await put(join(p.unity, 'Library', 'cache.bin'), 100 * KiB, old)
  age(
    old,
    p.unity,
    join(p.unity, 'Assets'),
    join(p.unity, 'ProjectSettings'),
    join(p.unity, 'Library')
  )

  p.venv = join(profile, 'Projects', 'py')
  await put(join(p.venv, 'pyproject.toml'), Buffer.from('[project]\nname = "py"\n'), old)
  await put(join(p.venv, '.venv', 'pyvenv.cfg'), Buffer.from('home = C:\\Python\n'), old)
  await put(join(p.venv, '.venv', 'lib', 'x.bin'), 100 * KiB, old)
  age(old, p.venv, join(p.venv, '.venv'), join(p.venv, '.venv', 'lib'))

  p.blend = await put(join(profile, 'Art', 'scene.blend'), 100 * KiB)
  p.blend1 = await put(join(profile, 'Art', 'scene.blend1'), 100 * KiB)

  p.frames = join(profile, 'Renders', 'shot')
  for (let i = 1; i <= 6; i++) {
    await put(join(p.frames, `frame${String(i).padStart(4, '0')}.png`), 70 * KiB, now - 60 * DAY)
  }
  age(now - 60 * DAY, p.frames)

  let deepDir = join(profile, 'Deep')
  while (join(deepDir, 'deep.bin').length <= 270)
    deepDir = join(deepDir, 'a-rather-long-folder-name-0123456789')
  p.deep = await put(join(deepDir, 'deep.bin'), 100 * KiB)

  p.small = join(profile, 'Small')
  for (let i = 0; i < 10; i++) await put(join(p.small, `s${i}.txt`), KiB)

  for (const [path, mtimeMs] of ages) await utimes(path, new Date(mtimeMs), new Date(mtimeMs))

  // Size on disk as the builder itself measures it, counting the hard-linked pair once.
  const seen = new Set<string>()
  let expectedSizeOnDisk = 0
  for (const file of files) {
    const s = lstatSync(file, { bigint: true })
    const key = `${s.dev}:${s.ino}`
    if (seen.has(key)) continue
    seen.add(key)
    expectedSizeOnDisk += Number(s.blocks) * 512
  }

  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    exclusions: [],
    personalFolders: [],
    scanTargets: [...DEFAULT_SETTINGS.scanTargets],
    thresholds: {
      trackFileMinBytes: 65536,
      staleMinBytes: 262144,
      staleAgeMonths: 6,
      tempMinAgeHours: 24,
      idleDays: 30
    }
  }

  return {
    root,
    env,
    settings,
    expectedSizeOnDisk,
    p,
    async dispose() {
      // The junction goes first so that removing the tree can never walk through it.
      await unlink(p.loop).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  }
}
