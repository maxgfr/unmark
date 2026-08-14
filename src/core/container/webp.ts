// WebP: RIFF chunks, plus a flags byte that has to be kept in sync.
//
// The catch that makes this more than a chunk filter: an extended WebP declares
// in its VP8X header which optional chunks are present. Remove the EXIF chunk
// without clearing the EXIF bit and the file claims metadata it no longer has,
// which some decoders treat as corruption. So the flags are rewritten too.

import type { Finding, FindingKind, Verdict } from '../report.ts'
import {
  ascii,
  concat,
  encode,
  readU32LE,
  startsWith,
  writeU32LE,
  type ContainerResult,
} from './types.ts'

export const sniffWebp = (bytes: Uint8Array) =>
  startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && ascii(bytes, 8, 4) === 'WEBP'

// Bits in the VP8X flags byte.
const FLAG_EXIF = 0x08
const FLAG_XMP = 0x04

const RULES: Record<string, { kind: FindingKind; verdict: Verdict; what: string; clears: number }> =
  {
    EXIF: { kind: 'exif', verdict: 'informational', what: 'EXIF block', clears: FLAG_EXIF },
    'XMP ': { kind: 'xmp', verdict: 'probable', what: 'XMP packet', clears: FLAG_XMP },
    C2PA: { kind: 'c2pa', verdict: 'confirmed', what: 'C2PA manifest', clears: 0 },
  }

export function cleanWebp(bytes: Uint8Array): ContainerResult {
  const findings: Finding[] = []
  const kept: Uint8Array[] = []
  let clearedFlags = 0
  let vp8xIndex = -1

  let offset = 12 // past 'RIFF' + size + 'WEBP'
  while (offset + 8 <= bytes.length) {
    const fourcc = ascii(bytes, offset, 4)
    const size = readU32LE(bytes, offset + 4)
    const padded = size + (size % 2) // chunks are padded to an even length
    const total = 8 + padded
    if (total <= 8 || offset + total > bytes.length) break

    const rule = RULES[fourcc]
    if (rule) {
      findings.push({
        kind: rule.kind,
        verdict: rule.verdict,
        offset,
        length: total,
        label: `${fourcc.trim()} — ${rule.what}`,
      })
      clearedFlags |= rule.clears
    } else {
      // Copy rather than reference: the VP8X flags byte is patched in place
      // below, and a subarray would write straight into the caller's buffer.
      const chunk = bytes.slice(offset, offset + total)
      if (fourcc === 'VP8X') vp8xIndex = kept.length
      kept.push(chunk)
    }

    offset += total
  }

  const vp8x = vp8xIndex === -1 ? undefined : kept[vp8xIndex]
  if (vp8x && clearedFlags !== 0) {
    vp8x[8] = (vp8x[8] ?? 0) & ~clearedFlags
  }

  const payload = concat([encode('WEBP'), ...kept])
  const out = concat([encode('RIFF'), new Uint8Array(4), payload])
  writeU32LE(out, 4, payload.length)

  return { output: out, findings, preserved: [] }
}
