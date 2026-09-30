import { describe, expect, it } from 'vitest'
import {
  authorshipFindings,
  DISCLAIMER,
  excerptOf,
  NOT_EVIDENCE,
  renderMarkdown,
  toJSON,
  type AuthorshipReport,
} from './report.ts'

const REPORT: AuthorshipReport = {
  schemaVersion: 1,
  engine: { name: 'unmark', version: '0.1.0' },
  calibration: { id: 'provisional-0', calibrated: false, date: null },
  verdict: 'likely_ai',
  score: 0.742,
  confidence: 'low',
  language: { document: 'fr', unsupportedShare: 0 },
  words: 412,
  sentences: 21,
  thresholds: { human: 0.3, ai: 0.7 },
  signals: [
    {
      id: 'lexicon',
      value: 0.81,
      weight: 0.25,
      label: 'Vocabulary',
      detail: '9 weighted flagged phrases in 412 words',
      evidenceLabel: 'STYLE_HEURISTIC',
    },
    {
      id: 'stylometry',
      value: null,
      weight: 0.2,
      label: 'Document shape',
      detail: 'too little text',
      evidenceLabel: 'MEASURED_FEATURE',
    },
  ],
  spans: [
    {
      start: 0,
      end: 40,
      line: 3,
      col: 1,
      endLine: 3,
      words: 9,
      score: 0.71,
      band: 'high',
      lowConfidence: false,
      reasons: ['fr.lex.plongeons'],
      excerpt: 'Plongeons | dans `le` sujet, dans un monde où tout change.',
      lang: 'fr',
    },
  ],
  findings: [
    {
      id: 'fr.lex.plongeons@0',
      patternId: 'fr.lex.plongeons',
      category: 'lexicon',
      tier: 1,
      start: 0,
      end: 9,
      line: 3,
      col: 1,
      excerpt: 'Plongeons | dans `le` sujet',
      reason: 'a stock phrase of generated French',
      fixHint: 'say the specific thing',
      evidenceLabel: 'STYLE_HEURISTIC',
      severity: 'medium',
    },
  ],
  technicalMarks: [],
  style: { words: 412, sentences: 21, paragraphs: 4, measurable: true, metrics: [] },
  notEvidence: NOT_EVIDENCE,
  disclaimer: DISCLAIMER,
}

describe('renderMarkdown', () => {
  it('renders the fixed report', () => {
    expect(renderMarkdown(REPORT)).toMatchSnapshot()
  })

  it('states the verdict and the disclaimer together, before anything else', () => {
    const markdown = renderMarkdown(REPORT)
    const verdictAt = markdown.indexOf('Likely AI-written')
    const disclaimerAt = markdown.indexOf(DISCLAIMER)
    expect(verdictAt).toBeGreaterThan(-1)
    expect(disclaimerAt).toBeGreaterThan(verdictAt)
    expect(disclaimerAt).toBeLessThan(markdown.indexOf('## '))
  })

  it('escapes pipes and backticks in excerpts so the table holds', () => {
    const row = renderMarkdown(REPORT)
      .split('\n')
      .find((line) => line.startsWith('| 3 '))
    expect(row).toContain(String.raw`Plongeons \| dans \`le\` sujet`)
  })

  it('never says a text was written by a person', () => {
    const human = renderMarkdown({ ...REPORT, verdict: 'likely_human', score: 0.1 })
    expect(human).toContain('Few AI-writing signals found')
    expect(human.toLowerCase()).not.toMatch(/written by a (?:human|person)|human-written/)
  })

  it('names the reason for an abstention instead of a score', () => {
    const short = renderMarkdown({
      ...REPORT,
      verdict: 'insufficient_evidence',
      abstainReason: 'too_short',
      score: null,
    })
    expect(short).toContain('Not enough text to assess')
    expect(short).not.toMatch(/· score /)
  })

  it('names the calibration behind the verdict', () => {
    expect(renderMarkdown(REPORT)).toContain('provisional-0')
  })
})

describe('toJSON', () => {
  it('round-trips through JSON with the disclaimer', () => {
    const parsed = JSON.parse(toJSON(REPORT))
    expect(parsed.disclaimer).toBe(DISCLAIMER)
    expect(parsed.findings[0].line).toBe(3)
  })
})

describe('authorshipFindings', () => {
  it('maps findings to reported ai_style findings with real positions', () => {
    const [finding] = authorshipFindings(REPORT)
    expect(finding).toMatchObject({ kind: 'ai_style', offset: 0, length: 9 })
    expect(finding?.noFix).toBe('say the specific thing')
    expect(finding?.replacement).toBeUndefined()
    expect(finding?.verdict).not.toBe('confirmed')
  })
})

describe('excerptOf', () => {
  it('flattens whitespace and cuts a long passage around the match', () => {
    const text = `${'word '.repeat(40)}TARGET${' word'.repeat(40)}`
    const start = text.indexOf('TARGET')
    const excerpt = excerptOf(text, start, start + 6, 0, text.length)
    expect(excerpt.length).toBeLessThanOrEqual(90)
    expect(excerpt).toContain('TARGET')
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerptOf('a\n\tb   c', 0, 1, 0, 8)).toBe('a b c')
  })
})
