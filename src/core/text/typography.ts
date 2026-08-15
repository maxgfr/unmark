// Flattening the punctuation that generated prose reaches for.
//
// This is not watermark removal and must not be sold as it. An em dash is not a
// mark, it is a style — the stylometry report already counts them, and this is
// the other half of that loop: having been told the dash density is four times
// a human baseline, you can do something about it.
//
// It is off by default and always will be, because it rewrites the author's
// punctuation. A writer who uses em dashes deliberately, or who writes French,
// is not served by having their typography normalised behind their back.
//
// What it deliberately leaves alone:
//   « »   French guillemets — correct punctuation, not a tell
//   ’     the French apostrophe in l'été is the right character
//   ° €   currency and units
// Straightening those would damage real text in exchange for nothing, which is
// the same mistake as stripping a Persian zero-width non-joiner.

import type { Finding } from '../report.ts'
import { codeMask } from './regions.ts'

interface Substitution {
  point: number
  name: string
  /** What replaces it. */
  to: string
  /** Whether this one is an AI-writing tell or merely typographic tidying. */
  tell: boolean
}

const SUBSTITUTIONS: Substitution[] = [
  // The tells the stylometry report counts.
  { point: 0x2014, name: 'EM DASH', to: '-', tell: true },
  { point: 0x2013, name: 'EN DASH', to: '-', tell: true },
  { point: 0x2026, name: 'HORIZONTAL ELLIPSIS', to: '...', tell: true },

  // Smart quotes. Common in generated prose, and equally common in anything
  // that has been through a word processor — hence `tell: false`.
  { point: 0x201c, name: 'LEFT DOUBLE QUOTATION MARK', to: '"', tell: false },
  { point: 0x201d, name: 'RIGHT DOUBLE QUOTATION MARK', to: '"', tell: false },
  { point: 0x2018, name: 'LEFT SINGLE QUOTATION MARK', to: "'", tell: false },
  { point: 0x2019, name: 'RIGHT SINGLE QUOTATION MARK', to: "'", tell: false },
  { point: 0x201e, name: 'DOUBLE LOW-9 QUOTATION MARK', to: '"', tell: false },
  { point: 0x201a, name: 'SINGLE LOW-9 QUOTATION MARK', to: ',', tell: false },
  { point: 0x2032, name: 'PRIME', to: "'", tell: false },
  { point: 0x2033, name: 'DOUBLE PRIME', to: '"', tell: false },
  { point: 0x2010, name: 'HYPHEN', to: '-', tell: false },
  { point: 0x2011, name: 'NON-BREAKING HYPHEN', to: '-', tell: false },
  { point: 0x2212, name: 'MINUS SIGN', to: '-', tell: false },
  { point: 0x00ad, name: 'SOFT HYPHEN', to: '', tell: false },
]

const BY_POINT = new Map(SUBSTITUTIONS.map((entry) => [entry.point, entry]))

export interface TypographyOptions {
  /** Only the dash-and-ellipsis family, leaving quotation marks as written. */
  tellsOnly?: boolean
}

export interface TypographyResult {
  output: string
  findings: Finding[]
}

const uPlus = (point: number) => `U+${point.toString(16).toUpperCase().padStart(4, '0')}`

/**
 * Replace typographic punctuation with its ASCII equivalent.
 *
 * An em dash surrounded by spaces becomes a spaced hyphen rather than a bare
 * one, so "a — b" reads as "a - b" and not "a-b": the second is a compound
 * word, which is a different sentence.
 */
export function normaliseTypography(text: string, options?: TypographyOptions): TypographyResult {
  const tellsOnly = options?.tellsOnly ?? false
  const findings: Finding[] = []
  // The narrow seal, not the wide one. A curly quote inside a JSON string in a
  // fenced block must survive; a curly quote inside a quotation is still the
  // author's own punctuation and is exactly what this pass exists to flatten.
  const sealed = codeMask(text)
  let out = ''

  for (let index = 0; index < text.length; index += 1) {
    const point = text.codePointAt(index)
    if (point === undefined) break

    const substitution = BY_POINT.get(point)
    if (!substitution || (tellsOnly && !substitution.tell) || sealed[index] === 1) {
      out += text[index]
      continue
    }

    // One finding per occurrence rather than one per codepoint with a count.
    // The count version reported `offset: 0, length: text.length`, which reads
    // exactly like a position and is not one — there was nothing here to point
    // at, and the loop already had the index in hand. `collapseRuns` folds them
    // back into `23 × U+2014 EM DASH → -` for display, keyed on the label, so
    // the report says what it always said and every dash is now findable.
    //
    // `length: 1` holds because every entry in SUBSTITUTIONS is inside the BMP.
    // A table that grew an astral entry would need `widthOf` here.
    findings.push({
      kind: 'typography',
      // Never more than informational: punctuation is a style, and style is
      // not evidence of anything.
      verdict: 'informational',
      offset: index,
      length: 1,
      label: `${uPlus(point)} ${substitution.name} → ${substitution.to || 'removed'}`,
      evidence: substitution.tell
        ? 'counted by the writing-style report as a generated-prose tell'
        : 'typographic tidying, not a tell on its own',
      replacement: substitution.to,
    })
    out += substitution.to
  }

  // "word—word" keeps its hyphen tight; "word — word" keeps its spaces. Neither
  // gains or loses a space it did not have.
  return { output: out, findings }
}
