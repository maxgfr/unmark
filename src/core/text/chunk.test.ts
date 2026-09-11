import { describe, expect, it } from 'vitest'
import { chunkDocument } from './chunk.ts'

const rebuild = (text: string) =>
  chunkDocument(text, 20)
    .map((chunk) => chunk.text)
    .join('')

describe('chunkDocument', () => {
  it('tiles the text, so the pieces join back into the original', () => {
    const text = 'Un.\n\nDeux trois.\n\n\n  Quatre cinq six.\n\nSept.\n'
    expect(rebuild(text)).toBe(text)
    for (const chunk of chunkDocument(text, 20)) {
      expect(text.slice(chunk.start, chunk.end)).toBe(chunk.text)
    }
  })

  it('keeps offsets contiguous and in order', () => {
    const text = 'a b c.\n\nd e f.\n\ng h i.'
    const chunks = chunkDocument(text, 3)
    expect(chunks[0]?.start).toBe(0)
    expect(chunks.at(-1)?.end).toBe(text.length)
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]?.start).toBe(chunks[i - 1]?.end)
    }
  })

  it('packs short paragraphs together instead of one request each', () => {
    const text = 'un deux\n\ntrois quatre\n\ncinq six\n\nsept huit'
    expect(chunkDocument(text, 20)).toHaveLength(1)
  })

  it('splits when the budget is reached', () => {
    const text = 'un deux trois\n\nquatre cinq six\n\nsept huit neuf'
    const chunks = chunkDocument(text, 4)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text)
  })

  it('cuts an oversized paragraph at its sentences', () => {
    const text = 'Un deux trois quatre. Cinq six sept huit. Neuf dix onze douze.'
    const chunks = chunkDocument(text, 5)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((chunk) => chunk.text).join('')).toBe(text)
    expect(chunks[0]?.text.trimEnd()).toBe('Un deux trois quatre.')
  })

  it('hands over one long sentence rather than nothing', () => {
    const text = 'un deux trois quatre cinq six sept huit neuf dix'
    const chunks = chunkDocument(text, 3)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).toBe(text)
  })

  it('says nothing about an empty document', () => {
    expect(chunkDocument('', 20)).toEqual([])
  })

  it('leaves a short document in one piece', () => {
    const text = 'Bonjour, comment allez-vous ?'
    expect(chunkDocument(text, 180)).toEqual([{ text, start: 0, end: text.length }])
  })
})
