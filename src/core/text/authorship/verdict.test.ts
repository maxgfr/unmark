import { describe, expect, it } from 'vitest'
import { decide, MIN_WORDS, weightedScore } from './verdict.ts'
import type { Signal } from './signals.ts'
import type { Calibration } from './calibration.ts'

const CAL: Calibration = {
  id: 'test',
  calibrated: true,
  date: '2026-01-01',
  corpus: 'test',
  weights: { spans: 1, lexicon: 1, discourse: 1, stylometry: 1, forensic: 1 },
  thresholds: { human: 0.3, ai: 0.7 },
}

const signal = (id: string, value: number | null, extra: Partial<Signal> = {}): Signal => ({
  id,
  value,
  weight: 1,
  label: id,
  detail: '',
  evidenceLabel: 'MEASURED_FEATURE',
  ...extra,
})

const base = {
  words: 500,
  unsupported: false,
  residue: false,
  technical: false,
  calibration: CAL,
}

describe('decide', () => {
  it('abstains below 150 words and decides at 150', () => {
    const signals = [signal('a', 0.9), signal('b', 0.9)]
    expect(decide({ ...base, words: MIN_WORDS - 1, signals })).toMatchObject({
      verdict: 'insufficient_evidence',
      abstainReason: 'too_short',
      score: null,
    })
    expect(decide({ ...base, words: MIN_WORDS, signals }).verdict).toBe('likely_ai')
  })

  it('abstains on prose mostly in an unsupported language', () => {
    const result = decide({ ...base, unsupported: true, signals: [signal('a', 0.9)] })
    expect(result).toMatchObject({
      verdict: 'insufficient_evidence',
      abstainReason: 'unsupported_language',
    })
  })

  it('averages the available signals and ignores the unavailable ones', () => {
    const result = decide({
      ...base,
      signals: [signal('a', 0.1), signal('b', 0.3), signal('c', null)],
    })
    expect(result.score).toBeCloseTo(0.2)
    expect(result.verdict).toBe('likely_human')
  })

  it('lets an external signal move the score', () => {
    const own = [signal('a', 0.5), signal('b', 0.5)]
    const without = decide({ ...base, signals: own })
    const withIt = decide({ ...base, signals: [...own, signal('binoculars', 1, { weight: 2 })] })
    expect(withIt.score).toBeGreaterThan(without.score as number)
  })

  it('leaves a one-sided signal out of the mean when it found nothing', () => {
    const result = decide({
      ...base,
      signals: [signal('a', 0.6), signal('forensic', 0, { oneSided: true })],
    })
    expect(result.score).toBeCloseTo(0.6)
  })

  it('refuses likely_ai on the strength of one signal (guard A)', () => {
    const result = decide({ ...base, signals: [signal('a', 1), signal('b', 0.45)] })
    expect(result.score).toBeGreaterThanOrEqual(0.7)
    expect(result.verdict).toBe('uncertain')
  })

  it('never says likely_human with chat residue or a technical mark (guard B)', () => {
    const low = [signal('a', 0), signal('b', 0)]
    expect(decide({ ...base, signals: low, technical: true }).verdict).toBe('uncertain')
  })

  it('raises the score to the AI threshold on residue, still under guard A (guard C)', () => {
    const lone = decide({ ...base, residue: true, signals: [signal('a', 0.1), signal('b', 0.1)] })
    expect(lone.score).toBeGreaterThanOrEqual(0.7)
    expect(lone.verdict).toBe('uncertain')
    const backed = decide({
      ...base,
      residue: true,
      signals: [signal('a', 0.6), signal('forensic', 0.9)],
    })
    expect(backed.verdict).toBe('likely_ai')
  })

  it('never returns a verdict outside the four', () => {
    const verdicts = new Set(['likely_ai', 'uncertain', 'likely_human', 'insufficient_evidence'])
    for (const value of [0, 0.2, 0.5, 0.8, 1]) {
      const { verdict } = decide({ ...base, signals: [signal('a', value), signal('b', value)] })
      expect(verdicts.has(verdict)).toBe(true)
    }
  })

  it('grades confidence by length, calibration, distance and signal count', () => {
    const four = [signal('a', 0.95), signal('b', 0.95), signal('c', 0.95), signal('d', 0.95)]
    expect(decide({ ...base, signals: four }).confidence).toBe('high')
    expect(decide({ ...base, words: 200, signals: four }).confidence).toBe('low')
    expect(
      decide({ ...base, calibration: { ...CAL, calibrated: false }, signals: four }).confidence,
    ).toBe('low')
    expect(decide({ ...base, signals: four.slice(0, 3) }).confidence).toBe('low')
    const near = four.map((s) => ({ ...s, value: 0.75 }))
    expect(decide({ ...base, signals: near }).confidence).toBe('medium')
  })
})

describe('weightedScore', () => {
  it('is the score decide gives, before the verdict rules', () => {
    const signals = [signal('a', 0.2), signal('b', 0.6, { weight: 3 }), signal('c', null)]
    expect(weightedScore(signals, false, 0.7)).toBeCloseTo(0.5)
    expect(decide({ ...base, signals }).score).toBeCloseTo(0.5)
    expect(weightedScore(signals, true, 0.7)).toBeCloseTo(0.7)
  })
})
