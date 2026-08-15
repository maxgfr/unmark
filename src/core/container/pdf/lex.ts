// The PDF object model, and a reader for it that thinks in bytes.
//
// PDF is a byte format wearing a text costume. A string can hold any octet, a
// name can hold a `#20` escape, and every cross-reference in the file is a byte
// offset — so a parser that decodes to UTF-16 and counts characters will be
// wrong on exactly the files that matter. The trick the old byte-blanking pass
// used is kept: one latin1 view of the whole file, built once, where a string
// index is a byte offset and `charCodeAt` is the byte. Everything below reads
// from that view and slices the original `Uint8Array` when it needs real bytes.
//
// `decodeStream` lives here rather than in objects.ts so the dependency graph
// stays a straight line — xref.ts has to inflate a cross-reference stream
// before there is any object map to speak of.
//
// A stream's filters are a pipeline, so decoding them is a sequential await.
// oxlint-disable no-await-in-loop

import { inflate } from '../flate.ts'

export interface PdfNull {
  readonly type: 'null'
}
export interface PdfBool {
  readonly type: 'bool'
  readonly value: boolean
}
export interface PdfNumber {
  readonly type: 'number'
  readonly value: number
}
/** Strings are kept as bytes: a PDF string is not text until something decodes it. */
export interface PdfString {
  readonly type: 'string'
  readonly bytes: Uint8Array
}
export interface PdfName {
  readonly type: 'name'
  readonly name: string
}
export interface PdfArray {
  readonly type: 'array'
  readonly items: PdfObject[]
}
export interface PdfDict {
  readonly type: 'dict'
  /** A Map, not an object: insertion order survives and deletion is honest. */
  readonly entries: Map<string, PdfObject>
}
export interface PdfStream {
  readonly type: 'stream'
  readonly dict: PdfDict
  /** Undecoded, exactly as it sat in the file. */
  readonly raw: Uint8Array
}
export interface PdfRef {
  readonly type: 'ref'
  readonly num: number
  readonly gen: number
}

export type PdfObject =
  PdfNull | PdfBool | PdfNumber | PdfString | PdfName | PdfArray | PdfDict | PdfStream | PdfRef

export const PDF_NULL: PdfNull = { type: 'null' }
export const pdfNumber = (value: number): PdfNumber => ({ type: 'number', value })
export const pdfName = (name: string): PdfName => ({ type: 'name', name })
export const pdfRef = (num: number, gen = 0): PdfRef => ({ type: 'ref', num, gen })
export const pdfArray = (items: PdfObject[]): PdfArray => ({ type: 'array', items })
export const pdfDict = (entries?: Iterable<readonly [string, PdfObject]>): PdfDict => ({
  type: 'dict',
  entries: new Map(entries),
})

/** A dictionary, whether it arrived on its own or attached to a stream. */
export const asDict = (object: PdfObject | undefined): PdfDict | undefined =>
  object?.type === 'dict' ? object : object?.type === 'stream' ? object.dict : undefined

export const dictGet = (object: PdfObject | undefined, key: string): PdfObject | undefined =>
  asDict(object)?.entries.get(key)

export const asNumber = (object: PdfObject | undefined): number | undefined =>
  object?.type === 'number' ? object.value : undefined

export const asName = (object: PdfObject | undefined): string | undefined =>
  object?.type === 'name' ? object.name : undefined

export const asArray = (object: PdfObject | undefined): PdfObject[] | undefined =>
  object?.type === 'array' ? object.items : undefined

/** A one-element list reads the same as the bare value in /Filter and friends. */
export const asList = (object: PdfObject | undefined): PdfObject[] =>
  object === undefined || object.type === 'null' ? [] : (asArray(object) ?? [object])

export interface PdfSource {
  readonly bytes: Uint8Array
  /** Byte-for-char view, so a string index is a byte offset. */
  readonly text: string
}

export function source(bytes: Uint8Array): PdfSource {
  let text = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    text += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return { bytes, text }
}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
// ( ) < > [ ] { } / %
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])
const isRegular = (code: number): boolean => !WHITESPACE.has(code) && !DELIMITER.has(code)

/** Deep enough for any real document, shallow enough that a cycle cannot hang. */
const MAX_DEPTH = 96

const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)/y

/** `\n`, `\r`, `\t`, `\b`, `\f` — the escapes that are not just the next byte. */
const ESCAPES: Record<number, number> = {
  0x6e: 0x0a,
  0x72: 0x0d,
  0x74: 0x09,
  0x62: 0x08,
  0x66: 0x0c,
}

// A declaration rather than a const arrow, so TypeScript treats a call as
// never-returning and narrows what follows it.
function fail(message: string): never {
  throw new Error(`pdf: ${message}`)
}

/** A cursor over one source, used for a single object and then thrown away. */
export class Reader {
  readonly src: PdfSource
  pos: number

  constructor(src: PdfSource, pos = 0) {
    this.src = src
    this.pos = pos
  }

  /** Whitespace and `%` comments, which are legal between any two tokens. */
  skip(): void {
    const { text } = this.src
    for (;;) {
      const code = text.charCodeAt(this.pos)
      if (WHITESPACE.has(code)) {
        this.pos += 1
        continue
      }
      if (code === 0x25) {
        while (this.pos < text.length) {
          const c = text.charCodeAt(this.pos)
          if (c === 0x0a || c === 0x0d) break
          this.pos += 1
        }
        continue
      }
      // NaN past the end of the file lands here, which is how the loop ends.
      return
    }
  }

  at(literal: string): boolean {
    return this.src.text.startsWith(literal, this.pos)
  }

  /** A non-negative integer, or undefined without moving. */
  integer(): number | undefined {
    const { text } = this.src
    let end = this.pos
    while (end < text.length) {
      const code = text.charCodeAt(end)
      if (code < 0x30 || code > 0x39) break
      end += 1
    }
    if (end === this.pos) return undefined
    const value = Number(text.slice(this.pos, end))
    this.pos = end
    return value
  }

  parse(depth = 0): PdfObject {
    if (depth > MAX_DEPTH) fail('object nesting is too deep to be real')
    this.skip()

    const { text } = this.src
    const code = text.charCodeAt(this.pos)

    if (code === 0x2f) return this.name()
    if (code === 0x28) return this.literalString()
    if (code === 0x5b) return this.array(depth)
    if (code === 0x3c) {
      return text.charCodeAt(this.pos + 1) === 0x3c ? this.dictionary(depth) : this.hexString()
    }
    if (this.at('true')) {
      this.pos += 4
      return { type: 'bool', value: true }
    }
    if (this.at('false')) {
      this.pos += 5
      return { type: 'bool', value: false }
    }
    if (this.at('null')) {
      this.pos += 4
      return PDF_NULL
    }
    if ((code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2d || code === 0x2e) {
      return this.numberOrRef()
    }
    return fail(`unexpected byte 0x${(code || 0).toString(16)} at offset ${this.pos}`)
  }

  /** `/Name`, with `#xx` escapes decoded. */
  private name(): PdfName {
    const { text } = this.src
    this.pos += 1
    let out = ''
    while (this.pos < text.length) {
      const code = text.charCodeAt(this.pos)
      if (!isRegular(code)) break
      if (code === 0x23) {
        const hex = text.slice(this.pos + 1, this.pos + 3)
        const value = Number.parseInt(hex, 16)
        if (hex.length === 2 && !Number.isNaN(value)) {
          out += String.fromCharCode(value)
          this.pos += 3
          continue
        }
      }
      out += text[this.pos]
      this.pos += 1
    }
    return { type: 'name', name: out }
  }

  /**
   * `(a (nested) string)`.
   *
   * Parentheses nest and do not have to be escaped when they balance, which is
   * why this cannot be a regex: `/\(([^)]*)\)/` stops at the first inner `)`
   * and truncates the value, and a truncated title is a title that was never
   * really removed.
   */
  private literalString(): PdfString {
    const { text } = this.src
    this.pos += 1
    const out: number[] = []
    let depth = 1

    while (this.pos < text.length) {
      const code = text.charCodeAt(this.pos)
      this.pos += 1

      if (code === 0x5c) {
        const escape = text.charCodeAt(this.pos)
        this.pos += 1
        if (escape >= 0x30 && escape <= 0x37) {
          // Up to three octal digits, and it is legal to stop short.
          let value = escape - 0x30
          for (let i = 0; i < 2; i += 1) {
            const next = text.charCodeAt(this.pos)
            if (next < 0x30 || next > 0x37) break
            value = value * 8 + (next - 0x30)
            this.pos += 1
          }
          out.push(value & 0xff)
          continue
        }
        if (escape === 0x0d && text.charCodeAt(this.pos) === 0x0a) this.pos += 1
        // A backslash before a newline is a line continuation: nothing is added.
        if (escape === 0x0a || escape === 0x0d) continue
        out.push(ESCAPES[escape] ?? escape)
        continue
      }

      if (code === 0x28) depth += 1
      if (code === 0x29) {
        depth -= 1
        if (depth === 0) break
      }
      out.push(code & 0xff)
    }

    return { type: 'string', bytes: Uint8Array.from(out) }
  }

  /** `<48656C6C6F>`, whitespace allowed anywhere, a missing last digit is 0. */
  private hexString(): PdfString {
    const { text } = this.src
    this.pos += 1
    const digits: number[] = []
    while (this.pos < text.length) {
      const code = text.charCodeAt(this.pos)
      this.pos += 1
      if (code === 0x3e) break
      const digit = Number.parseInt(String.fromCharCode(code), 16)
      if (!Number.isNaN(digit)) digits.push(digit)
    }
    const out = new Uint8Array(Math.ceil(digits.length / 2))
    for (let i = 0; i < out.length; i += 1) {
      out[i] = ((digits[i * 2] ?? 0) << 4) | (digits[i * 2 + 1] ?? 0)
    }
    return { type: 'string', bytes: out }
  }

  private array(depth: number): PdfArray {
    this.pos += 1
    const items: PdfObject[] = []
    for (;;) {
      this.skip()
      if (this.pos >= this.src.text.length) fail('array is not closed')
      if (this.src.text.charCodeAt(this.pos) === 0x5d) {
        this.pos += 1
        return { type: 'array', items }
      }
      items.push(this.parse(depth + 1))
    }
  }

  private dictionary(depth: number): PdfDict {
    this.pos += 2
    const entries = new Map<string, PdfObject>()
    for (;;) {
      this.skip()
      if (this.pos >= this.src.text.length) fail('dictionary is not closed')
      if (this.at('>>')) {
        this.pos += 2
        return { type: 'dict', entries }
      }
      if (this.src.text.charCodeAt(this.pos) !== 0x2f) {
        fail(`dictionary key is not a name at offset ${this.pos}`)
      }
      const key = this.name()
      entries.set(key.name, this.parse(depth + 1))
    }
  }

  /**
   * A number, or the `12 0 R` that only looks like two of them.
   *
   * Told apart by lookahead and nothing else: there is no token in the format
   * that says "a reference starts here".
   */
  private numberOrRef(): PdfNumber | PdfRef {
    const start = this.pos
    const { text } = this.src

    const num = this.integer()
    if (num !== undefined) {
      const afterNum = this.pos
      this.skip()
      const gen = this.integer()
      if (gen !== undefined) {
        const afterGen = this.pos
        this.skip()
        // The end of the file counts as a delimiter. Without that, a trailer
        // ending in `/Root 1 0 R` with no trailing newline reads as the number
        // 1 and the document has no catalog.
        const after = text.charCodeAt(this.pos + 1)
        if (text.charCodeAt(this.pos) === 0x52 && (Number.isNaN(after) || !isRegular(after))) {
          this.pos += 1
          return { type: 'ref', num, gen }
        }
        this.pos = afterGen
      }
      this.pos = afterNum
      // Still might be a real, `4.5`. Fall through to the number scan.
    }

    this.pos = start
    NUMBER.lastIndex = start
    const match = NUMBER.exec(text)
    if (!match) fail(`not a number at offset ${start}`)
    this.pos = NUMBER.lastIndex
    return { type: 'number', value: Number(match[0]) }
  }
}

export interface IndirectObject {
  num: number
  gen: number
  object: PdfObject
  /** Where `endobj` left the cursor, for a caller walking a run of objects. */
  end: number
}

/** How a caller supplies a `/Length` that lives in another object. */
export type LengthResolver = (ref: PdfRef) => number | undefined

/**
 * Read `12 0 obj … endobj` starting at a byte offset.
 *
 * The stream body is the interesting part. `/Length` is allowed to be an
 * indirect reference, and is allowed to be wrong — both happen in files that
 * every viewer opens — so the declared length is treated as a hint that has to
 * survive a check, and `endstream` is the fallback.
 */
export function parseIndirect(
  src: PdfSource,
  at: number,
  resolveLength?: LengthResolver,
): IndirectObject {
  const reader = new Reader(src, at)
  reader.skip()

  const num = reader.integer()
  if (num === undefined) fail(`no object number at offset ${at}`)
  reader.skip()
  const gen = reader.integer()
  if (gen === undefined) fail(`no generation number at offset ${at}`)
  reader.skip()
  if (!reader.at('obj')) fail(`no 'obj' keyword at offset ${at}`)
  reader.pos += 3

  const object = reader.parse()
  reader.skip()

  if (object.type !== 'dict' || !reader.at('stream')) {
    if (reader.at('endobj')) reader.pos += 6
    return { num, gen, object, end: reader.pos }
  }

  const { text, bytes } = src
  reader.pos += 6
  // The spec says CRLF or LF here, never a bare CR. Writers disagree.
  if (text.charCodeAt(reader.pos) === 0x0d) reader.pos += 1
  if (text.charCodeAt(reader.pos) === 0x0a) reader.pos += 1
  const start = reader.pos

  let end = -1
  const declaredObject = object.entries.get('Length')
  const declared =
    declaredObject?.type === 'number'
      ? declaredObject.value
      : declaredObject?.type === 'ref'
        ? resolveLength?.(declaredObject)
        : undefined

  if (declared !== undefined && declared >= 0 && start + declared <= bytes.length) {
    const probe = new Reader(src, start + declared)
    probe.skip()
    if (probe.at('endstream')) end = start + declared
  }

  if (end === -1) {
    const found = text.indexOf('endstream', start)
    if (found === -1) fail(`stream in object ${num} has no endstream`)
    end = found
    // The EOL before `endstream` is punctuation, not payload.
    if (text.charCodeAt(end - 1) === 0x0a) end -= 1
    if (text.charCodeAt(end - 1) === 0x0d) end -= 1
    if (end < start) end = start
  }

  const raw = bytes.slice(start, end)
  reader.pos = text.indexOf('endstream', end)
  reader.pos = reader.pos === -1 ? end : reader.pos + 9
  reader.skip()
  if (reader.at('endobj')) reader.pos += 6

  return { num, gen, object: { type: 'stream', dict: object, raw }, end: reader.pos }
}

/**
 * Undo a PNG predictor.
 *
 * Cross-reference streams are almost always written with `/Predictor 12`,
 * because their rows are near-identical and subtracting the row above turns
 * most of the table into zeroes. Skip this and the offsets come out as
 * differences rather than offsets, which parses cleanly and points nowhere.
 */
export function unpredict(data: Uint8Array, parms: PdfDict | undefined): Uint8Array {
  const predictor = asNumber(parms?.entries.get('Predictor')) ?? 1
  if (predictor <= 1) return data
  if (predictor === 2) fail('TIFF predictor 2 is not supported')

  const colors = asNumber(parms?.entries.get('Colors')) ?? 1
  const bits = asNumber(parms?.entries.get('BitsPerComponent')) ?? 8
  const columns = asNumber(parms?.entries.get('Columns')) ?? 1
  const pixel = Math.max(1, Math.ceil((colors * bits) / 8))
  const rowLength = Math.ceil((colors * bits * columns) / 8)
  if (rowLength <= 0) fail('predictor row length is zero')

  const rows = Math.floor(data.length / (rowLength + 1))
  const out = new Uint8Array(rows * rowLength)

  for (let row = 0; row < rows; row += 1) {
    const inAt = row * (rowLength + 1)
    const outAt = row * rowLength
    const filter = data[inAt] ?? 0

    for (let i = 0; i < rowLength; i += 1) {
      const raw = data[inAt + 1 + i] ?? 0
      const left = i >= pixel ? (out[outAt + i - pixel] ?? 0) : 0
      const up = row > 0 ? (out[outAt - rowLength + i] ?? 0) : 0
      const upLeft = row > 0 && i >= pixel ? (out[outAt - rowLength + i - pixel] ?? 0) : 0

      let value: number
      switch (filter) {
        case 0: {
          value = raw
          break
        }
        case 1: {
          value = raw + left
          break
        }
        case 2: {
          value = raw + up
          break
        }
        case 3: {
          value = raw + ((left + up) >> 1)
          break
        }
        case 4: {
          const p = left + up - upLeft
          const dl = Math.abs(p - left)
          const du = Math.abs(p - up)
          const dul = Math.abs(p - upLeft)
          value = raw + (dl <= du && dl <= dul ? left : du <= dul ? up : upLeft)
          break
        }
        default: {
          return fail(`unknown PNG predictor filter ${filter}`)
        }
      }
      out[outAt + i] = value & 0xff
    }
  }

  return out
}

/**
 * A stream's bytes, decoded.
 *
 * Only /FlateDecode is implemented, and anything else throws rather than
 * returning the compressed bytes as if they were content. The two places this
 * is called — cross-reference streams and object streams — are Flate or
 * nothing in every file anyone has written; an image filter reaching here would
 * mean the caller asked for something it should not have.
 */
export async function decodeStream(
  stream: PdfStream,
  resolve: (object: PdfObject | undefined) => PdfObject | undefined = (o) => o,
): Promise<Uint8Array> {
  const filters = asList(resolve(stream.dict.entries.get('Filter')))
  const parms = asList(resolve(stream.dict.entries.get('DecodeParms')))
  let data = stream.raw

  for (const [index, filter] of filters.entries()) {
    const kind = asName(resolve(filter))
    if (kind !== 'FlateDecode' && kind !== 'Fl') {
      fail(`unsupported stream filter /${kind ?? '?'}`)
    }
    data = await inflate(data)
    data = unpredict(data, asDict(resolve(parms[index])))
  }

  return data
}
