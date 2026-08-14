// Pure ASCII, like unicode.test.ts: every carrier is built from a codepoint.

import { describe, expect, it } from 'vitest'
import { decodeStego, encodeStego, stegoFindings } from './stego.ts'

const cp = (...points: number[]) => String.fromCodePoint(...points)
const ZWJ = cp(0x200d)

describe('round trips', () => {
  it.each(['hello', 'unmark', 'user-4417@example.com', 'Ünïcödé påylöad', ''])(
    'survives a zero-width binary round trip: %j',
    (payload) => {
      const carriers = encodeStego(payload, 'zero-width')
      const [best] = decodeStego(`before ${carriers}after`)
      expect(best?.payload ?? '').toBe(payload)
    },
  )

  it('survives a tag-character round trip', () => {
    const carriers = encodeStego('leaked-id-91', 'tag')
    const [best] = decodeStego(`Nothing to see here.${carriers}`)
    expect(best?.payload).toBe('leaked-id-91')
    expect(best?.scheme).toBe('tag')
  })

  it('survives a variation-selector round trip', () => {
    const carriers = encodeStego('watch me', 'variation')
    const [best] = decodeStego(`A${carriers}`)
    expect(best?.payload).toBe('watch me')
    expect(best?.scheme).toBe('variation')
  })
})

describe('decoding', () => {
  it('reads a payload written with the inverted bit assignment', () => {
    // Encoders disagree about which zero-width character means 1. Trying only
    // one assignment would miss half the payloads in the wild.
    const inverted = encodeStego('secret', 'zero-width', { invert: true })
    const [best] = decodeStego(inverted)
    expect(best?.payload).toBe('secret')
  })

  it('locates the carrier run in the original string', () => {
    const prefix = 'The quick brown fox '
    const [best] = decodeStego(prefix + encodeStego('id', 'zero-width'))
    expect(best?.offset).toBe(prefix.length)
    expect(best?.length).toBeGreaterThan(0)
  })

  it('ranks the most plausible reading first', () => {
    const [best] = decodeStego(encodeStego('plaintext', 'zero-width'))
    expect(best?.confidence).toBeGreaterThan(0.9)
  })

  it('reads a payload split across the sentence it hides in', () => {
    // Real encoders scatter carriers between words rather than dumping them in
    // one block, precisely so a "strange run of characters" check misses them.
    const bits = encodeStego('split', 'zero-width')
    const scattered = [...bits].map((carrier, i) => `w${i} ${carrier}`).join('')
    expect(decodeStego(scattered)[0]?.payload).toBe('split')
  })
})

describe('restraint', () => {
  it('finds nothing in ordinary prose', () => {
    expect(decodeStego('A perfectly ordinary sentence, nothing hidden.')).toEqual([])
  })

  it('does not invent a payload from emoji glue', () => {
    // Three ZWJ in a row are a family emoji, not two bytes. Reporting a payload
    // here would be the tool crying wolf on the most common emoji on earth.
    const family = `${cp(0x1f468)}${ZWJ}${cp(0x1f469)}${ZWJ}${cp(0x1f467)}`
    expect(decodeStego(family)).toEqual([])
  })

  it('does not invent a payload from a single stray carrier', () => {
    expect(decodeStego(`a${cp(0x200b)}b`)).toEqual([])
  })

  it('does not report a run that decodes to control characters', () => {
    // A run of identical carriers decodes to NUL bytes. That is a run of
    // identical carriers, not a message.
    expect(decodeStego(cp(0x200b).repeat(64))).toEqual([])
  })

  it('does not treat a subdivision flag as a tag payload', () => {
    const scotland = cp(0x1f3f4) + cp(0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074) + cp(0xe007f)
    expect(decodeStego(scotland)).toEqual([])
  })
})

describe('stegoFindings', () => {
  it('reports a decoded payload as confirmed, with the payload as evidence', () => {
    const [finding] = stegoFindings(`hi ${encodeStego('tracked-user-7', 'zero-width')}`)
    expect(finding).toMatchObject({ kind: 'stego_payload', verdict: 'confirmed' })
    expect(finding?.evidence).toContain('tracked-user-7')
  })

  it('reports nothing for clean text', () => {
    expect(stegoFindings('Clean.')).toEqual([])
  })
})
