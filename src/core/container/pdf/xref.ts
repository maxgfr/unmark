// Where every object in the file is, according to the file.
//
// Four things have to work here, and a reader that implements only the first
// will open a 1997 document and choke on anything made this decade:
//
//   - the classic `xref` table with its 20-byte rows and a `trailer` after it;
//   - cross-reference streams (PDF 1.5), which are a compressed binary table
//     with a PNG predictor applied to the rows to make them squash better;
//   - `/Prev`, which chains one section to the one it was appended to — this is
//     the whole mechanism of incremental saves;
//   - `/XRefStm`, the hybrid-reference trick, where a file carries both forms
//     so old readers see a valid table and new ones find the compressed
//     objects the old table had to mark free.
//
// Walking newest-first and keeping the first entry seen for each object number
// is what makes an incremental save resolve to its latest version. Reversing
// that would silently serve the draft.
//
// Sections are read one after another because each one names the next; there
// is no set of offsets to fetch in parallel.
// oxlint-disable no-await-in-loop

import {
  asArray,
  asName,
  asNumber,
  decodeStream,
  parseIndirect,
  Reader,
  type PdfDict,
  type PdfObject,
  type PdfSource,
} from './lex.ts'

export type XrefEntry =
  /** A byte offset into the file. */
  | { kind: 'offset'; offset: number; gen: number }
  /** Inside an object stream: which stream, and which slot in it. */
  | { kind: 'compressed'; stream: number; index: number }
  | { kind: 'free' }

export interface Xref {
  entries: Map<number, XrefEntry>
  trailer: PdfDict
  /** Sections in the `/Prev` chain. More than one means the file was updated. */
  sections: number
  /** Linearization also splits the table in two, without being an update. */
  linearized: boolean
  /** True when the chain was unusable and the file had to be scanned instead. */
  recovered: boolean
}

/** An incremental save per section; a file with thousands is not a document. */
const MAX_SECTIONS = 512
/** Above this, a `/Size` or subsection count is corrupt rather than large. */
const MAX_OBJECTS = 1 << 22

function fail(message: string): never {
  throw new Error(`pdf: ${message}`)
}

const bigEndian = (data: Uint8Array, at: number, width: number): number => {
  let value = 0
  for (let i = 0; i < width; i += 1) value = value * 256 + (data[at + i] ?? 0)
  return value
}

interface Section {
  entries: Map<number, XrefEntry>
  trailer: PdfDict
}

/** The classic table: subsection headers, then one fixed-width row per object. */
function readClassicSection(src: PdfSource, reader: Reader): Section {
  reader.pos += 4 // 'xref'
  const entries = new Map<number, XrefEntry>()

  for (;;) {
    reader.skip()
    if (reader.at('trailer')) {
      reader.pos += 7
      break
    }
    if (reader.pos >= src.text.length) fail('cross-reference table ends without a trailer')

    const first = reader.integer()
    reader.skip()
    const count = reader.integer()
    if (first === undefined || count === undefined) {
      fail(`malformed cross-reference subsection at offset ${reader.pos}`)
    }
    if (count > MAX_OBJECTS) fail(`cross-reference subsection claims ${count} objects`)

    for (let i = 0; i < count; i += 1) {
      reader.skip()
      const offset = reader.integer()
      reader.skip()
      const gen = reader.integer()
      reader.skip()
      const type = src.text[reader.pos]
      reader.pos += 1
      if (offset === undefined || gen === undefined || (type !== 'n' && type !== 'f')) {
        fail(`malformed cross-reference row at offset ${reader.pos}`)
      }
      entries.set(first + i, type === 'f' ? { kind: 'free' } : { kind: 'offset', offset, gen })
    }
  }

  const trailer = reader.parse()
  if (trailer.type !== 'dict') fail('trailer is not a dictionary')
  return { entries, trailer }
}

/** The 1.5 form: a stream whose bytes are the table, `/W` wide per field. */
async function readStreamSection(src: PdfSource, at: number): Promise<Section> {
  const { object } = parseIndirect(src, at)
  if (object.type !== 'stream') fail(`no cross-reference at offset ${at}`)
  if (asName(object.dict.entries.get('Type')) !== 'XRef') {
    fail(`object at offset ${at} is not a cross-reference stream`)
  }

  const widths = (asArray(object.dict.entries.get('W')) ?? []).map((w) => asNumber(w) ?? 0)
  const [w0 = 0, w1 = 0, w2 = 0] = widths
  const row = w0 + w1 + w2
  if (row <= 0) fail('cross-reference stream has no /W widths')

  const size = asNumber(object.dict.entries.get('Size')) ?? 0
  if (size > MAX_OBJECTS) fail(`cross-reference stream claims ${size} objects`)
  const index = asArray(object.dict.entries.get('Index'))?.map((n) => asNumber(n) ?? 0) ?? [0, size]

  const data = await decodeStream(object)
  const entries = new Map<number, XrefEntry>()
  let at2 = 0

  for (let s = 0; s + 1 < index.length; s += 2) {
    const first = index[s] ?? 0
    const count = index[s + 1] ?? 0
    for (let i = 0; i < count && at2 + row <= data.length; i += 1) {
      // A zero width means "take the default", and the default type is 1.
      const type = w0 === 0 ? 1 : bigEndian(data, at2, w0)
      const f2 = bigEndian(data, at2 + w0, w1)
      const f3 = bigEndian(data, at2 + w0 + w1, w2)
      at2 += row

      const num = first + i
      if (type === 0) entries.set(num, { kind: 'free' })
      else if (type === 1) entries.set(num, { kind: 'offset', offset: f2, gen: f3 })
      else if (type === 2) entries.set(num, { kind: 'compressed', stream: f2, index: f3 })
      // Any other type is reserved by the spec, and skipping it is what the
      // spec says to do.
    }
  }

  return { entries, trailer: object.dict }
}

async function readSection(src: PdfSource, at: number): Promise<Section> {
  const reader = new Reader(src, at)
  reader.skip()
  return reader.at('xref') ? readClassicSection(src, reader) : readStreamSection(src, at)
}

/**
 * Fold one section into the running map.
 *
 * `replaceFree` is the hybrid-reference case and only that case: the classic
 * half of a hybrid file marks every object that lives in an object stream as
 * free, precisely so a reader that does not understand `/XRefStm` sees a
 * consistent table. Letting the stream's entries win over those free rows is
 * the difference between reading such a file and reading a third of it.
 */
function merge(into: Map<number, XrefEntry>, from: Map<number, XrefEntry>, replaceFree: boolean) {
  for (const [num, entry] of from) {
    const held = into.get(num)
    if (held === undefined || (replaceFree && held.kind === 'free' && entry.kind !== 'free')) {
      into.set(num, entry)
    }
  }
}

/** The `N G obj` header ending at `at`, read backwards from the keyword. */
function headerBefore(
  text: string,
  at: number,
): { num: number; gen: number; start: number } | undefined {
  const isSpace = (i: number) => {
    const c = text.charCodeAt(i)
    return c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00
  }
  const isDigit = (i: number) => {
    const c = text.charCodeAt(i)
    return c >= 0x30 && c <= 0x39
  }

  let i = at - 1
  while (i >= 0 && isSpace(i)) i -= 1
  const genEnd = i + 1
  while (i >= 0 && isDigit(i)) i -= 1
  const genStart = i + 1
  if (genStart === genEnd) return undefined

  while (i >= 0 && isSpace(i)) i -= 1
  const numEnd = i + 1
  if (numEnd === genStart) return undefined
  while (i >= 0 && isDigit(i)) i -= 1
  const numStart = i + 1
  if (numStart === numEnd) return undefined
  if (numStart > 0 && isDigit(numStart - 1)) return undefined

  return {
    num: Number(text.slice(numStart, numEnd)),
    gen: Number(text.slice(genStart, genEnd)),
    start: numStart,
  }
}

/**
 * Find every `N G obj` in the file, ignoring what the table claims.
 *
 * The last resort, and it is worth having: a file whose `startxref` points at
 * the wrong byte is still a file whose objects are all there and all findable.
 * Later definitions win, which is the same "newest revision" rule the chain
 * walk follows.
 */
export function scanObjects(src: PdfSource): Map<number, XrefEntry> {
  const { text } = src
  const entries = new Map<number, XrefEntry>()

  for (let at = text.indexOf('obj'); at !== -1; at = text.indexOf('obj', at + 3)) {
    const header = headerBefore(text, at)
    if (!header) continue
    // An offset points at the object number, not at the keyword.
    entries.set(header.num, { kind: 'offset', offset: header.start, gen: header.gen })
  }

  return entries
}

/** A trailer for a file whose own trailer could not be read. */
function recoverTrailer(src: PdfSource, entries: Map<number, XrefEntry>): PdfDict {
  const at = src.text.lastIndexOf('trailer')
  if (at !== -1) {
    try {
      const reader = new Reader(src, at + 7)
      const parsed = reader.parse()
      if (parsed.type === 'dict' && parsed.entries.has('Root')) return parsed
    } catch {
      // Fall through to looking for the catalog itself.
    }
  }

  for (const [num, entry] of entries) {
    if (entry.kind !== 'offset') continue
    try {
      const { object } = parseIndirect(src, entry.offset)
      if (object.type === 'dict' && asName(object.entries.get('Type')) === 'Catalog') {
        const root: PdfObject = { type: 'ref', num, gen: entry.gen }
        return { type: 'dict', entries: new Map<string, PdfObject>([['Root', root]]) }
      }
    } catch {
      continue
    }
  }

  return fail('no trailer and no catalog: this is not a readable PDF')
}

export async function readXref(src: PdfSource): Promise<Xref> {
  const linearized = src.text.slice(0, 4096).includes('/Linearized')

  try {
    const marker = src.text.lastIndexOf('startxref')
    if (marker === -1) fail('no startxref')
    const reader = new Reader(src, marker + 9)
    reader.skip()
    const start = reader.integer()
    if (start === undefined) fail('startxref has no offset')

    const entries = new Map<number, XrefEntry>()
    const trailer = new Map<string, PdfObject>()
    const visited = new Set<number>()
    let sections = 0
    let next: number | undefined = start

    while (next !== undefined && !visited.has(next) && sections < MAX_SECTIONS) {
      if (next < 0 || next >= src.bytes.length)
        fail(`cross-reference offset ${next} is outside the file`)
      visited.add(next)
      const section: Section = await readSection(src, next)
      sections += 1
      merge(entries, section.entries, false)
      for (const [key, value] of section.trailer.entries) {
        if (!trailer.has(key)) trailer.set(key, value)
      }

      const hybrid = asNumber(section.trailer.entries.get('XRefStm'))
      if (hybrid !== undefined && !visited.has(hybrid) && hybrid < src.bytes.length) {
        visited.add(hybrid)
        merge(entries, (await readSection(src, hybrid)).entries, true)
      }

      next = asNumber(section.trailer.entries.get('Prev'))
    }

    if (entries.size === 0) fail('cross-reference table is empty')
    return {
      entries,
      trailer: { type: 'dict', entries: trailer },
      sections,
      linearized,
      recovered: false,
    }
  } catch {
    const entries = scanObjects(src)
    if (entries.size === 0) fail('no cross-reference table and no objects to scan for')
    return {
      entries,
      trailer: recoverTrailer(src, entries),
      sections: 1,
      linearized,
      recovered: true,
    }
  }
}
