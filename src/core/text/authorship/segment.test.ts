import { describe, expect, it } from 'vitest'
import { segment, tokens, word } from './segment.ts'

const texts = (text: string) => segment(text).sentences.map((s) => text.slice(s.start, s.end))

describe('segment', () => {
  it('splits prose into sentences with their offsets', () => {
    expect(texts('One sentence here. Another one! A third?')).toEqual([
      'One sentence here.',
      'Another one!',
      'A third?',
    ])
  })

  it('locates each sentence by line and column', () => {
    const text = '# Title\n\nA sentence that wraps\nonto the next line. New one.'
    const [first, second] = segment(text).sentences
    expect(first).toMatchObject({ line: 3, col: 1, endLine: 4, paragraphIndex: 0 })
    expect(second).toMatchObject({ line: 4, col: 21, endLine: 4, paragraphIndex: 0 })
  })

  it('does not end a sentence at a French or English abbreviation', () => {
    expect(texts('M. Dupont et Mme Martin sont venus. Ils sont partis.')).toHaveLength(2)
    expect(texts('Voir p. ex. le chapitre, c.-à-d. la suite, etc. et le n° 4. Fin.')).toHaveLength(
      2,
    )
    expect(texts('Dr. Smith moved to the U.S. last year, e.g. in May. Then left.')).toHaveLength(2)
  })

  it('does not end a sentence inside a decimal number', () => {
    expect(texts('Le taux est de 3.5 pour cent. Il monte.')).toHaveLength(2)
  })

  it('keeps French quotation marks with no-break spaces inside one sentence', () => {
    const text = 'Il a dit : « Non ! » puis il est parti. Ensuite rien.'
    expect(texts(text)).toEqual(['Il a dit : « Non ! » puis il est parti.', 'Ensuite rien.'])
  })

  it('treats every list item as its own paragraph', () => {
    const { sentences } = segment('- first item here\n- second item here')
    expect(sentences.map((s) => s.paragraphIndex)).toEqual([0, 1])
    expect(texts('- first item here\n- second item here')).toEqual([
      'first item here',
      'second item here',
    ])
  })

  it('leaves out code, quotations and blockquotes', () => {
    const text = [
      'A real sentence of prose here.',
      '',
      '```',
      'const code = "not prose at all";',
      '```',
      '',
      '> A quoted paragraph that someone else wrote.',
    ].join('\n')
    expect(texts(text)).toEqual(['A real sentence of prose here.'])
  })

  it('drops a sentence that is mostly sealed and counts only unsealed words', () => {
    const text =
      'He said "this is all a quotation of someone". My own words follow it, plainly written here.'
    const { sentences, words } = segment(text)
    expect(sentences.map((s) => s.words)).toEqual([8])
    expect(words).toBe(8)
  })

  it('counts accented words as single words', () => {
    const [sentence] = segment('Élève, été, garçon et naïveté.').sentences
    expect(sentence?.words).toBe(5)
  })
})

describe('tokens', () => {
  it('splits French clitics from the word they lean on', () => {
    expect(tokens("l'école qu'il aime d’abord").map((t) => t.norm)).toEqual([
      'l',
      'école',
      'qu',
      'il',
      'aime',
      'd',
      'abord',
    ])
  })

  it('keeps English contractions and hyphenated words whole', () => {
    expect(tokens("it's a well-known fact").map((t) => t.norm)).toEqual([
      "it's",
      'a',
      'well-known',
      'fact',
    ])
  })
})

describe('word', () => {
  it('matches whole words, accents included, where \\b would not', () => {
    const pattern = word('été')
    expect('un été chaud'.match(pattern)).toEqual(['été'])
    expect('complété, étés'.match(word('été'))).toBeNull()
    expect(pattern.flags).toBe('giu')
  })
})
