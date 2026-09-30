// Document-level evidence, one number per habit family.
//
// The rule that shapes this file: every habit belongs to exactly one signal.
// If em dashes fed both the sentence texture and the style report, one habit
// would vote twice and two weak signals would look like corroboration. So the
// families are split by what they read, and a style metric that a catalogue
// already reads is left out of the stylometry signal:
//
//   spans       sentence texture: narrow vocabulary, dashes
//   lexicon     flagged vocabulary, by tier and density
//   discourse   structural and rhetorical habits
//   variation   words not reused: a synonym each time instead of the same word
//   stylometry  document shape no catalogue reads: rhythm, recap, outline
//   forensic    chat residue and technical marks
//
// A signal that cannot be measured is `null`, never 0. Zero is a measurement
// — "looked, found none" — and averaging an unmeasured signal in as zero
// would pull every short or French text toward "human" for no reason.

import type { Finding } from '../../report.ts'
import type { StyleReport } from '../stylometry.ts'
import type { Hit } from './features.ts'
import type { Lang } from './segment.ts'
import type { SpanScore } from './spans.ts'
import { CALIBRATION, type Calibration } from './calibration.ts'

export type EvidenceLabel =
  'TECHNICAL_MARK' | 'CHAT_RESIDUE' | 'STYLE_HEURISTIC' | 'MEASURED_FEATURE' | 'EXTERNAL_MODEL'

export interface Signal {
  id: string
  /** 0–1, or null when it could not be measured on this text. */
  value: number | null
  weight: number
  label: string
  detail: string
  evidenceLabel: EvidenceLabel
  /**
   * Evidence only when present. A clean forensic scan is not evidence of a
   * human writer, so a one-sided signal at zero stays out of the average.
   */
  oneSided?: boolean
}

/**
 * A signal computed outside the core — a model-based score, for instance.
 *
 * The core stays synchronous and never touches a network; a caller that can
 * run a model does so first and hands the number in here.
 */
export interface ExternalSignal {
  id: string
  value: number | null
  weight: number
  label: string
  detail?: string
}

export interface SignalInput {
  words: number
  lang: Lang
  spans: readonly SpanScore[]
  hits: readonly Hit[]
  marks: readonly Finding[]
  style: StyleReport
  /** Content-word reuse, from `wordReuse`. */
  reuse: { share: number; tokens: number }
}

/** Reuse at or above this reads as a person's; at or below `REUSE_LOW`, as generated. */
const REUSE_HIGH = 0.2
const REUSE_LOW = 0.06
/** Fewer content words than this and the share is noise. */
const MIN_REUSE_TOKENS = 60

/**
 * The style metrics the stylometry signal reads, per language.
 *
 * Only the ones no catalogue reads. French gets the language-neutral subset:
 * the outline and template metrics look for English headings and English
 * connectors, and read French as nothing.
 */
export const STYLOMETRY_OWNED: Record<Lang, ReadonlySet<string>> = {
  en: new Set([
    'burstiness',
    'paragraph_variance',
    'staccato',
    'recap_loop',
    'paragraph_template',
    'generic_outline',
  ]),
  fr: new Set(['burstiness', 'paragraph_variance', 'staccato', 'recap_loop']),
}

/** A saturating map from a rate to 0–1: half-way at `scale · ln 2`. */
const saturate = (rate: number, scale: number) => 1 - Math.exp(-rate / scale)

const round = (value: number) => Math.round(value * 1000) / 1000

export function builtInSignals(
  input: SignalInput,
  calibration: Calibration = CALIBRATION,
): Signal[] {
  const { weights } = calibration
  const counted = input.spans.filter((span) => !span.lowConfidence)
  const countedWords = counted.reduce((sum, span) => sum + span.words, 0)

  // spans — texture only; the phrase and structure parts belong to others.
  let texture: number | null = null
  if (countedWords > 0) {
    const sum = counted.reduce((total, span) => {
      const f = span.features
      return total + span.words * ((f.diversity + f.typography) / 2)
    }, 0)
    texture = round(Math.min(1, (2 * sum) / countedWords))
  }

  const weightOf = (category: (c: string) => boolean) =>
    input.hits
      .filter((hit) => hit.counted && category(hit.entry.category))
      .reduce((t, h) => t + h.weight, 0)

  const lexiconWeight = weightOf((c) => c === 'lexicon')
  const discourseWeight = weightOf((c) => c === 'structure' || c === 'discourse')
  const sentences = Math.max(1, counted.length)

  // stylometry — the owned metrics that could be measured.
  const owned = STYLOMETRY_OWNED[input.lang]
  const measurable = input.style.measurable
    ? input.style.metrics.filter((m) => owned.has(m.id) && !Number.isNaN(m.value))
    : []
  const triggered = measurable.filter((m) => m.triggered)

  // forensic — the strongest thing found, or zero.
  let forensic = 0
  const found: string[] = []
  for (const hit of input.hits) {
    if (!hit.counted) continue
    if (hit.entry.category === 'residue') forensic = Math.max(forensic, 0.9)
    // Markdown in a .txt is weak: people paste their own Markdown too. It is
    // kept under the 0.5 that would let it corroborate a verdict on its own.
    if (hit.entry.category === 'formatting') forensic = Math.max(forensic, 0.3)
  }
  for (const mark of input.marks) {
    forensic = Math.max(forensic, mark.verdict === 'confirmed' ? 1 : 0.85)
    found.push(mark.kind)
  }

  return [
    {
      id: 'spans',
      value: texture,
      weight: weights.spans,
      label: 'Sentence texture',
      detail: 'narrow vocabulary and dashes, sentence by sentence',
      evidenceLabel: 'MEASURED_FEATURE',
    },
    {
      id: 'lexicon',
      value: input.words > 0 ? round(saturate((lexiconWeight / input.words) * 100, 1.2)) : null,
      weight: weights.lexicon,
      label: 'Vocabulary',
      detail: `${round(lexiconWeight)} weighted flagged phrases in ${input.words} words`,
      evidenceLabel: 'STYLE_HEURISTIC',
    },
    {
      id: 'discourse',
      value: counted.length > 0 ? round(saturate(discourseWeight / sentences, 0.25)) : null,
      weight: weights.discourse,
      label: 'Sentence structure',
      detail: `${round(discourseWeight)} weighted structural habits in ${counted.length} sentences`,
      evidenceLabel: 'STYLE_HEURISTIC',
    },
    {
      id: 'variation',
      value:
        input.reuse.tokens < MIN_REUSE_TOKENS
          ? null
          : round(
              Math.min(1, Math.max(0, (REUSE_HIGH - input.reuse.share) / (REUSE_HIGH - REUSE_LOW))),
            ),
      weight: weights.variation,
      label: 'Word variation',
      detail: `${Math.round(input.reuse.share * 100)} % of content words reused within a hundred`,
      evidenceLabel: 'MEASURED_FEATURE',
    },
    {
      id: 'stylometry',
      value: measurable.length > 0 ? round(Math.min(1, triggered.length / 3)) : null,
      weight: weights.stylometry,
      label: 'Document shape',
      detail:
        measurable.length > 0
          ? `${triggered.length} of ${measurable.length} shape metrics past their threshold${triggered.length > 0 ? `: ${triggered.map((m) => m.label.toLowerCase()).join(', ')}` : ''}`
          : 'too little text, or no metric that reads this language',
      evidenceLabel: 'MEASURED_FEATURE',
    },
    {
      id: 'forensic',
      value: forensic,
      weight: weights.forensic,
      label: 'Residue and marks',
      detail:
        forensic === 0
          ? 'no chat residue and no technical mark'
          : found.length > 0
            ? `technical marks: ${[...new Set(found)].join(', ')}`
            : 'text left over from a chat window',
      evidenceLabel: found.length > 0 ? 'TECHNICAL_MARK' : 'CHAT_RESIDUE',
      oneSided: true,
    },
  ]
}

/** An external signal in the shape the verdict reads. */
export const fromExternal = (signal: ExternalSignal): Signal => ({
  id: signal.id,
  value: signal.value === null ? null : Math.min(1, Math.max(0, signal.value)),
  weight: signal.weight,
  label: signal.label,
  detail: signal.detail ?? '',
  evidenceLabel: 'EXTERNAL_MODEL',
})
