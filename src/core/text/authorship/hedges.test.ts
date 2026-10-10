import { describe, expect, it } from 'vitest'
import { hedgingHits } from './hedges.ts'
import { route } from './route.ts'
import { segment } from './segment.ts'
import { FR_TRAPS } from './catalogue/fr.traps.ts'

const hedges = (text: string) => {
  const seg = segment(text)
  route(text, seg, 'auto')
  return hedgingHits(text, seg).map((hit) => [hit.entry.id, text.slice(hit.start, hit.end)])
}

describe('hedgingHits', () => {
  it('flags two hedges on one claim', () => {
    expect(
      hedges(
        'These data concern sutured fixations and cannot be directly extrapolated to the Carlevale, but they could support the plausibility of an infectious risk.',
      ).map(([id]) => id),
    ).toEqual(['en.hedge.stacked'])
    expect(
      hedges(
        'Ces données ne peuvent être directement extrapolées au Carlevale, mais elles pourraient soutenir la plausibilité d’un risque infectieux.',
      ).map(([id]) => id),
    ).toEqual(['fr.hedge.stacked'])
  })

  it('flags an assertion hedged in the same sentence', () => {
    expect(
      hedges(
        'Ces résultats montrent que l’extériorisation sous-conjonctivale à distance semble constituer une complication fréquente.',
      ).map(([id]) => id),
    ).toEqual(['fr.hedge.contradictory'])
  })

  it('flags a stretch where hedge follows hedge', () => {
    const text =
      'A chronic reaction could contribute to this remodelling. Mechanical stress could maintain it. The particularities of the pocket technique could also play a role. The anchor sits in a thin pocket.'
    expect(hedges(text).map(([id]) => id)).toEqual([
      'en.hedge.dense',
      'en.hedge.dense',
      'en.hedge.dense',
    ])
  })

  it('leaves one hedge alone, in either language', () => {
    expect(hedges('The mechanism could be tissue remodelling. The data are scarce.')).toEqual([])
    for (const { register, text } of FR_TRAPS) expect(hedges(text), register).toEqual([])
  })

  it('does not read the month of May as a hedge', () => {
    expect(
      hedges('Patients seen in May 2021 could return in June. They were examined twice.'),
    ).toEqual([])
  })
})
