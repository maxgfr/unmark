import { describe, expect, it } from 'vitest'
import { identity, rebase, span, splice, through, type Splice } from './frame.ts'
import type { Finding } from '../report.ts'

const origins = (frame: Int32Array) => [...frame]

describe('identity', () => {
  it('carries a sentinel past the end, so a span end reads like a span start', () => {
    expect(origins(identity(3))).toEqual([0, 1, 2, 3])
  })
})

describe('splice', () => {
  it('leaves a string and its frame alone when there is nothing to apply', () => {
    const result = splice('abc', [])
    expect(result.text).toBe('abc')
    expect(origins(result.frame)).toEqual([0, 1, 2, 3])
  })

  it('reads an offset past a deletion back to where it was', () => {
    // "ab<zwsp>c" — the carrier at 2 comes out, so 'c' moves from 3 to 2.
    const result = splice('ab​c', [{ start: 2, end: 3, to: '' }])

    expect(result.text).toBe('abc')
    expect(origins(result.frame)).toEqual([0, 1, 3, 4])
  })

  it('does not shift anything for a same-width substitution', () => {
    // A Cyrillic а replaced by a Latin one is one character for one character.
    const result = splice('bаd', [{ start: 1, end: 2, to: 'a' }])

    expect(result.text).toBe('bad')
    expect(origins(result.frame)).toEqual([0, 1, 2, 3])
  })

  it('maps every unit of grown text back to the one point it replaced', () => {
    const result = splice('a…b', [{ start: 1, end: 2, to: '...' }])

    expect(result.text).toBe('a...b')
    expect(origins(result.frame)).toEqual([0, 1, 1, 1, 2, 3])
  })

  it('handles an astral carrier, which is two code units for none', () => {
    // A tag character is outside the BMP: the walk deletes two units, not one.
    const original = `a\u{E0041}b`
    expect(original.length).toBe(4)

    const result = splice(original, [{ start: 1, end: 3, to: '' }])
    expect(result.text).toBe('ab')
    expect(origins(result.frame)).toEqual([0, 3, 4])
  })

  it('takes every splice in the frame the pass was given, not in each other', () => {
    // Both `start` values index the same string. Applying left to right without
    // care would read the second one against a document the first shortened.
    const result = splice('a-b-c', [
      { start: 1, end: 2, to: '' },
      { start: 3, end: 4, to: '' },
    ])

    expect(result.text).toBe('abc')
    expect(origins(result.frame)).toEqual([0, 2, 4, 5])
  })

  it('skips a splice that overlaps the one before it rather than throwing', () => {
    const result = splice('abcdef', [
      { start: 1, end: 4, to: 'X' },
      { start: 2, end: 5, to: 'Y' },
    ])

    expect(result.text).toBe('aXef')
  })
})

describe('through', () => {
  it('composes two frames into one that reaches the original', () => {
    // Carriers out first, then a later pass edits what is left.
    const first = splice('ab​cd', [{ start: 2, end: 3, to: '' }])
    expect(first.text).toBe('abcd')

    const second = splice(first.text, [{ start: 1, end: 2, to: '' }])
    expect(second.text).toBe('acd')

    expect(origins(through(first.frame, second.frame))).toEqual([0, 3, 4, 5])
  })

  it('is what passing a frame into splice already does', () => {
    const first = splice('ab​cd', [{ start: 2, end: 3, to: '' }])
    const composed = splice(first.text, [{ start: 1, end: 2, to: '' }], first.frame)
    const second = splice(first.text, [{ start: 1, end: 2, to: '' }])

    expect(origins(composed.frame)).toEqual(origins(through(first.frame, second.frame)))
  })
})

describe('span', () => {
  it('widens a span back over the characters removed inside it', () => {
    // A phrase reported as 4 long in the cleaned string covered 6 characters of
    // what was pasted, because two carriers were sitting inside it.
    const cleaned = splice('ab​cd​ef', [
      { start: 2, end: 3, to: '' },
      { start: 5, end: 6, to: '' },
    ])
    expect(cleaned.text).toBe('abcdef')

    expect(span(cleaned.frame, 1, 4)).toEqual({ offset: 1, length: 6 })
  })

  it('leaves an untouched span exactly as it was', () => {
    const cleaned = splice('abcde​', [{ start: 5, end: 6, to: '' }])

    expect(span(cleaned.frame, 1, 3)).toEqual({ offset: 1, length: 3 })
  })
})

describe('rebase', () => {
  const finding = (over: Partial<Finding>): Finding => ({
    kind: 'typography',
    verdict: 'informational',
    offset: 0,
    length: 0,
    label: 'x',
    ...over,
  })

  it('moves a positional finding into the original frame', () => {
    const cleaned = splice('​ab—c', [{ start: 0, end: 1, to: '' }])
    expect(cleaned.text).toBe('ab—c')

    const moved = rebase(cleaned.frame, finding({ offset: 2, length: 1 }))
    expect(moved.offset).toBe(3)
    expect(moved.length).toBe(1)
  })

  it('gives a document-scoped finding the length of the original', () => {
    // A style tell describes the whole text. Its numbers read like a position
    // and are not one, so they are restated rather than mapped.
    const cleaned = splice('​abc', [{ start: 0, end: 1, to: '' }])

    const moved = rebase(cleaned.frame, finding({ offset: 0, length: 3, scope: 'document' }))
    expect(moved.offset).toBe(0)
    expect(moved.length).toBe(4)
  })
})

describe('the case the module exists for', () => {
  it('reads an em dash offset back through eighty-eight stripped carriers', () => {
    const carriers = '​'.repeat(88)
    const original = `Quarterly results${carriers} are attached — in full.`

    const walk: Splice[] = Array.from({ length: 88 }, (_, index) => ({
      start: 17 + index,
      end: 18 + index,
      to: '',
    }))
    const cleaned = splice(original, walk)
    expect(cleaned.text).toBe('Quarterly results are attached — in full.')

    const inCleaned = cleaned.text.indexOf('—')
    const inOriginal = original.indexOf('—')
    expect(inOriginal - inCleaned).toBe(88)

    expect(span(cleaned.frame, inCleaned, 1)).toEqual({ offset: inOriginal, length: 1 })
  })
})
