// What every container handler agrees to do.
//
// A "container" here is any file that carries metadata alongside its content:
// a PNG with text chunks, a DOCX with document properties, an HTML page with a
// generator tag. The content is none of our business — the point of this half
// of the tool is that stripping provenance must not re-encode, recompress or
// otherwise touch the pixels or the prose.

import type { Finding } from '../report.ts'

export interface ContainerResult {
  output: Uint8Array
  /** Metadata that was removed. */
  findings: Finding[]
  /** Metadata matched but deliberately kept, with the reason on each. */
  preserved: Finding[]
  /**
   * What was looked at, one line each, whether or not anything turned up.
   *
   * "Nothing found" and "not looked for" read the same in a list of findings,
   * and only the first is reassuring. A PDF whose images were never opened is
   * the case that made this necessary: its report showed `/Info` and nothing
   * else, and nobody could tell whether a manifest had been lost on export or
   * simply not searched for. Not findings, so `audit` does not count them.
   */
  coverage?: string[]
  /** Every picture in a document, with where it sits, marked or not. */
  media?: MediaEntry[]
}

export interface MediaEntry {
  /** The part inside the package: `word/media/image24.png`. */
  part: string
  /** The paragraph that anchors it, from 1 in document order; absent when the body never uses it. */
  paragraph?: number
  /** The caption beside it — "Figure 4. …" — when one is near enough to be its own. */
  caption?: string
  /** How many findings the picture itself carries. */
  marks: number
  /** The C2PA classification when the picture carries a manifest. */
  c2pa?: string
}

export const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((byte, i) => bytes[i] === byte)

export const ascii = (bytes: Uint8Array, offset: number, length: number): string =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))

/** Big-endian, which is what every image container in here uses. */
export const readU32 = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) << 24) |
  ((bytes[offset + 1] ?? 0) << 16) |
  ((bytes[offset + 2] ?? 0) << 8) |
  (bytes[offset + 3] ?? 0)

export const readU32LE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)) >>>
  0

export const writeU32LE = (bytes: Uint8Array, offset: number, value: number): void => {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

export const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
export const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { fatal: false }).decode(bytes)

/**
 * Trim a metadata value so a report line stays one line.
 *
 * Collapsing whitespace is not cosmetic: a raw newline inside a value would
 * break the alignment of every row after it in a terminal table.
 */
export const snippet = (value: string, limit = 120): string => {
  const flat = value.replaceAll(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}
