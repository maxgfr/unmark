// Reading what was hidden, not just deleting it.
//
// Every "invisible character remover" on the web strips the carriers and tells
// you it found "hidden characters". That throws away the interesting half: the
// carriers usually *spell something* — an account id, an email, a tracking
// token, the name of whoever leaked the document. Deleting them without reading
// them destroys the only evidence of who marked the text and with what.
//
// So this decodes first. It is deliberately conservative: it would rather
// return nothing than hand back a plausible-looking string it invented out of
// emoji glue, because a decoder that cries wolf is one nobody reads.

import type { Finding } from '../report.ts'
import { EXOTIC_SPACES, isLoadBearing } from './unicode.ts'
import { CONFUSABLES } from './confusables.ts'

export type StegoScheme = 'zero-width' | 'tag' | 'variation' | 'space' | 'trailing' | 'confusable'

export interface StegoDecoding {
  scheme: StegoScheme
  /** The recovered text. */
  payload: string
  /** 0–1. How much of the decoding reads as real text rather than noise. */
  confidence: number
  /** Where the carriers start, as a UTF-16 offset into the input. */
  offset: number
  /** How far the carrier run extends, in UTF-16 code units. */
  length: number
  /** How it was read, in one line, for a report the user can check. */
  detail: string
}

// The five zero-width characters encoders actually use as a symbol alphabet.
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff])
const TAG_BASE = 0xe0000
const isTagPayload = (point: number) => point >= 0xe0020 && point <= 0xe007e
const isVariation = (point: number) =>
  (point >= 0xfe00 && point <= 0xfe0f) || (point >= 0xe0100 && point <= 0xe01ef)

interface Carrier {
  point: number
  offset: number
  width: number
}

/**
 * Collect the carriers of one scheme, skipping any that are doing real work.
 *
 * Scattered, not contiguous: encoders spread carriers between words precisely
 * so that a "suspicious run of characters" check walks past them.
 */
function carriersOf(text: string, belongs: (point: number) => boolean): Carrier[] {
  const found: Carrier[] = []
  let index = 0

  while (index < text.length) {
    const point = text.codePointAt(index)
    if (point === undefined) break
    const width = point > 0xffff ? 2 : 1

    if (belongs(point) && !isLoadBearing(text, index)) {
      found.push({ point, offset: index, width })
    }
    index += width
  }
  return found
}

const span = (carriers: Carrier[]) => {
  const first = carriers[0]
  const last = carriers.at(-1)
  if (!first || !last) return { offset: 0, length: 0 }
  return { offset: first.offset, length: last.offset + last.width - first.offset }
}

/** Printable-text ratio: what fraction of this reads as something a human wrote. */
function score(decoded: string): number {
  if (decoded.length === 0) return 0
  let good = 0
  for (const char of decoded) {
    const point = char.codePointAt(0) ?? 0
    const control = point < 0x20 && char !== '\n' && char !== '\t' && char !== '\r'
    const c1 = point >= 0x7f && point <= 0x9f
    if (!control && !c1 && char !== '�') good += 1
  }
  return good / [...decoded].length
}

const utf8 = new TextDecoder('utf-8', { fatal: false })

function bitsToText(bits: number[]): { text: string; detail: string } | undefined {
  const byteCount = Math.floor(bits.length / 8)
  if (byteCount < 2) return undefined

  const bytes = new Uint8Array(byteCount)
  for (let i = 0; i < byteCount; i += 1) {
    let value = 0
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | (bits[i * 8 + bit] ?? 0)
    bytes[i] = value
  }
  return { text: utf8.decode(bytes), detail: `${byteCount} bytes, MSB first, decoded as UTF-8` }
}

/** All orderings of the observed symbols — which one means 0 is a convention. */
function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += 1) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of permutations(rest)) out.push([items[i] as T, ...tail])
  }
  return out
}

function decodeZeroWidth(text: string): StegoDecoding[] {
  const carriers = carriersOf(text, (point) => ZERO_WIDTH.has(point))
  if (carriers.length < 8) return []

  const alphabet = [...new Set(carriers.map((c) => c.point))].sort((a, b) => a - b)
  // One symbol carries no information: a run of identical carriers is a run of
  // identical carriers, not a message. More than four and this is not a
  // fixed-alphabet encoding we know how to read.
  if (alphabet.length < 2 || alphabet.length > 4) return []

  const bitsPerSymbol = alphabet.length <= 2 ? 1 : 2
  const { offset, length } = span(carriers)
  const results: StegoDecoding[] = []

  for (const ordering of permutations(alphabet)) {
    const rank = new Map(ordering.map((point, value) => [point, value]))
    const bits: number[] = []
    for (const carrier of carriers) {
      const value = rank.get(carrier.point) ?? 0
      for (let bit = bitsPerSymbol - 1; bit >= 0; bit -= 1) bits.push((value >> bit) & 1)
    }

    const decoded = bitsToText(bits)
    if (!decoded) continue

    const confidence = score(decoded.text)
    // A payload that is mostly control bytes is a wrong reading, not a find.
    if (confidence < 0.9 || decoded.text.length < 2) continue

    results.push({
      scheme: 'zero-width',
      payload: decoded.text,
      confidence,
      offset,
      length,
      detail: `${carriers.length} zero-width carriers over a ${alphabet.length}-symbol alphabet, ${decoded.detail}`,
    })
  }

  return results
}

function decodeTag(text: string): StegoDecoding[] {
  const carriers = carriersOf(text, isTagPayload)
  if (carriers.length < 2) return []

  const payload = carriers.map((c) => String.fromCodePoint(c.point - TAG_BASE)).join('')
  const confidence = score(payload)
  if (confidence < 0.9) return []

  const { offset, length } = span(carriers)
  return [
    {
      scheme: 'tag',
      payload,
      // Tag characters map one-to-one onto ASCII. There is no guessing here,
      // which is why this is the one scheme that can be certain.
      confidence: 1,
      offset,
      length,
      detail: `${carriers.length} Unicode tag characters, each one ASCII plus U+E0000`,
    },
  ]
}

function decodeVariation(text: string): StegoDecoding[] {
  const carriers = carriersOf(text, isVariation)
  if (carriers.length < 2) return []

  const bytes = new Uint8Array(
    carriers.map(({ point }) => (point <= 0xfe0f ? point - 0xfe00 : point - 0xe0100 + 16)),
  )
  const payload = utf8.decode(bytes)
  const confidence = score(payload)
  if (confidence < 0.9 || payload.length < 2) return []

  const { offset, length } = span(carriers)
  return [
    {
      scheme: 'variation',
      payload,
      confidence,
      offset,
      length,
      detail: `${carriers.length} variation selectors, one byte each, decoded as UTF-8`,
    },
  ]
}

const PLAIN_SPACE = 0x20

/** Where every space in the text is, and which kind it is. */
function spaceRun(text: string): { point: number; offset: number }[] {
  const run: { point: number; offset: number }[] = []
  for (let index = 0; index < text.length; index += 1) {
    const point = text.codePointAt(index)
    if (point === undefined) break
    if (point === PLAIN_SPACE || EXOTIC_SPACES.has(point)) run.push({ point, offset: index })
  }
  return run
}

/**
 * A payload spelled in the choice of space character.
 *
 * The homoglyph scheme: leave an ordinary U+0020 to mean one bit and substitute
 * a three-per-em (U+2004) or an ideographic space (U+3000) to mean the other.
 * No renderer shows a difference, and unlike the zero-width family the carriers
 * are not extra characters — the text has exactly the spaces it should have, so
 * a check that only counts invisible characters walks straight past it.
 */
function decodeSpaces(text: string): StegoDecoding[] {
  const run = spaceRun(text)
  if (run.length < 16) return []

  const exotic = [...new Set(run.map((s) => s.point))].filter((point) => point !== PLAIN_SPACE)
  // One substitute makes a binary alphabet. Several at once is not a scheme
  // this knows how to read, and guessing at one would invent a payload.
  if (exotic.length !== 1) return []

  const marker = exotic[0] as number
  if (!run.some((s) => s.point === PLAIN_SPACE)) return []

  const first = run[0]
  const last = run.at(-1)
  if (!first || !last) return []

  const results: StegoDecoding[] = []
  for (const oneIsExotic of [true, false]) {
    const bits = run.map((s) => ((s.point === marker) === oneIsExotic ? 1 : 0))
    const decoded = bitsToText(bits)
    if (!decoded) continue

    const confidence = score(decoded.text)
    if (confidence < 0.9 || decoded.text.length < 2) continue

    results.push({
      scheme: 'space',
      payload: decoded.text,
      confidence,
      offset: first.offset,
      length: last.offset - first.offset + 1,
      detail: `${run.length} spaces, U+${marker.toString(16).toUpperCase().padStart(4, '0')} against U+0020, ${decoded.detail}`,
    })
  }
  return results
}

/**
 * Trailing runs that form a tab-and-space alphabet, and are therefore a carrier.
 *
 * Deliberately narrow. Trailing whitespace is everywhere and mostly means an
 * editor was not configured to trim it — and in Markdown two trailing spaces
 * are a hard line break, so removing them changes how the document renders.
 * Only the mixed alphabet is a scheme, and only that is removed.
 */
export function trailingCarrierRuns(text: string): { index: number; length: number }[] {
  const runs = [...text.matchAll(/[ \t]+(?=\n|$)/g)]
  const symbols = runs.flatMap((run) => [...run[0]])
  if (symbols.length < 16) return []

  const distinct = new Set(symbols)
  if (distinct.size !== 2 || !distinct.has('\t') || !distinct.has(' ')) return []

  return runs.map((run) => ({ index: run.index, length: run[0].length }))
}

export interface SpaceCadence {
  /** The substituted codepoint. */
  point: number
  /** How many spaces apart the substitutions fall. */
  stride: number
  /** How many substitutions were found. */
  count: number
}

/**
 * Substituted spaces falling at a regular interval.
 *
 * "Every third space is a three-per-em" is not something a keyboard produces.
 * A single non-breaking space is ambiguous — French typography is full of them
 * — but a periodic one is structural, and periodicity is the difference between
 * reporting a curiosity and reporting a mark.
 */
export function detectSpaceCadence(text: string): SpaceCadence | undefined {
  const run = spaceRun(text)
  if (run.length < 12) return undefined

  const exotic = [...new Set(run.map((s) => s.point))].filter((point) => point !== PLAIN_SPACE)
  if (exotic.length !== 1) return undefined

  const marker = exotic[0] as number
  const positions = run.flatMap((s, i) => (s.point === marker ? [i] : []))
  if (positions.length < 4) return undefined

  const gaps: number[] = []
  for (let i = 1; i < positions.length; i += 1) {
    gaps.push((positions[i] as number) - (positions[i - 1] as number))
  }

  const stride = gaps[0] as number
  // Every gap identical, and the substitution is not simply every space.
  if (stride < 2 || !gaps.every((gap) => gap === stride)) return undefined

  return { point: marker, stride, count: positions.length }
}

const TAB = 0x09

/**
 * A payload in the whitespace nobody looks at: the end of each line.
 *
 * The SNOW family, and Shiu's variant for social media. Trailing spaces and
 * tabs are stripped by most editors and shown by none, so a run of them at the
 * end of a line is both invisible and, unlike a zero-width character, made of
 * entirely ordinary codepoints — nothing about a tab is suspicious until you
 * notice it is at the end of a line and carrying bits.
 */
function decodeTrailing(text: string): StegoDecoding[] {
  const runs = [...text.matchAll(/[ \t]+(?=\n|$)/g)]
  if (runs.length === 0) return []

  const symbols: number[] = []
  for (const run of runs) {
    for (const char of run[0]) symbols.push(char.codePointAt(0) ?? 0)
  }
  if (symbols.length < 16) return []

  const distinct = new Set(symbols)
  // A run of plain spaces is a sloppy editor. A mix of tab and space at the end
  // of a line is an alphabet.
  if (distinct.size !== 2 || !distinct.has(TAB) || !distinct.has(PLAIN_SPACE)) return []

  const first = runs[0]
  const last = runs.at(-1)
  if (!first || !last) return []

  const results: StegoDecoding[] = []
  for (const oneIsTab of [true, false]) {
    const bits = symbols.map((point) => ((point === TAB) === oneIsTab ? 1 : 0))
    const decoded = bitsToText(bits)
    if (!decoded) continue

    const confidence = score(decoded.text)
    if (confidence < 0.9 || decoded.text.length < 2) continue

    results.push({
      scheme: 'trailing',
      payload: decoded.text,
      confidence,
      offset: first.index,
      length: last.index + last[0].length - first.index,
      detail: `${symbols.length} trailing tabs and spaces across ${runs.length} line ends, ${decoded.detail}`,
    })
  }
  return results
}

// Which Latin letters have a lookalike, and which codepoints are those
// lookalikes. Derived from the substitution table rather than restated, so the
// two cannot drift apart.
const LOOKALIKE_OF = (() => {
  const byLatin = new Map<string, Set<number>>()
  for (const [point, latin] of CONFUSABLES) {
    const existing = byLatin.get(latin)
    if (existing) existing.add(point)
    else byLatin.set(latin, new Set([point]))
  }
  return byLatin
})()

/**
 * A payload in which letters are Latin and which are lookalikes.
 *
 * The LookALikes and Rizzo schemes. Every position that *could* be substituted
 * carries a bit: the real Latin letter is one value, its Cyrillic or Greek twin
 * is the other. The text reads normally and contains no unusual characters at
 * all — only unusual choices among ordinary ones.
 */
function decodeConfusables(text: string): StegoDecoding[] {
  const slots: { bit: number; offset: number }[] = []

  for (let index = 0; index < text.length; index += 1) {
    const point = text.codePointAt(index)
    if (point === undefined) break
    const char = String.fromCodePoint(point)

    if (LOOKALIKE_OF.has(char)) slots.push({ bit: 0, offset: index })
    else if (CONFUSABLES.has(point)) slots.push({ bit: 1, offset: index })
  }

  if (slots.length < 16) return []
  // All Latin means an ordinary sentence, which is most sentences.
  if (!slots.some((slot) => slot.bit === 1)) return []

  const first = slots[0]
  const last = slots.at(-1)
  if (!first || !last) return []

  const results: StegoDecoding[] = []
  for (const invert of [false, true]) {
    const decoded = bitsToText(slots.map((slot) => (invert ? 1 - slot.bit : slot.bit)))
    if (!decoded) continue

    const confidence = score(decoded.text)
    if (confidence < 0.9 || decoded.text.length < 2) continue

    results.push({
      scheme: 'confusable',
      payload: decoded.text,
      confidence,
      offset: first.offset,
      length: last.offset - first.offset + 1,
      detail: `${slots.length} substitutable letters, lookalike against Latin, ${decoded.detail}`,
    })
  }
  return results
}

/**
 * Every reading of the text that holds up, most plausible first.
 *
 * Returns an empty array far more often than not, which is the point.
 */
export function decodeStego(text: string): StegoDecoding[] {
  return [
    ...decodeZeroWidth(text),
    ...decodeTag(text),
    ...decodeVariation(text),
    ...decodeSpaces(text),
    ...decodeTrailing(text),
    ...decodeConfusables(text),
  ].sort((a, b) => b.confidence - a.confidence || a.offset - b.offset)
}

const SCHEME_LABEL: Record<StegoScheme, string> = {
  'zero-width': 'zero-width characters',
  tag: 'Unicode tag characters',
  variation: 'variation selectors',
  space: 'the choice of space character',
  trailing: 'trailing tabs and spaces at line ends',
  confusable: 'the choice between Latin letters and their lookalikes',
}

/** The best reading per scheme, as findings for the report. */
export function stegoFindings(text: string): Finding[] {
  const seen = new Set<StegoScheme>()
  const findings: Finding[] = []

  for (const decoding of decodeStego(text)) {
    if (seen.has(decoding.scheme)) continue
    seen.add(decoding.scheme)
    findings.push({
      kind: 'stego_payload',
      verdict: decoding.confidence === 1 ? 'confirmed' : 'probable',
      offset: decoding.offset,
      length: decoding.length,
      label: `Hidden payload encoded in ${SCHEME_LABEL[decoding.scheme]}`,
      evidence: decoding.payload,
    })
  }

  // A periodic substitution is structural even when it decodes to nothing: the
  // pattern may carry a flag rather than a message, and "every third space is a
  // three-per-em" is not a thing a keyboard does.
  const cadence = detectSpaceCadence(text)
  if (cadence && !seen.has('space')) {
    const name = `U+${cadence.point.toString(16).toUpperCase().padStart(4, '0')}`
    findings.push({
      kind: 'space',
      verdict: 'confirmed',
      offset: 0,
      length: text.length,
      label: `Every ${cadence.stride}${cadence.stride === 2 ? 'nd' : cadence.stride === 3 ? 'rd' : 'th'} space is ${name}`,
      evidence: `${cadence.count} substitutions at a constant interval — a pattern, not typing`,
    })
  }

  return findings
}

interface EncodeOptions {
  /** Swap which symbol means 1. Encoders in the wild disagree about this. */
  invert?: boolean
  /**
   * For the `space` scheme: which space stands in for U+0020. Defaults to the
   * three-per-em space, the substitution seen most often in the wild.
   */
  marker?: number
}

/**
 * The inverse, so a round trip can be asserted rather than assumed.
 *
 * Also what the app uses to build the demo payload on the Text tab: showing
 * someone a marked string they can then watch being decoded explains the threat
 * far better than a paragraph about it.
 */
export function encodeStego(payload: string, scheme: StegoScheme, options?: EncodeOptions): string {
  const bytes = new TextEncoder().encode(payload)

  if (scheme === 'tag') {
    return [...payload]
      .map((char) => String.fromCodePoint(TAG_BASE + (char.codePointAt(0) ?? 0)))
      .join('')
  }

  if (scheme === 'variation') {
    return [...bytes]
      .map((byte) => String.fromCodePoint(byte < 16 ? 0xfe00 + byte : 0xe0100 + byte - 16))
      .join('')
  }

  // These schemes spell their payload in ordinary characters rather than in
  // extra ones, so what comes back is whitespace, meaningful only where the
  // scheme puts it: between words for `space`, at a line end for `trailing`.
  const alphabet =
    scheme === 'space'
      ? [PLAIN_SPACE, options?.marker ?? 0x2004]
      : scheme === 'trailing'
        ? [PLAIN_SPACE, TAB]
        : [0x200b, 0x200c]

  const [zero, one] = options?.invert ? [alphabet[1], alphabet[0]] : alphabet

  let out = ''
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      out += String.fromCodePoint((byte >> bit) & 1 ? (one as number) : (zero as number))
    }
  }
  return out
}
