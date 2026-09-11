import { describe, expect, it } from 'vitest'
import { editDistance, isCorrection, nameSurvived } from './correction.ts'

describe('editDistance', () => {
  it('measures small repairs and gives up on large ones', () => {
    expect(editDistance('moliere', 'moliere')).toBe(0)
    expect(editDistance('molliere', 'moliere')).toBe(1)
    expect(editDistance('theatre', 'theatre')).toBe(0)
    // Past the cap the exact number stops mattering, only that it is over.
    expect(editDistance('moliere', 'shakespeare')).toBeGreaterThan(2)
  })
})

describe('nameSurvived', () => {
  it('accepts the repair of a misspelled proper noun', () => {
    // The whole point: there is no way to correct "Molliere" while keeping it.
    expect(nameSurvived('Molliere', ['Molière', 'Paris'])).toBe(true)
    expect(nameSurvived('Théatre', ['Théâtre'])).toBe(true)
    expect(nameSurvived('Poquelin', ['Poquelin'])).toBe(true)
  })

  it('still reports a name that simply vanished', () => {
    expect(nameSurvived('Molliere', ['Paris'])).toBe(false)
    expect(nameSurvived('Poquelin', [])).toBe(false)
  })

  it('does not accept a different name as the repair of this one', () => {
    expect(nameSurvived('Molière', ['Shakespeare'])).toBe(false)
    expect(nameSurvived('Paris', ['Berlin'])).toBe(false)
  })
})

describe('isCorrection', () => {
  it('recognises a text repaired in place', () => {
    expect(
      isCorrection(
        'Sont pere étais tapissié du roi, mais le jeune homme na pas voulut suivre ces traces.',
        "Son père était tapissier du roi, mais le jeune homme n'a pas voulu suivre ses traces.",
      ),
    ).toBe(true)
  })

  it('does not call a fresh rewrite a correction', () => {
    expect(
      isCorrection(
        'The team completed the report and sent it to the client yesterday evening.',
        'Everything was delivered, and nobody had anything further to add about it.',
      ),
    ).toBe(false)
  })

  it('says nothing about an empty source', () => {
    expect(isCorrection('', 'anything')).toBe(false)
  })
})
