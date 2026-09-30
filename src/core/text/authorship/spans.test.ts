import { describe, expect, it } from 'vitest'
import { segment } from './segment.ts'
import { route } from './route.ts'
import { measure, scan } from './features.ts'
import { technicalMarks } from './forensics.ts'
import { bandOf, scoreSentences } from './spans.ts'
import { encodeStego } from '../stego.ts'

function spans(text: string, lang: 'fr' | 'en' = 'en') {
  const seg = segment(text)
  route(text, seg, lang)
  const hits = scan(text, seg)
  return scoreSentences(seg, measure(text, seg, hits, technicalMarks(text)), hits)
}

describe('bandOf', () => {
  it('cuts at 0.60, 0.35 and 0.15', () => {
    expect([0.6, 0.59, 0.35, 0.34, 0.15, 0.14].map(bandOf)).toEqual([
      'high',
      'medium',
      'medium',
      'low',
      'low',
      'none',
    ])
  })
})

describe('scoreSentences', () => {
  it('scores a sentence full of habits above a plain one', () => {
    const [loaded, plain] = spans(
      'Plongeons dans un monde où tout change, que vous soyez débutant ou expert. Le conseil a voté le budget mardi soir après deux heures de débat.',
      'fr',
    )
    expect(loaded?.score).toBeGreaterThan(0.35)
    expect(plain?.score).toBeLessThan(0.15)
    expect(loaded?.reasons).toContain('fr.lex.plongeons')
    expect(loaded?.reasons).toContain('fr.struct.que_vous_soyez')
  })

  it('raises a sentence with chat residue to at least 0.90', () => {
    const [, residue] = spans('Here is the report you asked for. I hope this helps!')
    expect(residue?.score).toBeGreaterThanOrEqual(0.9)
    expect(residue?.band).toBe('high')
  })

  it('raises a sentence carrying invisible characters to at least 0.85', () => {
    const [marked] = spans(`The results are attached here.${encodeStego('id-9', 'zero-width')}`)
    expect(marked?.score).toBeGreaterThanOrEqual(0.85)
    expect(marked?.reasons).toContain('mark.zwj_family')
  })

  it('raises a sentence with a mixed-script word to at least 0.90', () => {
    const [spoofed] = spans('Log in to your pаypal account right now please.')
    expect(spoofed?.score).toBeGreaterThanOrEqual(0.9)
  })

  it('does not raise a sentence for repeating its neighbours', () => {
    // Measured on real text: people repeat their own words more than models do.
    const repeated = Array.from(
      { length: 6 },
      () => 'The new system makes the work faster for the whole team every day.',
    ).join(' ')
    expect(spans(repeated)[2]?.score).toBeLessThan(0.15)
  })

  it('marks a sentence under eight words as low confidence', () => {
    const [short, long] = spans(
      'Fixed now. The mechanic said the bottom bracket was shot and replaced it.',
    )
    expect(short?.lowConfidence).toBe(true)
    expect(long?.lowConfidence).toBe(false)
  })

  it('keeps each score between 0 and 1 and locates it', () => {
    for (const span of spans('One. Two three four five six seven eight nine ten.')) {
      expect(span.score).toBeGreaterThanOrEqual(0)
      expect(span.score).toBeLessThanOrEqual(1)
      expect(span.line).toBe(1)
    }
  })
})
