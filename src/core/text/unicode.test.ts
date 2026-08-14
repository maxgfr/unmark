// Every character under test is built with String.fromCodePoint, so this file
// is pure ASCII.
//
// A test suite about invisible characters must not contain any. Written as
// literals they are invisible to review; written as \u escapes they are one
// formatter or one copy-paste away from arriving as something else — the first
// draft of this file lost two of them exactly that way. A codepoint number
// cannot be silently rewritten.

import { describe, expect, it } from 'vitest'
import { cleanText, inspectText } from './unicode.ts'

const cp = (...points: number[]) => String.fromCodePoint(...points)

const ZWSP = cp(0x200b)
const ZWNJ = cp(0x200c)
const ZWJ = cp(0x200d)
const WJ = cp(0x2060)
const BOM = cp(0xfeff)
const NBSP = cp(0x00a0)
const THIN = cp(0x2009)
const RLO = cp(0x202e)
const PDF = cp(0x202c)
const VS16 = cp(0xfe0f)
const KEYCAP = cp(0x20e3)
const TAG_A = cp(0xe0041)

/** "password" with a Cyrillic а (U+0430) standing in for the Latin a. */
const SPOOFED = `p${cp(0x0430)}ssword`

const kinds = (text: string, options?: Parameters<typeof inspectText>[1]) =>
  inspectText(text, options).map((f) => f.kind)

describe('carriers', () => {
  it('finds a zero-width space between two ASCII words', () => {
    const findings = inspectText(`hello${ZWSP}world`)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      kind: 'zwj_family',
      verdict: 'confirmed',
      offset: 5,
      length: 1,
    })
    expect(findings[0]?.label).toContain('U+200B')
  })

  it('finds bidi overrides — the Trojan Source trick', () => {
    // Source that renders as one thing and compiles as another. Nothing about
    // an RLO in the middle of ASCII is innocent.
    expect(kinds(`const admin = false;${RLO}// ${PDF}true`)).toEqual(['bidi', 'bidi'])
  })

  it('finds tag characters', () => {
    expect(kinds(`hi${TAG_A}${cp(0xe0042)}`)).toEqual(['tag_chars', 'tag_chars'])
  })

  it('reports astral carriers with their UTF-16 length', () => {
    // Offsets address the string as JavaScript holds it, or a caller splicing
    // by them would cut a surrogate pair in half.
    const [finding] = inspectText(`ab${TAG_A}`)
    expect(finding).toMatchObject({ offset: 2, length: 2 })
  })

  it('finds exotic spaces but does not call them confirmed', () => {
    // A non-breaking space is one keystroke away on a Mac keyboard and is all
    // over French typography. Real, worth showing, not evidence of anything.
    const findings = inspectText(`hello${NBSP}world`)
    expect(findings[0]).toMatchObject({ kind: 'space', verdict: 'probable' })
  })

  it('leaves ordinary text alone', () => {
    expect(inspectText('Just a normal sentence, with punctuation and a dash.')).toEqual([])
  })

  it('ignores confusables unless asked', () => {
    // Aggressive by default would flag every Russian word in a bilingual doc.
    expect(kinds(SPOOFED)).toEqual([])
    expect(kinds(SPOOFED, { confusables: true })).toEqual(['confusable'])
  })

  it('does not flag a confusable in a word that is genuinely Cyrillic', () => {
    // "пароль" is a Russian word, not a spoof of a Latin one. Only a word that
    // mixes scripts is evidence of anything.
    const parol = cp(0x043f, 0x0430, 0x0440, 0x043e, 0x043b, 0x044c)
    expect(kinds(parol, { confusables: true })).toEqual([])
  })
})

describe('preservation', () => {
  it('keeps the zero-width joiner that makes a family one emoji', () => {
    const family = `${cp(0x1f468)}${ZWJ}${cp(0x1f469)}${ZWJ}${cp(0x1f467)}`
    const result = cleanText(family)
    expect(result.output).toBe(family)
    expect(result.preserved).toHaveLength(2)
    expect(result.preserved[0]).toMatchObject({ verdict: 'likely_false_positive' })
    expect(result.preserved[0]?.preserved).toContain('emoji')
  })

  it('keeps the variation selector that makes a glyph render as emoji', () => {
    const text = `warning ${cp(0x2757)}${VS16} now`
    expect(cleanText(text).output).toBe(text)
  })

  it('keeps the variation selector in a keycap sequence', () => {
    const keycap = `1${VS16}${KEYCAP}`
    expect(cleanText(keycap).output).toBe(keycap)
  })

  it('keeps the zero-width non-joiner that is Persian orthography', () => {
    // می‌روم — "I go". The ZWNJ is the word, not a watermark hidden in it.
    const persian = `${cp(0x0645, 0x06cc)}${ZWNJ}${cp(0x0631, 0x0648, 0x0645)}`
    const result = cleanText(persian)
    expect(result.output).toBe(persian)
    expect(result.preserved[0]?.preserved).toMatch(/Arabic|joiner/i)
  })

  it('keeps the joiner that forms a Devanagari conjunct', () => {
    const devanagari = `${cp(0x0915, 0x094d)}${ZWJ}${cp(0x0937)}`
    expect(cleanText(devanagari).output).toBe(devanagari)
  })

  it('keeps the tag sequence that spells a subdivision flag', () => {
    // Scotland: a black flag plus six tag characters that ARE the flag.
    const scotland = cp(0x1f3f4) + cp(0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074) + cp(0xe007f)
    const result = cleanText(scotland)
    expect(result.output).toBe(scotland)
    expect(result.findings).toHaveLength(0)
  })

  it('keeps a byte-order mark at the very start', () => {
    expect(cleanText(`${BOM}hello`).output).toBe(`${BOM}hello`)
  })

  it('strips the same byte-order mark in the middle of a sentence', () => {
    expect(cleanText(`hel${BOM}lo`).output).toBe('hello')
  })

  it('strips the same joiner when it sits between plain ASCII', () => {
    // Identical codepoint, opposite verdict. Context is the whole judgement.
    expect(cleanText(`he${ZWJ}llo`).output).toBe('hello')
  })

  it('paranoid mode strips emoji glue and keeps nothing back', () => {
    const family = `${cp(0x1f468)}${ZWJ}${cp(0x1f469)}`
    const result = cleanText(family, { paranoid: true })
    expect(result.output).toBe(`${cp(0x1f468)}${cp(0x1f469)}`)
    expect(result.preserved).toHaveLength(0)
  })
})

describe('cleanText', () => {
  it('strips carriers and leaves the words untouched', () => {
    const result = cleanText(`The${ZWSP} quick${WJ} brown${BOM} fox`)
    expect(result.output).toBe('The quick brown fox')
    expect(result.findings).toHaveLength(3)
  })

  it('normalizes exotic spaces to a plain space rather than deleting them', () => {
    // Deleting a non-breaking space would join two words. The mark is the
    // exotic codepoint, not the gap it renders as.
    expect(cleanText(`hello${NBSP}world`).output).toBe('hello world')
    expect(cleanText(`a${THIN}b`).output).toBe('a b')
  })

  it('maps a confusable back to its Latin lookalike when asked', () => {
    expect(cleanText(SPOOFED, { confusables: true }).output).toBe('password')
  })

  it('is idempotent — re-inspecting a cleaned string finds nothing', () => {
    // The round-trip that makes the report verifiable rather than a claim.
    const dirty = `A${ZWSP}b${RLO}c${NBSP}d${TAG_A}e${BOM}f`
    const once = cleanText(dirty)
    expect(inspectText(once.output)).toEqual([])
    expect(cleanText(once.output).output).toBe(once.output)
  })

  it('does not touch a string that has nothing in it', () => {
    const clean = 'Perfectly ordinary text.'
    const result = cleanText(clean)
    expect(result.output).toBe(clean)
    expect(result.findings).toEqual([])
    expect(result.preserved).toEqual([])
  })

  it('reports findings in document order', () => {
    const offsets = inspectText(`a${ZWSP}b${ZWNJ}c${WJ}`).map((f) => f.offset)
    expect(offsets).toEqual([...offsets].sort((x, y) => x - y))
  })

  it('keeps offsets addressing the original string, not the cleaned one', () => {
    // A UI highlighting the input needs offsets into what the user pasted.
    const findings = cleanText(`aa${ZWSP}bb${ZWSP}cc`).findings
    expect(findings.map((f) => f.offset)).toEqual([2, 5])
  })
})
