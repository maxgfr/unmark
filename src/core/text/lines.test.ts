import { describe, expect, it } from 'vitest'
import { lineIndex } from './lines.ts'

describe('lineIndex', () => {
  it('numbers lines and columns from one', () => {
    const at = lineIndex('first\nsecond\nthird')
    expect(at.locate(0)).toEqual({ line: 1, col: 1 })
    expect(at.locate(4)).toEqual({ line: 1, col: 5 })
    expect(at.locate(6)).toEqual({ line: 2, col: 1 })
    expect(at.locate(13)).toEqual({ line: 3, col: 1 })
  })

  it('places a newline at the end of the line it closes', () => {
    expect(lineIndex('ab\ncd').locate(2)).toEqual({ line: 1, col: 3 })
  })

  it('treats CRLF as one line break', () => {
    const at = lineIndex('one\r\ntwo\r\nthree')
    expect(at.locate(5)).toEqual({ line: 2, col: 1 })
    expect(at.locate(10)).toEqual({ line: 3, col: 1 })
    expect(at.lines).toBe(3)
  })

  it('counts columns in code points, not UTF-16 units', () => {
    // An emoji is two code units and one character on screen. A column that
    // counted units would put everything after it one place too far right.
    const text = 'a\u{1F600}b'
    expect(lineIndex(text).locate(3)).toEqual({ line: 1, col: 3 })
  })

  it('handles a last line with no newline and an empty text', () => {
    expect(lineIndex('x\ny').locate(2)).toEqual({ line: 2, col: 1 })
    expect(lineIndex('').locate(0)).toEqual({ line: 1, col: 1 })
    expect(lineIndex('').lines).toBe(1)
  })

  it('clamps an offset past the end to the last position', () => {
    expect(lineIndex('ab').locate(99)).toEqual({ line: 1, col: 3 })
  })
})
