// JPEG: marker segments in front of an entropy-coded scan.
//
// As with PNG, the operation is removal only. Everything from the start of scan
// to the end of the file is copied verbatim — that is the actual image, and a
// tool that decoded and re-encoded it to "clean" it would be throwing away
// quality to remove a text field.

import type { Finding, FindingKind, Verdict } from '../report.ts'
import { ascii, concat, decodeUtf8, snippet, startsWith, type ContainerResult } from './types.ts'

export const sniffJpeg = (bytes: Uint8Array) => startsWith(bytes, [0xff, 0xd8, 0xff])

const SOS = 0xda
const EOI = 0xd9

interface Segment {
  kind: FindingKind
  verdict: Verdict
  what: string
  evidence?: string
  /** Report it, but leave it in the file. */
  keep?: boolean
}

/** Printable runs inside a binary blob, for quoting an ICC tag back. */
function printableRuns(data: Uint8Array, minimum = 6): string[] {
  const runs: string[] = []
  let current = ''
  for (const byte of data) {
    if (byte >= 0x20 && byte < 0x7f) current += String.fromCharCode(byte)
    else {
      if (current.length >= minimum) runs.push(current)
      current = ''
    }
  }
  if (current.length >= minimum) runs.push(current)
  return runs
}

/**
 * What a segment is, or undefined to keep it.
 *
 * APP0 (JFIF) and APP14 (Adobe colour transform) are kept: neither is
 * provenance, and dropping APP14 breaks how a CMYK JPEG renders.
 *
 * APP2 is the segment that needs reading rather than assuming. It is either an
 * ICC colour profile or an MPF block, and only the identifier tells them apart
 * — an MPF block can hold an entire second photograph, which is a far larger
 * leak than any text field in the file.
 */
function classify(marker: number, data: Uint8Array): Segment | undefined {
  const head = ascii(data, 0, Math.min(32, data.length))

  if (marker === 0xe2) {
    if (head.startsWith('MPF')) {
      return {
        kind: 'text_chunk',
        verdict: 'confirmed',
        what: 'MPF block — can contain a second, complete image',
      }
    }
    // An ICC profile is kept: removing it changes how the image renders. But it
    // is worth reporting, because it survives an EXIF strip and its description
    // and copyright tags identify the software or service that wrote it —
    // Facebook stamps its own profiles with "Copyright: FB".
    if (head.startsWith('ICC_PROFILE')) {
      const strings = printableRuns(data.subarray(14)).filter(
        (run) => !run.startsWith('ICC_PROFILE'),
      )
      return {
        kind: 'generator_tag',
        verdict: 'informational',
        what: 'ICC colour profile — kept, it changes how the image renders',
        keep: true,
        ...(strings.length > 0 ? { evidence: snippet(strings.slice(0, 3).join(' · ')) } : {}),
      }
    }
    return undefined
  }

  if (marker === 0xe1) {
    if (head.startsWith('Exif')) {
      return { kind: 'exif', verdict: 'informational', what: 'EXIF block' }
    }
    if (head.startsWith('http://ns.adobe.com/xap/1.0/')) {
      const packet = decodeUtf8(data.subarray(29))
      const generator = /<(?:xmp|tiff|photoshop):(?:CreatorTool|Software)>([^<]+)</i.exec(packet)
      return {
        kind: 'xmp',
        verdict: 'probable',
        what: 'XMP packet',
        ...(generator?.[1] ? { evidence: snippet(generator[1]) } : {}),
      }
    }
    return { kind: 'exif', verdict: 'informational', what: 'APP1 metadata block' }
  }

  // C2PA rides in APP11 as a JUMBF box. Its presence is a deliberate stamp.
  if (marker === 0xeb) {
    return { kind: 'c2pa', verdict: 'confirmed', what: 'JUMBF / C2PA provenance box' }
  }

  if (marker === 0xed && head.startsWith('Photoshop')) {
    return { kind: 'iptc', verdict: 'informational', what: 'Photoshop / IPTC resource block' }
  }

  if (marker === 0xfe) {
    return {
      kind: 'text_chunk',
      verdict: 'informational',
      what: 'comment',
      evidence: snippet(decodeUtf8(data)),
    }
  }

  return undefined
}

export function cleanJpeg(bytes: Uint8Array): ContainerResult {
  const findings: Finding[] = []
  const preserved: Finding[] = []
  const kept: Uint8Array[] = [bytes.subarray(0, 2)] // SOI

  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break
    const marker = bytes[offset + 1] ?? 0

    // Standalone markers carry no length field.
    if (marker === EOI || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      kept.push(bytes.subarray(offset, offset + 2))
      offset += 2
      continue
    }

    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)
    if (length < 2 || offset + 2 + length > bytes.length) break

    if (marker === SOS) {
      // Everything from here is the compressed image. Copy it and stop looking
      // for markers, because entropy-coded data contains byte pairs that look
      // exactly like them.
      kept.push(bytes.subarray(offset))
      offset = bytes.length
      break
    }

    const data = bytes.subarray(offset + 4, offset + 2 + length)
    const segment = classify(marker, data)

    if (segment) {
      const finding: Finding = {
        kind: segment.kind,
        verdict: segment.verdict,
        offset,
        length: length + 2,
        label: `APP${(marker & 0x0f).toString()} — ${segment.what}`,
        ...(segment.evidence ? { evidence: segment.evidence } : {}),
        ...(segment.keep
          ? { preserved: 'a colour profile, not provenance — removing it changes the rendering' }
          : {}),
      }

      if (segment.keep) {
        preserved.push(finding)
        kept.push(bytes.subarray(offset, offset + 2 + length))
      } else {
        findings.push(finding)
      }
    } else {
      kept.push(bytes.subarray(offset, offset + 2 + length))
    }

    offset += 2 + length
  }

  // A truncated or unparseable tail is still the user's file: copy the rest
  // rather than silently returning a shorter image.
  if (offset < bytes.length) kept.push(bytes.subarray(offset))

  return { output: concat(kept), findings, preserved }
}
