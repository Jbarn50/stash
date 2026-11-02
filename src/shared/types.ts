// Types shared by the main process, the preload script and the renderer.
// Types only, no runtime code: the sandboxed renderer imports this file.

export type Bytes = number
export type SafetyRating = 'safe' | 'review' | 'info'
export type Category = 'duplicates' | 'tempCaches' | 'installersStale' | 'devLeftovers' | 'system'
export type RuleId = string

export interface WinEnv {
  systemRoot: string
  usersRoot: string
  userProfile: string
  localAppData: string
  temp: string
  downloads: string
  desktop: string
  documents: string
  pictures: string
  music: string
  videos: string
  oneDrive: string | null
  stashDirs: string[]
}

export interface Thresholds {
  trackFileMinBytes: number
  staleMinBytes: number
  staleAgeMonths: number
  tempMinAgeHours: number
  idleDays: number
}

export interface Settings {
  version: 1
  exclusions: string[]
  personalFolders: string[]
  scanTargets: string[]
  thresholds: Thresholds
}

export interface Finding {
  id: string
  scanId: string
  ruleId: RuleId
  category: Category
  safety: SafetyRating
  title: string
  explanation: string
  path: string
  kind: 'file' | 'folder'
  sizeOnDisk: Bytes
  logicalSize: Bytes
  mtimeMs: number
  sizeUnknown?: boolean
  groupId?: string
  suggestedKeep?: boolean
}

export interface ScanProgress {
  scanId: string
  phase: 'scanning' | 'hashing'
  foldersScanned: number
  filesScanned: number
  bytesSeen: Bytes
  currentPath: string
  topLevel: { name: string; sizeOnDisk: Bytes }[]
  hashedBytes?: Bytes
  hashTotalBytes?: Bytes
}

export interface ScanSummary {
  scanId: string
  root: string
  incomplete: boolean
  foldersScanned: number
  filesScanned: number
  totalSizeOnDisk: Bytes
  unreadableFolders: number
  reclaimable: Bytes
  byCategory: Record<Category, Bytes>
  windowsCanClean: Bytes
  durationMs: number
}

export type SessionState = 'idle' | 'scanning' | 'hashing' | 'ready'

export type SessionEvent =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'done'; summary: ScanSummary }
  | { type: 'error'; message: string }

export interface ViewNode {
  kind: 'folder' | 'file' | 'small' | 'link' | 'other'
  id: number | null
  name: string
  sizeOnDisk: Bytes
  mtimeMs: number | null
  unreadable?: boolean
  children?: ViewNode[]
}

export interface CleanupItemRecord {
  findingId: string
  ruleId: RuleId
  kind: 'file' | 'folder'
  originalPath: string
  sizeOnDisk: Bytes
  mtime: string
  status: 'recycled' | 'skipped'
  reason?: string
  tip?: string
  recycledAs?: string
}

export interface CleanupBatch {
  type: 'cleanup'
  batchId: string
  startedAt: string
  finishedAt: string
  items: CleanupItemRecord[]
}

export interface RestoreItemRecord {
  originalPath: string
  status: 'restored' | 'purged' | 'failed'
  restoredTo?: string
  reason?: string
}

export interface RestoreRecord {
  type: 'restore'
  batchId: string
  at: string
  items: RestoreItemRecord[]
}

export type CleanOutcome =
  | { status: 'done'; batch: CleanupBatch }
  | {
      status: 'needsOverflowConfirm'
      drive: string
      batchBytes: Bytes
      binUsedBytes: Bytes
      binMaxBytes: Bytes
    }
  | {
      status: 'rejected'
      reason: 'stale-scan' | 'busy' | 'incomplete-scan' | 'unknown-finding'
    }

export interface HistoryEntry {
  batch: CleanupBatch
  restores: RestoreRecord[]
}

export interface DriveUsage {
  root: string
  totalBytes: Bytes
  freeBytes: Bytes
}

export interface Overview {
  drives: DriveUsage[]
  recycleBinUsedBytes: Bytes
  lastScan: ScanSummary | null
  state: SessionState
}
