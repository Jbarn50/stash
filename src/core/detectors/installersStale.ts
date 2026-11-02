import { win32 } from 'node:path'
import type { Finding } from '../../shared/types'
import { fileFinding, type DetectorContext } from './context'
import { insideLeftoverShape } from './devLeftovers'
import { insideGitFolder, inPersonalScope } from './scope'

const DAY = 86_400_000
const INSTALLER_EXTENSIONS = new Set(['.exe', '.msi', '.zip', '.iso'])

/** `now` moved back by whole calendar months, in UTC. */
function monthsBefore(now: number, months: number): number {
  const d = new Date(now)
  d.setUTCMonth(d.getUTCMonth() - months)
  return d.getTime()
}

/**
 * Old installers and archives in Downloads, then large personal files untouched for months.
 * Installers go first so an old archive that is also large is reported once, as an installer.
 */
export function detectInstallersStale(ctx: DetectorContext): Finding[] {
  const { tree, claims, settings } = ctx
  const findings: Finding[] = []

  const downloadsId = tree.findFolder(ctx.env.downloads)
  if (downloadsId !== undefined) {
    const cutoff = ctx.now - settings.thresholds.idleDays * DAY
    for (const file of tree.files) {
      if (
        INSTALLER_EXTENSIONS.has(win32.extname(file.name).toLowerCase()) &&
        file.mtimeMs < cutoff &&
        !file.cloudOnly &&
        !file.extraHardLink &&
        tree.isInside(file.folderId, downloadsId) &&
        !claims.fileClaimed(file.id)
      ) {
        findings.push(fileFinding(ctx, 'downloads-installers', file.id))
      }
    }
  }

  // "Stale" means not modified: Windows does not reliably record when a file was last opened.
  const staleCutoff = monthsBefore(ctx.now, settings.thresholds.staleAgeMonths)
  for (const file of tree.files) {
    if (
      file.sizeOnDisk >= settings.thresholds.staleMinBytes &&
      file.mtimeMs < staleCutoff &&
      !file.cloudOnly &&
      !file.extraHardLink &&
      !claims.fileClaimed(file.id) &&
      !insideGitFolder(tree, file.folderId) &&
      !insideLeftoverShape(tree, file.folderId) &&
      inPersonalScope(tree.filePath(file.id), ctx.env, settings)
    ) {
      findings.push(fileFinding(ctx, 'stale-large', file.id))
    }
  }
  return findings
}
