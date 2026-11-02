import type { Settings } from '../../../shared/types'

// Defined here, not imported from src/core: core pulls in node:path, which the sandboxed renderer can't load.
const MiB = 1_048_576

export interface SettingsForm {
  exclusions: string[]
  personalFolders: string[]
  scanTargets: string[]
  trackFileMinMB: number
  staleMinMB: number
  staleAgeMonths: number
  tempMinAgeHours: number
  idleDays: number
}

export function toForm(s: Settings): SettingsForm {
  return {
    exclusions: [...s.exclusions],
    personalFolders: [...s.personalFolders],
    scanTargets: [...s.scanTargets],
    trackFileMinMB: s.thresholds.trackFileMinBytes / MiB,
    staleMinMB: s.thresholds.staleMinBytes / MiB,
    staleAgeMonths: s.thresholds.staleAgeMonths,
    tempMinAgeHours: s.thresholds.tempMinAgeHours,
    idleDays: s.thresholds.idleDays
  }
}

/** MB × 1,048,576, rounded to whole bytes: validateSettings wants positive safe integers. */
export function fromForm(f: SettingsForm): Settings {
  return {
    version: 1,
    exclusions: [...f.exclusions],
    personalFolders: [...f.personalFolders],
    scanTargets: [...f.scanTargets],
    thresholds: {
      trackFileMinBytes: Math.round(f.trackFileMinMB * MiB),
      staleMinBytes: Math.round(f.staleMinMB * MiB),
      staleAgeMonths: f.staleAgeMonths,
      tempMinAgeHours: f.tempMinAgeHours,
      idleDays: f.idleDays
    }
  }
}
