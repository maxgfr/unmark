// The box tree: how to read one, how to write its header back, and where the
// bytes it used to occupy went.
//
// A box is a 32-bit big-endian size, a four-byte type, then a payload. Two
// escapes have to be honoured or nothing else works: size 1 means the real
// 64-bit size follows the type, and size 0 means the box runs to the end of the
// file. Both turn up in real files — the first in any video over 4 GB, the
// second in anything a muxer streamed to a pipe.
//
// `shifted` lives here too, because it answers a question about the tree rather
// than about any one format: given the ranges a rewrite cut out, where does an
// offset recorded in the original file land in the new one.

import { ascii, readU32 } from '../types.ts'

// ------------------------------------------------------------------ numbers

/** Big-endian read of 0, 2, 4 or 8 bytes. Multiplication, because `<<` is 32-bit. */
export function readUint(bytes: Uint8Array, offset: number, size: number): number {
  let value = 0
  for (let i = 0; i < size; i += 1) value = value * 256 + (bytes[offset + i] ?? 0)
  return value
}

export function writeUint(bytes: Uint8Array, offset: number, size: number, value: number): void {
  let rest = value
  for (let i = size - 1; i >= 0; i -= 1) {
    bytes[offset + i] = rest % 256
    rest = Math.floor(rest / 256)
  }
}

export const hex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')

// -------------------------------------------------------------------- boxes

export interface Box {
  type: string
  /** Where the size field starts. */
  start: number
  /** One past the box's last byte. */
  end: number
  /** Where the payload starts: past the size, the type, any 64-bit size and any UUID. */
  body: number
  /** Lowercase hex of the 16 bytes a `uuid` box carries, or '' for every other box. */
  uuid: string
}

/**
 * Read one box, or nothing if the bytes at `start` are not a whole box.
 *
 * Returning undefined rather than throwing is what makes a truncated file safe:
 * the caller copies whatever is left verbatim instead of losing it.
 */
export function readBox(bytes: Uint8Array, start: number, limit: number): Box | undefined {
  if (start + 8 > limit) return undefined

  const declared = readU32(bytes, start) >>> 0
  const type = ascii(bytes, start + 4, 4)
  let header = 8
  let size = declared

  if (declared === 1) {
    if (start + 16 > limit) return undefined
    size = readUint(bytes, start + 8, 8)
    header = 16
  } else if (declared === 0) {
    size = limit - start
  }

  let uuid = ''
  if (type === 'uuid') {
    if (start + header + 16 > limit) return undefined
    uuid = hex(bytes.subarray(start + header, start + header + 16))
    header += 16
  }

  if (size < header || start + size > limit) return undefined
  return { type, start, end: start + size, body: start + header, uuid }
}

export const headerLength = (box: Box): number => box.body - box.start

/** The box's own header bytes, with a new size written into whichever field holds it. */
export function rewriteHeader(bytes: Uint8Array, box: Box, size: number): Uint8Array {
  // A copy: the 64-bit and UUID fields are re-emitted as they were, and writing
  // into a subarray would reach back into the caller's buffer.
  const header = bytes.slice(box.start, box.body)
  if (readU32(bytes, box.start) >>> 0 === 1) writeUint(header, 8, 8, size)
  else writeUint(header, 0, 4, size)
  return header
}

/** Whether a plain box starts here — used to tell the two `meta` layouts apart. */
function looksLikeBox(bytes: Uint8Array, at: number, limit: number): boolean {
  if (at + 8 > limit) return false
  const size = readU32(bytes, at) >>> 0
  if (size < 8 || at + size > limit) return false
  return [...bytes.subarray(at + 4, at + 8)].every((byte) => byte >= 0x20 && byte < 0x7f)
}

/**
 * Where a `meta` box's children begin.
 *
 * `meta` is a FullBox in ISO/IEC 14496-12: one version byte and three flag bytes
 * sit between the header and the first child. QuickTime's `meta`, which .mov
 * files still write, has no such field. Reading the wrong one shifts every child
 * by four bytes, which is the classic ISOBMFF bug — the walk then finds either
 * garbage, and gives up on a file it could have cleaned, or a box type that
 * happens to appear four bytes off and mangles the file. So look before
 * skipping: if a whole box starts at the payload, this is QuickTime's layout.
 */
const metaChildren = (bytes: Uint8Array, box: Box): number =>
  looksLikeBox(bytes, box.body, box.end) ? box.body : box.body + 4

/** Boxes whose payload is nothing but more boxes. Everything else is a leaf. */
const CONTAINERS = new Set([
  'moov',
  'trak',
  'udta',
  'meta',
  'iprp',
  'ipco',
  'mdia',
  'minf',
  'stbl',
  'ilst',
  'edts',
])

/**
 * Where this box's children start, or undefined if it is a leaf.
 *
 * `iinf` and `iref` are containers with a preamble: `iinf` counts its `infe`
 * children in a field that has to be rewritten when one goes, and `iref`'s
 * version decides how wide the item ids in its children are.
 */
export function containerChildren(bytes: Uint8Array, box: Box): number | undefined {
  if (box.type === 'meta') return metaChildren(bytes, box)
  if (box.type === 'iinf') return box.body + 4 + ((bytes[box.body] ?? 0) === 0 ? 2 : 4)
  if (box.type === 'iref') return box.body + 4
  if (CONTAINERS.has(box.type)) return box.body
  return undefined
}

export interface Found {
  box: Box
  /** The type of the box this one sits in, or '' at the top level. */
  parent: string
  /** Where that parent's header starts, so two same-named parents stay distinct. */
  parentStart: number
}

/** Every box in the file, depth first, each with what contained it. */
export function collect(
  bytes: Uint8Array,
  start: number,
  end: number,
  parent: string,
  parentStart: number,
  into: Found[],
): void {
  let at = start
  while (at < end) {
    const box = readBox(bytes, at, end)
    if (!box || box.end <= at) break
    into.push({ box, parent, parentStart })
    const children = containerChildren(bytes, box)
    if (children !== undefined) collect(bytes, children, box.end, box.type, box.start, into)
    at = box.end
  }
}

// ---------------------------------------------------------- moved-byte maths

export interface Range {
  start: number
  end: number
}

/** Where an original offset ends up, or -1 if it pointed into bytes that are gone. */
export function shifted(removed: readonly Range[], offset: number): number {
  let delta = 0
  for (const range of removed) {
    if (range.end <= offset) delta += range.end - range.start
    else if (range.start < offset) return -1
  }
  return offset - delta
}
