// Serialise an object map back into a PDF.
//
// Deliberately the dullest possible writer. Every object goes out as a plain
// uncompressed indirect object, the cross-reference table is the classic
// 20-byte-row form, and the trailer names `/Root` and `/Size` and nothing else.
// No object streams, no cross-reference stream, no `/Prev`.
//
// That last part is the point rather than a simplification. An object read out
// of a compressed object stream is written back expanded, because writing it
// back compressed would rebuild the exact hiding place the rebuild exists to
// empty. There is no `CompressionStream` in this file and there must not be
// one: the only bytes that stay compressed are the ones copied through
// untouched, still carrying the `/Filter` they arrived with.
//
// Streams are copied raw. The cleaner never re-encodes content — same rule the
// PNG and JPEG handlers follow, for the same reason.

import { concat, encode } from '../types.ts'
import type { PdfDict, PdfObject, PdfRef } from './lex.ts'
import type { StoredObject } from './objects.ts'

export interface WriteInput {
  objects: Map<number, StoredObject>
  root: PdfRef
}

/**
 * `%PDF-1.7`, then a comment of four bytes above 127.
 *
 * The binary comment is in the spec for a reason that still bites: without it,
 * a transfer that thinks the file is text will helpfully translate the line
 * endings inside every stream.
 */
const HEADER = Uint8Array.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
])

/** A string chunk is always ASCII, so its length in characters is its length in bytes. */
type Chunk = string | Uint8Array

const chunkLength = (chunk: Chunk): number => chunk.length

/** No exponents: `1e-7` is a number to JavaScript and a syntax error to a PDF. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value)
  const fixed = value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return fixed === '-0' ? '0' : fixed
}

/** Anything outside the printable regular characters goes back as `#xx`. */
function writeName(name: string): string {
  let out = '/'
  for (const character of name) {
    const code = character.charCodeAt(0)
    const regular = code > 0x20 && code < 0x7f && !'()<>[]{}/%#'.includes(character)
    out += regular ? character : `#${(code & 0xff).toString(16).padStart(2, '0')}`
  }
  return out
}

/**
 * A literal string with everything unprintable escaped.
 *
 * Escaping more than the format demands keeps the whole serialised file ASCII,
 * which is what lets byte offsets be computed from string lengths a few
 * functions down. A reader cannot tell the difference.
 */
function writeString(bytes: Uint8Array): string {
  let out = '('
  for (const byte of bytes) {
    if (byte === 0x28) out += String.raw`\(`
    else if (byte === 0x29) out += String.raw`\)`
    else if (byte === 0x5c) out += '\\\\'
    else if (byte >= 0x20 && byte <= 0x7e) out += String.fromCharCode(byte)
    else out += `\\${byte.toString(8).padStart(3, '0')}`
  }
  return `${out})`
}

function writeDict(dict: PdfDict, push: (chunk: Chunk) => void, override?: [string, PdfObject]) {
  push('<<')
  const entries = new Map(dict.entries)
  if (override) entries.set(override[0], override[1])
  for (const [key, value] of entries) {
    push(` ${writeName(key)} `)
    write(value, push)
  }
  push(' >>')
}

function write(object: PdfObject, push: (chunk: Chunk) => void): void {
  switch (object.type) {
    case 'null': {
      push('null')
      return
    }
    case 'bool': {
      push(object.value ? 'true' : 'false')
      return
    }
    case 'number': {
      push(formatNumber(object.value))
      return
    }
    case 'name': {
      push(writeName(object.name))
      return
    }
    case 'string': {
      push(writeString(object.bytes))
      return
    }
    case 'ref': {
      push(`${object.num} ${object.gen} R`)
      return
    }
    case 'array': {
      push('[')
      for (const item of object.items) {
        push(' ')
        write(item, push)
      }
      push(' ]')
      return
    }
    case 'dict': {
      writeDict(object, push)
      return
    }
    case 'stream': {
      // /Length is rewritten from the bytes actually being emitted rather than
      // copied. It is the one number in a PDF that a reader will believe over
      // the evidence, and an indirect /Length has nowhere to live in a file
      // whose object numbering has just changed underneath it.
      writeDict(object.dict, push, ['Length', { type: 'number', value: object.raw.length }])
      push('\nstream\n')
      push(object.raw)
      push('\nendstream')
      return
    }
  }
}

const pad = (value: number, width: number): string =>
  String(Math.max(0, Math.trunc(value)))
    .padStart(width, '0')
    .slice(-width)

export function writePdf(input: WriteInput): Uint8Array {
  const live = [...input.objects.entries()].sort(([a], [b]) => a - b)
  const size = (live.at(-1)?.[0] ?? 0) + 1

  const chunks: Chunk[] = []
  let offset = 0
  const push = (chunk: Chunk) => {
    chunks.push(chunk)
    offset += chunkLength(chunk)
  }

  push(HEADER)

  const offsets = new Map<number, number>()
  for (const [num, stored] of live) {
    offsets.set(num, offset)
    push(`${num} ${stored.gen} obj\n`)
    write(stored.object, push)
    push('\nendobj\n')
  }

  const xrefAt = offset
  push(`xref\n0 ${size}\n`)
  // Object 0 is the head of the free list and is always this exact row.
  push('0000000000 65535 f \n')
  for (let num = 1; num < size; num += 1) {
    const at = offsets.get(num)
    const stored = input.objects.get(num)
    push(
      at === undefined || !stored
        ? '0000000000 65535 f \n'
        : `${pad(at, 10)} ${pad(Math.min(stored.gen, 65_535), 5)} n \n`,
    )
  }

  push(
    `trailer\n<< /Size ${size} /Root ${input.root.num} ${input.root.gen} R >>\n` +
      `startxref\n${xrefAt}\n%%EOF\n`,
  )

  return concat(chunks.map((chunk) => (typeof chunk === 'string' ? encode(chunk) : chunk)))
}
