import { win32 } from 'node:path'
import type { Settings, Thresholds } from '../shared/types'
import { driveOf, normalizePath } from './paths'

export const MiB = 1_048_576

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  exclusions: [],
  personalFolders: [],
  scanTargets: ['C:\\'],
  thresholds: {
    trackFileMinBytes: MiB,
    staleMinBytes: 100 * MiB,
    staleAgeMonths: 6,
    tempMinAgeHours: 24,
    idleDays: 30
  }
}

function fail(what: string): never {
  throw new Error(`Invalid settings: ${what}`)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

// The normalized path, or null unless it is absolute and starts with a drive letter (`C:\...`).
// Relative, drive-relative (`C:x`), rooted (`\x`) and network paths are all refused.
function drivePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizePath(value)
  return win32.isAbsolute(normalized) && driveOf(normalized) !== '' ? normalized : null
}

function pathList(value: unknown, defaults: string[], field: string): string[] {
  if (value === undefined) return [...defaults]
  if (!Array.isArray(value)) fail(field)
  return value.map((item) => drivePath(item) ?? fail(field))
}

function thresholdsFrom(value: unknown): Thresholds {
  const thresholds = { ...DEFAULT_SETTINGS.thresholds }
  if (value === undefined) return thresholds
  if (!isObject(value)) fail('thresholds')
  for (const name of Object.keys(thresholds) as (keyof Thresholds)[]) {
    const given = value[name]
    if (given === undefined) continue
    if (!isPositiveInteger(given)) fail(`thresholds.${name}`)
    thresholds[name] = given
  }
  return thresholds
}

/**
 * Turns whatever was read from settings.json, or sent by the UI, into valid settings: missing fields
 * take their defaults and paths are normalized. Anything malformed throws `Invalid settings: <field>`.
 * The result shares nothing with `DEFAULT_SETTINGS` or with `input`.
 */
export function validateSettings(input: unknown): Settings {
  if (!isObject(input)) fail('expected an object')
  if (input.version !== undefined && input.version !== 1) fail('version')
  return {
    version: 1,
    exclusions: pathList(input.exclusions, DEFAULT_SETTINGS.exclusions, 'exclusions'),
    personalFolders: pathList(
      input.personalFolders,
      DEFAULT_SETTINGS.personalFolders,
      'personalFolders'
    ),
    scanTargets: pathList(input.scanTargets, DEFAULT_SETTINGS.scanTargets, 'scanTargets'),
    thresholds: thresholdsFrom(input.thresholds)
  }
}
