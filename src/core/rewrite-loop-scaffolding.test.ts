import { describe, expect, it } from 'vitest'
import { trimScaffolding } from './rewrite-loop.ts'

describe('trimScaffolding', () => {
  it('keeps the answer and drops the prompt the model quoted back', () => {
    // Observed on the real model: a retry hands it the previous attempt under
    // an English heading, and on a long document it reproduces the heading and
    // everything after. That English reached the language gate, which reported
    // "French and English" and rejected a good correction.
    const echoed = [
      'Jean-Baptiste Poquelin, né à Paris en 1622.',
      '',
      'PREVIOUS CANDIDATE:',
      'Jean-Baptiste Poquelin, né a Paris en 1622.',
      '',
      'CORRECT THESE FAILURES:',
      'source language: Keep French',
    ].join('\n')
    expect(trimScaffolding(echoed)).toBe('Jean-Baptiste Poquelin, né à Paris en 1622.')
  })

  it('cuts at whichever heading comes first', () => {
    expect(
      trimScaffolding('Bonjour.\n\nCORRECT THESE FAILURES:\nx\n\nPREVIOUS CANDIDATE:\ny'),
    ).toBe('Bonjour.')
  })

  it('leaves an ordinary answer alone', () => {
    const clean = 'Son père était tapissier du roi.'
    expect(trimScaffolding(clean)).toBe(clean)
    expect(trimScaffolding('')).toBe('')
  })
})
