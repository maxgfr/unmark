import { describe, expect, it } from 'vitest'
import { segment } from './segment.ts'
import { route } from './route.ts'
import { measure, scan } from './features.ts'
import { technicalMarks } from './forensics.ts'
import { encodeStego } from '../stego.ts'

/** Features of every sentence of `text`, read as `lang`. */
function features(text: string, lang: 'fr' | 'en' = 'en', format?: string) {
  const seg = segment(text)
  route(text, seg, lang)
  const hits = scan(text, seg, format)
  return { seg, hits, features: measure(text, seg, hits, technicalMarks(text)) }
}

const first = (text: string, lang: 'fr' | 'en' = 'en') => features(text, lang).features[0]

// A contract per feature: one text that triggers it, one that does not.

describe('scan', () => {
  it('runs the catalogue of the sentence language only', () => {
    const { hits } = features('Plongeons dans le sujet sans tarder aujourd’hui.', 'en')
    expect(hits.filter((h) => h.counted)).toEqual([])
    const fr = features('Plongeons dans le sujet sans tarder aujourd’hui.', 'fr')
    expect(fr.hits.filter((h) => h.counted).map((h) => h.entry.id)).toEqual(['fr.lex.plongeons'])
  })

  it('reads residue in every language', () => {
    const { hits } = features('The report is attached. I hope this helps!', 'fr')
    expect(hits.some((h) => h.counted && h.entry.category === 'residue')).toBe(true)
  })

  it('ignores a match inside a quotation', () => {
    const text =
      'The essay quotes a chatbot saying "I hope this helps" and then argues with it for a page.'
    expect(features(text).hits.filter((h) => h.counted)).toEqual([])
  })

  it('counts a tier-2 habit only when two share a paragraph', () => {
    const one = features('Le projet avance. Il est notamment financé par la région.', 'fr')
    expect(one.hits.filter((h) => h.counted)).toEqual([])
    const two = features(
      'Le projet avance, notamment grâce à la région. En outre, la ville participe.',
      'fr',
    )
    expect(two.hits.filter((h) => h.counted)).toHaveLength(2)
  })

  it('never counts a tier-3 habit on its own', () => {
    const alone = features('En effet, le projet avance bien depuis le mois dernier.', 'fr')
    expect(alone.hits.filter((h) => h.counted)).toEqual([])
    const paired = features('En effet, plongeons dans le sujet sans tarder dès aujourd’hui.', 'fr')
    expect(paired.hits.filter((h) => h.counted).map((h) => h.entry.tier)).toEqual([3, 1])
  })

  it('reads Markdown furniture only in a plain-text file', () => {
    const text = 'The **key point** is the cost of the whole operation this year.'
    expect(features(text, 'en', 'Markdown').hits.filter((h) => h.counted)).toEqual([])
    expect(features(text, 'en', 'Text').hits.filter((h) => h.counted)).toHaveLength(1)
  })
})

describe('measure', () => {
  it('phrase: fires on flagged vocabulary', () => {
    expect(first('Plongeons dans le sujet, dans un monde où tout change vite.', 'fr')?.phrase).toBe(
      1,
    )
    expect(first('Le conseil a voté le budget mardi soir après deux heures.', 'fr')?.phrase).toBe(0)
  })

  it('structure: fires on a structural habit', () => {
    expect(
      first('Que vous soyez débutant ou expert, cet outil vous aidera.', 'fr')?.structure,
    ).toBe(0.5)
    expect(first('Cet outil aide les débutants comme les experts.', 'fr')?.structure).toBe(0)
  })

  it('repetition: fires when a sentence repeats phrases from its neighbours', () => {
    const repeated = Array.from(
      { length: 6 },
      () => 'the new system makes the work faster for the whole team every day.',
    ).join(' ')
    expect(first(repeated)?.repetition).toBeGreaterThan(0.5)
    expect(
      first(
        'I got the bike back yesterday. The mechanic said the bracket was shot, which explains the noise.',
      )?.repetition,
    ).toBe(0)
  })

  it('diversity: fires when the vocabulary is narrower than the language baseline', () => {
    const narrow = Array.from({ length: 12 }, () => 'the team and the work and the team.').join(' ')
    expect(first(narrow)?.diversity).toBeGreaterThan(0.5)
    const varied =
      'Autumn rain drummed against corrugated roofs while stray cats sheltered beneath abandoned carts, their fur matted; somewhere a radio crackled forgotten jazz, and an old baker kneaded tomorrow’s bread, humming tunelessly between yawns.'
    expect(first(varied)?.diversity).toBe(0)
  })

  it('typography: fires on em dashes, but not on a dialogue dash opening a line', () => {
    expect(first('The plan — which nobody read — failed in the end.')?.typography).toBe(1)
    expect(first('— Tu viens ? demanda-t-elle en poussant la porte.', 'fr')?.typography).toBe(0)
  })

  it('flags residue, carriers and mixed-script words for the floors', () => {
    expect(first('Here is the text. I hope this helps you with it today.')?.residue).toBe(false)
    expect(
      features('Here is the text you asked for. I hope this helps!').features[1]?.residue,
    ).toBe(true)
    const marked = `The results are attached here.${encodeStego('id-9', 'zero-width')}`
    expect(first(marked)?.carrier).toBe(true)
    expect(first('Log in to your pаypal account right now please.')?.mixedScript).toBe(true)
    expect(first('Log in to your paypal account right now please.')?.mixedScript).toBe(false)
  })
})
