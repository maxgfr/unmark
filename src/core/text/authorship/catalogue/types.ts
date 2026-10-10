// What a catalogue entry is.
//
// A habit, not a verdict. Every entry names a construction that generated
// prose leans on and that people also write, so each one carries three things
// beside its pattern: why it is on the list, what a writer would do instead,
// and the legitimate uses it must leave alone — the traps.
//
// The tier is how much one occurrence is worth:
//
//   1  counts on its own. Rare in human prose, common in generated prose.
//   2  counts only at density: two or more tier-2 hits in the same paragraph.
//      Formal French is full of "en outre" and "notamment"; one of them is a
//      register, several stacked in one paragraph is a habit.
//   3  never counts alone. It adds weight to a sentence something else already
//      flagged, and is invisible otherwise.

import type { Lang } from '../segment.ts'

export type Tier = 1 | 2 | 3

/**
 * Which signal an entry feeds. One habit, one signal:
 *
 *   lexicon            vocabulary                         → lexicon
 *   structure, discourse  the shape of sentences and turns → discourse
 *   residue, formatting   left over from a chat window      → forensic
 *   register           formulas of a register (academic), read only when
 *                      asked for, tier 3                   → discourse
 *   hedging, phrasing  the phrases `--humanise` rewrites, and stacked
 *                      hedges                              → none yet
 *
 * hedging and phrasing are found, located and reported, and weigh nothing:
 * the calibration was fitted without them, and a habit that has not been
 * measured on the corpus does not get to move a verdict. They count once a
 * refit has given them a weight.
 */
export type Category =
  | 'lexicon'
  | 'structure'
  | 'discourse'
  | 'residue'
  | 'formatting'
  | 'register'
  | 'hedging'
  | 'phrasing'

/** Categories that are reported but weigh nothing in a score, until a refit. */
export const UNWEIGHTED: ReadonlySet<Category> = new Set<Category>(['hedging', 'phrasing'])

export interface Pattern {
  /** `lang.category.name`, stable: reports and judges cite it. */
  id: string
  /** Which sentences it reads. `any` entries read every sentence. */
  lang: Lang | 'any'
  tier: Tier
  category: Category
  /** Global. Built with `word()` for anything French. */
  pattern: RegExp
  /** Why this reads as generated, in one sentence a writer can check. */
  reason: string
  /** What to do instead. Never a substitution: there is no right synonym. */
  fixHint: string
  /** Text it must match, once each. Frozen beside it so it cannot drift. */
  samples: readonly string[]
  /** Legitimate uses it must not match. */
  traps: readonly string[]
  /** Tested against the text just before a match; a hit cancels it. */
  unless?: RegExp
  /** Only read in documents of these formats. Absent means every format. */
  formats?: readonly string[]
}

/** Whether `entry` reads a document of `format`. */
export const applies = (entry: Pattern, format: string | undefined): boolean =>
  entry.formats === undefined || (format !== undefined && entry.formats.includes(format))

/** How much text before a match an `unless` guard is shown. */
export const GUARD_WINDOW = 40

/** Leading space and sentence punctuation a match may start on. */
const LEADING = /^[\s.!?,;:]*/u

/**
 * Where `entry` matches in `text`, guards applied.
 *
 * A match is trimmed of the punctuation and space some patterns anchor on
 * ("…. Moreover,"), so the span a report shows starts on the word.
 */
export function matchesOf(
  entry: Pattern,
  text: string,
  from = 0,
  to = text.length,
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const pattern = new RegExp(entry.pattern.source, entry.pattern.flags)
  pattern.lastIndex = from
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[0].length === 0) {
      pattern.lastIndex += 1
      continue
    }
    if (match.index >= to) break
    const start = match.index + (LEADING.exec(match[0])?.[0].length ?? 0)
    const end = match.index + match[0].length
    if (start >= end) continue
    if (entry.unless?.test(text.slice(Math.max(0, start - GUARD_WINDOW), start))) continue
    out.push({ start, end })
  }
  return out
}
