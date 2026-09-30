// One score per sentence, for the passages a report points at.
//
// Adapted from ADAFAI (MIT): a weighted sum of what the sentence does, floors
// for the things that are near-certain on their own, and bands a reader can
// scan. The weights are provisional until the evaluation fits them; the floors
// are not, because a sentence carrying a zero-width payload is not a matter
// of degree.

import type { FindingKind } from '../../report.ts'
import type { Hit, SentenceFeatures } from './features.ts'
import type { Lang, Segmentation } from './segment.ts'

export type Band = 'high' | 'medium' | 'low' | 'none'

export interface SpanScore {
  /** Index into the segmentation's sentences. */
  index: number
  start: number
  end: number
  line: number
  col: number
  endLine: number
  words: number
  lang?: Lang
  score: number
  band: Band
  /** Too short to mean much: shown, but left out of document aggregates. */
  lowConfidence: boolean
  /** Pattern ids, `feature.*` and `mark.*`, strongest first. */
  reasons: string[]
  features: SentenceFeatures
}

export const SPAN_WEIGHTS = {
  phrase: 0.35,
  structure: 0.25,
  repetition: 0.2,
  diversity: 0.1,
  typography: 0.1,
} as const

/** Scores a sentence cannot go below, whatever else it does. */
export const FLOORS = { residue: 0.9, carrier: 0.85, mixedScript: 0.9 } as const

/** Below this many words a sentence is scored and flagged as low confidence. */
export const MIN_SENTENCE_WORDS = 8

export const bandOf = (score: number): Band =>
  score >= 0.6 ? 'high' : score >= 0.35 ? 'medium' : score >= 0.15 ? 'low' : 'none'

const FEATURE_REASON = 0.5

export function scoreSentences(
  seg: Segmentation,
  features: readonly SentenceFeatures[],
  hits: readonly Hit[],
): SpanScore[] {
  const patterns = seg.sentences.map((): string[] => [])
  for (const hit of hits) {
    if (hit.counted && hit.sentence !== -1) patterns[hit.sentence]?.push(hit.entry.id)
  }

  return seg.sentences.map((sentence, index) => {
    const f = features[index] as SentenceFeatures
    let score =
      SPAN_WEIGHTS.phrase * f.phrase +
      SPAN_WEIGHTS.structure * f.structure +
      SPAN_WEIGHTS.repetition * f.repetition +
      SPAN_WEIGHTS.diversity * f.diversity +
      SPAN_WEIGHTS.typography * f.typography
    if (f.residue) score = Math.max(score, FLOORS.residue)
    if (f.carrier) score = Math.max(score, FLOORS.carrier)
    if (f.mixedScript) score = Math.max(score, FLOORS.mixedScript)
    score = Math.min(1, Math.max(0, score))

    const reasons = [
      ...[...new Set(f.marks)].map((kind: FindingKind) => `mark.${kind}`),
      ...new Set(patterns[index]),
      ...(f.repetition >= FEATURE_REASON ? ['feature.repetition'] : []),
      ...(f.diversity >= FEATURE_REASON ? ['feature.diversity'] : []),
      ...(f.typography >= FEATURE_REASON ? ['feature.typography'] : []),
    ]

    return {
      index,
      start: sentence.start,
      end: sentence.end,
      line: sentence.line,
      col: sentence.col,
      endLine: sentence.endLine,
      words: sentence.words,
      ...(sentence.lang ? { lang: sentence.lang } : {}),
      score: Math.round(score * 1000) / 1000,
      band: bandOf(score),
      lowConfidence: sentence.words < MIN_SENTENCE_WORDS,
      reasons,
      features: f,
    }
  })
}
