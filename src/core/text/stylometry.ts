// Tells, not proof.
//
// A statistical text watermark lives in word choice, and nothing deterministic
// can remove it — that is Layer B's problem and it needs a model. What *is*
// deterministic is measuring the habits that generated prose tends to have.
//
// Every one of these is something a human writer legitimately does. So this
// module reports and never rewrites, and its findings can never be `confirmed`
// — the strongest thing it may say is that several tells co-occur. A detector
// that announces "written by AI" on the strength of an em-dash count is
// guessing, and people have been failed by exactly that guess.
//
// Three layers, following theclaymethod/unslop, because *which kind* of tell
// fired is more useful than a single number:
//
//   Phrase      literal vocabulary. The cheapest to detect and the cheapest to
//               evade — a find-and-replace defeats it.
//   Structure   rhythm and shape: dashes per paragraph, sentence-length spread,
//               signpost density, staccato runs.
//   Silhouette  the arrangement of ideas: a closing paragraph that recaps the
//               ones above it, headings that follow a generic outline,
//               paragraphs that repeat one internal shape. This is the layer
//               that survives a word-level rewrite, which is why it is worth
//               more than another vocabulary list.
//
// Measured over prose only. A document that is half code would otherwise have
// its sentence statistics decided by its code blocks.

import type { Finding, Verdict } from '../report.ts'
import { blocksOf, paragraphsOf } from './regions.ts'

export type StyleLayer = 'phrase' | 'structure' | 'silhouette'

export interface StyleMetric {
  id: string
  label: string
  layer: StyleLayer
  /**
   * What underlying habit this measures.
   *
   * Several metrics can read the same habit from different angles — dashes per
   * thousand words and dashes in the worst paragraph are both about dashes.
   * The co-occurrence verdict counts distinct signals, not distinct metrics,
   * so measuring one habit twice cannot manufacture a pattern.
   */
  signal: string
  /** The measurement, in the unit named by `detail`. */
  value: number
  threshold: number
  triggered: boolean
  detail: string
}

export interface StyleReport {
  words: number
  sentences: number
  paragraphs: number
  /** False when the sample is too small for any of this to mean anything. */
  measurable: boolean
  metrics: StyleMetric[]
}

/**
 * Below this, a per-1000-words rate is arithmetic rather than evidence.
 *
 * One em dash in twelve words is 83 per 1000 — six times the threshold, off a
 * single character. Every rate metric here has that failure mode, so the module
 * declines to report rather than extrapolating from a sample that cannot carry
 * the claim.
 */
export const MIN_WORDS = 120

/** Variance across four sentences is not variance. */
export const MIN_SENTENCES = 8

/**
 * Below this, the shape of a document is not yet a shape.
 *
 * Three paragraphs will always look either uniform or varied depending on which
 * three they are. The silhouette layer stays silent rather than reading a
 * pattern out of a sample that cannot hold one.
 */
export const MIN_PARAGRAPHS = 5

const WORD = /[\p{L}\p{N}'’-]+/gu

// Single words and phrases that turn up far more often in generated prose than
// in the wild. Lowercased; phrases are matched with their spaces.
const MARKERS = [
  'delve',
  'delving',
  'tapestry',
  'testament to',
  'realm of',
  'underscore',
  'underscores',
  'pivotal',
  'crucial',
  'leverage',
  'leveraging',
  'robust',
  'seamless',
  'seamlessly',
  'intricate',
  'nuanced',
  'multifaceted',
  'landscape',
  'navigating',
  'foster',
  'fostering',
  'unlock',
  'elevate',
  'embark',
  'myriad',
  'plethora',
  'paradigm',
  'holistic',
  'synergy',
  'cutting-edge',
  'game-changer',
  'deep dive',
  'resonate',
  'showcase',
  'spearhead',
  'meticulous',
  'meticulously',
  'boasts',
  'vibrant',
  'bustling',
  'treasure trove',
  "in today's",
  'fast-paced',
  'ever-evolving',
  "it's worth noting",
  "it's important to note",
  'that said',
  'moreover',
  'furthermore',
]

/** unslop's business-jargon triggers: the register, rather than the vocabulary. */
const JARGON = [
  'navigate challenges',
  'leverage synergies',
  'circle back',
  'move the needle',
  'low-hanging fruit',
  'actionable insights',
  'drive value',
  'unlock potential',
  'best practices',
  'thought leadership',
  'value proposition',
  'core competency',
  'double down',
  'north star',
  'boil the ocean',
  'table stakes',
]

// "not just X, but Y" and its family. The construction is not rare in human
// writing; the density of it is what the metric measures.
const NEGATIVE_PARALLELISM =
  /\bnot (?:just|only|merely|simply|about)\b[^.!?;]{1,80}?\b(?:but|it(?:'|’)s)\b/giu

// "A, B, and C" — the cadence, counted per sentence rather than per document so
// a long essay is not penalised for containing lists.
const RULE_OF_THREE = /\b[\p{L}]+,\s+[\p{L}]+,\s+(?:and|or)\s+[\p{L}]+/giu

const EM_DASH = /[—–]/gu

/** "Experts argue", "studies show" — authority with nobody behind it. */
const VAGUE_ATTRIBUTION =
  /\b(?:experts?|observers?|analysts?|critics?|researchers?)\s+(?:argue|say|note|believe|suggest|have noted)\b|\b(?:studies|reports?|research)\s+(?:show|shows|suggest|suggests|indicate|indicates)\b|\bit is (?:widely )?believed\b|\bindustry reports?\b|\bsome critics\b/giu

/** Transitions that announce a turn instead of taking one. */
const SIGNPOST =
  /(?:^|[.!?]\s|\n)\s*(?:however|moreover|furthermore|additionally|importantly|notably|ultimately|overall|consequently|nevertheless|nonetheless|that said|in conclusion|first(?:ly)?|second(?:ly)?|third(?:ly)?|finally)\b[,\s]/giu

/** "serves as", "stands as", "boasts" — anything but "is". */
const COPULA_AVOIDANCE =
  /\b(?:serves?|stands?|functions?)\s+as\b|\brepresents?\s+an?\b|\bboasts?\b|\bfeatures?\s+an?\b|\boffers?\s+an?\b/giu

/** "from the Big Bang to the cosmic web" — a range whose ends share no scale. */
const FALSE_RANGE = /\bfrom\s+[^.!?]{3,40}?\s+to\s+[^.!?]{3,40}?(?=[,.;!?]|$)/giu

/** "X is the language of Y", "X becomes a trap" — a claim dressed as a proverb. */
const APHORISM =
  /\bis the (?:language|currency|architecture|backbone|lifeblood|engine) of\b|\bbecomes? a trap\b|\bis not a \w+ but a \w+\b/giu

/** Headings a generic outline produces regardless of subject. */
const GENERIC_HEADING =
  /^(?:introduction|overview|background|key (?:benefits|features|takeaways|points)|benefits|challenges(?: and \w+)?|use cases|best practices|future (?:outlook|prospects|directions)|conclusion|final thoughts|summary|getting started|why it matters)$/i

/**
 * Metrics where the tell is uniformity, so a smaller number is the worse one.
 *
 * Exported because a caller comparing two documents has to know which way each
 * metric points before it can say one is worse than the other.
 */
export const LOWER_IS_THE_TELL: ReadonlySet<string> = new Set(['burstiness', 'paragraph_variance'])

const countMatches = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])[\s ]+/u)
    .map((s) => s.trim())
    .filter((s) => WORD.test(s) && ((WORD.lastIndex = 0), true))
}

const wordsIn = (text: string) => [...text.matchAll(WORD)].length

/** Coefficient of variation — spread, scale-free. */
function variation(values: number[]): number {
  const usable = values.filter((n) => n > 0)
  if (usable.length < 5) return Number.NaN

  const mean = usable.reduce((a, b) => a + b, 0) / usable.length
  if (mean === 0) return Number.NaN
  const spread = usable.reduce((sum, n) => sum + (n - mean) ** 2, 0) / usable.length
  return Math.sqrt(spread) / mean
}

function phraseHits(lower: string, list: readonly string[]): number {
  let hits = 0
  for (const phrase of list) {
    const escaped = phrase.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    // \b does not fire next to an apostrophe, so phrases starting with one are
    // matched on a looser boundary.
    const pattern = /^[\p{L}]/u.test(phrase)
      ? new RegExp(String.raw`\b${escaped}\b`, 'giu')
      : new RegExp(escaped, 'giu')
    hits += countMatches(lower, pattern)
  }
  return hits
}

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'with',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'as',
  'by',
  'from',
  'we',
  'you',
  'they',
  'he',
  'she',
  'i',
  'not',
  'no',
  'so',
  'if',
  'then',
  'than',
  'there',
  'their',
  'has',
  'have',
  'had',
  'will',
  'would',
  'can',
  'could',
  'more',
  'most',
  'which',
  'what',
])

const contentWords = (text: string): Set<string> =>
  new Set(
    [...text.toLowerCase().matchAll(WORD)]
      .map((match) => match[0])
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word)),
  )

/**
 * How much of the closing paragraph is already above it.
 *
 * The recap loop: a final paragraph that restates the document rather than
 * ending it. Measured as containment rather than overlap, because a short recap
 * of a long document should still score high.
 */
function recapShare(paragraphs: readonly string[]): number {
  if (paragraphs.length < 3) return Number.NaN
  const last = paragraphs.at(-1) as string
  if (wordsIn(last) < 25) return Number.NaN

  const earlier = new Set<string>()
  for (const paragraph of paragraphs.slice(0, -1)) {
    for (const word of contentWords(paragraph)) earlier.add(word)
  }

  const closing = contentWords(last)
  if (closing.size === 0) return Number.NaN
  let shared = 0
  for (const word of closing) if (earlier.has(word)) shared += 1
  return shared / closing.size
}

/**
 * The share of paragraphs built to one internal template.
 *
 * The shape LLMs reach for is claim, then illustration, then a hedge: a first
 * sentence that asserts, a middle that opens "For example", a last that opens
 * "However". One paragraph doing this is fine. Most of them doing it is a mould.
 */
function templatedShare(paragraphs: readonly string[]): number {
  const sized = paragraphs.filter((paragraph) => sentencesOf(paragraph).length >= 3)
  if (sized.length < 3) return Number.NaN

  let templated = 0
  for (const paragraph of sized) {
    const sentences = sentencesOf(paragraph)
    const illustrates = sentences
      .slice(1, -1)
      .some((sentence) => /^(?:for (?:example|instance)|consider|take\b|imagine)/i.test(sentence))
    const hedges = /^(?:however|that said|of course|still|yet|but|although|while)\b/i.test(
      sentences.at(-1) ?? '',
    )
    if (illustrates && hedges) templated += 1
  }
  return templated / sized.length
}

/** The longest run of consecutive very short sentences. */
function staccatoRun(sentences: readonly string[]): number {
  let best = 0
  let run = 0
  for (const sentence of sentences) {
    if (wordsIn(sentence) <= 5) {
      run += 1
      best = Math.max(best, run)
    } else {
      run = 0
    }
  }
  return best
}

export function analyzeStyle(text: string): StyleReport {
  const paragraphs = paragraphsOf(text)
  const prose = paragraphs.join('\n\n')
  const lower = prose.toLowerCase()
  const sentences = sentencesOf(prose)
  const words = wordsIn(prose)

  const perThousand = (n: number) => (words === 0 ? 0 : (n / words) * 1000)
  const perHundredSentences = (n: number) =>
    sentences.length === 0 ? 0 : (n / sentences.length) * 100

  const measurable = words >= MIN_WORDS
  const enoughParagraphs = paragraphs.length >= MIN_PARAGRAPHS
  const spread = sentences.length >= MIN_SENTENCES ? variation(sentences.map(wordsIn)) : Number.NaN

  const headings = blocksOf(text).filter((block) => block.kind === 'heading')
  const headingText = headings.map((block) =>
    text
      .slice(block.start, block.end)
      .replace(/^\s*#{1,6}\s*/, '')
      .trim(),
  )

  const metrics: StyleMetric[] = [
    // ── Phrase ────────────────────────────────────────────────────────────
    {
      id: 'marker_vocabulary',
      label: 'Marker vocabulary',
      layer: 'phrase',
      signal: 'vocabulary',
      value: perThousand(phraseHits(lower, MARKERS)),
      threshold: 25,
      triggered: false,
      detail: 'flagged words and phrases per 1000 words',
    },
    {
      id: 'business_jargon',
      label: 'Business jargon',
      layer: 'phrase',
      signal: 'jargon',
      value: perThousand(phraseHits(lower, JARGON)),
      threshold: 6,
      triggered: false,
      detail: 'jargon collocations per 1000 words',
    },
    {
      id: 'vague_attribution',
      label: 'Vague attribution',
      layer: 'phrase',
      signal: 'attribution',
      value: perHundredSentences(countMatches(prose, VAGUE_ATTRIBUTION)),
      threshold: 12,
      triggered: false,
      detail: '"experts say" with nobody named, per 100 sentences',
    },

    // ── Structure ─────────────────────────────────────────────────────────
    {
      id: 'em_dash',
      label: 'Em-dash density',
      layer: 'structure',
      signal: 'em_dash',
      value: perThousand(countMatches(prose, EM_DASH)),
      threshold: 12,
      triggered: false,
      detail: 'em dashes per 1000 words',
    },
    {
      id: 'em_dash_paragraph',
      label: 'Em dashes in one paragraph',
      layer: 'structure',
      signal: 'em_dash',
      // The density above averages a stuffed paragraph away across a long
      // document. unslop counts per paragraph instead, and two in one paragraph
      // is its hard violation. Both are kept: the rate reads a long document,
      // the maximum reads a single dense one.
      value: Math.max(0, ...paragraphs.map((p) => countMatches(p, EM_DASH))),
      threshold: 2,
      triggered: false,
      detail: 'the worst single paragraph',
    },
    {
      id: 'rule_of_three',
      label: 'Rule of three',
      layer: 'structure',
      signal: 'triples',
      value: perHundredSentences(countMatches(prose, RULE_OF_THREE)),
      threshold: 40,
      triggered: false,
      detail: '"A, B, and C" lists per 100 sentences',
    },
    {
      id: 'negative_parallelism',
      label: 'Negative parallelism',
      layer: 'structure',
      signal: 'parallelism',
      value: perHundredSentences(countMatches(prose, NEGATIVE_PARALLELISM)),
      threshold: 25,
      triggered: false,
      detail: '"not just X, but Y" per 100 sentences',
    },
    {
      id: 'burstiness',
      label: 'Sentence-length variance',
      layer: 'structure',
      signal: 'burstiness',
      value: spread,
      threshold: 0.35,
      triggered: false,
      detail: 'coefficient of variation — humans swing, models converge',
    },
    {
      id: 'paragraph_variance',
      label: 'Paragraph-length variance',
      layer: 'structure',
      signal: 'paragraph_shape',
      value: enoughParagraphs ? variation(paragraphs.map(wordsIn)) : Number.NaN,
      // 0.25 was too loose: an ordinary five-paragraph human anecdote measures
      // around 0.09, so the metric fired on exactly the writing it exists to
      // exonerate. Tightened to where a deliberately templated document still
      // trips it and prose does not.
      threshold: 0.12,
      triggered: false,
      detail: 'paragraphs cut to one length',
    },
    {
      id: 'signpost_density',
      label: 'Signpost density',
      layer: 'structure',
      signal: 'signposting',
      value: perHundredSentences(countMatches(prose, SIGNPOST)),
      threshold: 20,
      triggered: false,
      detail: 'sentences opening with a transition, per 100',
    },
    {
      id: 'staccato',
      label: 'Staccato run',
      layer: 'structure',
      signal: 'staccato',
      value: staccatoRun(sentences),
      threshold: 3,
      triggered: false,
      detail: 'consecutive sentences of five words or fewer',
    },
    {
      id: 'false_range',
      label: 'False ranges',
      layer: 'structure',
      signal: 'false_range',
      value: perHundredSentences(countMatches(prose, FALSE_RANGE)),
      threshold: 25,
      triggered: false,
      detail: '"from X to Y" across no real scale, per 100 sentences',
    },
    {
      id: 'copula_avoidance',
      label: 'Copula avoidance',
      layer: 'structure',
      signal: 'copula',
      value: perHundredSentences(countMatches(prose, COPULA_AVOIDANCE)),
      threshold: 30,
      triggered: false,
      detail: 'anything but "is", per 100 sentences',
    },
    {
      id: 'aphorism',
      label: 'Aphorism formulas',
      layer: 'structure',
      signal: 'aphorism',
      value: perHundredSentences(countMatches(prose, APHORISM)),
      threshold: 8,
      triggered: false,
      detail: 'a claim dressed as a proverb, per 100 sentences',
    },

    // ── Silhouette ────────────────────────────────────────────────────────
    {
      id: 'recap_loop',
      label: 'Recap loop',
      layer: 'silhouette',
      signal: 'recap',
      value: recapShare(paragraphs),
      threshold: 0.7,
      triggered: false,
      detail: 'share of the closing paragraph already said above',
    },
    {
      id: 'paragraph_template',
      label: 'Paragraph-role template',
      layer: 'silhouette',
      signal: 'template',
      value: templatedShare(paragraphs),
      threshold: 0.6,
      triggered: false,
      detail: 'share of paragraphs built claim, example, hedge',
    },
    {
      id: 'generic_outline',
      label: 'Generic outline',
      layer: 'silhouette',
      signal: 'outline',
      value:
        headingText.length >= 3
          ? headingText.filter((heading) => GENERIC_HEADING.test(heading)).length /
            headingText.length
          : Number.NaN,
      threshold: 0.5,
      triggered: false,
      detail: 'headings that would fit any subject',
    },
  ]

  // Every metric fires when it goes *above* its threshold, except the two where
  // the tell is uniformity: too little spread, not too much.
  const BELOW = LOWER_IS_THE_TELL
  for (const metric of metrics) {
    if (!measurable || Number.isNaN(metric.value)) continue
    metric.triggered = BELOW.has(metric.id)
      ? metric.value < metric.threshold
      : metric.value > metric.threshold
  }

  return {
    words,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    measurable,
    metrics,
  }
}

const round = (value: number) => Math.round(value * 100) / 100

/** How many independent habits fired, which is not the same as how many metrics did. */
export const distinctSignals = (metrics: readonly StyleMetric[]): number =>
  new Set(metrics.filter((metric) => metric.triggered).map((metric) => metric.signal)).size

/**
 * Tells worth showing the user, as findings.
 *
 * Offsets are zero and lengths span the whole text on purpose: these describe
 * the document, not a position in it, and pointing at one em dash would imply
 * that dash is the problem.
 */
export function stylometryFindings(text: string): Finding[] {
  const report = analyzeStyle(text)
  const hits = report.metrics.filter((m) => m.triggered)
  if (hits.length === 0) return []

  // One tell is a writing habit. Several at once is a pattern — still not
  // proof, which is why this stops at `probable` and goes no further.
  //
  // Counted over distinct signals rather than metrics. Three metrics that all
  // read the same em dashes are one habit, and letting them each vote would
  // manufacture a pattern out of a single character.
  const signals = distinctSignals(hits)
  const verdict: Verdict = signals >= 3 ? 'probable' : 'informational'

  return hits.map((metric) => ({
    kind: 'stylometry' as const,
    verdict,
    offset: 0,
    length: text.length,
    label: `${metric.label}: ${round(metric.value)} (${metric.detail})`,
    evidence:
      signals >= 3
        ? `${signals} independent style tells co-occur — a pattern, not proof`
        : `${metric.layer} layer — a single style tell, and humans do this too`,
  }))
}
