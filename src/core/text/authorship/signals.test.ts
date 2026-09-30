import { describe, expect, it } from 'vitest'
import { builtInSignals, type SignalInput } from './signals.ts'
import type { StyleMetric, StyleReport } from '../stylometry.ts'
import type { SpanScore } from './spans.ts'
import type { Hit } from './features.ts'
import type { Pattern } from './catalogue/index.ts'

const metric = (id: string, triggered: boolean, value = 1): StyleMetric => ({
  id,
  label: id,
  layer: 'structure',
  signal: id,
  value,
  threshold: 0,
  triggered,
  detail: '',
})

const style = (metrics: StyleMetric[], measurable = true): StyleReport => ({
  words: 500,
  sentences: 30,
  paragraphs: 6,
  measurable,
  metrics,
})

const span = (features: Partial<SpanScore['features']>, words = 12): SpanScore => ({
  index: 0,
  start: 0,
  end: 1,
  line: 1,
  col: 1,
  endLine: 1,
  words,
  score: 0,
  band: 'none',
  lowConfidence: words < 8,
  reasons: [],
  features: {
    phrase: 0,
    structure: 0,
    repetition: 0,
    diversity: 0,
    typography: 0,
    residue: false,
    carrier: false,
    mixedScript: false,
    marks: [],
    ...features,
  },
})

const hit = (category: Pattern['category'], weight = 1): Hit => ({
  entry: { category } as Pattern,
  start: 0,
  end: 1,
  sentence: 0,
  counted: true,
  weight,
})

const input = (over: Partial<SignalInput> = {}): SignalInput => ({
  words: 400,
  lang: 'en',
  spans: [span({})],
  hits: [],
  marks: [],
  style: style([]),
  ...over,
})

const value = (signals: ReturnType<typeof builtInSignals>, id: string) =>
  signals.find((s) => s.id === id)?.value

describe('builtInSignals', () => {
  it('returns the five built-in signals', () => {
    expect(builtInSignals(input()).map((s) => s.id)).toEqual([
      'spans',
      'lexicon',
      'discourse',
      'stylometry',
      'forensic',
    ])
  })

  it('reads vocabulary only in the lexicon signal', () => {
    const plain = builtInSignals(input())
    const loaded = builtInSignals(input({ hits: Array.from({ length: 8 }, () => hit('lexicon')) }))
    expect(value(loaded, 'lexicon')).toBeGreaterThan(0.5)
    expect(value(loaded, 'lexicon')).toBeGreaterThan(value(plain, 'lexicon') as number)
    expect(value(loaded, 'spans')).toBe(value(plain, 'spans'))
    expect(value(loaded, 'discourse')).toBe(value(plain, 'discourse'))
  })

  it('reads sentence texture only in the spans signal', () => {
    const textured = builtInSignals(input({ spans: [span({ repetition: 1, typography: 1 })] }))
    expect(value(textured, 'spans')).toBeGreaterThan(0.5)
    expect(value(textured, 'lexicon')).toBe(0)
  })

  it('counts structural habits in the discourse signal', () => {
    const signals = builtInSignals(input({ hits: [hit('structure'), hit('discourse')] }))
    expect(value(signals, 'discourse')).toBeGreaterThan(0.5)
  })

  it('leaves out the style metrics a catalogue already owns', () => {
    const owned = builtInSignals(
      input({ style: style([metric('marker_vocabulary', true), metric('rule_of_three', true)]) }),
    )
    expect(value(owned, 'stylometry')).toBeNull()
  })

  it('reads only language-neutral style metrics in French', () => {
    const metrics = [metric('paragraph_template', true), metric('generic_outline', true)]
    expect(value(builtInSignals(input({ lang: 'en', style: style(metrics) })), 'stylometry')).toBe(
      0.667,
    )
    expect(
      value(builtInSignals(input({ lang: 'fr', style: style(metrics) })), 'stylometry'),
    ).toBeNull()
  })

  it('is null when stylometry cannot measure, never zero', () => {
    const signals = builtInSignals(input({ style: style([metric('burstiness', false)], false) }))
    expect(value(signals, 'stylometry')).toBeNull()
  })

  it('makes the forensic signal one-sided: zero when clean, strong on residue', () => {
    const clean = builtInSignals(input()).find((s) => s.id === 'forensic')
    expect(clean).toMatchObject({ value: 0, oneSided: true })
    expect(value(builtInSignals(input({ hits: [hit('residue')] })), 'forensic')).toBe(0.9)
  })

  it('is null for spans when every sentence is too short to count', () => {
    expect(
      value(builtInSignals(input({ spans: [span({ repetition: 1 }, 5)] })), 'spans'),
    ).toBeNull()
  })
})
