import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateSettings } from '../core/settings'
import type { Settings } from '../shared/types'

const FILE = 'settings.json'

// Saves run one after another: they share settings.json.tmp, so two at once would trip over it.
let lastSave: Promise<unknown> = Promise.resolve()

/**
 * Reads settings.json from `dir`. A missing file gives the defaults. A file that is not valid
 * settings is renamed settings.json.bad, replacing any earlier one, and the defaults are used.
 * A file that cannot be read at all is an error: treating it as missing would drop the user's
 * exclusions, and the next save would overwrite them.
 */
export async function loadSettings(dir: string): Promise<Settings> {
  const file = join(dir, FILE)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return validateSettings({})
    throw e
  }
  try {
    return validateSettings(JSON.parse(text))
  } catch {
    await rename(file, `${file}.bad`)
    return validateSettings({})
  }
}

/**
 * Validates `input` and stores it: written to settings.json.tmp, then renamed over settings.json,
 * so a crash never leaves half a file. Invalid input throws `Invalid settings: <field>` and leaves
 * the stored settings as they were. Returns the settings as stored.
 */
export function saveSettings(dir: string, input: unknown): Promise<Settings> {
  const save = lastSave.then(async () => {
    const settings = validateSettings(input)
    const file = join(dir, FILE)
    await mkdir(dir, { recursive: true })
    await writeFile(`${file}.tmp`, JSON.stringify(settings, null, 2))
    await rename(`${file}.tmp`, file)
    return settings
  })
  lastSave = save.catch(() => undefined)
  return save
}
