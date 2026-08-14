import { describe, expect, it } from 'vitest'
import { humanise } from './humanise.ts'
import { normaliseTypography } from './typography.ts'

const cp = (...points: number[]) => String.fromCodePoint(...points)
const EM_DASH = cp(0x2014)
const CURLY_OPEN = cp(0x201c)
const CURLY_CLOSE = cp(0x201d)
const APOSTROPHE = cp(0x2019)
const ELLIPSIS = cp(0x2026)
const GUILLEMET_OPEN = cp(0x00ab)
const GUILLEMET_CLOSE = cp(0x00bb)

describe('normaliseTypography', () => {
  it('replaces em and en dashes', () => {
    const result = normaliseTypography(`The report ${EM_DASH} which was late ${EM_DASH} arrived.`)
    expect(result.output).not.toContain(EM_DASH)
    expect(result.output).toBe('The report - which was late - arrived.')
  })

  it('straightens curly quotes and the ellipsis', () => {
    const text = `He said ${CURLY_OPEN}later${CURLY_CLOSE}${ELLIPSIS} and left.`
    expect(normaliseTypography(text).output).toBe('He said "later"... and left.')
  })

  it('leaves French guillemets alone', () => {
    // Correct French punctuation, not a tell. Straightening it would damage
    // real text in exchange for nothing.
    const french = `Il a dit ${GUILLEMET_OPEN} plus tard ${GUILLEMET_CLOSE} puis il est parti.`
    expect(normaliseTypography(french).output).toBe(french)
  })

  it('can restrict itself to the dash family', () => {
    // The apostrophe in l'été is the right character in French. Someone who
    // only wants the dash tell gone should not lose their apostrophes.
    const text = `Le rapport ${EM_DASH} l${APOSTROPHE}${CURLY_OPEN}test${CURLY_CLOSE}`
    const result = normaliseTypography(text, { tellsOnly: true })
    expect(result.output).not.toContain(EM_DASH)
    expect(result.output).toContain(APOSTROPHE)
    expect(result.output).toContain(CURLY_OPEN)
  })

  it('counts each substitution and never calls it more than informational', () => {
    // Punctuation is a style. It is not evidence of anything, and a verdict
    // above informational would say otherwise.
    const result = normaliseTypography(`a ${EM_DASH} b ${EM_DASH} c`)
    expect(result.findings[0]?.label).toContain('2 ×')
    expect(result.findings.every((f) => f.verdict === 'informational')).toBe(true)
    expect(result.findings.every((f) => f.kind === 'typography')).toBe(true)
  })

  it('does nothing to text that is already plain', () => {
    const plain = 'A sentence with "straight quotes" and a - hyphen.'
    const result = normaliseTypography(plain)
    expect(result.output).toBe(plain)
    expect(result.findings).toEqual([])
  })
})

describe('humanise', () => {
  it('shortens filler phrases', () => {
    const result = humanise('In order to proceed, due to the fact that it was late, we stopped.')
    expect(result.output).toBe('To proceed, because it was late, we stopped.')
  })

  it('keeps the leading capital when a sentence starts with the filler', () => {
    expect(humanise('In order to win, train.').output).toBe('To win, train.')
  })

  it('collapses stacked hedges', () => {
    expect(humanise('It could potentially possibly rain.').output).toBe('It could rain.')
  })

  it('deletes a chat pleasantry whole', () => {
    // There is no shorter form of "I hope this helps!" that belongs in a
    // document, so the sentence goes rather than being trimmed.
    const result = humanise('The revenue rose 4%. I hope this helps! Let me know if you need more.')
    expect(result.output.trim()).toBe('The revenue rose 4%.')
    expect(result.findings.some((f) => f.label.includes('chat pleasantry'))).toBe(true)
  })

  it('deletes signposting', () => {
    const result = humanise("Let's dive into caching. Next.js caches at several layers.")
    expect(result.output.trim()).toBe('Next.js caches at several layers.')
  })

  it('deletes a knowledge-cutoff disclaimer', () => {
    const result = humanise('As of my last training update, the figure was 12. It is now 15.')
    expect(result.output.trim()).toBe('It is now 15.')
  })

  it('strips decorative emoji from headings and bullets', () => {
    const result = humanise('## 🚀 Launch\n- ✅ Done\n- 💡 Idea\n')
    expect(result.output).toBe('## Launch\n- Done\n- Idea\n')
  })

  it('leaves emoji in running prose alone', () => {
    // An emoji in a sentence is the writer talking. Only the decorative one at
    // the head of a heading or a bullet is the pattern.
    const prose = 'The build finally passed 🎉 after three days.'
    expect(humanise(prose).output).toBe(prose)
  })

  it('does not touch ordinary prose', () => {
    const plain = 'The mechanic said the bottom bracket was shot, which explains the noise.'
    const result = humanise(plain)
    expect(result.output).toBe(plain)
    expect(result.findings).toEqual([])
  })

  it('leaves the words it has no correct substitute for', () => {
    // "Delve" and "tapestry" have no one right replacement — rewriting the
    // sentence is the fix, and that needs a writer. The stylometry report
    // counts them; this pass must not guess.
    const flowery = 'Let us delve into this rich tapestry of pivotal moments.'
    expect(humanise(flowery).output).toBe(flowery)
  })

  it('reports what it changed', () => {
    const result = humanise('In order to proceed. I hope this helps.')
    expect(result.findings.length).toBeGreaterThan(0)
    expect(result.findings.every((f) => f.kind === 'ai_phrase')).toBe(true)
  })
})

describe('sentence-start anchoring', () => {
  it('removes a sycophantic opener that is not the first thing in the document', () => {
    // The first draft anchored these to ^, meaning start of *string* — so
    // "Great question!" was only ever caught when it opened the whole file,
    // which it never does.
    const result = humanise('Some context here.\n\nGreat question! The answer is 12.')
    expect(result.output).not.toContain('Great question')
    expect(result.output).toContain('The answer is 12.')
  })

  it('keeps "a great question" where the phrase is the content', () => {
    const sentence = 'That is a great question to put to the committee.'
    expect(humanise(sentence).output).toBe(sentence)
  })

  it('collapses the blank lines a removed paragraph leaves behind', () => {
    const result = humanise('First.\n\nI hope this helps!\n\nSecond.')
    expect(result.output).not.toMatch(/\n{3,}/)
    expect(result.output).toContain('First.')
    expect(result.output).toContain('Second.')
  })

  it('does not collapse a deliberate paragraph break', () => {
    const text = 'First paragraph.\n\nSecond paragraph.'
    expect(humanise(text).output).toBe(text)
  })
})
