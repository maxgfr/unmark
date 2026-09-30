import { beforeAll, describe, expect, it } from 'vitest'
import { detectAuthorship } from './index.ts'
import { excerptOf } from './report.ts'
import { route } from './route.ts'
import { segment } from './segment.ts'
import { AI_FR, HUMAN_FR } from '../../../test/authorship-samples.ts'

// Timing budgets, run on their own by `pnpm test:perf`: under the parallel
// suite every file competes for the same cores and a budget measures the
// neighbours as much as the code.

const FR = `Le conseil municipal s'est réuni mardi soir pour examiner le budget de l'année prochaine. Les élus ont longuement débattu de la rénovation de l'école primaire, dont la toiture fuit depuis deux hivers.`
const EN = `The council met on Tuesday evening to go through next year's budget. Most of the discussion was about the primary school roof, which has been leaking for two winters now.`

describe('route performance', () => {
  it('routes a long document quickly, and still finds both halves of a bilingual one', () => {
    const french = Array.from({ length: 1500 }, (_, i) => `${FR} Séance ${i}.`)
    const english = Array.from({ length: 1500 }, (_, i) => `${EN} Session ${i}.`)
    const text = [...french, ...english].join('\n\n')
    route(text, segment(text.slice(0, 2000))) // warm the detectors
    const seg = segment(text)
    const started = performance.now()
    const routed = route(text, seg)
    expect(performance.now() - started).toBeLessThan(600)
    expect(routed.paragraphs[10]).toBe('fr')
    expect(routed.paragraphs.at(-10)).toBe('en')
  })
})

describe('excerpt performance', () => {
  it('stays fast when the surrounding passage is a megabyte long', () => {
    const text = 'word '.repeat(200_000)
    const started = performance.now()
    for (let i = 0; i < 5_000; i += 1) excerptOf(text, i * 100, i * 100 + 4, 0, text.length)
    expect(performance.now() - started).toBeLessThan(300)
  })
})

// Budgets for a warm engine: the first call compiles a few hundred patterns
// and loads the language models, which is a one-off cost and not the one
// these guard. Measured alone, both run in about half their budget.
describe('performance', () => {
  beforeAll(() => {
    detectAuthorship(AI_FR)
  })

  it('reads 100k words in under 1.5 s', () => {
    const paragraphs = HUMAN_FR.split('\n\n')
    const long = Array.from(
      { length: 2400 },
      (_, i) => `${paragraphs[i % paragraphs.length]} Séance numéro ${i}.`,
    ).join('\n\n')
    expect(long.split(/\s+/).length).toBeGreaterThan(100_000)
    const started = performance.now()
    detectAuthorship(long)
    expect(performance.now() - started).toBeLessThan(1500)
  })

  it('reads one megabyte on a single line in under 2 s', () => {
    const unit = 'en offrant, en permettant, notamment, que vous soyez, non seulement ant, '
    const line = unit.repeat(Math.ceil(1_000_000 / unit.length))
    const started = performance.now()
    detectAuthorship(line, { lang: 'fr' })
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
