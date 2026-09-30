// From signals to a sentence a person reads.
//
// Three verdicts and an abstention, and never `confirmed`: style is evidence
// about habits, and habits are shared by people and models. The guards below
// are what keep one strong habit, or one pasted template, from becoming an
// accusation on its own.

import type { Calibration } from './calibration.ts'
import type { Signal } from './signals.ts'

export type AuthorshipVerdict = 'likely_ai' | 'uncertain' | 'likely_human' | 'insufficient_evidence'
export type Confidence = 'low' | 'medium' | 'high'
export type AbstainReason = 'too_short' | 'unsupported_language'

/** Below this many words of prose, no verdict. Every rate is noise at this length. */
export const MIN_WORDS = 150

/** A signal at or above this counts toward guard A. */
const STRONG = 0.5
/** Guard A: how many strong signals `likely_ai` needs. */
const CORROBORATION = 2

export interface VerdictInput {
  words: number
  unsupported: boolean
  signals: readonly Signal[]
  /** Chat residue was found. */
  residue: boolean
  /** A technical mark was found. */
  technical: boolean
  calibration: Calibration
}

export interface VerdictResult {
  verdict: AuthorshipVerdict
  score: number | null
  confidence: Confidence
  abstainReason?: AbstainReason
  /** The signals that entered the average. */
  used: number
}

const inMean = (signal: Signal) =>
  signal.value !== null && !(signal.oneSided === true && signal.value === 0)

/**
 * The weighted mean of the signals that can be averaged, with guard C applied.
 *
 * Exported for the evaluation, which needs a score for every document —
 * including the short ones the verdict abstains on — to rank them.
 */
export function weightedScore(signals: readonly Signal[], residue: boolean, ai: number): number {
  const used = signals.filter(inMean)
  const total = used.reduce((sum, s) => sum + s.weight, 0)
  const mean =
    total === 0 ? 0 : used.reduce((sum, s) => sum + s.weight * (s.value as number), 0) / total
  // Guard C: chat residue is near-certain on its own, so it lifts the score to
  // the threshold — and guard A still decides whether that is a verdict.
  return residue ? Math.max(mean, ai) : mean
}

export function decide(input: VerdictInput): VerdictResult {
  const { human, ai } = input.calibration.thresholds

  if (input.words < MIN_WORDS) {
    return {
      verdict: 'insufficient_evidence',
      score: null,
      confidence: 'low',
      abstainReason: 'too_short',
      used: 0,
    }
  }

  if (input.unsupported) {
    return {
      verdict: 'insufficient_evidence',
      score: null,
      confidence: 'low',
      abstainReason: 'unsupported_language',
      used: 0,
    }
  }
  const used = input.signals.filter(inMean)
  const score = weightedScore(input.signals, input.residue, ai)

  const strong = input.signals.filter((s) => s.value !== null && s.value >= STRONG).length
  let verdict: AuthorshipVerdict
  if (score >= ai) {
    // Guard A: one habit, however strong, is a habit.
    verdict = strong >= CORROBORATION ? 'likely_ai' : 'uncertain'
  } else if (score < human) {
    // Guard B: no reassurance about a text carrying residue or a mark.
    verdict = input.residue || input.technical ? 'uncertain' : 'likely_human'
  } else {
    verdict = 'uncertain'
  }

  const distance = Math.min(Math.abs(score - human), Math.abs(score - ai))
  let confidence: Confidence = 'medium'
  if (input.words < 250 || !input.calibration.calibrated || used.length <= 3) confidence = 'low'
  else if (input.words >= 400 && distance > 0.15 && used.length >= 4) confidence = 'high'

  return {
    verdict,
    score: Math.round(score * 1000) / 1000,
    confidence,
    used: used.length,
  }
}
