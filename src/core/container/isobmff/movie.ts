// MP4 and MOV: the tags, the two ways of naming them, and the timestamps.
//
// iTunes-style metadata lives in `moov/udta/meta/ilst`, where each tag is a box
// whose type is its name — '©too' for the encoder, and so on. QuickTime files
// use a second layout for the same list: a `keys` box declares dotted key names
// like `com.apple.quicktime.model`, and the `ilst` children are named by their
// *position* in that list rather than by any name of their own. A table keyed on
// four-character codes therefore never fires on an iPhone .mov, which is the
// file most likely to be dropped on a tool like this. Both are read here.
//
// The third leak is not a tag at all. `mvhd`, `tkhd` and `mdhd` each open with a
// creation and a modification time, in seconds since 1904. They are blanked in
// place: same bytes, all zeroes, so nothing moves and no offset needs correcting.
// `writeZip` already zeroes DOS timestamps for the same reason — a timestamp is
// metadata like any other.

import type { Finding, FindingKind, Verdict } from '../../report.ts'
import { decodeUtf8, readU32, snippet } from '../types.ts'
import { readBox, readUint, shifted, writeUint, type Box, type Range } from './boxes.ts'

interface Tag {
  kind: FindingKind
  verdict: Verdict
  what: string
}

// Tag names begin with byte 0xA9, which decodes to '©' one byte at a time — the
// same characters this table carries. Genre, track number and the rest are left
// alone: they describe the work, not the tool or the person that made it.
const ILST_TAGS: Record<string, Tag> = {
  '©too': { kind: 'generator_tag', verdict: 'informational', what: 'encoder name' },
  '©swr': { kind: 'generator_tag', verdict: 'informational', what: 'software that wrote the file' },
  '©day': { kind: 'doc_property', verdict: 'informational', what: 'creation date' },
  '©nam': { kind: 'doc_property', verdict: 'informational', what: 'title' },
  '©cmt': { kind: 'doc_property', verdict: 'informational', what: 'comment' },
  '©ART': { kind: 'doc_property', verdict: 'informational', what: 'artist' },
  // The most sensitive field a video container carries, and the one a phone
  // writes without being asked. ISO 6709: '+48.8566+002.3522/'.
  '©xyz': { kind: 'exif', verdict: 'informational', what: 'GPS location (ISO 6709)' },
}

// A Map rather than an object literal, because unlike the four-character codes
// above these keys come out of the file as arbitrary strings, and a lookup of
// 'constructor' on an object literal answers with something from the prototype.
const QUICKTIME_KEYS = new Map<string, Tag>([
  ['com.apple.quicktime.make', { kind: 'exif', verdict: 'informational', what: 'device maker' }],
  ['com.apple.quicktime.model', { kind: 'exif', verdict: 'informational', what: 'device model' }],
  [
    'com.apple.quicktime.software',
    { kind: 'generator_tag', verdict: 'informational', what: 'software that wrote the file' },
  ],
  [
    'com.apple.quicktime.location.ISO6709',
    { kind: 'exif', verdict: 'informational', what: 'GPS location (ISO 6709)' },
  ],
  [
    'com.apple.quicktime.creationdate',
    { kind: 'doc_property', verdict: 'informational', what: 'creation date' },
  ],
])

/** The key names a `keys` box declares, in the order `ilst` refers to them by. */
export function parseKeys(bytes: Uint8Array, box: Box): string[] {
  let at = box.body + 4 // past version and flags
  if (at + 4 > box.end) return []
  const count = readUint(bytes, at, 4)
  at += 4

  const names: string[] = []
  for (let i = 0; i < count; i += 1) {
    if (at + 8 > box.end) break
    const size = readUint(bytes, at, 4)
    if (size < 8 || at + size > box.end) break
    // Four bytes of namespace — 'mdta' for a dotted name — then the name itself.
    names.push(decodeUtf8(bytes.subarray(at + 8, at + size)))
    at += size
  }
  return names
}

/**
 * The text an atom carries, in whichever of the two layouts it used.
 *
 * Inside `ilst` the value is wrapped in a `data` box that carries a type
 * indicator and a locale. Directly inside `udta`, which is where QuickTime
 * writes `©xyz`, there is no box at all: a 16-bit length and a 16-bit language
 * code sit in front of the characters.
 */
function atomText(bytes: Uint8Array, box: Box): string {
  const data = readBox(bytes, box.body, box.end)
  if (data && data.type === 'data' && data.body + 8 <= data.end) {
    return snippet(decodeUtf8(bytes.subarray(data.body + 8, data.end)))
  }

  if (box.body + 4 <= box.end) {
    const length = readUint(bytes, box.body, 2)
    const end = box.body + 4 + length
    if (length > 0 && end <= box.end) return snippet(decodeUtf8(bytes.subarray(box.body + 4, end)))
  }
  return snippet(decodeUtf8(bytes.subarray(box.body, box.end)))
}

/** The `mean` and `name` children of a free-form `----` atom, which say what it is. */
function freeFormName(bytes: Uint8Array, box: Box): string {
  const parts: string[] = []
  let at = box.body
  while (at < box.end) {
    const child = readBox(bytes, at, box.end)
    if (!child) break
    if (child.type === 'name' || child.type === 'mean') {
      parts.push(decodeUtf8(bytes.subarray(child.body + 4, child.end)))
    }
    at = child.end
  }
  return snippet(parts.filter(Boolean).join(' · '))
}

/**
 * What a tag is, or undefined to copy it through untouched.
 *
 * `keys` is the resolved key table of the nearest enclosing `meta`, empty when
 * there is none. It is consulted second: a four-character name read as a 32-bit
 * number lands far outside any key list, and an index read as four characters
 * spells control bytes, so the two lookups cannot answer for each other.
 */
export function classifyTag(
  bytes: Uint8Array,
  box: Box,
  parent: string,
  keys: readonly string[],
): Finding | undefined {
  if (parent !== 'ilst' && parent !== 'udta') return undefined

  const found = (name: string, tag: Tag, evidence: string): Finding => ({
    kind: tag.kind,
    verdict: tag.verdict,
    offset: box.start,
    length: box.end - box.start,
    label: `${name} — ${tag.what}`,
    ...(evidence ? { evidence } : {}),
  })

  const named = ILST_TAGS[box.type]
  if (named) return found(box.type, named, atomText(bytes, box))

  if (box.type === '----') {
    return found(
      '----',
      { kind: 'doc_property', verdict: 'informational', what: 'free-form tag' },
      freeFormName(bytes, box),
    )
  }

  if (parent === 'ilst' && keys.length > 0) {
    // Numbered from one. Anything that is not an index — a four-character name
    // read as a 32-bit number, say — lands outside the list and reads back as
    // undefined, which is the answer wanted anyway.
    const name = keys[(readU32(bytes, box.start + 4) >>> 0) - 1]
    const keyed = name === undefined ? undefined : QUICKTIME_KEYS.get(name)
    if (name !== undefined && keyed) return found(name, keyed, atomText(bytes, box))
  }

  return undefined
}

// ------------------------------------------------------------- header times

/** Boxes that open with a creation time and a modification time. */
const TIMED = new Set(['mvhd', 'tkhd', 'mdhd'])

/** Seconds between the ISOBMFF epoch, 1904-01-01, and the Unix one. */
const EPOCH_1904 = 2_082_844_800

function asDate(seconds: number): string {
  const date = new Date((seconds - EPOCH_1904) * 1000)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * Zero the two timestamps in a movie, track or media header.
 *
 * The replacement is the same length as the original, so nothing after it moves
 * and no offset table needs correcting. Returns nothing when there is no such
 * box or when both stamps are already zero, which is what keeps a file with
 * nothing to strip byte-identical and makes a second pass a no-op.
 */
export function blankTimestamps(
  bytes: Uint8Array,
  box: Box,
): { patched: Uint8Array; finding: Finding } | undefined {
  if (!TIMED.has(box.type)) return undefined

  const width = (bytes[box.body] ?? 0) === 1 ? 8 : 4
  const at = box.body + 4
  if (at + width * 2 > box.end) return undefined

  const created = readUint(bytes, at, width)
  const modified = readUint(bytes, at + width, width)
  if (created === 0 && modified === 0) return undefined

  const patched = bytes.slice(box.start, box.end)
  writeUint(patched, at - box.start, width, 0)
  writeUint(patched, at - box.start + width, width, 0)

  const stamps = [...new Set([created, modified].filter(Boolean).map(asDate).filter(Boolean))]
  return {
    patched,
    finding: {
      kind: 'doc_property',
      verdict: 'informational',
      offset: at,
      length: width * 2,
      label: `${box.type} — creation and modification timestamps`,
      ...(stamps.length > 0 ? { evidence: snippet(stamps.join(' · ')) } : {}),
    },
  }
}

// ------------------------------------------------------------ chunk offsets

/**
 * Move the media chunk offsets to follow the media.
 *
 * Returns '' when it worked and the reason to refuse when an offset pointed at
 * bytes that are no longer in the file.
 */
export function repointChunks(out: Uint8Array, box: Box, removed: readonly Range[]): string {
  const size = box.type === 'stco' ? 4 : 8
  let at = box.body + 4
  const count = readUint(out, at, 4)
  at += 4

  for (let i = 0; i < count && at + size <= box.end; i += 1, at += size) {
    const moved = shifted(removed, readUint(out, at, size))
    if (moved < 0) return 'a media chunk offset pointed at bytes that were removed'
    writeUint(out, at, size, moved)
  }
  return ''
}
