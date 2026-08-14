// Tells, not proof.
//
// A statistical text watermark lives in word choice, and nothing deterministic
// can remove it — that is Layer B's problem and it needs a model. What *is*
// deterministic is measuring the habits that generated prose tends to have:
// dash density, triples, negative parallelism, marker vocabulary, and sentence
// lengths that cluster around the mean instead of swinging.
//
// Every one of these is something a human writer legitimately does. So this
// module reports and never rewrites, and its findings can never be `confirmed`
// — the strongest thing it may say is that several tells co-occur. A detector
// that announces "written by AI" on the strength of an em-dash count is
// guessing, and people have been failed by exactly that guess.

import type { Finding, Verdict } from '../report.ts'

export interface StyleMetric {
  id: string
  label: string
  /** The measurement, in the unit named by `detail`. */
  value: number
  threshold: number
  triggered: boolean
  detail: string
}

export interface StyleReport {
  words: number
  sentences: number
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

// "not just X, but Y" and its family. The construction is not rare in human
// writing; the density of it is what the metric measures.
const NEGATIVE_PARALLELISM =
  /\bnot (?:just|only|merely|simply|about)\b[^.!?;]{1,80}?\b(?:but|it(?:'|’)s)\b/giu

// "A, B, and C" — the cadence, counted per sentence rather than per document so
// a long essay is not penalised for containing lists.
const RULE_OF_THREE = /\b[\p{L}]+,\s+[\p{L}]+,\s+(?:and|or)\s+[\p{L}]+/giu

const EM_DASH = /[—–]/gu

const countMatches = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].length

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])[\s ]+/u)
    .map((s) => s.trim())
    .filter((s) => WORD.test(s) && ((WORD.lastIndex = 0), true))
}

const wordsIn = (text: string) => [...text.matchAll(WORD)].length

/** Coefficient of variation — the spread of sentence lengths, scale-free. */
function burstiness(sentences: string[]): number {
  const lengths = sentences.map(wordsIn).filter((n) => n > 0)
  if (lengths.length < 5) return Number.NaN

  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length
  if (mean === 0) return Number.NaN
  const variance = lengths.reduce((sum, n) => sum + (n - mean) ** 2, 0) / lengths.length
  return Math.sqrt(variance) / mean
}

function markerHits(lower: string): number {
  let hits = 0
  for (const marker of MARKERS) {
    const escaped = marker.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
    // \b does not fire next to an apostrophe, so phrases starting with one are
    // matched on a looser boundary.
    const pattern = /^[\p{L}]/u.test(marker)
      ? new RegExp(String.raw`\b${escaped}\b`, 'giu')
      : new RegExp(escaped, 'giu')
    hits += countMatches(lower, pattern)
  }
  return hits
}

export function analyzeStyle(text: string): StyleReport {
  const lower = text.toLowerCase()
  const sentences = sentencesOf(text)
  const words = wordsIn(text)
  const perThousand = (n: number) => (words === 0 ? 0 : (n / words) * 1000)
  const perHundredSentences = (n: number) =>
    sentences.length === 0 ? 0 : (n / sentences.length) * 100

  const measurable = words >= MIN_WORDS
  const spread = sentences.length >= MIN_SENTENCES ? burstiness(sentences) : Number.NaN

  const metrics: StyleMetric[] = [
    {
      id: 'em_dash',
      label: 'Em-dash density',
      value: perThousand(countMatches(text, EM_DASH)),
      threshold: 12,
      triggered: false,
      detail: 'em dashes per 1000 words',
    },
    {
      id: 'rule_of_three',
      label: 'Rule of three',
      value: perHundredSentences(countMatches(text, RULE_OF_THREE)),
      threshold: 40,
      triggered: false,
      detail: '"A, B, and C" lists per 100 sentences',
    },
    {
      id: 'negative_parallelism',
      label: 'Negative parallelism',
      value: perHundredSentences(countMatches(text, NEGATIVE_PARALLELISM)),
      threshold: 25,
      triggered: false,
      detail: '"not just X, but Y" per 100 sentences',
    },
    {
      id: 'marker_vocabulary',
      label: 'Marker vocabulary',
      value: perThousand(markerHits(lower)),
      threshold: 25,
      triggered: false,
      detail: 'flagged words and phrases per 1000 words',
    },
    {
      id: 'burstiness',
      label: 'Sentence-length variance',
      value: spread,
      threshold: 0.35,
      triggered: false,
      detail: 'coefficient of variation — humans swing, models converge',
    },
  ]

  for (const metric of metrics) {
    if (!measurable || Number.isNaN(metric.value)) continue
    // Every metric fires when it goes *above* its threshold, except variance,
    // where the tell is uniformity: too little spread, not too much.
    metric.triggered =
      metric.id === 'burstiness' ? metric.value < metric.threshold : metric.value > metric.threshold
  }

  return { words, sentences: sentences.length, measurable, metrics }
}

const round = (value: number) => Math.round(value * 100) / 100

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
  const verdict: Verdict = hits.length >= 3 ? 'probable' : 'informational'

  return hits.map((metric) => ({
    kind: 'stylometry' as const,
    verdict,
    offset: 0,
    length: text.length,
    label: `${metric.label}: ${round(metric.value)} (${metric.detail})`,
    evidence:
      hits.length >= 3
        ? `${hits.length} style tells co-occur — a pattern, not proof`
        : 'a single style tell — humans do this too',
  }))
}
