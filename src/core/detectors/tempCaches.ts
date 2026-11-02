import type { Finding, RuleId } from '../../shared/types'
import { resolvePattern } from '../rules/pattern'
import { fileFinding, folderFinding, type DetectorContext } from './context'

const HOUR = 3_600_000

const CACHE_FOLDERS: [RuleId, string][] = [
  [
    'browser-cache-chromium',
    '%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\{Cache,Code Cache,GPUCache}'
  ],
  [
    'browser-cache-chromium',
    '%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\{Cache,Code Cache,GPUCache}'
  ],
  ['browser-cache-firefox', '%LOCALAPPDATA%\\Mozilla\\Firefox\\Profiles\\*\\cache2'],
  ['crash-dumps', '%LOCALAPPDATA%\\CrashDumps'],
  ['pkg-cache-npm', '%LOCALAPPDATA%\\npm-cache'],
  ['pkg-cache-pip', '%LOCALAPPDATA%\\pip\\Cache'],
  ['pkg-cache-yarn', '%LOCALAPPDATA%\\Yarn\\Cache']
]

/** The temp folder's old top-level items, plus browser, package and crash-dump caches. */
export function detectTempCaches(ctx: DetectorContext): Finding[] {
  const { tree, claims } = ctx
  const findings: Finding[] = []

  // Only the temp folder's own children are candidates: the folder itself must stay.
  const tempId = tree.findFolder(ctx.env.temp)
  if (tempId !== undefined) {
    const cutoff = ctx.now - ctx.settings.thresholds.tempMinAgeHours * HOUR
    const temp = tree.folders[tempId]
    for (const id of temp.childIds) {
      const folder = tree.folders[id]
      if (!claims.folderClaimed(id) && folder.sizeOnDisk > 0 && folder.newestMtimeMs < cutoff) {
        findings.push(folderFinding(ctx, 'temp-user', id))
      }
    }
    for (const id of temp.fileIds) {
      if (!claims.fileClaimed(id) && tree.files[id].mtimeMs < cutoff) {
        findings.push(fileFinding(ctx, 'temp-user', id))
      }
    }
  }

  for (const [ruleId, pattern] of CACHE_FOLDERS) {
    for (const id of resolvePattern(tree, pattern, ctx.env)) {
      if (!claims.folderClaimed(id) && tree.folders[id].sizeOnDisk > 0) {
        findings.push(folderFinding(ctx, ruleId, id))
      }
    }
  }
  return findings
}
