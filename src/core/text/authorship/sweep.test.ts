import { describe, expect, it } from 'vitest'
import {
  applyRewrites,
  checkRewrite,
  renderSweep,
  ruleRewrite,
  summariseRewrites,
  sweep,
  sweepPrompt,
  type SweepRow,
} from './sweep.ts'
import { describeLocation } from './locate.ts'
import { HUMAN_EN } from '../../../test/authorship-samples.ts'

const DISCUSSION = [
  '## 2.6 Discussion',
  '',
  'To our knowledge, this is the series with the longest follow-up [12]. Rates published at 12 months range from 0.7 to 13 % [19,26]. The definition retained weighs as much as the duration of follow-up.',
  '',
  'These data cannot be directly extrapolated to the Carlevale, but they could support the plausibility of an infectious risk [32]. The pocket holds only by the thickness of sclera above the anchor, of the order of 0.30 mm.',
  '',
  'No case of endophthalmitis was observed in our cohort.',
  '',
  'The result could potentially change with a larger series [4].',
].join('\n')

describe('sweep', () => {
  const result = sweep(DISCUSSION)
  const row = (fragment: string) => result.rows.find((r) => r.text.includes(fragment))

  it('lists every sentence with a habit, however isolated, with its type', () => {
    expect(row('To our knowledge')?.habits.map((h) => h.type)).toContain('stock_formula')
    expect(row('To our knowledge')?.registerExplained).toBe(true)
    expect(row('cannot be directly')?.type).toBe('stacked_hedge')
    expect(row('0.30 mm')?.habits.map((h) => h.type)).toContain('unsourced_figure')
    expect(row('weighs as much')?.habits.map((h) => h.type)).toContain('closing_line')
    expect(row('No case of endophthalmitis')?.habits.map((h) => h.type)).toContain('closing_line')
  })

  it('names the words of a formula listed alone', () => {
    const alone = row('To our knowledge')?.habits.find((h) => h.type === 'stock_formula')
    expect(alone?.detail).toMatch(/« to our knowledge[^»]* »/iu)
  })

  it('quotes each sentence exactly as it is in the text', () => {
    for (const r of result.rows) expect(DISCUSSION.slice(r.start, r.end)).toBe(r.text)
  })

  it('proposes a deterministic rewrite when one rule has one answer, and checks it', () => {
    expect(row('could potentially')?.rewrite).toEqual({
      text: 'The result could change with a larger series [4].',
      source: 'rule',
      verified: true,
    })
    expect(ruleRewrite('Cela pourrait potentiellement expliquer le risque.')).toBe(
      'Cela pourrait expliquer le risque.',
    )
    expect(ruleRewrite('Nothing to change here.')).toBeUndefined()
  })

  it('checks quotes against the sources it is given', () => {
    const checked = sweep(DISCUSSION, {
      sources: {
        'thesis.docx': { text: DISCUSSION.replaceAll(' ', '  ') },
        'thesis.pdf': { text: 'nothing of the sort', loose: true },
      },
    })
    for (const r of checked.rows) {
      expect(r.quote.checked).toEqual(['thesis.docx', 'thesis.pdf'])
      expect(r.quote.found).toEqual(['thesis.docx'])
    }
  })

  it('stays quiet on plain prose', () => {
    expect(sweep(HUMAN_EN).rows.filter((r) => r.confidence !== 'low')).toEqual([])
  })
})

describe('rewrites from a model or an agent', () => {
  const result = sweep(DISCUSSION)
  const hedged = result.rows.find((r) =>
    r.text.includes('cannot be directly'),
  ) as (typeof result.rows)[number]

  it('keeps one that kept every number and reference call', () => {
    const [updated] = applyRewrites(
      [hedged],
      [
        {
          id: hedged.id,
          rewrite:
            'These cases involved sutures, not the Carlevale, but they make an infectious risk plausible [32].',
        },
      ],
      'agent',
    )
    expect(updated?.rewrite).toMatchObject({ source: 'agent', verified: true })
  })

  it('rejects one that dropped a reference call, and says why', () => {
    const verdict = checkRewrite(
      hedged.text,
      'These cases involved sutures, not the Carlevale, but they make an infectious risk plausible.',
      'model',
    )
    expect(verdict.verified).toBe(false)
    expect(verdict.failures?.join(' ')).toContain('reference call [32]')
  })

  it('rejects one that changed a figure', () => {
    const verdict = checkRewrite(
      'The pocket holds by about 0.30 mm of sclera.',
      'The pocket holds by about 0.3 mm of sclera.',
      'agent',
    )
    expect(verdict.verified).toBe(false)
  })

  it('asks for JSON keyed by row id, naming each habit', () => {
    const prompt = sweepPrompt(result.rows)
    expect(prompt).toContain(hedged.id)
    expect(prompt).toContain('stacked hedges')
    expect(prompt).toContain('"rewrite"')
  })

  it('renders the table current text → replace with, by section', () => {
    const markdown = renderSweep(result, describeLocation)
    expect(markdown).toContain(
      '| Where | Current text | Replace with | Habit | Confidence | Register |',
    )
    expect(markdown).toContain('The result could change with a larger series [4].')
  })
})

describe('what sweep does not flag', () => {
  const types = (text: string) => sweep(text).rows.flatMap((r) => r.habits.map((h) => h.type))

  it('does not read "ainsi que" as a recap connector', () => {
    expect(
      types(
        '## 2.6 Discussion\n\nLes patients ainsi que leurs familles ont été informés du risque infectieux [3].',
      ),
    ).not.toContain('recap_connector')
    expect(
      types('## 2.6 Discussion\n\nLes patients ainsi que leurs familles ont été informés [3].'),
    ).not.toContain('marker_vocabulary')
  })

  it('does not say a lone tier-3 word was flagged beside something else', () => {
    const [row] = sweep(
      '## 2.3 Introduction\n\nCe dispositif constitue un véritable atout pour les patients opérés [3].',
    ).rows
    expect(row?.type).toBe('marker_vocabulary')
    expect(row?.habits[0]?.detail).not.toContain('already flagged')
  })

  it('does not count a range or a spaced en dash in a title line as a dash', () => {
    expect(
      types(
        '## Remerciements\n\nProfesseur des Universités – Praticien Hospitalier, Ophtalmologie,\n\n## 2.6 Discussion\n\nAt four years, 25 of the 41 eyes (61.0 %; 95 % CI 45.7 – 74.3) carried one exteriorised haptic [4].',
      ),
    ).not.toContain('em_dash')
    expect(
      types(
        '## 2.3 Introduction\n\nFour families of solutions coexist — anterior chamber lenses, iris fixation and scleral fixation — and none has been shown superior [7].',
      ),
    ).toContain('em_dash')
  })
})

describe('formulas repeated across sections', () => {
  const definition = 'whether it remained covered by an intact conjunctiva or crossed it'
  const slogan =
    'in nearly nine displaced anchors out of ten the conjunctiva still separated the implant'
  const TEXT = [
    '## 2.2 Abstract',
    '',
    `Haptic exteriorisation was defined as an anchor having left its scleral cover, ${definition}. Exteriorisation was frequent, but ${slogan} from the ocular surface.`,
    '',
    '## 2.4.5 Endpoints',
    '',
    `The primary endpoint was exteriorisation of an anchor out of its scleral cover, ${definition}.`,
    '',
    '## 2.5.3 Results',
    '',
    `Among the 34 exteriorised haptics, 30 stayed under the conjunctiva, ${definition}. The majority therefore remained covered: ${slogan} from the surface.`,
    '',
    '## 2.7 Conclusion',
    '',
    `Loss of the scleral cover was frequent, but ${slogan} from the ocular surface.`,
  ].join('\n')
  const result = sweep(TEXT)
  const repeated = (fragment: string) =>
    result.rows
      .filter((r) => r.text.includes(fragment))
      .map((r) => r.habits.find((h) => h.type === 'repeated_formula'))

  it('keeps a slogan copied into the conclusion at medium', () => {
    const habits = repeated('nine displaced anchors')
    expect(habits).toHaveLength(3)
    for (const habit of habits) expect(habit?.confidence).toBe('medium')
  })

  it('reads a definition repeated from the methods as the register, at low', () => {
    const habits = repeated('intact conjunctiva').filter(Boolean)
    expect(habits.length).toBeGreaterThan(0)
    for (const habit of habits) expect(habit).toMatchObject({ confidence: 'low', register: true })
  })

  it('quotes in each row the words that row repeats', () => {
    for (const row of result.rows) {
      for (const habit of row.habits.filter((h) => h.type === 'repeated_formula')) {
        const quoted = /^"([^"]+)"/.exec(habit.detail)?.[1] ?? ''
        expect(row.text.replaceAll(/\s+/g, ' ')).toContain(quoted)
      }
    }
  })
})

describe('the rewrite gate of sweep', () => {
  const HEDGED =
    'These data cannot be directly extrapolated to the device, but they could support the plausibility of an infectious risk [32].'

  it('accepts deleting a sentence that carries no figure and no reference call', () => {
    expect(checkRewrite('The data nevertheless remain reassuring.', '', 'agent')).toEqual({
      text: '',
      source: 'agent',
      verified: true,
    })
  })

  it('refuses to delete a sentence that carries a figure or a reference call', () => {
    const verdict = checkRewrite('Rates range from 0.7 to 13 % [19].', '', 'agent')
    expect(verdict.verified).toBe(false)
    expect(verdict.failures?.join(' ')).toMatch(/0\.7|\[19\]/)
  })

  it('rejects a rewrite that changed nothing', () => {
    const verdict = checkRewrite(HEDGED, ` ${HEDGED}`, 'agent')
    expect(verdict.verified).toBe(false)
    expect(verdict.failures?.join(' ')).toContain('unchanged')
  })

  it('rejects a rewrite that kept the habit it was asked to remove', () => {
    const verdict = checkRewrite(
      HEDGED,
      'These data cannot be extrapolated to the device, but they might support an infectious risk [32].',
      'agent',
    )
    expect(verdict.verified).toBe(false)
    expect(verdict.failures?.join(' ')).toContain('stacked hedges')
  })

  it('rejects a rewrite that brought in a pattern of the catalogue', () => {
    const verdict = checkRewrite(
      HEDGED,
      'These sutured cases delve into a rich tapestry of evidence and make a pivotal infectious risk plausible [32].',
      'agent',
    )
    expect(verdict.verified).toBe(false)
    expect(verdict.failures?.join(' ')).toMatch(/introduced/)
  })

  it('still accepts a plain rewrite', () => {
    expect(
      checkRewrite(
        HEDGED,
        'These cases involved sutures, not the device, but they make an infectious risk plausible [32].',
        'agent',
      ).verified,
    ).toBe(true)
  })

  it('does not offer a figure without its call for rewriting: only the author can add the call', () => {
    const result = sweep(
      '## 2.3 Introduction\n\nThe pocket holds only by the thickness of sclera above the anchor, of the order of 0.30 mm. Rates vary [4].',
    )
    const row = result.rows.find((r) => r.text.includes('0.30 mm'))
    expect(row?.habits.map((h) => h.type)).toEqual(['unsourced_figure'])
    expect(sweepPrompt(result.rows)).not.toContain(row?.id as string)
    expect(renderSweep(result, describeLocation)).toContain('add the reference call')
  })

  it('counts what an agent answered: verified, rejected, and ids it does not know', () => {
    const result = sweep(DISCUSSION)
    const row = result.rows.find((r) => r.text.includes('cannot be directly')) as SweepRow
    const outcome = summariseRewrites(
      applyRewrites(
        result.rows,
        [
          { id: row.id, rewrite: 'A risk is plausible.' },
          { id: 'S99999', rewrite: 'Anything.' },
        ],
        'agent',
      ),
      [
        { id: row.id, rewrite: 'A risk is plausible.' },
        { id: 'S99999', rewrite: 'Anything.' },
      ],
    )
    expect(outcome).toEqual({ verified: 0, rejected: 1, unknown: ['S99999'] })
  })
})

describe('sweep noise', () => {
  const types = (text: string) => sweep(text).rows.flatMap((r) => r.habits.map((h) => h.type))

  it('does not take « de plus de » or a mid-sentence « also » for a connector', () => {
    expect(
      types(
        '## 2.6 Discussion\n\nDe plus en plus de patients sont opérés chaque année [2]. Toutefois, ils sont suivis plus de deux ans [3].\n\nThe pocket also holds the anchor [4]. However, the flap is thinner [5].',
      ),
    ).not.toContain('connector_series')
  })

  it('does not read an ordinal « the first » as an announcement', () => {
    expect(
      types('## 2.3 Introduction\n\nThe first series reported four eyes with a stable lens [12].'),
    ).not.toContain('promise_without_follow_up')
  })

  it('does not read commas around an aside as a triad', () => {
    expect(
      types(
        '## 2.6 Discussion\n\nThe anchor, once displaced, may stay covered and remain stable for years.',
      ),
    ).not.toContain('triad')
  })

  it('raises a register formula repeated three times to medium', () => {
    const rows = sweep(
      '## 2.6 Discussion\n\nTo our knowledge, this is the longest series [1]. To our knowledge, one case was reported [2].\n\n## 2.7 Conclusion\n\nTo our knowledge, this is the longest series [1].',
    ).rows.filter((r) => r.type === 'stock_formula')
    expect(rows).toHaveLength(3)
    for (const row of rows)
      expect(row).toMatchObject({ confidence: 'medium', registerExplained: false })
  })
})

describe('hedge after hedge', () => {
  it('lists each sentence of a dense stretch at medium', () => {
    const rows = sweep(
      '## 2.6.3 Mechanistic hypotheses\n\nThe pocket could thin over time [1]. The anchor could move inside it [2]. Inflammation might also play a role [3].',
    ).rows.filter((r) => r.type === 'stacked_hedge')
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row.confidence).toBe('medium')
  })
})
