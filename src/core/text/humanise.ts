// Removing the boilerplate that generated prose is made of.
//
// Following Wikipedia's "Signs of AI writing", maintained by WikiProject AI
// Cleanup, which catalogues the patterns from thousands of observed instances,
// and theclaymethod/unslop, which adds the collocation guards that keep a
// phrase rule from firing on the one sentence where the phrase is legitimate.
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
//
// Two structural rules this file did not used to follow, and now does:
//
//   Nothing acts inside a sealed region. A fenced code block, a blockquote, a
//   URL and a quoted phrase are all off limits — see regions.ts. Quoting
//   marketing copy is not writing marketing copy, and "in order to" inside a
//   shell snippet is part of a command.
//
//   Every edit is computed against the original string and applied in one pass
//   at the end. The previous version mutated a buffer as it went, so a finding's
//   offset addressed a document that no longer existed by the time the caller
//   read it — and those offsets were then sorted against offsets from cleanText,
//   which do address the original.

import type { Finding } from '../report.ts'
import { blocksOf, isSealed, protectedMask } from './regions.ts'

export interface Rule {
  pattern: RegExp
  /**
   * A phrase this rule is meant to catch, frozen beside it.
   *
   * The point is regression, not birth defects: once written down, the sample
   * stops moving when the pattern does. Edit a pattern so it no longer matches
   * its own sample and the suite says so — which is exactly the check that was
   * missing when `(?:w14?|w15|cp|dc|xmp)?` was written, read as a list of
   * namespace prefixes, and quietly meant "w1 followed by an optional 4".
   */
  sample: string
  /** Replacement, or undefined to delete the whole sentence containing it. */
  to?: string
  what: string
  /**
   * A guard tested against the text immediately before the match.
   *
   * The collocation idea from unslop: `leverage` is filler in "leverage our
   * expertise" and a real word in "financial leverage" or "mechanical
   * leverage". A rule with no guard fires on both and the second one is damage.
   */
  unless?: RegExp
}

/** How much preceding text an `unless` guard is shown. */
const GUARD_WINDOW = 40

/**
 * Phrases with exactly one shorter form.
 *
 * Case-insensitive, but the replacement restores the original's leading case so
 * a sentence-initial "In order to" becomes "To" and not "to".
 */
/**
 * Exported so a test can walk them.
 *
 * A rule table is where a dead pattern hides best: the code reads correctly,
 * the tests around it pass, and one entry silently never matches anything.
 * `humanise.test.ts` iterates these and fails on any rule that cannot fire.
 */
export const PHRASES: Rule[] = [
  // Filler (§23)
  { pattern: /\bin order to\b/gi, sample: 'in order to', to: 'to', what: 'filler' },
  {
    pattern: /\bdue to the fact that\b/gi,
    sample: 'due to the fact that',
    to: 'because',
    what: 'filler',
  },
  {
    pattern: /\bfor the reason that\b/gi,
    sample: 'for the reason that',
    to: 'because',
    what: 'filler',
  },
  {
    pattern: /\bat this point in time\b/gi,
    sample: 'at this point in time',
    to: 'now',
    what: 'filler',
  },
  {
    pattern: /\bat the present time\b/gi,
    sample: 'at the present time',
    to: 'now',
    what: 'filler',
  },
  { pattern: /\bin the event that\b/gi, sample: 'in the event that', to: 'if', what: 'filler' },
  { pattern: /\bhas the ability to\b/gi, sample: 'has the ability to', to: 'can', what: 'filler' },
  {
    pattern: /\bhave the ability to\b/gi,
    sample: 'have the ability to',
    to: 'can',
    what: 'filler',
  },
  { pattern: /\bis able to\b/gi, sample: 'is able to', to: 'can', what: 'filler' },
  { pattern: /\ba large number of\b/gi, sample: 'a large number of', to: 'many', what: 'filler' },
  { pattern: /\bthe majority of\b/gi, sample: 'the majority of', to: 'most', what: 'filler' },
  {
    pattern: /\bin spite of the fact that\b/gi,
    sample: 'in spite of the fact that',
    to: 'although',
    what: 'filler',
  },
  { pattern: /\bwith regard to\b/gi, sample: 'with regard to', to: 'about', what: 'filler' },
  { pattern: /\bin terms of\b/gi, sample: 'in terms of', to: 'in', what: 'filler' },
  {
    pattern: /\bit is important to note that\s*/gi,
    sample: 'it is important to note that',
    to: '',
    what: 'filler',
  },
  {
    pattern: /\bit is worth noting that\s*/gi,
    sample: 'it is worth noting that',
    to: '',
    what: 'filler',
  },
  {
    pattern: /\bit should be noted that\s*/gi,
    sample: 'it should be noted that',
    to: '',
    what: 'filler',
  },
  { pattern: /\bneedless to say,?\s*/gi, sample: 'needless to say,', to: '', what: 'filler' },
  {
    pattern: /\bthe fact of the matter is that\s*/gi,
    sample: 'the fact of the matter is that',
    to: '',
    what: 'filler',
  },
  {
    pattern: /\bit goes without saying that\s*/gi,
    sample: 'it goes without saying that',
    to: '',
    what: 'filler',
  },
  { pattern: /\bas we all know,?\s*/gi, sample: 'as we all know,', to: '', what: 'filler' },
  {
    pattern: /\bat the end of the day,\s*/gi,
    sample: 'at the end of the day,',
    to: '',
    what: 'filler',
  },
  { pattern: /\bin conclusion,\s*/gi, sample: 'in conclusion,', to: '', what: 'filler' },
  { pattern: /\bto sum up,\s*/gi, sample: 'to sum up,', to: '', what: 'filler' },
  { pattern: /\bin summary,\s*/gi, sample: 'in summary,', to: '', what: 'filler' },
  { pattern: /\ba number of\b/gi, sample: 'a number of', to: 'several', what: 'filler' },
  { pattern: /\bprior to\b/gi, sample: 'prior to', to: 'before', what: 'filler' },
  {
    pattern: /\bin conjunction with\b/gi,
    sample: 'in conjunction with',
    to: 'with',
    what: 'filler',
  },
  { pattern: /\bis indicative of\b/gi, sample: 'is indicative of', to: 'shows', what: 'filler' },

  // AI vocabulary that does have one right answer (§7). The words with no
  // correct substitution — delve, tapestry, pivotal, vibrant — are deliberately
  // absent: they are reported by stylometry and rewritten by a person.
  { pattern: /\butiliz(?:e|es|ed)\b/gi, sample: 'utilize', to: 'use', what: 'inflated word' },
  { pattern: /\butilis(?:e|es|ed)\b/gi, sample: 'utilise', to: 'use', what: 'inflated word' },
  { pattern: /\butiliz(?:ation|ing)\b/gi, sample: 'utilization', to: 'use', what: 'inflated word' },
  {
    pattern: /\bleverag(?:e|es|ed)\b/gi,
    sample: 'leverage',
    to: 'use',
    what: 'inflated word',
    // "financial leverage" and "mechanical leverage" are the noun, and the noun
    // is a real word. Only the verb is filler.
    unless: /\b(?:financial|operating|mechanical|gains?|more|less|the|its|their|of)\s+$/i,
  },
  { pattern: /\bleveraging\b/gi, sample: 'leveraging', to: 'using', what: 'inflated word' },
  {
    pattern: /\bfacilitat(?:e|es|ed)\b/gi,
    sample: 'facilitate',
    to: 'help',
    what: 'inflated word',
  },
  { pattern: /\bcommenc(?:e|es|ed)\b/gi, sample: 'commence', to: 'start', what: 'inflated word' },
  { pattern: /\bendeavou?r to\b/gi, sample: 'endeavour to', to: 'try to', what: 'inflated word' },
  { pattern: /\ba myriad of\b/gi, sample: 'a myriad of', to: 'many', what: 'inflated word' },
  { pattern: /\ba plethora of\b/gi, sample: 'a plethora of', to: 'many', what: 'inflated word' },
  {
    pattern: /\bin today's fast-paced world,?\s*/gi,
    sample: "in today's fast-paced world,",
    to: '',
    what: 'inflated word',
  },
  {
    pattern: /\bin the ever-evolving (?:world|landscape) of\b/gi,
    sample: 'in the ever-evolving world of',
    to: 'in',
    what: 'inflated word',
  },
  { pattern: /\bsubsequently\b/gi, sample: 'subsequently', to: 'later', what: 'inflated word' },

  // Stacked hedging (§24)
  {
    pattern: /\bcould potentially possibly\b/gi,
    sample: 'could potentially possibly',
    to: 'could',
    what: 'stacked hedge',
  },
  {
    pattern: /\bcould potentially\b/gi,
    sample: 'could potentially',
    to: 'could',
    what: 'stacked hedge',
  },
  { pattern: /\bmay potentially\b/gi, sample: 'may potentially', to: 'may', what: 'stacked hedge' },
  { pattern: /\bmight possibly\b/gi, sample: 'might possibly', to: 'might', what: 'stacked hedge' },
  {
    pattern: /\bit could be argued that\s*/gi,
    sample: 'it could be argued that',
    to: '',
    what: 'stacked hedge',
  },
  {
    pattern: /\bone could argue that\s*/gi,
    sample: 'one could argue that',
    to: '',
    what: 'stacked hedge',
  },
  {
    pattern: /\bit seems that it\b/gi,
    sample: 'it seems that it',
    to: 'it',
    what: 'stacked hedge',
  },

  // Persuasive authority (§27)
  {
    pattern: /\bthe real question is\b/gi,
    sample: 'the real question is',
    to: 'the question is',
    what: 'authority trope',
  },
  {
    pattern: /(?<=^|[.!?;:]\s{0,3}|\n\s{0,3})at its core,\s*/gi,
    sample: 'at its core,',
    to: '',
    what: 'authority trope',
  },
  {
    pattern: /\bat the heart of the matter,\s*/gi,
    sample: 'at the heart of the matter,',
    to: '',
    what: 'authority trope',
  },
  {
    pattern: /(?<=^|[.!?;:]\s{0,3}|\n\s{0,3})fundamentally,\s*/gi,
    sample: 'fundamentally,',
    to: '',
    what: 'authority trope',
  },
  {
    pattern: /\bwhen you really think about it,\s*/gi,
    sample: 'when you really think about it,',
    to: '',
    what: 'authority trope',
  },
  {
    pattern: /(?<=^|[.!?;:]\s{0,3}|\n\s{0,3})in reality,\s*/gi,
    sample: 'in reality,',
    to: '',
    what: 'authority trope',
  },
  {
    pattern: /\bwhat really matters is\b/gi,
    sample: 'what really matters is',
    to: 'what matters is',
    what: 'authority trope',
  },
  {
    pattern: /\bthe deeper issue is\b/gi,
    sample: 'the deeper issue is',
    to: 'the issue is',
    what: 'authority trope',
  },
  {
    pattern: /\bmake no mistake[,:.]\s*/gi,
    sample: 'make no mistake,',
    to: '',
    what: 'authority trope',
  },
  {
    pattern: /\blet that sink in\.\s*/gi,
    sample: 'let that sink in.',
    to: '',
    what: 'authority trope',
  },

  // Conversational openers (§33) — only as a standalone hook, hence the anchor.
  {
    pattern: /(^|\n)\s*(?:Honestly|Look|Real talk)[?!,:]\s*/g,
    sample: 'Honestly?',
    to: '$1',
    what: 'fake-candid hook',
  },
  {
    pattern: /(^|\n)\s*Here's the thing[,:.]?\s*/g,
    sample: "Here's the thing,",
    to: '$1',
    what: 'fake-candid hook',
  },
  {
    pattern: /(^|\n)\s*Let(?:'s| us) be honest[,:.]?\s*/g,
    sample: "Let's be honest,",
    to: '$1',
    what: 'fake-candid hook',
  },
  {
    pattern: /(^|\n)\s*The thing is[,:.]?\s*/g,
    sample: 'The thing is,',
    to: '$1',
    what: 'fake-candid hook',
  },
]

/**
 * Sentences that are chat residue rather than content.
 *
 * Deleted whole, because there is no shorter form of "I hope this helps" that
 * belongs in a document.
 */
export const SENTENCES: Rule[] = [
  // Collaborative artifacts (§20)
  { pattern: /\bI hope this helps\b/i, sample: 'I hope this helps', what: 'chat pleasantry' },
  { pattern: /\bhope (?:that|this) helps\b/i, sample: 'hope that helps', what: 'chat pleasantry' },
  { pattern: /\blet me know if you\b/i, sample: 'let me know if you', what: 'chat pleasantry' },
  { pattern: /\bwould you like me to\b/i, sample: 'would you like me to', what: 'chat pleasantry' },
  {
    pattern: /\bwant me to (?:give|show|explain|continue)\b/i,
    sample: 'want me to give',
    what: 'chat pleasantry',
  },
  { pattern: /\bshould I continue\b/i, sample: 'should I continue', what: 'chat pleasantry' },
  {
    pattern: /\bfeel free to (?:ask|reach out)\b/i,
    sample: 'feel free to ask',
    what: 'chat pleasantry',
  },
  { pattern: /\bhappy to help\b/i, sample: 'happy to help', what: 'chat pleasantry' },
  { pattern: /\banything else I can\b/i, sample: 'anything else I can', what: 'chat pleasantry' },
  {
    pattern: /\bas an AI language model\b/i,
    sample: 'as an AI language model',
    what: 'chat pleasantry',
  },

  // Sycophancy (§22)
  //
  // Anchored to the start of a *sentence*, not the start of the string. The
  // first draft used `^`, which meant "Great question!" was only ever caught
  // when it was the very first thing in the document — and it never is.
  // The lookbehind excludes "a great question", where the phrase is content.
  {
    pattern: /(?<=^|[.!?]\s{0,3}|\n\s{0,3})(?:great|excellent|good) question\b/i,
    sample: 'great question',
    what: 'sycophancy',
  },
  {
    pattern: /\byou'?re absolutely right\b/i,
    sample: "you're absolutely right",
    what: 'sycophancy',
  },
  {
    pattern: /\bthat'?s an? (?:great|excellent) point\b/i,
    sample: "that's an great point",
    what: 'sycophancy',
  },
  {
    pattern: /(?<=^|[.!?]\s{0,3}|\n\s{0,3})(?:certainly|of course|absolutely)[!.]/i,
    sample: 'certainly!',
    what: 'sycophancy',
  },

  // Signposting (§28)
  {
    pattern: /\blet(?:'?s| us) (?:dive|delve) in(?:to)?\b/i,
    sample: "let's dive into",
    what: 'signposting',
  },
  {
    pattern: /\blet(?:'?s| us) (?:explore|break this down|take a look|get started)\b/i,
    sample: "let's explore",
    what: 'signposting',
  },
  {
    pattern: /\blet(?:'?s| us) take a closer look\b/i,
    sample: "let's take a closer look",
    what: 'signposting',
  },
  {
    pattern: /\bhere'?s what you need to know\b/i,
    sample: "here's what you need to know",
    what: 'signposting',
  },
  { pattern: /\bwithout further ado\b/i, sample: 'without further ado', what: 'signposting' },
  {
    pattern: /\bin this (?:article|section|post),? (?:we|I|you)'?(?:ll| will| are)\b/i,
    sample: "in this article, we'll",
    what: 'signposting',
  },
  { pattern: /\bbuckle up\b/i, sample: 'buckle up', what: 'signposting' },

  // Knowledge-cutoff disclaimers and speculative gap-filling (§21)
  {
    pattern: /\bas of my (?:last )?(?:training|knowledge) (?:update|cutoff)\b/i,
    sample: 'as of my last training update',
    what: 'cutoff disclaimer',
  },
  {
    pattern: /\bup to my last training update\b/i,
    sample: 'up to my last training update',
    what: 'cutoff disclaimer',
  },
  {
    pattern: /\bwhile specific details (?:are|remain) (?:limited|scarce)\b/i,
    sample: 'while specific details are limited',
    what: 'gap-filling',
  },
  {
    pattern: /\bmaintains a low profile\b/i,
    sample: 'maintains a low profile',
    what: 'gap-filling',
  },
  {
    pattern: /\bprefers to stay out of the spotlight\b/i,
    sample: 'prefers to stay out of the spotlight',
    what: 'gap-filling',
  },
  {
    pattern: /\bkeeps personal details private\b/i,
    sample: 'keeps personal details private',
    what: 'gap-filling',
  },
  {
    pattern: /\bbased on (?:the )?available information\b/i,
    sample: 'based on the available information',
    what: 'gap-filling',
  },
  {
    pattern: /\bis not publicly available\b/i,
    sample: 'is not publicly available',
    what: 'gap-filling',
  },

  // Generic positive conclusions (§25)
  {
    pattern: /\bthe future looks bright\b/i,
    sample: 'the future looks bright',
    what: 'generic conclusion',
  },
  {
    pattern: /\bexciting times (?:lie ahead|are ahead)\b/i,
    sample: 'exciting times lie ahead',
    what: 'generic conclusion',
  },
  {
    pattern: /\ba step in the right direction\b/i,
    sample: 'a step in the right direction',
    what: 'generic conclusion',
  },
  {
    pattern: /\bthe possibilities are endless\b/i,
    sample: 'the possibilities are endless',
    what: 'generic conclusion',
  },
  {
    pattern: /\bonly time will tell\b/i,
    sample: 'only time will tell',
    what: 'generic conclusion',
  },
  { pattern: /\bwatch this space\b/i, sample: 'watch this space', what: 'generic conclusion' },
  {
    pattern: /\bthe journey (?:is just beginning|continues)\b/i,
    sample: 'the journey is just beginning',
    what: 'generic conclusion',
  },

  // Transcript furniture — text copied straight out of a chat window (§20).
  {
    pattern: /^\s*(?:You said|ChatGPT said|Assistant said):/im,
    sample: 'You said:',
    what: 'transcript furniture',
  },
  {
    pattern: /^\s*Thought for \d+\s*(?:seconds?|minutes?)\b/im,
    sample: 'Thought for 8 seconds',
    what: 'transcript furniture',
  },
]

/** Emoji used as decoration at the start of a heading or a bullet (§18). */
const DECORATIVE_EMOJI = /(^|\n)(\s*(?:[-*+]|#{1,6}|\d+\.)\s*)(?:\p{Extended_Pictographic}️?\s*)+/gu

/**
 * A bullet whose whole content is a bolded label and a colon (§15, §16).
 *
 * Wikipedia's fix is to rewrite the list into prose, which needs a writer. The
 * part with one right answer is narrower and is all this does: drop the
 * mechanical emphasis and keep the label. `- **Performance:** fast` becomes
 * `- Performance: fast`.
 */
const INLINE_HEADER_BULLET = /(^|\n)(\s*(?:[-*+]|\d+[.)])\s+)\*\*([^*\n]{1,60}?)(:?)\*\*(:?)/g

/**
 * Compounds AI hyphenates everywhere, including after the noun (§26).
 *
 * An explicit list, not a cross-product of prefixes and suffixes. The
 * cross-product matched pairs that were never words and, worse, dehyphenated
 * only the first hyphen of the one compound that has two: "the pipeline is
 * end-to-end" came out as "end to-end", which is not a shorter form of anything.
 * A pass whose contract is "only patterns with one unambiguous answer" cannot
 * ship a rule that invents a third.
 */
const PREDICATE_COMPOUNDS = new RegExp(
  String.raw`\b(is|are|was|were|be|been|being|seems?|looks?|feels?|remains?)\s+((?:very|quite|fairly|highly)\s+)?(` +
    [
      'third-party',
      'cross-functional',
      'client-facing',
      'data-driven',
      'well-known',
      'high-quality',
      'real-time',
      'long-term',
      'end-to-end',
    ].join('|') +
    String.raw`)\b`,
  'gi',
)

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

/** One edit, in the coordinates of the document the caller handed us. */
interface Edit {
  start: number
  end: number
  to: string
  what: string
  /** Sentence deletions are reported individually; phrase edits are counted. */
  sentence?: string
}

const overlaps = (edits: readonly Edit[], start: number, end: number): boolean =>
  edits.some((edit) => start < edit.end && end > edit.start)

/**
 * Fix the seam a deletion leaves behind, and nothing else.
 *
 * The previous version ran `[^\S\n]{2,} -> ' '` over the whole document, which
 * collapsed every Markdown indent in the file — nested lists and indented code
 * flattened by a pass that was supposed to be tidying up after itself. The
 * damage was invisible in the diff of a prose paragraph and total in a
 * technical document. This only ever looks at the join.
 */
function tidySeam(text: string, at: number): { text: string; shift: number } {
  let output = text
  let index = at
  let shift = 0

  // Two horizontal spaces where a phrase used to be.
  while (
    index > 0 &&
    index < output.length &&
    /[^\S\n]/.test(output[index - 1] as string) &&
    /[^\S\n]/.test(output[index] as string)
  ) {
    output = output.slice(0, index) + output.slice(index + 1)
    shift -= 1
  }

  // A space left stranded before the punctuation that followed the deletion.
  if (
    index > 0 &&
    index < output.length &&
    /[^\S\n]/.test(output[index - 1] as string) &&
    /[,.;:!?]/.test(output[index] as string)
  ) {
    output = output.slice(0, index - 1) + output.slice(index)
    index -= 1
    shift -= 1
  }

  // A deletion that took the head of a sentence leaves the next word in lower
  // case. "Fundamentally, the design is sound." came out as "the design is
  // sound." — grammatically wrong in a pass whose whole claim is that it only
  // makes changes with one right answer.
  let before = index - 1
  while (before >= 0 && /[^\S\n]/.test(output[before] as string)) before -= 1
  const opensSentence = before < 0 || /[.!?\n]/.test(output[before] as string)
  if (opensSentence && index < output.length && /[a-z]/.test(output[index] as string)) {
    output =
      output.slice(0, index) + (output[index] as string).toUpperCase() + output.slice(index + 1)
  }

  // A whole paragraph removed leaves a stack of blank lines, which reads as a
  // formatting mistake rather than as a deletion.
  let runStart = index
  while (runStart > 0 && /[\n\r\t ]/.test(output[runStart - 1] as string)) runStart -= 1
  let runEnd = index
  while (runEnd < output.length && /[\n\r\t ]/.test(output[runEnd] as string)) runEnd += 1
  const run = output.slice(runStart, runEnd)
  if ((run.match(/\n/g)?.length ?? 0) >= 3) {
    output = output.slice(0, runStart) + '\n\n' + output.slice(runEnd)
    shift += 2 - (runEnd - runStart)
  }

  return { text: output, shift }
}

export function humanise(text: string): HumaniseResult {
  if (text.length === 0) return { output: text, findings: [] }

  const mask = protectedMask(text)
  const edits: Edit[] = []

  // Whole sentences first, so a phrase rule does not spend an edit inside a
  // sentence that is about to disappear.
  //
  // Collected as spans and merged before becoming edits. Two chat sentences in
  // a row share the whitespace between them, so treating the second as
  // "overlapping, therefore skip" would delete one and leave the other —
  // which is what happened to "I hope this helps! Let me know if you need more."
  const deletions: { start: number; end: number; what: Set<string> }[] = []
  for (const rule of SENTENCES) {
    const scan = new RegExp(rule.pattern.source, `${rule.pattern.flags.replace(/[gy]/g, '')}g`)
    for (const match of text.matchAll(scan)) {
      if (match.index === undefined) continue
      if (isSealed(mask, match.index, match.index + match[0].length)) continue
      const { start, end } = sentenceBounds(text, match.index)
      deletions.push({ start, end, what: new Set([rule.what]) })
    }
  }

  deletions.sort((a, b) => a.start - b.start)
  const merged: typeof deletions = []
  for (const span of deletions) {
    const last = merged.at(-1)
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end)
      for (const what of span.what) last.what.add(what)
    } else {
      merged.push(span)
    }
  }

  for (const span of merged) {
    edits.push({
      start: span.start,
      end: span.end,
      to: '',
      what: [...span.what].join(' and '),
      sentence: text.slice(span.start, span.end).trim(),
    })
  }

  for (const rule of PHRASES) {
    for (const match of text.matchAll(rule.pattern)) {
      const start = match.index
      if (start === undefined) continue
      const end = start + match[0].length
      if (isSealed(mask, start, end)) continue
      if (overlaps(edits, start, end)) continue
      if (rule.unless?.test(text.slice(Math.max(0, start - GUARD_WINDOW), start))) continue

      const replacement = rule.to ?? ''
      const to = replacement.includes('$1')
        ? replacement.replace('$1', match[1] ?? '')
        : matchCase(match[0], replacement)
      edits.push({ start, end, to, what: rule.what })
    }
  }

  for (const match of text.matchAll(DECORATIVE_EMOJI)) {
    const start = match.index
    if (start === undefined) continue
    const end = start + match[0].length
    if (isSealed(mask, start, end) || overlaps(edits, start, end)) continue
    edits.push({ start, end, to: `${match[1] ?? ''}${match[2] ?? ''}`, what: 'decorative emoji' })
  }

  for (const match of text.matchAll(INLINE_HEADER_BULLET)) {
    const start = match.index
    if (start === undefined) continue
    const end = start + match[0].length
    if (isSealed(mask, start, end) || overlaps(edits, start, end)) continue
    // The colon is what makes this a header rather than a bullet that merely
    // begins in bold, and it can sit on either side of the closing asterisks.
    // Without it, `- the **fast** path` would lose emphasis it earned.
    const colon = (match[4] ?? '') || (match[5] ?? '')
    if (!colon) continue
    edits.push({
      start,
      end,
      to: `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}:`,
      what: 'mechanical boldface',
    })
  }

  for (const match of text.matchAll(PREDICATE_COMPOUNDS)) {
    const start = match.index
    if (start === undefined) continue
    const end = start + match[0].length
    if (isSealed(mask, start, end) || overlaps(edits, start, end)) continue
    edits.push({
      start,
      end,
      // Every hyphen in the compound goes, not just the first: "end-to-end"
      // becomes "end to end" rather than "end to-end".
      to: `${match[1] ?? ''} ${match[2] ?? ''}${(match[3] ?? '').replaceAll('-', ' ')}`,
      what: 'predicate hyphen',
    })
  }

  for (const edit of titleCaseEdits(text, mask)) {
    if (!overlaps(edits, edit.start, edit.end)) edits.push(edit)
  }

  if (edits.length === 0) return { output: text, findings: [] }
  edits.sort((a, b) => a.start - b.start)

  // Apply left to right, tracking where each join lands in the output so the
  // seam tidy can be local instead of global.
  const findings: Finding[] = []
  const counts = new Map<string, number>()
  let output = ''
  let read = 0
  const seams: number[] = []

  for (const edit of edits) {
    output += text.slice(read, edit.start) + edit.to
    read = edit.end
    if (edit.to.length === 0) seams.push(output.length)

    if (edit.sentence !== undefined) {
      findings.push({
        kind: 'ai_phrase',
        verdict: 'probable',
        offset: edit.start,
        length: edit.end - edit.start,
        label: `A sentence of ${edit.what}`,
        evidence: edit.sentence,
      })
    } else {
      counts.set(edit.what, (counts.get(edit.what) ?? 0) + 1)
    }
  }
  output += text.slice(read)

  for (let index = seams.length - 1; index >= 0; index -= 1) {
    const tidied = tidySeam(output, seams[index] as number)
    output = tidied.text
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

  return { output, findings }
}

const TITLE_CASE_SMALL = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'nor',
  'of',
  'on',
  'or',
  'over',
  'per',
  'the',
  'to',
  'up',
  'via',
  'with',
  'without',
])

/**
 * Headings written in Title Case, lowered to sentence case (§17).
 *
 * The risk is proper nouns, so the document answers for itself: a word that
 * appears capitalised somewhere other than the start of a sentence is treated
 * as a name and left alone. "Strategic Negotiations And Global Partnerships"
 * loses its capitals; "Negotiations With Microsoft" keeps Microsoft's.
 */
function titleCaseEdits(text: string, mask: Uint8Array): Edit[] {
  const proper = properNouns(text)
  const edits: Edit[] = []

  for (const block of blocksOf(text)) {
    if (block.kind !== 'heading') continue
    const heading = text.slice(block.start, block.end)
    const body = /^(\s*#{1,6}\s+)(.*)$/.exec(heading)
    if (!body) continue

    const prefix = body[1] ?? ''
    const words = (body[2] ?? '').split(/(\s+)/)
    const lexical = words.filter((word) => /\w/.test(word))
    if (lexical.length < 3) continue

    const capitalised = lexical.filter((word) => /^[A-Z]/.test(word)).length
    if (capitalised / lexical.length < 0.8) continue

    let seen = 0
    const rebuilt = words
      .map((word) => {
        if (!/\w/.test(word)) return word
        seen += 1
        if (seen === 1) return word
        const bare = word.replace(/[^\p{L}\p{N}'-]/gu, '')
        // An acronym, a name the document uses elsewhere, or a word with an
        // internal capital (iPhone, GitHub) keeps whatever case it has.
        if (bare.length < 2) return word
        if (bare === bare.toUpperCase()) return word
        if (/[A-Z]/.test(bare.slice(1))) return word
        if (proper.has(bare) && !TITLE_CASE_SMALL.has(bare.toLowerCase())) return word
        return word[0]!.toLowerCase() + word.slice(1)
      })
      .join('')

    const to = prefix + rebuilt
    if (to === heading) continue
    if (isSealed(mask, block.start, block.end)) continue
    edits.push({ start: block.start, end: block.end, to, what: 'title-case heading' })
  }

  return edits
}

/**
 * Words the document capitalises mid-sentence, which makes them names.
 *
 * Read from the body only. A Title Case heading capitalises every word by
 * definition, so letting headings vote would make each of them evidence for its
 * own capitals and the rule would never fire on anything.
 */
function properNouns(text: string): Set<string> {
  const names = new Set<string>()
  for (const block of blocksOf(text)) {
    if (block.kind === 'heading' || block.kind === 'fence') continue
    const body = text.slice(block.start, block.end)
    for (const match of body.matchAll(/(\S)\s+([A-Z][\p{L}'-]+)/gu)) {
      if (/[.!?:;]/.test(match[1] ?? '')) continue
      const word = match[2]
      if (word) names.add(word)
    }
  }
  return names
}
