// The text of a PDF, page by page.
//
// Enough of the content-stream model to read prose back out: the text-showing
// operators (`Tj`, `TJ`, `'`, `"`), the matrices that place them, and each
// font's way from a byte code to a character — its `ToUnicode` map when it has
// one, its encoding (WinAnsi, MacRoman, Standard, with `/Differences`) when it
// does not. Positions decide where a space, a line break and a paragraph break
// go, since a PDF stores none of the three.
//
// What it is for: `detect` on a PDF, and finding the page a paragraph of a
// .docx was printed on. It is not a layout engine. Columns are read in stream
// order, which is reading order for the producers that write prose, and a page
// whose content stream uses a filter other than Flate is left empty and
// counted rather than guessed at.
//
// Pages are read one after the other: each is an independent decode.
// oxlint-disable no-await-in-loop

import { asArray, asDict, asName, asNumber, decodeStream, Reader, source } from './lex.ts'
import type { PdfDict, PdfObject, PdfSource, PdfStream } from './lex.ts'
import { loadDocument, lookup, resolve, type PdfDocument } from './objects.ts'

export interface PdfPageText {
  /** 1-based. */
  page: number
  /** Lines joined by `\n`, paragraphs by a blank line. */
  text: string
}

export interface PdfText {
  pages: PdfPageText[]
  /** Pages whose content could not be decoded, by number. */
  unreadable: number[]
  /** The trailer names an /Encrypt dictionary: every string is ciphertext. */
  encrypted?: true
}

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
]

// ------------------------------------------------------------------ encodings

/** WinAnsi 0x80–0x9F; the rest of the upper half is Latin-1. */
const WIN_ANSI_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ'
/** MacRoman 0x80–0xFF. */
const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ'

function baseEncoding(name: string | undefined): string[] {
  const table = Array.from({ length: 256 }, (_, code) =>
    code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : '',
  )
  if (name === 'MacRomanEncoding') {
    for (let i = 0; i < 128; i += 1) table[0x80 + i] = MAC_ROMAN_HIGH[i] ?? ''
  } else if (name === 'StandardEncoding') {
    table[0x27] = '’'
    table[0x60] = '‘'
  } else {
    // WinAnsi is the default a viewer falls back to, and Latin-1 beyond it.
    for (let i = 0; i < 32; i += 1) table[0x80 + i] = WIN_ANSI_HIGH[i] ?? ''
    for (let code = 0xa0; code <= 0xff; code += 1) table[code] = String.fromCharCode(code)
  }
  return table
}

/** The glyph names `/Differences` uses most, beyond single letters and `uniXXXX`. */
const GLYPH: Record<string, string> = {
  space: ' ',
  exclam: '!',
  quotedbl: '"',
  numbersign: '#',
  dollar: '$',
  percent: '%',
  ampersand: '&',
  quotesingle: "'",
  quoteright: '’',
  quoteleft: '‘',
  quotedblleft: '“',
  quotedblright: '”',
  quotesinglbase: '‚',
  quotedblbase: '„',
  parenleft: '(',
  parenright: ')',
  asterisk: '*',
  plus: '+',
  comma: ',',
  hyphen: '-',
  minus: '−',
  period: '.',
  slash: '/',
  colon: ':',
  semicolon: ';',
  less: '<',
  equal: '=',
  greater: '>',
  question: '?',
  at: '@',
  bracketleft: '[',
  backslash: '\\',
  bracketright: ']',
  underscore: '_',
  braceleft: '{',
  bar: '|',
  braceright: '}',
  asciitilde: '~',
  endash: '–',
  emdash: '—',
  ellipsis: '…',
  bullet: '•',
  degree: '°',
  plusminus: '±',
  multiply: '×',
  divide: '÷',
  section: '§',
  paragraph: '¶',
  copyright: '©',
  registered: '®',
  trademark: '™',
  guillemotleft: '«',
  guillemotright: '»',
  guilsinglleft: '‹',
  guilsinglright: '›',
  nbspace: ' ',
  fi: 'fi',
  fl: 'fl',
  ff: 'ff',
  ffi: 'ffi',
  ffl: 'ffl',
  germandbls: 'ß',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  oslash: 'ø',
  Oslash: 'Ø',
  dotlessi: 'ı',
  mu: 'µ',
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
}

const ACCENT: Record<string, string> = {
  acute: '́',
  grave: '̀',
  circumflex: '̂',
  dieresis: '̈',
  tilde: '̃',
  cedilla: '̧',
  ring: '̊',
  caron: '̌',
}

/** A glyph name as text: `eacute` is é, `uni00E9` is é, `a` is a. */
export function glyphToText(name: string): string {
  const known = GLYPH[name]
  if (known !== undefined) return known
  const uni = /^uni([0-9A-F]{4,})$/iu.exec(name)
  if (uni?.[1]) {
    const units = uni[1].match(/.{4}/gu) ?? []
    return units.map((unit) => String.fromCharCode(Number.parseInt(unit, 16))).join('')
  }
  const u = /^u([0-9A-F]{4,6})$/iu.exec(name)
  if (u?.[1]) return String.fromCodePoint(Number.parseInt(u[1], 16))
  if (/^[A-Za-z]$/u.test(name)) return name
  const accented = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|cedilla|ring|caron)$/u.exec(
    name,
  )
  if (accented?.[1] && accented[2]) return `${accented[1]}${ACCENT[accented[2]]}`.normalize('NFC')
  // `a.sc`, `f_f_i`: the part before a suffix, ligature parts joined.
  if (name.includes('_')) return name.split('_').map(glyphToText).join('')
  if (name.includes('.')) return glyphToText(name.slice(0, name.indexOf('.')))
  return ''
}

// ------------------------------------------------------------------ fonts

interface Font {
  /** How many bytes one character code takes: 1 for simple fonts, 2 for Identity-H. */
  bytes: 1 | 2
  /** Code → text, from ToUnicode or the encoding. */
  map: Map<number, string>
  /** Fallback for a simple font's code with no ToUnicode entry. */
  encoding?: string[]
  /** Advance widths in 1/1000 em. */
  widths: Map<number, number>
  defaultWidth: number
}

const hexBytes = (hex: string): number[] =>
  (hex.match(/[0-9a-f]{2}/giu) ?? []).map((pair) => Number.parseInt(pair, 16))

const hexValue = (hex: string): number => Number.parseInt(hex || '0', 16)

/** UTF-16BE hex, as a `ToUnicode` destination is written. */
function utf16(hex: string): string {
  const bytes = hexBytes(hex)
  const units: number[] = []
  for (let i = 0; i + 1 < bytes.length; i += 2)
    units.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0))
  return String.fromCharCode(...units)
}

/** A `ToUnicode` CMap: its code length and its code → text pairs. */
export function parseToUnicode(cmap: string): { bytes: 1 | 2; map: Map<number, string> } {
  const map = new Map<number, string>()
  let bytes: 1 | 2 = 1
  for (const block of cmap.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/gu)) {
    const first = /<([0-9a-f]+)>/iu.exec(block[1] ?? '')?.[1] ?? ''
    if (first.length >= 4) bytes = 2
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9a-f]*)>\s*<([0-9a-f]*)>/giu)) {
      if ((pair[1] ?? '').length >= 4) bytes = 2
      map.set(hexValue(pair[1] ?? ''), utf16(pair[2] ?? ''))
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    const body = block[1] ?? ''
    const RANGE = /<([0-9a-f]*)>\s*<([0-9a-f]*)>\s*(?:<([0-9a-f]*)>|\[([^\]]*)\])/giu
    for (const range of body.matchAll(RANGE)) {
      const low = hexValue(range[1] ?? '')
      const high = hexValue(range[2] ?? '')
      if ((range[1] ?? '').length >= 4) bytes = 2
      if (high < low || high - low > 0xffff) continue
      if (range[3] !== undefined) {
        const start = hexBytes(range[3])
        for (let code = low; code <= high; code += 1) {
          // The last byte counts up across the range; the others stay.
          const units = [...start]
          let carry = code - low
          for (let i = units.length - 1; i >= 0 && carry > 0; i -= 1) {
            const sum = (units[i] ?? 0) + carry
            units[i] = sum & 0xff
            carry = sum >> 8
          }
          map.set(code, utf16(units.map((b) => b.toString(16).padStart(2, '0')).join('')))
        }
      } else {
        const targets = [...(range[4] ?? '').matchAll(/<([0-9a-f]*)>/giu)]
        targets.forEach((target, at) => map.set(low + at, utf16(target[1] ?? '')))
      }
    }
  }
  return { bytes, map }
}

const latin1 = (bytes: Uint8Array): string => {
  let out = ''
  for (let i = 0; i < bytes.length; i += 8192)
    out += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return out
}

async function readFont(doc: PdfDocument, object: PdfObject | undefined): Promise<Font> {
  const dict = asDict(resolve(doc, object))
  const subtype = asName(dict?.entries.get('Subtype'))
  const font: Font = { bytes: 1, map: new Map(), widths: new Map(), defaultWidth: 500 }
  if (!dict) return font

  if (subtype === 'Type0') {
    font.bytes = 2
    const descendant = asDict(
      resolve(doc, asArray(resolve(doc, dict.entries.get('DescendantFonts')))?.[0]),
    )
    font.defaultWidth = asNumber(resolve(doc, descendant?.entries.get('DW'))) ?? 1000
    // W: [c [w1 w2 …]] or [c_first c_last w].
    const w = asArray(resolve(doc, descendant?.entries.get('W'))) ?? []
    for (let i = 0; i < w.length;) {
      const first = asNumber(resolve(doc, w[i]))
      const next = resolve(doc, w[i + 1])
      if (first === undefined) break
      if (next?.type === 'array') {
        next.items.forEach((item, at) => {
          const width = asNumber(resolve(doc, item))
          if (width !== undefined) font.widths.set(first + at, width)
        })
        i += 2
      } else {
        const last = asNumber(next) ?? first
        const width = asNumber(resolve(doc, w[i + 2])) ?? font.defaultWidth
        for (let code = first; code <= last && code - first < 0xffff; code += 1)
          font.widths.set(code, width)
        i += 3
      }
    }
  } else {
    const first = asNumber(resolve(doc, dict.entries.get('FirstChar'))) ?? 0
    const widths = asArray(resolve(doc, dict.entries.get('Widths'))) ?? []
    widths.forEach((item, at) => {
      const width = asNumber(resolve(doc, item))
      if (width !== undefined) font.widths.set(first + at, width)
    })
    const encoding = resolve(doc, dict.entries.get('Encoding'))
    const table = baseEncoding(
      asName(encoding) ?? asName(resolve(doc, asDict(encoding)?.entries.get('BaseEncoding'))),
    )
    const differences = asArray(resolve(doc, asDict(encoding)?.entries.get('Differences'))) ?? []
    let code = 0
    for (const item of differences) {
      const value = resolve(doc, item)
      if (value?.type === 'number') code = value.value
      else if (value?.type === 'name') {
        if (code >= 0 && code < 256) table[code] = glyphToText(value.name)
        code += 1
      }
    }
    font.encoding = table
  }

  const toUnicode = resolve(doc, dict.entries.get('ToUnicode'))
  if (toUnicode?.type === 'stream') {
    try {
      const parsed = parseToUnicode(latin1(await decodeStream(toUnicode, (o) => resolve(doc, o))))
      font.map = parsed.map
      if (subtype !== 'Type0') font.bytes = 1
    } catch {
      // A map that will not decode leaves the encoding to do the work.
    }
  }
  return font
}

function decodeString(font: Font, bytes: Uint8Array): { text: string; codes: number[] } {
  let text = ''
  const codes: number[] = []
  for (let i = 0; i < bytes.length; i += font.bytes) {
    const code = font.bytes === 2 ? ((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0) : (bytes[i] ?? 0)
    codes.push(code)
    text += font.map.get(code) ?? font.encoding?.[code] ?? ''
  }
  return { text, codes }
}

// ------------------------------------------------------------------ content

interface Chunk {
  text: string
  x: number
  y: number
  endX: number
  size: number
}

/** The operands and operators of a content stream, in order. */
function* tokens(src: PdfSource): Generator<{ op: string } | { operand: PdfObject }> {
  const { text } = src
  const reader = new Reader(src, 0)
  for (;;) {
    reader.skip()
    if (reader.pos >= text.length) return
    const code = text.charCodeAt(reader.pos)
    const operand =
      code === 0x2f ||
      code === 0x28 ||
      code === 0x5b ||
      code === 0x3c ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2d ||
      code === 0x2e
    if (operand) {
      try {
        yield { operand: reader.parse() }
      } catch {
        reader.pos += 1
      }
      continue
    }
    if (code === 0x5d || code === 0x29 || code === 0x3e || code === 0x7b || code === 0x7d) {
      reader.pos += 1
      continue
    }
    let end = reader.pos
    while (end < text.length) {
      const c = text.charCodeAt(end)
      if (
        c === 0x20 ||
        c === 0x0a ||
        c === 0x0d ||
        c === 0x09 ||
        c === 0x0c ||
        c === 0x00 ||
        c === 0x2f ||
        c === 0x28 ||
        c === 0x5b ||
        c === 0x3c ||
        c === 0x5d ||
        c === 0x29 ||
        c === 0x3e ||
        c === 0x25
      )
        break
      end += 1
    }
    const op = text.slice(reader.pos, Math.max(end, reader.pos + 1))
    reader.pos = Math.max(end, reader.pos + 1)
    if (op === 'ID') {
      // Inline image data is binary, ended by `EI` on its own.
      const close = /\sEI(?=[\s]|$)/gu
      close.lastIndex = reader.pos
      const found = close.exec(text)
      reader.pos = found ? found.index + found[0].length : text.length
      continue
    }
    yield { op }
  }
}

const MAX_FORM_DEPTH = 6

interface State {
  ctm: Matrix
  font?: Font
  size: number
  charSpace: number
  wordSpace: number
  scale: number
  leading: number
  rise: number
}

async function readContent(
  doc: PdfDocument,
  data: Uint8Array,
  resources: PdfObject | undefined,
  fonts: Map<PdfObject, Font>,
  out: Chunk[],
  initial: Matrix,
  depth: number,
): Promise<void> {
  const fontDict = asDict(lookup(doc, resources, 'Font'))
  const xobjects = asDict(lookup(doc, resources, 'XObject'))
  const fontOf = async (name: string): Promise<Font | undefined> => {
    const object = fontDict?.entries.get(name)
    if (!object) return undefined
    const key = object.type === 'ref' ? (doc.objects.get(object.num)?.object ?? object) : object
    let font = fonts.get(key)
    if (!font) {
      font = await readFont(doc, object)
      fonts.set(key, font)
    }
    return font
  }

  const stack: State[] = []
  let state: State = {
    ctm: initial,
    size: 0,
    charSpace: 0,
    wordSpace: 0,
    scale: 1,
    leading: 0,
    rise: 0,
  }
  let tm: Matrix = IDENTITY
  let tlm: Matrix = IDENTITY
  const operands: PdfObject[] = []
  const num = (at: number) => asNumber(operands.at(at)) ?? 0

  const show = (bytes: Uint8Array) => {
    const font = state.font
    if (!font) return
    const { text, codes } = decodeString(font, bytes)
    const start = multiply([1, 0, 0, 1, 0, state.rise], multiply(tm, state.ctm))
    let advance = 0
    for (const code of codes) {
      const width = (font.widths.get(code) ?? font.defaultWidth) / 1000
      const word = code === 32 && font.bytes === 1 ? state.wordSpace : 0
      advance += (width * state.size + state.charSpace + word) * state.scale
    }
    tm = multiply([1, 0, 0, 1, advance, 0], tm)
    const end = multiply(tm, state.ctm)
    const size = Math.abs(state.size * Math.hypot(start[2], start[3])) || 1
    if (text) out.push({ text, x: start[4], y: start[5], endX: end[4], size })
  }

  const src = source(data)
  for (const token of tokens(src)) {
    if ('operand' in token) {
      operands.push(token.operand)
      continue
    }
    switch (token.op) {
      case 'q': {
        stack.push({ ...state })
        break
      }
      case 'Q': {
        state = stack.pop() ?? state
        break
      }
      case 'cm': {
        state.ctm = multiply([num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)], state.ctm)
        break
      }
      case 'BT': {
        tm = IDENTITY
        tlm = IDENTITY
        break
      }
      case 'Tf': {
        state.size = num(-1)
        const name = asName(operands.at(-2))
        const font = name ? await fontOf(name) : undefined
        if (font) state.font = font
        else delete state.font
        break
      }
      case 'Tc': {
        state.charSpace = num(-1)
        break
      }
      case 'Tw': {
        state.wordSpace = num(-1)
        break
      }
      case 'Tz': {
        state.scale = num(-1) / 100
        break
      }
      case 'TL': {
        state.leading = num(-1)
        break
      }
      case 'Ts': {
        state.rise = num(-1)
        break
      }
      case 'Td':
      case 'TD': {
        if (token.op === 'TD') state.leading = -num(-1)
        tlm = multiply([1, 0, 0, 1, num(-2), num(-1)], tlm)
        tm = tlm
        break
      }
      case 'Tm': {
        tlm = [num(-6), num(-5), num(-4), num(-3), num(-2), num(-1)]
        tm = tlm
        break
      }
      case 'T*': {
        tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm)
        tm = tlm
        break
      }
      case 'Tj': {
        const value = operands.at(-1)
        if (value?.type === 'string') show(value.bytes)
        break
      }
      case "'":
      case '"': {
        if (token.op === '"') {
          state.wordSpace = num(-3)
          state.charSpace = num(-2)
        }
        tlm = multiply([1, 0, 0, 1, 0, -state.leading], tlm)
        tm = tlm
        const value = operands.at(-1)
        if (value?.type === 'string') show(value.bytes)
        break
      }
      case 'TJ': {
        const items = asArray(operands.at(-1)) ?? []
        for (const item of items) {
          if (item.type === 'string') show(item.bytes)
          else if (item.type === 'number') {
            tm = multiply([1, 0, 0, 1, (-item.value / 1000) * state.size * state.scale, 0], tm)
          }
        }
        break
      }
      case 'Do': {
        const name = asName(operands.at(-1))
        const form = name ? resolve(doc, xobjects?.entries.get(name)) : undefined
        if (
          depth < MAX_FORM_DEPTH &&
          form?.type === 'stream' &&
          asName(form.dict.entries.get('Subtype')) === 'Form'
        ) {
          try {
            const matrix = asArray(resolve(doc, form.dict.entries.get('Matrix')))
            const m = matrix?.map((item) => asNumber(resolve(doc, item)) ?? 0)
            const own: Matrix = m?.length === 6 ? (m as Matrix) : IDENTITY
            const bytes = await decodeStream(form, (o) => resolve(doc, o))
            await readContent(
              doc,
              bytes,
              form.dict.entries.get('Resources') ?? resources,
              fonts,
              out,
              multiply(own, state.ctm),
              depth + 1,
            )
          } catch {
            // A form that will not decode is a picture as far as text goes.
          }
        }
        break
      }
      default: {
        break
      }
    }
    operands.length = 0
  }
}

/** Chunks in stream order, as lines and paragraphs. */
export function layoutChunks(chunks: readonly Chunk[]): string {
  interface Line {
    text: string
    y: number
    size: number
    endX: number
  }
  const lines: Line[] = []
  let line: Line | undefined
  for (const chunk of chunks) {
    const sameLine = line && Math.abs(chunk.y - line.y) < 0.5 * Math.max(chunk.size, line.size)
    if (line && sameLine) {
      const gap = chunk.x - line.endX
      const needsSpace =
        gap > 0.15 * chunk.size && !line.text.endsWith(' ') && !chunk.text.startsWith(' ')
      line.text += `${needsSpace ? ' ' : ''}${chunk.text}`
      line.endX = Math.max(line.endX, chunk.endX)
      line.size = Math.max(line.size, chunk.size)
      continue
    }
    if (line) lines.push(line)
    line = { text: chunk.text, y: chunk.y, size: chunk.size, endX: chunk.endX }
  }
  if (line) lines.push(line)

  // A paragraph ends where a line stops well short of the right margin — the
  // last line of a justified paragraph, a heading, a page number — or before a
  // gap clearly wider than the leading around it, or a jump back up the page.
  const gaps = lines.slice(1).map((l, at) => (lines[at] as Line).y - l.y)
  const ordinary = gaps.filter((g) => g > 0).sort((a, b) => a - b)
  // Too few gaps to know the leading: only a gap wider than a line and a half.
  const median = ordinary.length >= 3 ? (ordinary[Math.floor(ordinary.length / 2)] ?? 0) : 0
  const ends = lines.map((l) => l.endX).sort((a, b) => a - b)
  const margin = ends[Math.floor(ends.length * 0.9)] ?? 0

  let out = ''
  let short = false
  lines.forEach((l, at) => {
    const text = l.text.replaceAll(/\s+/gu, ' ').trim()
    if (!text) return
    if (out) {
      const gap = gaps[at - 1] ?? 0
      const paragraph = short || gap <= 0 || gap > Math.max(median * 1.4, l.size * 1.6)
      if (paragraph) out += '\n\n'
      else if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(text)) out = out.slice(0, -1)
      else out += '\n'
    }
    out += text
    short = lines.length > 2 && l.endX < margin - 3 * l.size
  })
  return out
}

/** Leaves of the page tree, in reading order, with their inherited resources. */
function pagesInOrder(doc: PdfDocument): { page: PdfDict; resources?: PdfObject }[] {
  const root = lookup(doc, doc.trailer, 'Root')
  const tree = lookup(doc, root, 'Pages')
  const out: { page: PdfDict; resources?: PdfObject }[] = []
  const seen = new Set<PdfObject>()
  const walk = (node: PdfObject | undefined, inherited: PdfObject | undefined, depth: number) => {
    const dict = asDict(node)
    if (!dict || seen.has(dict) || depth > 64) return
    seen.add(dict)
    const resources = dict.entries.get('Resources') ?? inherited
    const kids = asArray(resolve(doc, dict.entries.get('Kids')))
    if (kids) {
      for (const kid of kids) walk(resolve(doc, kid), resources, depth + 1)
      return
    }
    out.push({ page: dict, ...(resources ? { resources } : {}) })
  }
  walk(tree, undefined, 0)
  return out
}

/** The text of every page of a PDF, or `undefined` when it cannot be read at all. */
export async function pdfText(bytes: Uint8Array): Promise<PdfText | undefined> {
  let doc: PdfDocument
  try {
    doc = await loadDocument(source(bytes))
  } catch {
    return undefined
  }
  const fonts = new Map<PdfObject, Font>()
  const pages: PdfPageText[] = []
  const unreadable: number[] = []
  const list = pagesInOrder(doc)
  for (const [at, { page, resources }] of list.entries()) {
    const contents = resolve(doc, page.entries.get('Contents'))
    const streams = (contents?.type === 'array' ? contents.items : [contents])
      .map((item) => resolve(doc, item))
      .filter((item): item is PdfStream => item?.type === 'stream')
    try {
      const parts = await Promise.all(streams.map((s) => decodeStream(s, (o) => resolve(doc, o))))
      const total = parts.reduce((sum, part) => sum + part.length + 1, 0)
      const data = new Uint8Array(total)
      let offset = 0
      for (const part of parts) {
        data.set(part, offset)
        offset += part.length
        data[offset] = 0x0a
        offset += 1
      }
      const chunks: Chunk[] = []
      await readContent(doc, data, resources, fonts, chunks, IDENTITY, 0)
      pages.push({ page: at + 1, text: layoutChunks(chunks) })
    } catch {
      unreadable.push(at + 1)
      pages.push({ page: at + 1, text: '' })
    }
  }
  return { pages, unreadable, ...(doc.trailer.entries.has('Encrypt') ? { encrypted: true } : {}) }
}
