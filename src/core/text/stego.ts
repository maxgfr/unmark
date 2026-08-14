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
import { isLoadBearing } from './unicode.ts'

export type StegoScheme = 'zero-width' | 'tag' | 'variation'

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

/**
 * Every reading of the text that holds up, most plausible first.
 *
 * Returns an empty array far more often than not, which is the point.
 */
export function decodeStego(text: string): StegoDecoding[] {
  return [...decodeZeroWidth(text), ...decodeTag(text), ...decodeVariation(text)].sort(
    (a, b) => b.confidence - a.confidence || a.offset - b.offset,
  )
}

const SCHEME_LABEL: Record<StegoScheme, string> = {
  'zero-width': 'zero-width characters',
  tag: 'Unicode tag characters',
  variation: 'variation selectors',
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
  return findings
}

interface EncodeOptions {
  /** Swap which symbol means 1. Encoders in the wild disagree about this. */
  invert?: boolean
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

  const [zero, one] = options?.invert ? [0x200c, 0x200b] : [0x200b, 0x200c]
  let out = ''
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit -= 1) {
      out += String.fromCodePoint((byte >> bit) & 1 ? (one as number) : (zero as number))
    }
  }
  return out
}
