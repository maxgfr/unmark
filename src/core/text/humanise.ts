// Removing the boilerplate that generated prose is made of.
//
// Following Wikipedia's "Signs of AI writing", maintained by WikiProject AI
// Cleanup, which catalogues the patterns from thousands of observed instances.
//
// The catalogue splits cleanly in two, and the split is the whole design here:
//
//   Mechanical — a phrase with one unambiguous shorter form, or a sentence that
//   is pure chat residue. "In order to" is always "to". "I hope this helps!"
//   is never part of the document. These are fixed.
//
//   Judgement — rule-of-three cadence, promotional tone, the word "delve",
//   passive voice, forced aphorisms. There is no correct substitution for
//   "delve"; rewriting the sentence is the fix, and that needs a writer. These
//   are measured by the stylometry report and left alone.
//
// A tool that guessed at the second category would produce mangled prose and
// call it humanised. The honest line is: fix what has one answer, report the
// rest, and never claim either one removes a watermark. None of this touches a
// statistical watermark — that lives in word choice across the whole document.

import type { Finding } from '../report.ts'

interface Rule {
  pattern: RegExp
  /** Replacement, or undefined to delete the whole sentence containing it. */
  to?: string
  what: string
}

/**
 * Phrases with exactly one shorter form.
 *
 * Case-insensitive, but the replacement restores the original's leading case so
 * a sentence-initial "In order to" becomes "To" and not "to".
 */
const PHRASES: Rule[] = [
  // Filler (§23)
  { pattern: /\bin order to\b/gi, to: 'to', what: 'filler' },
  { pattern: /\bdue to the fact that\b/gi, to: 'because', what: 'filler' },
  { pattern: /\bfor the reason that\b/gi, to: 'because', what: 'filler' },
  { pattern: /\bat this point in time\b/gi, to: 'now', what: 'filler' },
  { pattern: /\bat the present time\b/gi, to: 'now', what: 'filler' },
  { pattern: /\bin the event that\b/gi, to: 'if', what: 'filler' },
  { pattern: /\bhas the ability to\b/gi, to: 'can', what: 'filler' },
  { pattern: /\bhave the ability to\b/gi, to: 'can', what: 'filler' },
  { pattern: /\bis able to\b/gi, to: 'can', what: 'filler' },
  { pattern: /\ba large number of\b/gi, to: 'many', what: 'filler' },
  { pattern: /\bthe majority of\b/gi, to: 'most', what: 'filler' },
  { pattern: /\bin spite of the fact that\b/gi, to: 'although', what: 'filler' },
  { pattern: /\bwith regard to\b/gi, to: 'about', what: 'filler' },
  { pattern: /\bin terms of\b/gi, to: 'in', what: 'filler' },
  { pattern: /\bit is important to note that\s*/gi, to: '', what: 'filler' },
  { pattern: /\bit is worth noting that\s*/gi, to: '', what: 'filler' },
  { pattern: /\bit should be noted that\s*/gi, to: '', what: 'filler' },
  { pattern: /\bneedless to say,?\s*/gi, to: '', what: 'filler' },

  // Stacked hedging (§24)
  { pattern: /\bcould potentially possibly\b/gi, to: 'could', what: 'stacked hedge' },
  { pattern: /\bcould potentially\b/gi, to: 'could', what: 'stacked hedge' },
  { pattern: /\bmay potentially\b/gi, to: 'may', what: 'stacked hedge' },
  { pattern: /\bmight possibly\b/gi, to: 'might', what: 'stacked hedge' },
  { pattern: /\bit could be argued that\s*/gi, to: '', what: 'stacked hedge' },

  // Persuasive authority (§27)
  { pattern: /\bthe real question is\b/gi, to: 'the question is', what: 'authority trope' },
  { pattern: /\bat its core,\s*/gi, to: '', what: 'authority trope' },
  { pattern: /\bat the heart of the matter,\s*/gi, to: '', what: 'authority trope' },
  { pattern: /\bfundamentally,\s*/gi, to: '', what: 'authority trope' },
  { pattern: /\bwhen you really think about it,\s*/gi, to: '', what: 'authority trope' },

  // Conversational openers (§33) — only as a standalone hook, hence the anchor.
  { pattern: /(^|\n)\s*(?:Honestly|Look|Real talk)[?!,:]\s*/g, to: '$1', what: 'fake-candid hook' },
  { pattern: /(^|\n)\s*Here's the thing[,:.]?\s*/g, to: '$1', what: 'fake-candid hook' },
  { pattern: /(^|\n)\s*Let's be honest[,:.]?\s*/g, to: '$1', what: 'fake-candid hook' },
]

/**
 * Sentences that are chat residue rather than content.
 *
 * Deleted whole, because there is no shorter form of "I hope this helps!" that
 * belongs in a document.
 */
const SENTENCES: Rule[] = [
  // Collaborative artifacts (§20)
  { pattern: /\bI hope this helps\b/i, what: 'chat pleasantry' },
  { pattern: /\blet me know if you\b/i, what: 'chat pleasantry' },
  { pattern: /\bwould you like me to\b/i, what: 'chat pleasantry' },
  { pattern: /\bwant me to (?:give|show|explain|continue)\b/i, what: 'chat pleasantry' },
  { pattern: /\bshould I continue\b/i, what: 'chat pleasantry' },
  { pattern: /\bfeel free to (?:ask|reach out)\b/i, what: 'chat pleasantry' },

  // Sycophancy (§22)
  //
  // Anchored to the start of a *sentence*, not the start of the string. The
  // first draft used `^`, which meant "Great question!" was only ever caught
  // when it was the very first thing in the document — and it never is.
  // The lookbehind excludes "a great question", where the phrase is content.
  {
    pattern: /(?<=^|[.!?]\s{0,3}|\n\s{0,3})(?:great|excellent|good) question\b/i,
    what: 'sycophancy',
  },
  { pattern: /\byou'?re absolutely right\b/i, what: 'sycophancy' },
  {
    pattern: /(?<=^|[.!?]\s{0,3}|\n\s{0,3})(?:certainly|of course|absolutely)[!.]/i,
    what: 'sycophancy',
  },

  // Signposting (§28)
  { pattern: /\blet'?s (?:dive|delve) in(?:to)?\b/i, what: 'signposting' },
  { pattern: /\blet'?s (?:explore|break this down|take a look)\b/i, what: 'signposting' },
  { pattern: /\bhere'?s what you need to know\b/i, what: 'signposting' },
  { pattern: /\bwithout further ado\b/i, what: 'signposting' },

  // Knowledge-cutoff disclaimers and speculative gap-filling (§21)
  {
    pattern: /\bas of my (?:last )?(?:training|knowledge) (?:update|cutoff)\b/i,
    what: 'cutoff disclaimer',
  },
  { pattern: /\bup to my last training update\b/i, what: 'cutoff disclaimer' },
  { pattern: /\bwhile specific details (?:are|remain) (?:limited|scarce)\b/i, what: 'gap-filling' },
  { pattern: /\bmaintains a low profile\b/i, what: 'gap-filling' },
  { pattern: /\bprefers to stay out of the spotlight\b/i, what: 'gap-filling' },
]

/** Emoji used as decoration at the start of a heading or a bullet (§18). */
const DECORATIVE_EMOJI = /(^|\n)(\s*(?:[-*+]|#{1,6}|\d+\.)\s*)(?:\p{Extended_Pictographic}️?\s*)+/gu

export interface HumaniseResult {
  output: string
  findings: Finding[]
}

/** Restore the original's leading case, so a sentence still starts with a capital. */
const matchCase = (original: string, replacement: string): string =>
  replacement.length > 0 && /^[A-Z]/.test(original)
    ? replacement[0]!.toUpperCase() + replacement.slice(1)
    : replacement

/** Expand an index to the sentence around it. */
function sentenceBounds(text: string, index: number): { start: number; end: number } {
  let start = index
  while (start > 0 && !'.!?\n'.includes(text[start - 1] as string)) start -= 1

  let end = index
  while (end < text.length && !'.!?\n'.includes(text[end] as string)) end += 1
  while (end < text.length && '.!?'.includes(text[end] as string)) end += 1
  while (end < text.length && text[end] === ' ') end += 1

  return { start, end }
}

export function humanise(text: string): HumaniseResult {
  const findings: Finding[] = []
  const counts = new Map<string, number>()
  let output = text

  // Whole sentences first: removing them changes offsets, and the phrase pass
  // should not spend work on text that is about to disappear.
  for (const rule of SENTENCES) {
    for (;;) {
      const match = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', '')).exec(
        output,
      )
      if (!match) break

      const { start, end } = sentenceBounds(output, match.index)
      const removed = output.slice(start, end).trim()
      findings.push({
        kind: 'ai_phrase',
        verdict: 'probable',
        offset: start,
        length: end - start,
        label: `A sentence of ${rule.what}`,
        evidence: removed,
      })
      output = output.slice(0, start) + output.slice(end)
    }
  }

  for (const rule of PHRASES) {
    output = output.replaceAll(rule.pattern, (whole, ...rest) => {
      counts.set(rule.what, (counts.get(rule.what) ?? 0) + 1)
      // A rule with a capture group is rebuilding its own context.
      const replacement = rule.to ?? ''
      if (replacement.includes('$1')) return replacement.replace('$1', (rest[0] as string) ?? '')
      return matchCase(whole, replacement)
    })
  }

  const withoutEmoji = output.replaceAll(DECORATIVE_EMOJI, '$1$2')
  if (withoutEmoji !== output) {
    counts.set('decorative emoji', (counts.get('decorative emoji') ?? 0) + 1)
    output = withoutEmoji
  }

  for (const [what, count] of counts) {
    findings.push({
      kind: 'ai_phrase',
      verdict: 'informational',
      offset: 0,
      length: text.length,
      label: `${count} × ${what}`,
      evidence: 'a phrase with one shorter form, replaced in place',
    })
  }

  // Tidy the seams. Removing a sentence leaves a double space behind it, and
  // removing a whole paragraph leaves a stack of blank lines that reads as a
  // formatting mistake rather than as a deletion.
  output = output
    .replaceAll(/[^\S\n]{2,}/g, ' ')
    .replaceAll(/[^\S\n]([,.;:!?])/g, '$1')
    .replaceAll(/\n{3,}/g, '\n\n')
    .replaceAll(/[^\S\n]+\n/g, '\n')

  return { output, findings }
}
