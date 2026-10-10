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

/**
 * The human threshold never sits below this, whatever the fit says.
 *
 * Fitted on French prose where a model's text often shows no habit at all, the
 * human threshold came out at 0.00, and a score can never be below zero: every
 * text read as `uncertain`, including one where nothing at all was found. A
 * verdict that cannot take one of its values tells the reader nothing, so the
 * floor keeps `likely_human` — "few AI-writing signals found" — reachable.
 */
export const HUMAN_FLOOR = 0.1

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
  /** The human threshold actually applied: the fitted one, floored. */
  human: number
  /** False when no score can reach `likely_human` under this calibration. */
  humanReachable: boolean
}

/** The fitted human threshold, raised to the floor; and whether it can be met. */
export function humanThreshold(thresholds: { human: number; ai: number }): {
  human: number
  reachable: boolean
} {
  const human = Math.max(thresholds.human, HUMAN_FLOOR)
  return { human, reachable: human > 0 && human < thresholds.ai }
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
  const { ai } = input.calibration.thresholds
  const { human, reachable } = humanThreshold(input.calibration.thresholds)
  const floor = { human, humanReachable: reachable }

  if (input.words < MIN_WORDS) {
    return {
      verdict: 'insufficient_evidence',
      score: null,
      confidence: 'low',
      abstainReason: 'too_short',
      used: 0,
      ...floor,
    }
  }

  if (input.unsupported) {
    return {
      verdict: 'insufficient_evidence',
      score: null,
      confidence: 'low',
      abstainReason: 'unsupported_language',
      used: 0,
      ...floor,
    }
  }
  const used = input.signals.filter(inMean)
  const score = weightedScore(input.signals, input.residue, ai)

  // Only signals the calibration weighs can corroborate. One it fitted to
  // zero — texture, which dashes alone can saturate — is not evidence, and
  // must not be the second of two agreeing habits.
  const strong = input.signals.filter(
    (s) => s.weight > 0 && s.value !== null && s.value >= STRONG,
  ).length
  let verdict: AuthorshipVerdict
  if (score >= ai) {
    // Guard A: one habit, however strong, is a habit.
    verdict = strong >= CORROBORATION ? 'likely_ai' : 'uncertain'
  } else if (reachable && score < human) {
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
    ...floor,
  }
}
