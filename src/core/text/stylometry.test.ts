import { describe, expect, it } from 'vitest'
import { analyzeStyle, MIN_SENTENCES, MIN_WORDS, stylometryFindings } from './stylometry.ts'

const triggered = (text: string) =>
  analyzeStyle(text)
    .metrics.filter((m) => m.triggered)
    .map((m) => m.id)

// ~190 words. Uneven sentences, one em dash, no marker vocabulary. This is the
// sample that matters: a stylometry module is only worth shipping if it stays
// quiet here.
const HUMAN = `I got the bike back from the shop yesterday. The mechanic said the bottom
bracket was shot, which explains the noise it had been making since about
March, and he seemed faintly offended that I had ridden it that long. Fixed
now. Cost more than I wanted it to.

I rode it up the hill behind the station this morning and it was fine — quiet,
even, which I had forgotten was an option. There is still something going on
with the rear brake, a sort of delayed bite that I notice on the way down more
than on the flat, but that can wait until the weather turns and I stop using it
every day.

The other thing I keep meaning to do is replace the saddle. It came with the
bike and it was never right, and every winter I decide I will deal with it in
the spring, and every spring I decide the saddle is fine actually. I assume
this will continue. My friend Tom says I should measure my sit bones. I have
not measured my sit bones. It has been four years.`

/** Repeat a template until the sample is long enough to measure. */
const grow = (template: (i: number) => string, count: number) =>
  Array.from({ length: count }, (_, i) => template(i)).join(' ')

describe('sample size', () => {
  it('refuses to judge a sample too short to measure', () => {
    // One em dash in twelve words extrapolates to 83 per 1000. That is not a
    // signal, it is a division. Reporting it would be inventing evidence.
    expect(triggered('A short line — with one dash in it.')).toEqual([])
  })

  it('says how much text it needed', () => {
    const report = analyzeStyle('Too short — by far.')
    expect(report.words).toBeLessThan(MIN_WORDS)
    expect(report.measurable).toBe(false)
  })

  it('measures once there is enough text', () => {
    expect(analyzeStyle(HUMAN).measurable).toBe(true)
  })
})

describe('analyzeStyle', () => {
  it('finds nothing worth reporting in ordinary human prose', () => {
    expect(triggered(HUMAN)).toEqual([])
  })

  it('counts em dashes per thousand words', () => {
    const dashes = grow(
      (i) =>
        `The report was clear — the numbers had moved — and nobody wanted to say so, case ${i}.`,
      14,
    )
    expect(triggered(dashes)).toContain('em_dash')
  })

  it('catches negative parallelism', () => {
    const text = grow(
      (i) =>
        `It is not just a tool, but a philosophy for case ${i}. This is not merely a change, but a transformation of how the team works day to day.`,
      8,
    )
    expect(triggered(text)).toContain('negative_parallelism')
  })

  it('catches the rule of three', () => {
    const text = grow(
      (i) =>
        `The system is fast, cheap, and reliable in region ${i}. The design is clean, modern, and accessible to everyone who needs it.`,
      8,
    )
    expect(triggered(text)).toContain('rule_of_three')
  })

  it('catches marker vocabulary', () => {
    const text = grow(
      (i) =>
        `Let us delve into this rich tapestry of options ${i}. It is a testament to the ever-evolving landscape, a pivotal moment in the realm of seamless, cutting-edge design.`,
      7,
    )
    expect(triggered(text)).toContain('marker_vocabulary')
  })

  it('reports low sentence-length variance, which is the machine tell', () => {
    // Humans write a two-word sentence and then a forty-word one. Models
    // converge on the mean.
    const uniform = grow(
      (i) => `The system processes each incoming request in strict order for client ${i}.`,
      24,
    )
    expect(triggered(uniform)).toContain('burstiness')
  })

  it('does not judge variance it cannot measure', () => {
    // A handful of sentences is not a sample, even when the words add up.
    const fewSentences = `${grow((i) => `word${i}`, 200)}. And a second one here.`
    const report = analyzeStyle(fewSentences)
    expect(report.sentences).toBeLessThan(MIN_SENTENCES)
    expect(triggered(fewSentences)).not.toContain('burstiness')
  })

  it('survives empty and whitespace-only input', () => {
    expect(analyzeStyle('').metrics.every((m) => !m.triggered)).toBe(true)
    expect(analyzeStyle('   \n  ').words).toBe(0)
  })

  it('counts words and sentences', () => {
    const report = analyzeStyle('One two three. Four five!')
    expect(report.words).toBe(5)
    expect(report.sentences).toBe(2)
  })
})

describe('stylometryFindings', () => {
  const LOADED = grow(
    (i) =>
      `Let us delve into this rich tapestry — a testament to the ever-evolving landscape of case ${i}. It is not just robust, but seamless. The result is fast, cheap, and reliable — a pivotal, crucial moment.`,
    9,
  )

  it('never returns a confirmed verdict', () => {
    // Style is not evidence. A tool that says "confirmed: written by AI" on the
    // strength of an em-dash count is lying, and every one of these metrics is
    // something a human writer legitimately does.
    const findings = stylometryFindings(LOADED)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((f) => f.verdict !== 'confirmed')).toBe(true)
  })

  it('raises its confidence only when several tells co-occur', () => {
    const many = stylometryFindings(LOADED)
    expect(many.length).toBeGreaterThanOrEqual(3)
    expect(many.every((f) => f.verdict === 'probable')).toBe(true)

    const one = stylometryFindings(
      grow(
        (i) => `The report was clear — the numbers had moved — and nobody said so, case ${i}.`,
        14,
      ),
    )
    expect(one.every((f) => f.verdict === 'informational')).toBe(true)
  })

  it('is silent on clean prose', () => {
    expect(stylometryFindings(HUMAN)).toEqual([])
  })

  it('produces only findings that a clean pass will never remove', () => {
    expect(stylometryFindings(LOADED).every((f) => f.kind === 'stylometry')).toBe(true)
  })
})
