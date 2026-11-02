import type { Finding } from '../../shared/types'
import { isBlocked } from '../blocklist'
import { isSameOrInside } from '../paths'
import type { DetectorContext } from './context'
import { detectDevLeftovers } from './devLeftovers'
import { detectInstallersStale } from './installersStale'
import { detectSystem } from './system'
import { detectTempCaches } from './tempCaches'

/**
 * True when cleaning the finding would touch an exclusion: it lies inside an excluded folder (or is
 * one), or it is a folder with an excluded folder somewhere inside it, which would go along with it.
 */
export function isExcluded(
  finding: Pick<Finding, 'path' | 'kind'>,
  exclusions: readonly string[]
): boolean {
  return exclusions.some(
    (excluded) =>
      isSameOrInside(finding.path, excluded) ||
      (finding.kind === 'folder' && isSameOrInside(excluded, finding.path))
  )
}

/**
 * Every detector except duplicates, in order: a later detector skips what an earlier one claimed.
 * Afterwards, findings that touch an exclusion (see isExcluded) are dropped, and so is any cleanable
 * finding on a blocked path (info findings sit in blocked places by nature and are never cleaned).
 */
export function runStaticDetectors(ctx: DetectorContext): Finding[] {
  const findings = [
    ...detectSystem(ctx),
    ...detectTempCaches(ctx),
    ...detectDevLeftovers(ctx),
    ...detectInstallersStale(ctx)
  ]
  return findings.filter(
    (f) =>
      !isExcluded(f, ctx.settings.exclusions) &&
      (f.safety === 'info' || !isBlocked(f.path, ctx.env))
  )
}
