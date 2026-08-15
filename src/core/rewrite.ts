// The brief a rewrite is given, and the gate it has to clear afterwards.
//
// Everything else in this project is deterministic, which puts a hard ceiling
// on it: a statistical text watermark and the silhouette-layer tells both live
// in word choice and in the arrangement of ideas, and no regex reaches either.
// Crossing that ceiling needs a model.
//
// The dangerous version of "use a model" is to hand it the document, ask for
// something more human, and ship whatever comes back. That trades one machine's
// prose for another's, quietly drops a number, and reports success. So the
// model is bracketed by two deterministic halves, and this file is both of them:
//
//   buildBrief    what is wrong, where, why, and what must survive untouched
//   verifyRewrite did the result actually clear the gates, or only sound better
//
// `verifyRewrite` is the half that makes the loop worth building. It re-runs
// every detector on the rewrite and REJECTS it when a flagged pattern comes
// back, when a fact has moved, or when a protected region was edited. A
// rejection names what failed, so the next attempt is aimed rather than another
// roll of the dice.
//
// Nothing here opens a socket. Calling a model is the CLI's job (src/cli), and
// keeping that boundary is what lets the page keep saying `connect-src 'self'`
// and mean it.

import { humanise } from './text/humanise.ts'
import {
  analyzeStyle,
  LOWER_IS_THE_TELL,
  type StyleLayer,
  type StyleMetric,
} from './text/stylometry.ts'
import { blocksOf } from './text/regions.ts'

export interface BriefTell {
  id: string
  label: string
  layer: StyleLayer
  value: number
  threshold: number
  /** What a writer would actually have to change. */
  fix: string
}

export interface ProtectedSpan {
  start: number
  end: number
  text: string
  why: string
}

/**
 * The things a rewrite is not allowed to invent, lose or alter.
 *
 * Extracted from the original so the check afterwards is against the document
 * rather than against a promise. A rewrite that reads beautifully and has
 * dropped a figure is a worse outcome than no rewrite at all.
 */
export interface Facts {
  numbers: string[]
  dates: string[]
  names: string[]
  urls: string[]
  quotes: string[]
}

export interface Brief {
  words: number
  sentences: number
  paragraphs: number
  measurable: boolean
  tells: BriefTell[]
  /**
   * Every metric's value on the source, triggered or not.
   *
   * What lets the gate ask "is the rewrite worse than what it replaced" rather
   * than "did any metric fire". The second question is unanswerable in the
   * rewrite's favour: paragraph-length variance and sentence-length variance
   * fire on ordinary human writing, so a gate built on them rejects the correct
   * answer — and with `--model` it burns paid attempts doing it.
   */
  baseline: Record<string, number>
  facts: Facts
  protected: ProtectedSpan[]
  constraints: string[]
}

/** What a writer has to do about each metric — none of it is a substitution. */
const FIX: Record<string, string> = {
  marker_vocabulary: 'replace the flagged words with plain ones; there is no single substitute',
  business_jargon: 'say the concrete thing the jargon is standing in for',
  vague_attribution: 'name the source, or cut the claim',
  em_dash: 'recast the sentences; a period, a comma or a colon each fit different cases',
  em_dash_paragraph: 'no paragraph should need more than one dash',
  rule_of_three: 'break the triples; two items, or four, or a sentence',
  negative_parallelism: 'state the positive claim directly',
  burstiness: 'vary sentence length; write a short one, then a long one',
  paragraph_variance: 'let paragraphs be the length their content needs',
  signpost_density: 'take the turn instead of announcing it',
  staccato: 'join the fragments into real clauses',
  false_range: 'name the items instead of framing them as a range',
  copula_avoidance: 'use is and are',
  aphorism: 'state the ordinary claim the proverb is dressed up as',
  recap_loop: 'end on the last concrete point; delete the closing summary',
  paragraph_template: 'stop repeating claim, example, hedge in every paragraph',
  generic_outline: 'name each section after its subject',
}

const NUMBER = /\b\d+(?:[.,]\d+)*\s*%?/g
const DATE =
  /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s*\d{0,4}|\b(?:19|20)\d{2}\b)/gi
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'\])}]+/gi
const QUOTED = /"[^"\n]{4,300}"|“[^”\n]{4,300}”/g

/**
 * Words the document capitalises mid-sentence, which makes them names.
 *
 * Two exclusions, both of which cost real names and both of which are worth it.
 *
 * A name that only ever opens a sentence is missed. Without a lexicon, "Ada
 * signed it" and "Costs fell" are the same shape, so the choice is between
 * missing some names and demanding that a rewrite keep the first word of every
 * sentence — and the second makes the gate impossible to pass.
 *
 * Headings are skipped entirely. A Title Case heading capitalises every word by
 * definition, so reading names out of one turns "Strategic Negotiations And
 * Global Partnerships" into four names the rewrite must preserve — which would
 * reject the sentence-case fix that is the correct thing to do to that heading.
 */
function namesIn(text: string): string[] {
  const names = new Set<string>()
  for (const block of blocksOf(text)) {
    if (block.kind === 'fence' || block.kind === 'indented_code' || block.kind === 'heading') {
      continue
    }
    const body = text.slice(block.start, block.end)
    for (const match of body.matchAll(/(\S)\s+([A-Z][\p{L}'-]{2,})/gu)) {
      if (/[.!?:;]/.test(match[1] ?? '')) continue
      const word = match[2]
      if (word) names.add(word)
    }
  }

  // A month already counted as a date is not also a name. Reporting it twice
  // makes the rewrite satisfy the same constraint in two places for no gain.
  for (const date of collect(text, DATE)) {
    for (const word of date.split(/\s+/)) names.delete(word)
  }

  return [...names].sort()
}

const collect = (text: string, pattern: RegExp): string[] =>
  [...text.matchAll(pattern)].map((match) => match[0].trim())

export function extractFacts(text: string): Facts {
  return {
    numbers: collect(text, NUMBER).map((n) => n.replaceAll(/\s+/g, '')),
    dates: collect(text, DATE),
    names: namesIn(text),
    // A link at the end of a sentence swallows the full stop, and a rewrite
    // that moves the link to the middle of a sentence would then be reported as
    // having lost it.
    urls: collect(text, URL_IN_TEXT).map((url) => url.replace(/[.,;:!?)\]]+$/, '')),
    quotes: collect(text, QUOTED),
  }
}

/** Regions a rewrite must reproduce byte for byte. */
export function protectedSpans(text: string): ProtectedSpan[] {
  const spans: ProtectedSpan[] = []
  for (const block of blocksOf(text)) {
    const why =
      block.kind === 'fence' || block.kind === 'indented_code'
        ? 'code'
        : block.kind === 'frontmatter'
          ? 'frontmatter'
          : block.kind === 'blockquote'
            ? 'someone else being quoted'
            : ''
    if (!why) continue
    spans.push({
      start: block.start,
      end: block.end,
      text: text.slice(block.start, block.end),
      why,
    })
  }
  return spans
}

const CONSTRAINTS = [
  'Keep every fact, number, date, name, quotation and citation from the source. Add none.',
  'Reproduce every protected span exactly, including its whitespace.',
  'Do not introduce any of the patterns listed as tells. That includes the ones the source did not have.',
  'Match the register of the source. A technical document stays technical; do not add personality it does not have.',
  'Return only the rewritten document. No preamble, no explanation, no code fence around it.',
]

/** Everything a rewrite needs to know, and everything it will be checked against. */
export function buildBrief(text: string): Brief {
  const style = analyzeStyle(text)
  const tells: BriefTell[] = style.metrics
    .filter((metric: StyleMetric) => metric.triggered)
    .map((metric) => ({
      id: metric.id,
      label: metric.label,
      layer: metric.layer,
      value: Math.round(metric.value * 100) / 100,
      threshold: metric.threshold,
      fix: FIX[metric.id] ?? 'rewrite the affected sentences',
    }))

  // Rounded to match what `remaining` reports. Comparing a rounded value
  // against a raw one made a metric read as worse than itself: 0.29 < 0.2934.
  const baseline: Record<string, number> = {}
  for (const metric of style.metrics) baseline[metric.id] = round(metric.value)

  return {
    words: style.words,
    sentences: style.sentences,
    paragraphs: style.paragraphs,
    measurable: style.measurable,
    tells,
    baseline,
    facts: extractFacts(text),
    protected: protectedSpans(text),
    constraints: CONSTRAINTS,
  }
}

const round = (value: number) => Math.round(value * 100) / 100

export type FailureKind = 'pattern' | 'fact' | 'protected' | 'empty'

export interface Failure {
  kind: FailureKind
  what: string
  detail: string
}

export interface RewriteVerdict {
  ok: boolean
  failures: Failure[]
  /** Tells still firing on the rewrite, whether or not they were in the brief. */
  remaining: BriefTell[]
}

/** A multiset difference: what the original has that the rewrite does not. */
function missing(before: readonly string[], after: readonly string[]): string[] {
  const pool = new Map<string, number>()
  for (const item of after) pool.set(item, (pool.get(item) ?? 0) + 1)

  const lost: string[] = []
  for (const item of before) {
    const left = pool.get(item) ?? 0
    if (left === 0) lost.push(item)
    else pool.set(item, left - 1)
  }
  return lost
}

/**
 * Did the rewrite actually clear the gates, or does it only read better?
 *
 * Three ways to fail, and all three are things a fluent rewrite does by
 * accident. The verdict is not advisory: a caller loops on it.
 */
export function verifyRewrite(_original: string, rewrite: string, brief: Brief): RewriteVerdict {
  const failures: Failure[] = []

  if (rewrite.trim().length === 0) {
    return {
      ok: false,
      failures: [{ kind: 'empty', what: 'the rewrite', detail: 'nothing came back' }],
      remaining: [],
    }
  }

  // 1. Patterns. Both the ones the brief named and any the rewrite introduced —
  //    unslop's rule that voice never exempts content from the contract.
  const style = analyzeStyle(rewrite)
  const remaining: BriefTell[] = style.metrics
    .filter((metric) => metric.triggered)
    .map((metric) => ({
      id: metric.id,
      label: metric.label,
      layer: metric.layer,
      value: Math.round(metric.value * 100) / 100,
      threshold: metric.threshold,
      fix: FIX[metric.id] ?? 'rewrite the affected sentences',
    }))

  // Which of those are worth rejecting over, and which are only worth saying.
  //
  // The first version rejected on every metric that fired, and that made the
  // gate unusable: an ordinary five-paragraph human anecdote fails it against
  // itself, because paragraph-length variance and sentence-length variance both
  // trip on plain expository writing. A gate that fails the correct answer is
  // worse than no gate — and behind `--model` it spends money doing it.
  //
  // So two things are rejected, and neither is ambiguous:
  //
  //   a phrase-layer tell — flagged vocabulary and jargon, where there is no
  //   reading under which the rewrite is fine;
  //
  //   any metric that came out WORSE than the source. The rewrite does not have
  //   to be beyond reproach; it has to be an improvement, and it must not
  //   smuggle in a habit the original did not have.
  //
  // Everything else is reported through `remaining` and left to the reader.
  for (const tell of remaining) {
    const before = brief.baseline[tell.id]
    const worse =
      before === undefined ||
      Number.isNaN(before) ||
      (LOWER_IS_THE_TELL.has(tell.id) ? tell.value < before : tell.value > before)

    if (tell.layer !== 'phrase' && !worse) continue

    failures.push({
      kind: 'pattern',
      what: tell.label,
      detail:
        before === undefined || Number.isNaN(before)
          ? `introduced by the rewrite: ${tell.value} against ${tell.threshold} — ${tell.fix}`
          : worse
            ? `worse than the source: ${tell.value} against ${round(before)} — ${tell.fix}`
            : `still ${tell.value} against a threshold of ${tell.threshold} — ${tell.fix}`,
    })
  }

  // Boilerplate is checked with the pass that removes it: if `humanise` finds
  // anything to do, the rewrite put it there.
  for (const finding of humanise(rewrite).findings) {
    failures.push({
      kind: 'pattern',
      what: finding.label,
      detail: finding.evidence ?? 'generated-prose boilerplate in the rewrite',
    })
  }

  // 2. Facts. A rewrite that loses a figure is worse than no rewrite.
  const after = extractFacts(rewrite)
  const checks: [keyof Facts, string][] = [
    ['numbers', 'number'],
    ['dates', 'date'],
    ['urls', 'link'],
    ['quotes', 'quotation'],
    ['names', 'name'],
  ]
  for (const [key, noun] of checks) {
    for (const lost of missing(brief.facts[key], after[key])) {
      failures.push({
        kind: 'fact',
        what: `${noun} ${lost}`,
        detail: 'present in the source, missing from the rewrite',
      })
    }
  }

  // 3. Protected spans, reproduced byte for byte.
  for (const span of brief.protected) {
    if (!rewrite.includes(span.text)) {
      failures.push({
        kind: 'protected',
        what: `a ${span.why} block at offset ${span.start}`,
        detail: 'changed or missing; protected spans are copied, never rewritten',
      })
    }
  }

  return { ok: failures.length === 0, failures, remaining }
}

/**
 * The brief as a prompt.
 *
 * Lives here rather than in the CLI so the Claude skill, the local model and
 * `--print-prompt` are all given the same instructions. Three ways to ask one
 * question is three ways for the answers to disagree.
 */
export function briefToPrompt(text: string, brief: Brief): string {
  const tells =
    brief.tells.length > 0
      ? brief.tells
          .map(
            (tell) =>
              `- [${tell.layer}] ${tell.label} (${tell.value} vs ${tell.threshold}): ${tell.fix}`,
          )
          .join('\n')
      : '- none measured; rewrite for plainness without introducing any'

  const protectedList =
    brief.protected.length > 0
      ? brief.protected
          .map((span, index) => `${index + 1}. (${span.why})\n${span.text}`)
          .join('\n\n')
      : 'none'

  const facts = [
    brief.facts.numbers.length > 0 ? `numbers: ${brief.facts.numbers.join(', ')}` : '',
    brief.facts.dates.length > 0 ? `dates: ${brief.facts.dates.join(', ')}` : '',
    brief.facts.names.length > 0 ? `names: ${brief.facts.names.join(', ')}` : '',
    brief.facts.urls.length > 0 ? `links: ${brief.facts.urls.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return `Rewrite the document below so it stops reading as generated prose.

WHAT IS WRONG WITH IT
${tells}

RULES
${brief.constraints.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}

MUST SURVIVE UNCHANGED
${facts || 'nothing extracted'}

PROTECTED SPANS — reproduce each exactly
${protectedList}

DOCUMENT
${text}`
}
