import { describe, expect, it } from 'vitest'
import { replacedShortText, wordForms } from './shortrewrite.ts'

describe('wordForms', () => {
  it('folds case and accents so a repaired word is still the same word', () => {
    expect(wordForms('Ça va, Élodie ?')).toEqual(['ca', 'va', 'elodie'])
    expect(wordForms('sa va')).toEqual(['sa', 'va'])
    expect(wordForms('  ')).toEqual([])
  })
})

describe('replacedShortText', () => {
  it('rejects the translation the language gate could not see', () => {
    // Detected as Polish on both sides, so changedLanguage compared pl to pl
    // and approved. This check never asks what language either side is in.
    expect(replacedShortText('Hello ça dit quoi wsh ?', 'Chy jest co wiesz wsh?')).toBe(
      'only 1 of 5 words from the source survived',
    )
  })

  it('accepts a spelling and accent repair', () => {
    expect(replacedShortText('wsh comment sa va', 'wsh comment ça va ?')).toBeUndefined()
  })

  it('abstains below four words, where there is no majority to lose', () => {
    // "bonjour c cool" -> "Salut, cool." keeps one word of three and is still
    // an ordinary rewrite; the language gate owns that case.
    expect(replacedShortText('bonjour c cool', 'Salut, cool.')).toBeUndefined()
    expect(replacedShortText('bonjour c cool', "Bonjour, c'est cool.")).toBeUndefined()
  })

  it('accepts a grammar repair that keeps the sentence', () => {
    expect(
      replacedShortText('Nous avons préparer le dossier.', 'Nous avons préparé le dossier.'),
    ).toBeUndefined()
  })

  it('accepts an unchanged short text', () => {
    expect(replacedShortText('salut ça va', 'salut ça va')).toBeUndefined()
  })

  it('leaves long text to the language gate, where detection is reliable', () => {
    const long =
      'Le projet avance bien et nous avons terminé la première étape hier soir, donc nous préparons la suite.'
    const translated =
      'The project is progressing well and we finished the first stage last night, so we are preparing what comes next.'
    // Thirteen words in, this check abstains rather than second-guess a rewrite.
    expect(replacedShortText(long, translated)).toBeUndefined()
  })

  it('says nothing about an empty source', () => {
    expect(replacedShortText('', 'anything at all')).toBeUndefined()
  })

  it('counts survival, not order', () => {
    expect(replacedShortText('un deux trois quatre', 'quatre trois deux un')).toBeUndefined()
  })
})
