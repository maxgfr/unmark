// Telling a correction apart from a rewrite, and a repaired name from a lost one.
//
// `verifyRewrite` was built to police a de-slopping rewrite of generated prose,
// where the source is assumed to be spelled correctly and the rewrite is
// suspected of drifting: every extracted name must come back verbatim, and no
// style metric may come out worse. Applied to a text the user wants *corrected*,
// both rules reject the thing they asked for.
//
// A real example, verified against the local model on a French text full of
// deliberate mistakes. The model returned, correctly:
//
//   "Son père était tapissier du roi, mais le jeune homme ne voulut pas suivre"
//
// and the verdict threw it away, because "Molliere" had become "Molière" and so
// counted as a name present in the source and missing from the rewrite. A
// perfect correction failed the same check: there is no way to repair a
// misspelled proper noun while keeping the misspelling.

import { wordForms } from './shortrewrite.ts'

/** Words of the source that a correction is expected to keep, as a share. */
const CORRECTION_OVERLAP = 0.6
/** How far a repaired name may travel from the one it repairs. */
const NAME_DISTANCE = 2

/** Accent- and case-folded, so "Molière" and "Molliere" are comparable. */
function fold(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/** Levenshtein distance, stopping once it cannot matter. */
export function editDistance(a: string, b: string, cap = NAME_DISTANCE): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
      current[j] = value
      if (value < best) best = value
    }
    if (best > cap) return cap + 1
    previous = current
  }
  return previous[b.length] ?? cap + 1
}

/**
 * Did a name survive, allowing for the spelling repair that was asked for?
 *
 * Exact first, then folded, then folded within a small edit distance. A name
 * that simply vanished is still reported: "Molière" is two edits from
 * "Molliere" and none from nothing.
 */
export function nameSurvived(name: string, after: readonly string[]): boolean {
  if (after.includes(name)) return true
  const target = fold(name)
  return after.some((candidate) => {
    const other = fold(candidate)
    return other === target || editDistance(target, other) <= NAME_DISTANCE
  })
}

/**
 * Is this rewrite a correction of the source rather than a restyling of it?
 *
 * Measured the same way the short-rewrite guard measures replacement: by how
 * much of the source's vocabulary is still there. A correction repairs words in
 * place and keeps nearly all of them; a rewrite that earns the style gates'
 * attention has moved much further than that.
 */
export function isCorrection(original: string, candidate: string): boolean {
  const before = wordForms(original)
  if (before.length === 0) return false
  const pool = new Set(wordForms(candidate))
  const kept = before.filter((word) => pool.has(word)).length
  return kept / before.length >= CORRECTION_OVERLAP
}
