import type { Finding, RuleId } from '../../shared/types'
import { resolvePattern } from '../rules/pattern'
import { fileFinding, folderFinding, type DetectorContext } from './context'

const SYSTEM_FOLDERS: [RuleId, string][] = [
  ['sys-windows-temp', '%SYSTEMROOT%\\Windows\\Temp'],
  ['sys-windows-update', '%SYSTEMROOT%\\Windows\\SoftwareDistribution\\Download'],
  ['sys-installer-cache', '%SYSTEMROOT%\\Windows\\Installer'],
  ['sys-installer-cache', '%SYSTEMROOT%\\ProgramData\\Package Cache'],
  ['sys-component-store', '%SYSTEMROOT%\\Windows\\WinSxS']
]

const SYSTEM_FILES = new Map<string, RuleId>([
  ['hiberfil.sys', 'sys-hiberfil'],
  ['pagefile.sys', 'sys-pagefile'],
  ['swapfile.sys', 'sys-pagefile']
])

/**
 * System areas Windows manages. They are reported for information only: Stash points to Disk Cleanup
 * or the relevant setting and never cleans them itself.
 */
export function detectSystem(ctx: DetectorContext): Finding[] {
  const { tree, claims } = ctx
  const findings: Finding[] = []
  for (const [ruleId, pattern] of SYSTEM_FOLDERS) {
    for (const id of resolvePattern(tree, pattern, ctx.env)) {
      const folder = tree.folders[id]
      // An unreadable folder is still worth showing, as "size unknown"; an empty readable one is not.
      if (claims.folderClaimed(id) || (folder.sizeOnDisk === 0 && !folder.unreadable)) continue
      findings.push(folderFinding(ctx, ruleId, id))
    }
  }

  const rootId = tree.findFolder(ctx.env.systemRoot)
  if (rootId !== undefined) {
    for (const fileId of tree.folders[rootId].fileIds) {
      const ruleId = SYSTEM_FILES.get(tree.files[fileId].name.toLowerCase())
      if (ruleId && !claims.fileClaimed(fileId)) findings.push(fileFinding(ctx, ruleId, fileId))
    }
  }
  return findings
}
