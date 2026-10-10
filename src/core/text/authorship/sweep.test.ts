import { describe, expect, it } from 'vitest'
import {
  applyRewrites,
  checkRewrite,
  renderSweep,
  ruleRewrite,
  sweep,
  sweepPrompt,
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
