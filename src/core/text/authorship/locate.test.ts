import { describe, expect, it } from 'vitest'
import { describeLocation, layoutFromPages, locator, searchable, sectionLabel } from './locate.ts'

describe('searchable', () => {
  it('ignores what a layout changes: spacing, hyphenation, ligatures, punctuation', () => {
    expect(searchable('extério-\nrisation de l’ancrage, ﬁnale')).toBe(
      searchable('extériorisation de l’ancrage finale'),
    )
  })
})

describe('locator', () => {
  const text = [
    'The first paragraph says something long enough to be found again.',
    'The second paragraph runs across a page break, and its last sentence sits on the next page.',
  ].join('\n\n')
  const second = text.indexOf('The second')
  const paragraphs = [
    { start: 0, end: second - 2, index: 3, section: '2.6.3 Mechanistic hypotheses' },
    { start: second, end: text.length, index: 4, section: '2.6.3 Mechanistic hypotheses' },
  ]

  it('gives the paragraph and section from the layout', () => {
    const where = locator(text, { paragraphs })
    expect(where(5)).toEqual({ paragraph: 3, section: '2.6.3 Mechanistic hypotheses' })
    expect(where(second + 3)?.paragraph).toBe(4)
  })

  it('places each passage on its printed page, even inside a paragraph cut by a page', () => {
    const pages = [
      {
        page: 28,
        text: 'Running head\n\nThe first paragraph says something long\nenough to be found again.',
      },
      {
        page: 29,
        text: 'The second paragraph runs across a page break, and its last sen-\ntence',
      },
      { page: 30, text: 'sits on the next page.\n\n30' },
    ]
    const where = locator(text, { paragraphs, pages })
    expect(where(0)?.page).toBe(28)
    expect(where(second)?.page).toBe(29)
    const last = text.indexOf('sits on')
    expect(where(last, text.length)?.page).toBe(30)
  })

  it('says nothing about an offset outside every paragraph', () => {
    expect(locator('  text', { paragraphs: [{ start: 2, end: 6, index: 1 }] })(0)).toBeUndefined()
  })
})

describe('describeLocation', () => {
  it('reads as a citation', () => {
    expect(
      describeLocation({ page: 29, section: '2.6.3 Mechanistic hypotheses', paragraph: 9 }),
    ).toBe('p. 29, §2.6.3')
    expect(describeLocation({ section: 'Remerciements' })).toBe('“Remerciements”')
    expect(describeLocation({ paragraph: 14 })).toBe('¶14')
    expect(describeLocation(undefined)).toBeUndefined()
    expect(sectionLabel('3. Conclusion')).toBe('§3')
  })
})

describe('layoutFromPages', () => {
  it('drops folios, headings, captions and the reference list, and keeps pages', () => {
    const { text, layout } = layoutFromPages([
      { page: 1, text: '1. Introduction\n\nOpening paragraph of the text.\n\n1' },
      {
        page: 2,
        text: 'Figure 1. A caption.\n\nSecond paragraph.\n\nRéférences\n\n1. Smith J. A paper. 2020.\n\n2. Doe J. Another. 2021.\n\nFIGURES ET TABLEAUX\n\nA closing note after the list.',
      },
    ])
    expect(text.split('\n\n')).toEqual([
      'Opening paragraph of the text.',
      'Second paragraph.',
      'A closing note after the list.',
    ])
    expect(layout.paragraphs.map((p) => [p.page, p.section])).toEqual([
      [1, '1. Introduction'],
      [2, '1. Introduction'],
      [2, 'FIGURES ET TABLEAUX'],
    ])
  })

  it('leaves the oath out of a printed thesis', () => {
    const { text } = layoutFromPages([
      {
        page: 53,
        text: 'Ces résultats concluent la thèse.\n\nSERMENT D’HIPPOCRATE\n\nAu moment d’être admis à exercer la médecine, je promets et je jure d’être fidèle aux lois de l’honneur.',
      },
      { page: 55, text: 'Résumé\n\nContexte : la fixation sclérale repose sur deux ancrages.' },
    ])
    expect(text.split('\n\n')).toEqual([
      'Ces résultats concluent la thèse.',
      'Contexte : la fixation sclérale repose sur deux ancrages.',
    ])
  })
})
