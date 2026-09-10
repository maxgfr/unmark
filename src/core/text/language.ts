// Did the rewrite keep the language of the source?
//
// A fluent model asked to "rewrite" a French document will sometimes answer in
// English. Every other gate in `verifyRewrite` passes that answer: the numbers
// survive, the code is untouched, the names are still capitalised. So the
// language is checked on its own, and the check has to live with two facts
// about statistical language detection:
//
//   it is unreliable on short text — "Sales reached 10 units." is nothing in
//   particular, and TinyLD reads "Merci pour votre retour. Nous corrigeons le
//   bug" as Portuguese with a comfortable lead;
//
//   a false rejection costs three paid or slow attempts and then the rewrite
//   the user asked for, so it is never the safe side.
//
// Hence the asymmetry throughout: a language is REQUIRED only on confident
// evidence, and a requirement is SATISFIED by weaker evidence — the runner-up
// languages the detector saw in the same passage. When neither side is
// confident there is no verdict, and no verdict is not an approval: it is the
// gate saying it cannot tell, which for a two-word rewrite is the truth.

import { detectAll } from 'tinyld'
import { francAll } from 'franc-min'
import { blocksOf } from './regions.ts'

/** A confident TinyLD result: at least this score, with at least `LEAD` over the runner-up. */
const SURE = 0.2
const LEAD = 0.1
/** Below this TinyLD is guessing and franc-min agreement cannot rescue it. */
const WEAK = 0.05
/** Runner-up languages this strong count as "the passage might be this too". */
const PLAUSIBLE = 0.1
/** franc-min is treated as an opinion only when its winner has this lead. */
const FRANC_LEAD = 0.15
/** Enough characters to identify a language; more only costs time. */
const SAMPLE = 4000

interface Passage {
  /** The language this passage is confidently in, if any. */
  sure?: string
  /** `sure` plus every runner-up TinyLD rated at least `PLAUSIBLE`. */
  plausible: Set<string>
}

/**
 * The prose of a document, one string per block, with the non-prose scrubbed.
 *
 * Code, links, tags and quotations must not choose the output language: a
 * French document that quotes an English report is a French document, and the
 * comments in its fenced blocks are not what the rewrite is being asked about.
 */
function passages(text: string): string[] {
  return blocksOf(text)
    .filter(
      (block) =>
        !['fence', 'indented_code', 'frontmatter', 'blockquote', 'blank'].includes(block.kind),
    )
    .map((block) =>
      text
        .slice(block.start, block.end)
        .replace(/(`+)(?:(?!\1)[^\n])+\1/g, ' ')
        .replace(/"[^"\n]*"|“[^”\n]*”|«[^»\n]*»/g, ' ')
        .replace(/\bhttps?:\/\/\S+|<[^>\n]+>/g, ' ')
        .trim(),
    )
    .filter(Boolean)
}

/** franc-min speaks ISO 639-3; TinyLD speaks 639-1. `Intl` knows the mapping. */
function iso1(code: string): string | undefined {
  try {
    const language = new Intl.Locale(code).language
    return language === 'und' ? undefined : language
  } catch {
    return undefined
  }
}

/** franc-min's winner as a 639-1 code, but only when it clearly leads. */
function confidentFranc(sample: string): string | undefined {
  const [winner, runnerUp] = francAll(sample, { minLength: 10 })
  if (!winner || winner[0] === 'und') return undefined
  if (winner[1] - (runnerUp?.[1] ?? 0) < FRANC_LEAD) return undefined
  return iso1(winner[0])
}

function identify(text: string): Passage {
  const sample = text.slice(0, SAMPLE)
  const ranked = detectAll(sample)
  const plausible = new Set(
    ranked.filter((entry) => entry.accuracy >= PLAUSIBLE).map((entry) => entry.lang),
  )
  const [first, second] = ranked
  if (!first) return { plausible }

  // TinyLD's score is not a calibrated probability. Require a clear lead.
  if (first.accuracy >= SURE && first.accuracy - (second?.accuracy ?? 0) >= LEAD) {
    plausible.add(first.lang)
    // High confidence is not agreement, and a lead over nothing is not a lead.
    // On a short informal line TinyLD returns a single result at accuracy
    // 1.000 — there is no runner-up to subtract, so the lead test is satisfied
    // by a detector that had almost nothing to go on. "wsh comment sa va" comes
    // back as Polish at full confidence while franc-min calls it French, also
    // at full confidence, and with no runner-up the passage looked
    // unambiguously Polish. That reached the prompt as "Write only in Polish",
    // and a model told to write Polish without translating can only copy the
    // input back — the rewrite silently doing nothing.
    //
    // So a confident disagreement is recorded rather than discarded: the second
    // detector's language joins `plausible`. The verdict survives, so a real
    // translation is still caught, but the caller now sees two candidates and
    // falls back to "keep the language of every passage" instead of naming one.
    const other = confidentFranc(sample)
    if (other) plausible.add(other)
    return { sure: first.lang, plausible }
  }

  // Short greetings score poorly. Trust weak evidence only when a second,
  // independent classifier agrees outright; otherwise leave it undetermined.
  if (first.accuracy >= WEAK && confidentFranc(sample) === first.lang) {
    plausible.add(first.lang)
    return { sure: first.lang, plausible }
  }

  return { plausible }
}

/**
 * The passages of a document with their languages.
 *
 * Per passage rather than per document so a bilingual file keeps both halves.
 * When no single passage is confident — a list of short French lines — the
 * prose is identified as one piece, since the pieces were too small to read.
 */
function profile(text: string): Passage[] {
  const parts = passages(text)
  const found = parts.map(identify)
  if (found.some((passage) => passage.sure)) return found
  return parts.length ? [identify(parts.join('\n'))] : []
}

/**
 * The languages a document's prose may be in, in order of appearance.
 *
 * Every language a confident passage could be, not only the winner. The caller
 * is a prompt that says "write only in X", and naming one language when two
 * are plausible is the mistake: told "write only in Portuguese" about a French
 * paragraph the detector misread, the model does exactly that. Two names make
 * the prompt fall back to "keep the language of every passage", which is safe.
 */
export function proseLanguages(text: string): string[] {
  return [
    ...new Set(
      profile(text)
        .filter((passage) => passage.sure !== undefined)
        .flatMap((passage) => Array.from(passage.plausible)),
    ),
  ]
}

function sureLanguages(passages: readonly Passage[]): string[] {
  return [
    ...new Set(passages.map((p) => p.sure).filter((lang): lang is string => lang !== undefined)),
  ]
}

/**
 * Whether a language one side is confidently in still has a home on the other.
 *
 * Three ways to survive, each weaker than a confident match on purpose:
 *
 *   a passage on the other side is confidently that language;
 *   a passage on the other side saw it as a live runner-up;
 *   this passage's own runner-ups include what the other side is confidently
 *   in — the detector was unsure about this passage, and the other side
 *   resolved the doubt rather than changing the language.
 */
function survives(passage: Passage, sure: string, others: readonly Passage[]): boolean {
  return others.some(
    (other) =>
      other.plausible.has(sure) || (other.sure !== undefined && passage.plausible.has(other.sure)),
  )
}

export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

function describe(passage: Passage): string {
  return [...passage.plausible].map(languageName).join(' or ')
}

/**
 * A rejection reason when the rewrite changed language, else nothing.
 *
 * Nothing is not proof: a short or ambiguous text on either side leaves the
 * question open, and an open question is not a failure the model can correct.
 */
export function changedLanguage(original: string, candidate: string): string | undefined {
  if (original.trim() === candidate.trim()) return
  const before = profile(original)
  if (!sureLanguages(before).length) return
  const after = profile(candidate)
  if (!sureLanguages(after).length) return

  const lost = before.filter((p) => p.sure !== undefined && !survives(p, p.sure, after))
  const added = after.filter((p) => p.sure !== undefined && !survives(p, p.sure, before))
  if (!lost.length && !added.length) return

  // Name what was there, not only what was lost: the model is told what to
  // write, and "keep French and English" is the instruction it can act on.
  const keep = [...new Set(before.filter((p) => p.sure !== undefined).map(describe))]
  return `Keep ${keep.join(' and ')}; the rewrite was detected as ${sureLanguages(after)
    .map(languageName)
    .join(' and ')}`
}
