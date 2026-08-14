// GIF: a header, then a stream of blocks terminated by sub-block chains.
//
// The metadata lives in comment (0xFE) and application (0xFF) extensions. The
// NETSCAPE2.0 application extension is the exception — it is what makes an
// animated GIF loop, so removing it as "metadata" would silently change the
// image's behaviour.

import type { Finding } from '../report.ts'
import { ascii, concat, decodeUtf8, snippet, startsWith, type ContainerResult } from './types.ts'

export const sniffGif = (bytes: Uint8Array) =>
  startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)

const EXTENSION = 0x21
const IMAGE = 0x2c
const TRAILER = 0x3b
const COMMENT = 0xfe
const APPLICATION = 0xff

/** Walk a length-prefixed sub-block chain and return where it ends. */
function endOfSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start
  while (offset < bytes.length) {
    const size = bytes[offset] ?? 0
    if (size === 0) return offset + 1
    offset += 1 + size
  }
  return bytes.length
}

/** Concatenate a sub-block chain into the text it spells. */
function readSubBlocks(bytes: Uint8Array, start: number): string {
  const parts: Uint8Array[] = []
  let offset = start
  while (offset < bytes.length) {
    const size = bytes[offset] ?? 0
    if (size === 0) break
    parts.push(bytes.subarray(offset + 1, offset + 1 + size))
    offset += 1 + size
  }
  return decodeUtf8(concat(parts))
}

export function cleanGif(bytes: Uint8Array): ContainerResult {
  const findings: Finding[] = []
  const preserved: Finding[] = []

  // Header plus logical screen descriptor, then the global colour table if the
  // packed field says there is one.
  let offset = 13
  const packed = bytes[10] ?? 0
  if (packed & 0x80) offset += 3 * 2 ** ((packed & 0x07) + 1)

  const kept: Uint8Array[] = [bytes.subarray(0, Math.min(offset, bytes.length))]

  while (offset < bytes.length) {
    const block = bytes[offset]

    if (block === TRAILER) {
      kept.push(bytes.subarray(offset, offset + 1))
      offset += 1
      continue
    }

    if (block === EXTENSION) {
      const label = bytes[offset + 1] ?? 0
      const end = endOfSubBlocks(bytes, offset + 2)

      if (label === COMMENT || label === APPLICATION) {
        const body = readSubBlocks(bytes, offset + 2)
        // The loop-count extension is structural, not provenance.
        const isNetscape = label === APPLICATION && ascii(bytes, offset + 3, 11) === 'NETSCAPE2.0'

        const finding: Finding = {
          kind: label === COMMENT ? 'text_chunk' : 'generator_tag',
          verdict: isNetscape ? 'likely_false_positive' : 'informational',
          offset,
          length: end - offset,
          label: label === COMMENT ? 'Comment extension' : 'Application extension',
          evidence: snippet(body),
          ...(isNetscape
            ? { preserved: 'NETSCAPE2.0 loop control — removing it stops the animation looping' }
            : {}),
        }

        if (isNetscape) {
          preserved.push(finding)
          kept.push(bytes.subarray(offset, end))
        } else {
          findings.push(finding)
        }
        offset = end
        continue
      }

      kept.push(bytes.subarray(offset, end))
      offset = end
      continue
    }

    if (block === IMAGE) {
      let cursor = offset + 10
      const localPacked = bytes[offset + 9] ?? 0
      if (localPacked & 0x80) cursor += 3 * 2 ** ((localPacked & 0x07) + 1)
      cursor += 1 // LZW minimum code size
      const end = endOfSubBlocks(bytes, cursor)
      kept.push(bytes.subarray(offset, end))
      offset = end
      continue
    }

    // Something unexpected: copy the remainder untouched rather than guess.
    kept.push(bytes.subarray(offset))
    break
  }

  return { output: concat(kept), findings, preserved }
}
