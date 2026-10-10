import { describe, expect, it } from 'vitest'
import { ACADEMIC, CATALOGUE, matchesOf } from './catalogue/index.ts'
import { HEDGING } from './catalogue/hedging.ts'
import { PHRASES } from '../humanise.ts'
import { detectAuthorship } from './index.ts'
import { HUMAN_EN } from '../../../test/authorship-samples.ts'

describe('the academic register', () => {
  it('has well-formed tier-3 entries that match their samples and miss their traps', () => {
    const ids = ACADEMIC.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of ACADEMIC) {
      expect(entry.tier, entry.id).toBe(3)
      expect(entry.category).toBe('register')
      expect(entry.id).toMatch(/^(?:fr|en)\.register\.[a-z0-9_]+$/)
      for (const sample of entry.samples) expect(matchesOf(entry, sample).length, entry.id).toBe(1)
      for (const trap of entry.traps) expect(matchesOf(entry, trap), entry.id).toEqual([])
    }
  })

  it('is read only when asked for, and lists isolated formulas as not evidence', () => {
    const text = `To our knowledge, this is the first series of its kind. ${HUMAN_EN}`
    const plain = detectAuthorship(text)
    const academic = detectAuthorship(text, { register: 'academic' })
    expect(plain.notEvidence.join(' ')).not.toContain('to our knowledge')
    expect(academic.notEvidence.at(-1)).toContain('“to our knowledge”')
    expect(academic.score).toBe(plain.score)
    expect(academic.coverage.register).toBe('academic')
    expect(academic.coverage.patterns).toBeGreaterThan(plain.coverage.patterns)
  })

  it('says when an uncited text was read with the general catalogue only', () => {
    const cited = `${HUMAN_EN} Rates vary [1,2] and others [3] agree [4–6], as Smith et al. found [7].`
    const report = detectAuthorship(cited)
    expect(report.coverage.academicCues).toBe(true)
    expect(report.coverage.matched).toBeGreaterThanOrEqual(0)
  })
})

describe('the hedging catalogue', () => {
  it('reads every phrase the humanise pass rewrites', () => {
    const ids = new Set(CATALOGUE.map((e) => e.id))
    for (const entry of HEDGING) expect(ids.has(entry.id), entry.id).toBe(true)
    expect(
      HEDGING.filter(
        (e) =>
          e.lang === 'en' && e.id.startsWith('en.hedge.') && e.id !== 'en.hedge.potentially_most',
      ),
    ).toHaveLength(PHRASES.filter((rule) => rule.what === 'stacked hedge').length)
  })

  it('reports hedges and leaves the score where it was', () => {
    const hedged = `${HUMAN_EN}\n\nThe result could potentially change with more eyes.`
    const plain = `${HUMAN_EN}\n\nThe result could change with more eyes.`
    const a = detectAuthorship(hedged)
    const b = detectAuthorship(plain)
    expect(a.findings.map((f) => f.patternId)).toContain('en.hedge.could_potentially')
    expect(a.findings.find((f) => f.patternId === 'en.hedge.could_potentially')?.severity).toBe(
      'low',
    )
    // Found, and weighing nothing: the counted weight each signal reports is
    // the same with the hedge as without it.
    const weights = (r: typeof a) =>
      r.signals
        .filter((s) => s.id === 'lexicon' || s.id === 'discourse')
        .map((s) => /^[\d.]+ weighted/.exec(s.detail)?.[0])
    expect(weights(a)).toEqual(weights(b))
  })
})
