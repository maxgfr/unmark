// Pure ASCII, like unicode.test.ts: every carrier is built from a codepoint.

import { describe, expect, it } from 'vitest'
import { decodeStego, detectSpaceCadence, encodeStego, stegoFindings } from './stego.ts'

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

// The homoglyph-space family, from Sean Goedecke's survey of text watermarking:
// leave an ordinary U+0020 for one bit and substitute a three-per-em (U+2004)
// or an ideographic space (U+3000) for the other. Nothing renders differently,
// and unlike the zero-width schemes the text has exactly the spaces it should —
// so a check that counts invisible characters finds nothing at all.
describe('homoglyph spaces', () => {
  const THREE_PER_EM = 0x2004
  const IDEOGRAPHIC = 0x3000

  it('round-trips a payload spelled in the choice of space', () => {
    const carriers = encodeStego('leak-882', 'space')
    const [best] = decodeStego(`report${carriers}end`)
    expect(best?.payload).toBe('leak-882')
    expect(best?.scheme).toBe('space')
  })

  it('reads the inverted bit assignment', () => {
    const carriers = encodeStego('leak-882', 'space', { invert: true })
    expect(decodeStego(carriers)[0]?.payload).toBe('leak-882')
  })

  it('reads an ideographic space as the marker just as readily', () => {
    const carriers = encodeStego('cjk-77', 'space', { marker: IDEOGRAPHIC })
    const [best] = decodeStego(carriers)
    expect(best?.payload).toBe('cjk-77')
    expect(best?.detail).toContain('U+3000')
  })

  it('names which codepoint was standing in for a space', () => {
    expect(decodeStego(encodeStego('x-1', 'space'))[0]?.detail).toContain('U+2004')
  })

  it('finds nothing in ordinary prose with ordinary spaces', () => {
    const plain = 'The quick brown fox jumps over the lazy dog and then does it again today.'
    expect(decodeStego(plain).filter((d) => d.scheme === 'space')).toEqual([])
  })

  it('refuses to guess when several substitutes are mixed', () => {
    // Two different exotic spaces is not a binary alphabet. Picking one would
    // be inventing a scheme the text does not use.
    const mixed = `a${cp(THREE_PER_EM)}b${cp(IDEOGRAPHIC)}c d e f g h i j k l m n o p`
    expect(decodeStego(mixed).filter((d) => d.scheme === 'space')).toEqual([])
  })
})

describe('detectSpaceCadence', () => {
  const THREE_PER_EM = 0x2004

  /** "Every third space is a three-per-em" — the article's own example. */
  const periodic = (stride: number, words: number) =>
    Array.from({ length: words }, (_, i) => `w${i}`)
      .map((word, i) => (i > 0 && i % stride === 0 ? cp(THREE_PER_EM) + word : ` ${word}`))
      .join('')
      .trim()

  it('finds a substitution falling at a constant interval', () => {
    const cadence = detectSpaceCadence(periodic(3, 40))
    expect(cadence).toBeDefined()
    expect(cadence?.stride).toBe(3)
    expect(cadence?.point).toBe(THREE_PER_EM)
    expect(cadence?.count).toBeGreaterThan(3)
  })

  it('finds nothing when the spaces are all ordinary', () => {
    expect(
      detectSpaceCadence('one two three four five six seven eight nine ten eleven twelve'),
    ).toBeUndefined()
  })

  it('finds nothing when the substitutions are irregular', () => {
    // A stray non-breaking space here and there is French typography, not a
    // mark. Only the regularity makes it evidence.
    const irregular = `a${cp(0x00a0)}b c d${cp(0x00a0)}e f g h i j k${cp(0x00a0)}l m n o p q r`
    expect(detectSpaceCadence(irregular)).toBeUndefined()
  })

  it('needs enough spaces to call an interval an interval', () => {
    expect(detectSpaceCadence(`a${cp(THREE_PER_EM)}b c`)).toBeUndefined()
  })

  it('reports a periodic substitution as confirmed', () => {
    // The point of measuring periodicity: one exotic space is ambiguous, a
    // periodic one is structural, and the verdict should say so.
    const finding = stegoFindings(periodic(3, 40)).find((f) => f.kind === 'space')
    expect(finding).toMatchObject({ verdict: 'confirmed' })
    expect(finding?.label).toContain('U+2004')
    expect(finding?.label).toContain('Every 3rd space')
  })
})

// The remaining families from the Unicode-watermarking survey (arXiv 2512.13325):
// SNOW and Shiu hide bits in trailing whitespace, LookALikes and Rizzo hide them
// in the choice between a Latin letter and its Cyrillic or Greek twin. Neither
// inserts an unusual character — the text contains only ordinary ones, in
// unusual arrangements — so a check that hunts invisible codepoints sees nothing.
describe('trailing whitespace', () => {
  const TAB = '\t'

  /** SNOW-style: the payload's bits parked past the end of each line. */
  const withTrailing = (payload: string) => {
    const bits = encodeStego(payload, 'trailing')
    const perLine = 8
    let out = ''
    for (let i = 0; i < bits.length; i += perLine) {
      out += `line ${i / perLine}${bits.slice(i, i + perLine)}\n`
    }
    return out
  }

  it('round-trips a payload parked past the end of the line', () => {
    const [best] = decodeStego(withTrailing('snow-41'))
    expect(best?.payload).toBe('snow-41')
    expect(best?.scheme).toBe('trailing')
  })

  it('says how many line ends were carrying it', () => {
    expect(decodeStego(withTrailing('snow-41'))[0]?.detail).toMatch(/across \d+ line ends/)
  })

  it('ignores a file that is merely sloppy about trailing spaces', () => {
    // Trailing spaces are everywhere. Only a tab-and-space alphabet is a scheme.
    const sloppy = 'one   \ntwo    \nthree  \nfour     \nfive   \nsix    \nseven   \neight  \n'
    expect(decodeStego(sloppy).filter((d) => d.scheme === 'trailing')).toEqual([])
  })

  it('ignores tabs that are indentation rather than trailing', () => {
    const indented = `${TAB}const a = 1\n${TAB}${TAB}return a\n`.repeat(8)
    expect(decodeStego(indented).filter((d) => d.scheme === 'trailing')).toEqual([])
  })
})

describe('confusable letters', () => {
  /** LookALikes-style: bits spelled in Latin "a" against Cyrillic "а". */
  const withConfusables = (payload: string) => {
    const bytes = new TextEncoder().encode(payload)
    const bits: number[] = []
    for (const byte of bytes) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1)
    // Each bit rides on one letter: Latin a for 0, Cyrillic а (U+0430) for 1.
    return bits.map((bit) => (bit ? cp(0x0430) : 'a')).join('')
  }

  it('round-trips a payload spelled in lookalike letters', () => {
    const [best] = decodeStego(withConfusables('rizzo-9'))
    expect(best?.payload).toBe('rizzo-9')
    expect(best?.scheme).toBe('confusable')
  })

  it('finds nothing in ordinary Latin prose', () => {
    const plain = 'A perfectly ordinary sentence with no substitutions anywhere in it at all.'
    expect(decodeStego(plain).filter((d) => d.scheme === 'confusable')).toEqual([])
  })

  it('finds nothing in text that is simply Cyrillic', () => {
    const russian = cp(0x043f, 0x0430, 0x0440, 0x043e, 0x043b, 0x044c).repeat(6)
    expect(decodeStego(russian).filter((d) => d.scheme === 'confusable')).toEqual([])
  })
})

describe('payloads embedded in real sentences', () => {
  // The case that matters and that the first draft got wrong: a payload sitting
  // inside prose rather than alone. One ordinary space in the sentence before
  // the carriers shifts every bit by one and the whole thing decodes to noise.
  it('reads a space-scheme payload surrounded by ordinary prose', () => {
    const carriers = encodeStego('spaced-77', 'space')
    const [best] = decodeStego(`Internal memo. Do not forward.${carriers}Regards, the desk.`)
    expect(best?.payload).toBe('spaced-77')
  })

  it('reads a confusable payload surrounded by ordinary prose', () => {
    const bytes = new TextEncoder().encode('rizzo-9')
    const bits: number[] = []
    for (const byte of bytes) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1)
    const carriers = bits.map((bit) => (bit ? cp(0x0430) : 'a')).join('')

    // "attached" and "a" both contribute substitutable letters before the run.
    const [best] = decodeStego(`a memo attached${carriers} and nothing else`)
    expect(best?.payload).toBe('rizzo-9')
  })

  it('still reads a payload substituted one-for-one across a whole document', () => {
    // The other real shape: Innamark replaces every space in the document, so
    // the whole sequence is the message and there is no contiguous run at all.
    const bytes = new TextEncoder().encode('doc-5')
    const bits: number[] = []
    for (const byte of bytes) for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1)
    // One more word than there are bits: N gaps need N+1 words.
    const words = Array.from({ length: bits.length + 1 }, (_, i) => `w${i}`)
    const text = words
      .map((word, i) => (i === 0 ? word : `${cp(bits[i - 1] ? 0x2004 : 0x20)}${word}`))
      .join('')

    expect(decodeStego(text)[0]?.payload).toBe('doc-5')
  })
})
