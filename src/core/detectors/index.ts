import type { Finding } from '../../shared/types'
import { isBlocked } from '../blocklist'
import { isSameOrInside } from '../paths'
import type { DetectorContext } from './context'
import { detectInstallersStale } from './installersStale'
import { detectSystem } from './system'
import { detectTempCaches } from './tempCaches'

/**
 * Every detector except duplicates, in order: a later detector skips what an earlier one claimed.
 * Afterwards, findings inside an exclusion are dropped, and so is any cleanable finding on a
 * blocked path (info findings sit in blocked places by nature and are never cleaned).
 */
export function runStaticDetectors(ctx: DetectorContext): Finding[] {
  const findings = [...detectSystem(ctx), ...detectTempCaches(ctx), ...detectInstallersStale(ctx)]
  return findings.filter(
    (f) =>
      !ctx.settings.exclusions.some((excluded) => isSameOrInside(f.path, excluded)) &&
      (f.safety === 'info' || !isBlocked(f.path, ctx.env))
  )
}
