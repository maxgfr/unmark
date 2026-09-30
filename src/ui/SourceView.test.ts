import { describe, expect, it } from 'vitest'
import { runsOf } from './SourceView.tsx'
import type { Finding } from '../core/report.ts'

const carrier = (offset: number): Finding => ({
  kind: 'zwj_family',
  verdict: 'confirmed',
  offset,
  length: 1,
  label: 'U+200B',
})

describe('runsOf', () => {
  it('splits plain text at passage edges and names the passage of each run', () => {
    const text = 'One two. Three four five. Six.'
    const { runs } = runsOf(text, [], [{ start: 9, end: 25, band: 'high' }])
    expect(runs.map((r) => [r.text, r.band])).toEqual([
      ['One two. ', undefined],
      ['Three four five.', 0],
      [' Six.', undefined],
    ])
  })

  it('keeps a mark drawn inside a passage, and tells it which passage it sits in', () => {
    const text = 'abc​def'
    const { runs } = runsOf(text, [carrier(3)], [{ start: 0, end: 7, band: 'medium' }])
    expect(runs.map((r) => [r.text, r.mark, r.band])).toEqual([
      ['abc', undefined, 0],
      ['​', 0, 0],
      ['def', undefined, 0],
    ])
  })

  it('still bands a decoded payload', () => {
    const text = 'aaaa bbbb'
    const payload: Finding = { ...carrier(0), kind: 'stego_payload', length: 4 }
    const { runs } = runsOf(text, [payload])
    expect(runs.map((r) => [r.text, r.banded])).toEqual([
      ['aaaa', true],
      [' bbbb', false],
    ])
  })
})
