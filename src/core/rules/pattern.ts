import type { WinEnv } from '../../shared/types'
import type { ScanTree } from '../tree'

const WILDCARD = /[*{]/

// One path segment as a case-insensitive regex: `*` matches any name, `{a,b}` matches a or b.
function segmentRegex(segment: string): RegExp {
  const escape = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  const source = segment.replace(
    /\{([^}]*)\}|([^{]+)/g,
    (_, alternatives?: string, literal?: string) =>
      alternatives !== undefined
        ? `(?:${alternatives.split(',').map(escape).join('|')})`
        : escape(literal ?? '')
  )
  return new RegExp(`^${source}$`, 'i')
}

/**
 * The folders in `tree` that match `pattern`, such as `%LOCALAPPDATA%\Google\Chrome\User Data\*\Cache`.
 * Tokens: %SYSTEMROOT%, %LOCALAPPDATA%, %TEMP%. A segment may use `*` and `{a,b}`. Matching ignores
 * case. Nothing matches when the pattern's fixed start lies outside the scanned folder.
 */
export function resolvePattern(tree: ScanTree, pattern: string, env: WinEnv): number[] {
  const expanded = pattern
    .replace(/%SYSTEMROOT%/gi, env.systemRoot)
    .replace(/%LOCALAPPDATA%/gi, env.localAppData)
    .replace(/%TEMP%/gi, env.temp)
  const segments = expanded.split('\\').filter((s) => s !== '')
  const firstWild = segments.findIndex((s) => WILDCARD.test(s))
  const fixed = firstWild === -1 ? segments : segments.slice(0, firstWild)
  const rest = firstWild === -1 ? [] : segments.slice(firstWild)

  // The fixed part starts with a drive (`C:`), so put the separator back for the root.
  const base = tree.findFolder(fixed.length === 1 ? `${fixed[0]}\\` : fixed.join('\\'))
  if (base === undefined) return []

  let matches = [base]
  for (const segment of rest) {
    const regex = segmentRegex(segment)
    matches = matches.flatMap((id) =>
      tree.folders[id].childIds.filter((child) => regex.test(tree.folders[child].name))
    )
  }
  return matches
}
