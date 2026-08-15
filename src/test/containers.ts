// Fixtures built in code, not committed as binaries.
//
// A repository full of little .png and .docx files is a repository where nobody
// can see what is being tested — you cannot read a fixture in a diff, and
// "sample_watermarked.png" tells you nothing about which chunk it carries. A
// builder shows the mark being planted, so the test reads as a statement about
// the format rather than about a file someone once made.

import { crc32 } from '../core/container/crc32.ts'
import { concat, encode } from '../core/container/types.ts'

const u32 = (value: number): Uint8Array =>
  new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])

const u32le = (value: number): Uint8Array =>
  new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff])

const u16le = (value: number): Uint8Array => new Uint8Array([value & 0xff, (value >>> 8) & 0xff])

export const bytes = (...values: (number | Uint8Array | string)[]): Uint8Array =>
  concat(
    values.map((value) =>
      typeof value === 'number'
        ? new Uint8Array([value])
        : typeof value === 'string'
          ? encode(value)
          : value,
    ),
  )

// ---------------------------------------------------------------- PNG

export interface PngChunk {
  type: string
  data: Uint8Array | string
}

const pngChunk = (type: string, data: Uint8Array): Uint8Array => {
  const body = concat([encode(type), data])
  return concat([u32(data.length), body, u32(crc32(body))])
}

/** A structurally valid PNG carrying whatever extra chunks you name. */
export function png(extra: PngChunk[] = []): Uint8Array {
  const ihdr = concat([
    u32(1), // width
    u32(1), // height
    new Uint8Array([8, 6, 0, 0, 0]), // 8-bit RGBA, no interlace
  ])
  // A single stored-deflate block holding one transparent pixel's scanline.
  const idat = new Uint8Array([
    0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x06,
  ])

  return concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    ...extra.map((chunk) =>
      pngChunk(chunk.type, typeof chunk.data === 'string' ? encode(chunk.data) : chunk.data),
    ),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array()),
  ])
}

/** A PNG tEXt/iTXt payload: keyword, NUL, value. */
export const textChunkData = (keyword: string, value: string): Uint8Array =>
  concat([encode(keyword), new Uint8Array([0]), encode(value)])

// ---------------------------------------------------------------- JPEG

export interface JpegSegment {
  /** The marker byte after 0xFF — 0xE1 for APP1, 0xFE for COM. */
  marker: number
  data: Uint8Array | string
}

/** A JPEG with the segments you name, then a minimal scan and EOI. */
export function jpeg(segments: JpegSegment[] = []): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])] // SOI

  for (const segment of segments) {
    const data = typeof segment.data === 'string' ? encode(segment.data) : segment.data
    const length = data.length + 2
    parts.push(new Uint8Array([0xff, segment.marker, (length >> 8) & 0xff, length & 0xff]), data)
  }

  // SOS, three bytes of entropy-coded nonsense, EOI. Enough structure that a
  // parser has to copy the tail verbatim rather than keep scanning markers.
  parts.push(
    new Uint8Array([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
    new Uint8Array([0x12, 0x34, 0x56]),
    new Uint8Array([0xff, 0xd9]),
  )
  return concat(parts)
}

export const exifSegment = (payload: string): Uint8Array =>
  concat([encode('Exif'), new Uint8Array([0, 0]), encode(payload)])

export const xmpSegment = (payload: string): Uint8Array =>
  concat([encode('http://ns.adobe.com/xap/1.0/'), new Uint8Array([0]), encode(payload)])

// ---------------------------------------------------------------- WebP

export interface RiffChunk {
  fourcc: string
  data: Uint8Array | string
}

export function webp(chunks: RiffChunk[] = [], flags = 0): Uint8Array {
  const vp8x = concat([
    new Uint8Array([flags, 0, 0, 0]),
    new Uint8Array([0, 0, 0]), // canvas width - 1
    new Uint8Array([0, 0, 0]), // canvas height - 1
  ])

  const body: Uint8Array[] = [encode('WEBP')]
  const push = (fourcc: string, data: Uint8Array) => {
    body.push(encode(fourcc), u32le(data.length), data)
    if (data.length % 2 === 1) body.push(new Uint8Array([0])) // pad to even
  }

  push('VP8X', vp8x)
  push('VP8 ', new Uint8Array([0, 0, 0, 0]))
  for (const chunk of chunks) {
    push(chunk.fourcc, typeof chunk.data === 'string' ? encode(chunk.data) : chunk.data)
  }

  const payload = concat(body)
  return concat([encode('RIFF'), u32le(payload.length), payload])
}

// ---------------------------------------------------------------- GIF

export interface GifExtension {
  /** 0xFE for a comment, 0xFF for an application extension. */
  label: number
  data: string
}

export function gif(extensions: GifExtension[] = []): Uint8Array {
  const parts: Uint8Array[] = [
    encode('GIF89a'),
    u16le(1), // width
    u16le(1), // height
    new Uint8Array([0x00, 0x00, 0x00]), // no global colour table
  ]

  for (const extension of extensions) {
    const payload = encode(extension.data)
    parts.push(new Uint8Array([0x21, extension.label]))
    // Sub-block chain: one length-prefixed block, then a zero terminator.
    parts.push(new Uint8Array([payload.length]), payload, new Uint8Array([0]))
  }

  parts.push(
    // Image descriptor, minimal LZW data, then the trailer.
    new Uint8Array([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00]),
    new Uint8Array([0x02, 0x02, 0x44, 0x01, 0x00]),
    new Uint8Array([0x3b]),
  )
  return concat(parts)
}

// ---------------------------------------------------------------- ZIP

export interface ZipEntry {
  name: string
  /** Bytes for a picture pasted into the document; a string for a part. */
  content: string | Uint8Array
}

/** A stored (uncompressed) zip — enough for DOCX and ODT fixtures. */
export function zip(entries: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encode(entry.name)
    const data = typeof entry.content === 'string' ? encode(entry.content) : entry.content
    const checksum = crc32(data)

    const local = concat([
      u32le(0x04034b50),
      u16le(20), // version needed
      u16le(0), // flags
      u16le(0), // method: stored
      u16le(0), // time
      u16le(0), // date
      u32le(checksum),
      u32le(data.length),
      u32le(data.length),
      u16le(name.length),
      u16le(0),
      name,
      data,
    ])
    locals.push(local)

    centrals.push(
      concat([
        u32le(0x02014b50),
        u16le(20), // version made by
        u16le(20), // version needed
        u16le(0),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(checksum),
        u32le(data.length),
        u32le(data.length),
        u16le(name.length),
        u16le(0),
        u16le(0),
        u16le(0),
        u16le(0),
        u32le(0),
        u32le(offset),
        name,
      ]),
    )
    offset += local.length
  }

  const central = concat(centrals)
  const eocd = concat([
    u32le(0x06054b50),
    u16le(0),
    u16le(0),
    u16le(entries.length),
    u16le(entries.length),
    u32le(central.length),
    u32le(offset),
    u16le(0),
  ])

  return concat([...locals, central, eocd])
}

// ---------------------------------------------------------------- PDF

/**
 * A valid deflate stream that does not compress anything.
 *
 * The fixture builder is synchronous, and `CompressionStream` is not. Rather
 * than make every caller await a test fixture, object streams and
 * cross-reference streams are written as stored deflate blocks: BTYPE 00, a
 * length, the bytes. `DecompressionStream('deflate')` reads them exactly as it
 * reads a real one, which is the only property the tests need.
 */
export function zlibStored(data: Uint8Array): Uint8Array {
  let a = 1
  let b = 0
  for (const byte of data) {
    a = (a + byte) % 65_521
    b = (b + a) % 65_521
  }

  const parts: Uint8Array[] = [new Uint8Array([0x78, 0x01])]
  const block = 0xffff
  for (let at = 0; at < data.length || at === 0; at += block) {
    const chunk = data.slice(at, at + block)
    const final = at + block >= data.length ? 1 : 0
    parts.push(
      new Uint8Array([
        final,
        chunk.length & 0xff,
        (chunk.length >> 8) & 0xff,
        ~chunk.length & 0xff,
        (~chunk.length >> 8) & 0xff,
      ]),
      chunk,
    )
  }
  parts.push(new Uint8Array([(b >>> 8) & 0xff, b & 0xff, (a >>> 8) & 0xff, a & 0xff]))
  return concat(parts)
}

/** PNG Up: each row minus the row above, which is why xref streams use it. */
const pngUp = (rows: readonly Uint8Array[], width: number): Uint8Array => {
  const out: Uint8Array[] = []
  let previous = new Uint8Array(width)
  for (const row of rows) {
    const line = new Uint8Array(width + 1)
    line[0] = 2
    for (let i = 0; i < width; i += 1) line[i + 1] = ((row[i] ?? 0) - (previous[i] ?? 0)) & 0xff
    out.push(line)
    previous = Uint8Array.from(row)
  }
  return concat(out)
}

export interface PdfOptions {
  /**
   * Information dictionary entries, written as literal strings without escaping.
   *
   * Unescaped on purpose: passing `Quarterly (Q1 (draft)) report` produces a
   * genuinely nested literal string, which is the case a regex-based reader
   * truncates at the first inner `)`.
   */
  info?: Record<string, string>
  xmp?: string
  /** Pack the catalog, page tree, page, font and /Info into a compressed object stream. */
  objectStreams?: boolean
  /** Write the cross-reference as a stream with a PNG-Up predictor. */
  xrefStream?: boolean
  /** Both forms at once: a classic table that hides /Info behind an /XRefStm. */
  hybrid?: boolean
  /** Append this many incremental saves, each one replacing /Info. */
  incremental?: number
  /** A trailer /Encrypt entry, which means every string in the file is ciphertext. */
  encrypted?: boolean
  /** An AcroForm signature field with a /ByteRange. */
  signature?: boolean
  /** A linearization dictionary and a cross-reference table split in two. */
  linearized?: boolean
  /** Reserve an object number, mark it free, and reference it from nowhere. */
  freeObject?: boolean
  /** Generation number for the information dictionary. Default 0. */
  generation?: number
  /** Text drawn on page 1, so an oracle can check the content survived. */
  text?: string
  /** Keep the content stream's /Length in an object of its own. */
  indirectLength?: boolean
  /** Deflate the page content, so a cleaner has something it must not re-encode. */
  compressedContent?: boolean
  /** A private per-document blob left behind by an editor. */
  pieceInfo?: boolean
  /** A document-level script the viewer runs on open. */
  javaScript?: boolean
}

const pad10 = (value: number) => String(value).padStart(10, '0')
const pad5 = (value: number) => String(value).padStart(5, '0')
const xrefRow = (offset: number, gen: number) => `${pad10(offset)} ${pad5(gen)} n \n`
const FREE_ROW = '0000000000 65535 f \n'

const streamObject = (dict: string, data: Uint8Array): Uint8Array =>
  concat([encode(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, encode('\nendstream')])

/**
 * A structurally real PDF, in whichever of the format's shapes you ask for.
 *
 * Every variant here exists because it is a shape a real file takes and a
 * shape a naive reader gets wrong: a cross-reference stream instead of a
 * table, the information dictionary hidden inside a compressed object stream,
 * three saves stacked on top of each other, a length that lives in another
 * object. The page carries actual text so a cleaned copy can be handed to an
 * independent reader and checked for the same words.
 */
export function pdf(options: PdfOptions = {}): Uint8Array {
  const useObjStm = options.objectStreams === true || options.hybrid === true
  const useXrefStream = options.xrefStream === true || options.objectStreams === true
  const infoGen = options.generation ?? 0
  const content = encode(`BT /F1 18 Tf 20 40 Td (${options.text ?? 'Hello oracle'}) Tj ET\n`)

  // Numbered densely, so that a gap in the table means the fixture asked for
  // one. A builder that always leaves holes cannot test the case where there
  // are none.
  let next = 1
  const take = (wanted?: boolean) => (wanted === false ? 0 : (next += 1) - 1)
  const CATALOG = take()
  const PAGES = take()
  const PAGE = take()
  const CONTENTS = take()
  const FONT = take()
  const INFO = take()
  const METADATA = take(Boolean(options.xmp))
  const JAVASCRIPT = take(options.javaScript === true)
  const LENGTH = take(options.indirectLength === true)
  const SIGNATURE = take(options.signature === true)
  const FIELD = take(options.signature === true)
  const ENCRYPT = take(options.encrypted === true)
  const LINEAR = take(options.linearized === true)
  const OBJSTM = take(useObjStm)
  const XREF_STREAM = take(useXrefStream || options.hybrid === true)
  // One last number, handed out and then never given a body: a free object.
  take(options.freeObject === true)

  const catalog = ['/Type /Catalog', `/Pages ${PAGES} 0 R`]
  if (options.xmp) catalog.push(`/Metadata ${METADATA} 0 R`)
  if (options.javaScript) catalog.push(`/Names << /JavaScript ${JAVASCRIPT} 0 R >>`)
  if (options.pieceInfo) {
    catalog.push('/PieceInfo << /SomeEditor << /Private (session-4711) >> >>')
  }
  if (options.signature) catalog.push(`/AcroForm << /Fields [${FIELD} 0 R] /SigFlags 3 >>`)

  const infoEntries = Object.entries(options.info ?? {})
    .map(([key, value]) => `/${key} (${value})`)
    .join(' ')

  const bodies = new Map<number, string | Uint8Array>()
  bodies.set(CATALOG, `<< ${catalog.join(' ')} >>`)
  bodies.set(PAGES, `<< /Type /Pages /Kids [${PAGE} 0 R] /Count 1 >>`)
  bodies.set(
    PAGE,
    `<< /Type /Page /Parent ${PAGES} 0 R /MediaBox [0 0 200 100] ` +
      `/Resources << /Font << /F1 ${FONT} 0 R >> >> /Contents ${CONTENTS} 0 R >>`,
  )
  const payload = options.compressedContent ? zlibStored(content) : content
  const filter = options.compressedContent ? '/Filter /FlateDecode ' : ''
  bodies.set(
    CONTENTS,
    concat([
      encode(
        options.indirectLength
          ? `<< ${filter}/Length ${LENGTH} 0 R >>\nstream\n`
          : `<< ${filter}/Length ${payload.length} >>\nstream\n`,
      ),
      payload,
      encode('\nendstream'),
    ]),
  )
  bodies.set(FONT, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  bodies.set(INFO, `<< ${infoEntries} >>`)

  if (options.xmp) {
    bodies.set(
      METADATA,
      streamObject(
        '/Type /Metadata /Subtype /XML',
        encode(
          `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>${options.xmp}<?xpacket end="w"?>`,
        ),
      ),
    )
  }
  if (options.javaScript) {
    bodies.set(
      JAVASCRIPT,
      String.raw`<< /Names [(Boot) << /S /JavaScript /JS (app.alert\(1\);) >>] >>`,
    )
  }
  if (options.indirectLength) bodies.set(LENGTH, String(payload.length))
  if (options.signature) {
    bodies.set(
      SIGNATURE,
      '<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached ' +
        '/ByteRange [0 840 960 1200] /Contents <00> /M (D:20260101000000Z) >>',
    )
    bodies.set(
      FIELD,
      `<< /FT /Sig /T (Signature1) /V ${SIGNATURE} 0 R /Type /Annot /Subtype /Widget ` +
        `/Rect [0 0 0 0] /F 132 /P ${PAGE} 0 R >>`,
    )
  }
  if (options.encrypted) {
    bodies.set(ENCRYPT, '<< /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -1 >>')
  }
  if (options.linearized) {
    bodies.set(LINEAR, `<< /Linearized 1 /L 0 /O ${PAGE} /E 0 /N 1 /T 0 /H [0 0] >>`)
  }

  const generations = new Map<number, number>([[INFO, infoGen]])
  const packed = useObjStm ? (options.hybrid ? [INFO] : [CATALOG, PAGES, PAGE, FONT, INFO]) : []

  const infoRef = `${INFO} ${infoGen} R`
  const trailerEntries = [`/Root ${CATALOG} 0 R`, `/Info ${infoRef}`]
  if (options.encrypted) trailerEntries.push(`/Encrypt ${ENCRYPT} 0 R`)

  // Everything above is layout-independent. What follows places the bytes.
  const plain = [...bodies.keys()].filter((num) => !packed.includes(num)).sort((a, b) => a - b)
  // `next` stopped one past the last number handed out.
  const size = next

  const objStmData = (() => {
    if (packed.length === 0) return undefined
    const parts = packed.map((num) => `${String(bodies.get(num))}\n`)
    let index = ''
    let at = 0
    for (const [i, num] of packed.entries()) {
      index += `${num} ${at} `
      at += (parts[i] ?? '').length
    }
    return { first: index.length, count: packed.length, bytes: encode(index + parts.join('')) }
  })()

  /**
   * Lay the file out, given where the previous cross-reference section sits.
   *
   * Two passes for the linearized shape, whose first section names an offset
   * that only exists once the whole file has been written. `/Prev` is padded to
   * ten digits so the second pass produces bytes the same length as the first.
   */
  const assemble = (prevOffset: number): Uint8Array => {
    const parts: Uint8Array[] = []
    let at = 0
    const emit = (piece: string | Uint8Array) => {
      const chunk = typeof piece === 'string' ? encode(piece) : piece
      parts.push(chunk)
      at += chunk.length
    }
    const offsets = new Map<number, number>()
    const object = (num: number, body: string | Uint8Array) => {
      offsets.set(num, at)
      emit(`${num} ${generations.get(num) ?? 0} obj\n`)
      emit(body)
      emit('\nendobj\n')
    }

    emit('%PDF-1.7\n')

    let firstSection = 0
    if (options.linearized) {
      object(LINEAR, bodies.get(LINEAR) ?? '<< >>')
      firstSection = at
      emit(`xref\n0 1\n${FREE_ROW}${LINEAR} 1\n${xrefRow(offsets.get(LINEAR) ?? 0, 0)}`)
      emit(
        `trailer\n<< /Size ${size} ${trailerEntries.join(' ')} /Prev ${pad10(prevOffset)} >>\n` +
          'startxref\n0\n%%EOF\n',
      )
    }

    for (const num of plain) {
      if (num === LINEAR) continue
      object(num, bodies.get(num) ?? '<< >>')
    }

    let objStmAt = 0
    if (objStmData) {
      objStmAt = at
      object(
        OBJSTM,
        streamObject(
          `/Type /ObjStm /N ${objStmData.count} /First ${objStmData.first} ` +
            '/Filter /FlateDecode',
          zlibStored(objStmData.bytes),
        ),
      )
    }

    /** Rows for a cross-reference stream: type, four-byte field, two-byte field. */
    const streamRows = (nums: readonly number[], selfAt: number, selfNum: number) => {
      const rows: Uint8Array[] = []
      const write = (type: number, f2: number, f3: number) =>
        rows.push(
          new Uint8Array([
            type,
            (f2 >>> 24) & 0xff,
            (f2 >>> 16) & 0xff,
            (f2 >>> 8) & 0xff,
            f2 & 0xff,
            (f3 >>> 8) & 0xff,
            f3 & 0xff,
          ]),
        )

      for (const num of nums) {
        if (num === 0) write(0, 0, 65_535)
        else if (num === selfNum) write(1, selfAt, 0)
        else if (num === OBJSTM) write(1, objStmAt, 0)
        else if (packed.includes(num)) write(2, OBJSTM, packed.indexOf(num))
        else if (offsets.has(num)) write(1, offsets.get(num) ?? 0, generations.get(num) ?? 0)
        else write(0, 0, 65_535)
      }
      return rows
    }

    const xrefStreamObject = (nums: readonly number[], selfAt: number, index: string) => {
      const rows = streamRows(nums, selfAt, XREF_STREAM)
      return streamObject(
        `/Type /XRef /Size ${size} /Index [${index}] /W [1 4 2] ${trailerEntries.join(' ')} ` +
          '/Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >>',
        zlibStored(pngUp(rows, 7)),
      )
    }

    if (useXrefStream) {
      const startxref = at
      const nums = Array.from({ length: size }, (_, i) => i)
      object(XREF_STREAM, xrefStreamObject(nums, startxref, `0 ${size}`))
      emit(`startxref\n${startxref}\n%%EOF\n`)
      return concat(parts)
    }

    // Hybrid: the compressed entries live in an /XRefStm that the classic
    // table below deliberately cannot express, and marks free instead.
    let hybridAt = 0
    if (options.hybrid) {
      hybridAt = at
      object(
        XREF_STREAM,
        xrefStreamObject(
          [0, ...packed, XREF_STREAM],
          hybridAt,
          `0 1 ${packed.join(' 1 ')} 1 ${XREF_STREAM} 1`,
        ),
      )
    }

    const mainSection = at
    let table = `xref\n0 ${size}\n`
    for (let num = 0; num < size; num += 1) {
      const offset = offsets.get(num)
      table += offset === undefined ? FREE_ROW : xrefRow(offset, generations.get(num) ?? 0)
    }
    emit(table)

    const tail = [...trailerEntries]
    if (options.hybrid) tail.push(`/XRefStm ${hybridAt}`)
    emit(`trailer\n<< /Size ${size} ${tail.join(' ')} >>\n`)
    emit(`startxref\n${options.linearized ? firstSection : mainSection}\n%%EOF\n`)

    // Each incremental save appends a whole new revision: the object it
    // changes, a cross-reference section covering only that object, and a
    // trailer pointing back at the section before it.
    let previous = mainSection
    for (let pass = 1; pass <= (options.incremental ?? 0); pass += 1) {
      const objectAt = at
      emit(`${INFO} ${infoGen} obj\n<< /Producer (Draft Writer ${pass}.0) >>\nendobj\n`)
      const sectionAt = at
      emit(`xref\n0 1\n${FREE_ROW}${INFO} 1\n${xrefRow(objectAt, infoGen)}`)
      emit(
        `trailer\n<< /Size ${size} ${trailerEntries.join(' ')} /Prev ${previous} >>\n` +
          `startxref\n${sectionAt}\n%%EOF\n`,
      )
      previous = sectionAt
    }

    return concat(parts)
  }

  if (!options.linearized) return assemble(0)

  // The first pass exists only to learn where the main section landed, which
  // is the number the first section has to point back at.
  const probe = pdfLatin1(assemble(0))
  return assemble(probe.lastIndexOf('\nxref\n') + 1)
}

const pdfLatin1 = (bytes: Uint8Array): string => {
  let text = ''
  const chunk = 8192
  for (let i = 0; i < bytes.length; i += chunk) {
    text += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return text
}

/** The byte offsets the xref table claims, so a test can re-read them. */
export function pdfXrefOffsets(bytes: Uint8Array): number[] {
  return [...pdfLatin1(bytes).matchAll(/^(\d{10}) \d{5} n $/gm)].map((m) => Number(m[1]))
}

/**
 * Overwrite an ASCII run inside a PDF, byte for byte.
 *
 * For building the damaged fixtures: a `/Count` that lies, a `startxref` that
 * points nowhere. Decoding the file to a string and back would re-encode every
 * compressed stream in it as UTF-8, so the replacement has to be the same
 * length and has to happen in the bytes.
 */
export function pdfPatch(bytes: Uint8Array, find: string, replace: string): Uint8Array {
  if (find.length !== replace.length) throw new Error('pdfPatch: lengths must match')
  const at = pdfLatin1(bytes).indexOf(find)
  if (at === -1) throw new Error(`pdfPatch: ${find} is not in this file`)
  const out = bytes.slice()
  for (let i = 0; i < replace.length; i += 1) out[at + i] = replace.charCodeAt(i)
  return out
}

export const DOCX_CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator>Jane Doe</dc:creator><cp:lastModifiedBy>Jane Doe</cp:lastModifiedBy>
</cp:coreProperties>`

export const DOCX_APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>Microsoft Office Word</Application><Company>ACME</Company>
</Properties>`

// ---------------------------------------------------------------- ISOBMFF

const u16be = (value: number): Uint8Array => new Uint8Array([(value >>> 8) & 0xff, value & 0xff])

const u64 = (value: number): Uint8Array =>
  concat([u32(Math.floor(value / 2 ** 32)), u32(value >>> 0)])

const fromHex = (text: string): Uint8Array =>
  new Uint8Array((text.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)))

const asBytes = (value: Uint8Array | string | undefined): Uint8Array =>
  value === undefined ? new Uint8Array() : typeof value === 'string' ? encode(value) : value

// A box type is four bytes, not four characters. iTunes names its tags '©too'
// and friends, where the © is the single byte 0xA9 — UTF-8 encoding it would
// produce two bytes and a five-byte type nobody can parse.
const fourcc = (type: string): Uint8Array =>
  new Uint8Array([...type].map((char) => char.codePointAt(0) ?? 0))

export interface BoxSpec {
  type: string
  /** Bytes between the header and the children: a FullBox's counts, a leaf's payload. */
  prefix?: Uint8Array | string
  children?: BoxSpec[]
  /** Payload after the children, for a leaf. */
  data?: Uint8Array | string
  /** Four zero bytes of version and flags, as a FullBox carries. */
  full?: boolean
  /** Use the 64-bit size escape: size 1, then the real size after the type. */
  large?: boolean
  /** Declare size 0 — "this box runs to the end of the file". */
  toEnd?: boolean
  /** The sixteen bytes a `uuid` box carries after its type, as hex. */
  uuid?: string
}

/** One ISOBMFF box, with whichever of the two size escapes you ask for. */
export function box(spec: BoxSpec): Uint8Array {
  const body = concat([
    spec.uuid ? fromHex(spec.uuid) : new Uint8Array(),
    spec.full ? new Uint8Array(4) : new Uint8Array(),
    asBytes(spec.prefix),
    ...(spec.children ?? []).map(box),
    asBytes(spec.data),
  ])

  if (spec.toEnd) return concat([u32(0), fourcc(spec.type), body])
  if (spec.large) return concat([u32(1), fourcc(spec.type), u64(16 + body.length), body])
  return concat([u32(8 + body.length), fourcc(spec.type), body])
}

const ftyp = (major: string, compatible: readonly string[]): Uint8Array =>
  box({ type: 'ftyp', data: concat([encode(major), u32(0), encode(compatible.join(''))]) })

/** A `data` box, which is what every iTunes-style tag wraps its value in. */
const dataBox = (value: string): BoxSpec => ({
  type: 'data',
  data: concat([u32(1), u32(0), encode(value)]), // type indicator 1 = UTF-8, locale 0
})

export interface HeifItem {
  /** 'Exif' or 'mime' for metadata; anything else lands in `iinf` untouched. */
  type: string
  /** content_type, which only a `mime` item carries. */
  content?: string
  data: string
}

export interface HeifOptions {
  /** Metadata items, laid into `mdat` after the picture. */
  items?: HeifItem[]
  /** Extra top-level boxes, between `meta` and `mdat`. */
  extra?: BoxSpec[]
  /** Property boxes inside `iprp/ipco`. Defaults to an `ispe` and a `colr`. */
  properties?: BoxSpec[]
  /** Give `mdat` the 64-bit size escape. */
  largeMdat?: boolean
  /** Give `mdat` size 0, so it runs to the end of the file. */
  openMdat?: boolean
  /** What the picture item's bytes say, so a test can find them again. */
  picture?: string
  /** Lay the picture's bytes into `mdat` after the metadata items, not before. */
  pictureLast?: boolean
}

/**
 * A structurally real HEIF: `meta` describing items whose bytes live in `mdat`.
 *
 * The offsets in `iloc` are computed from where the payloads actually land, in
 * two passes — build the `meta` box with zeroes to learn its size, then again
 * with the real numbers, which fit the same fixed-width fields. That is what
 * lets a test assert an item is still readable at the offset the file claims.
 */
function heif(codec: string, brand: string, compatible: string[], options: HeifOptions) {
  const items = [
    { id: 1, type: codec, content: '', data: options.picture ?? 'a picture, more or less' },
    ...(options.items ?? []).map((item, index) => ({
      id: index + 2,
      type: item.type,
      content: item.content ?? '',
      data: item.data,
    })),
  ]
  const payloads = items.map((item) => encode(item.data))
  const properties = options.properties ?? [
    { type: 'ispe', full: true, data: concat([u32(1), u32(1)]) },
    { type: 'colr', data: concat([encode('prof'), encode('sRGB IEC61966-2.1 by Someone')]) },
  ]

  const infe = (item: (typeof items)[number]): BoxSpec => ({
    type: 'infe',
    prefix: concat([
      new Uint8Array([2, 0, 0, 0]), // version 2, no flags
      u16be(item.id),
      u16be(0), // item_protection_index
      encode(item.type),
      encode(`item ${String(item.id)}\0`),
      item.type === 'mime' ? encode(`${item.content}\0`) : new Uint8Array(),
    ]),
  })

  const meta = (offsets: readonly number[]): Uint8Array =>
    box({
      type: 'meta',
      full: true,
      children: [
        { type: 'hdlr', full: true, data: concat([u32(0), encode('pict'), new Uint8Array(13)]) },
        { type: 'pitm', full: true, data: u16be(1) },
        {
          type: 'iinf',
          full: true,
          prefix: u16be(items.length),
          children: items.map(infe),
        },
        {
          type: 'iloc',
          prefix: concat([
            new Uint8Array([1, 0, 0, 0]), // version 1, so construction_method is present
            new Uint8Array([0x44, 0x00]), // 4-byte offsets and lengths, no base offset or index
            u16be(items.length),
            ...items.map((item, index) =>
              concat([
                u16be(item.id),
                u16be(0), // reserved + construction_method 0: a file offset
                u16be(0), // data_reference_index
                u16be(1), // extent_count
                u32(offsets[index] ?? 0),
                u32(payloads[index]?.length ?? 0),
              ]),
            ),
          ]),
        },
        {
          type: 'iprp',
          children: [
            { type: 'ipco', children: properties },
            {
              type: 'ipma',
              full: true,
              data: concat([
                u32(1), // one entry
                u16be(1), // for item 1
                new Uint8Array([properties.length]),
                new Uint8Array(properties.map((_, index) => 0x80 | (index + 1))),
              ]),
            },
          ],
        },
        ...(items.length > 1
          ? [
              {
                type: 'iref',
                full: true,
                children: items.slice(1).map((item) => ({
                  type: 'cdsc',
                  data: concat([u16be(item.id), u16be(1), u16be(1)]),
                })),
              } satisfies BoxSpec,
            ]
          : []),
      ],
    })

  const head = ftyp(brand, compatible)
  const extra = (options.extra ?? []).map(box)
  const mdatHeader = options.largeMdat ? 16 : 8
  const placeholder = meta(items.map(() => 0))

  // Which order the payloads sit in inside `mdat`, which is independent of the
  // order the items are declared in. Putting the picture last is what makes a
  // removed item's bytes sit *in front of* one that stays.
  const indices = items.map((_, index) => index)
  const order = options.pictureLast ? [...indices.slice(1), 0] : indices

  let cursor =
    head.length +
    placeholder.length +
    extra.reduce((sum, part) => sum + part.length, 0) +
    mdatHeader
  const offsets = items.map(() => 0)
  for (const index of order) {
    offsets[index] = cursor
    cursor += payloads[index]?.length ?? 0
  }

  return concat([
    head,
    meta(offsets),
    ...extra,
    box({
      type: 'mdat',
      data: concat(order.map((index) => payloads[index] ?? new Uint8Array())),
      ...(options.largeMdat ? { large: true } : {}),
      ...(options.openMdat ? { toEnd: true } : {}),
    }),
  ])
}

export const heic = (options: HeifOptions = {}): Uint8Array =>
  heif('hvc1', 'heic', ['mif1', 'heic'], options)

export const avif = (options: HeifOptions = {}): Uint8Array =>
  heif('av01', 'avif', ['mif1', 'miaf'], options)

export interface Mp4Options {
  /** iTunes-style tags in moov/udta/meta/ilst, by atom name. */
  tags?: Record<string, string>
  /** Free-form `----` atoms in the same list, by name. */
  freeForm?: Record<string, string>
  /**
   * QuickTime `keys` metadata in moov/meta, by dotted key name.
   *
   * The layout every iPhone .mov uses: a `keys` box declares the names and the
   * `ilst` children are numbered by their position in it, not named at all.
   */
  keyed?: Record<string, string>
  /** Atoms directly inside `udta`, written QuickTime's way: a length, a language, text. */
  udta?: Record<string, string>
  /** Creation and modification time for mvhd, tkhd and mdhd, in seconds since 1904. */
  created?: number
  /** Extra boxes inside `moov`, after the track. */
  inMoov?: BoxSpec[]
  /** Extra top-level boxes, between `moov` and `mdat`. */
  extra?: BoxSpec[]
  /** Write `moov/udta/meta` the way QuickTime does: no version and flags. */
  quicktimeMeta?: boolean
  /** The bytes in `mdat`, which `stco` has to go on pointing at. */
  media?: string
  brand?: string
  compatible?: string[]
}

/**
 * An MP4 with one track, one chunk, and a tag list to strip things out of.
 *
 * `stco` holds the absolute file offset of the media, so it is filled in the
 * same two passes as the HEIF builder's `iloc`. A test that removes a tag and
 * then reads the media back through `stco` is testing the thing that actually
 * breaks when a box shrinks.
 */
export function mp4(options: Mp4Options = {}): Uint8Array {
  const media = encode(options.media ?? 'sample data, not really a video')
  const stamp = options.created ?? 0
  const tags: BoxSpec[] = [
    ...Object.entries(options.tags ?? {}).map(([name, value]) => ({
      type: name,
      children: [dataBox(value)],
    })),
    ...Object.entries(options.freeForm ?? {}).map(([name, value]) => ({
      type: '----',
      children: [
        { type: 'mean', full: true, data: 'com.apple.iTunes' },
        { type: 'name', full: true, data: name },
        dataBox(value),
      ],
    })),
  ]

  // QuickTime atoms carry their text behind a 16-bit length and a 16-bit
  // language code, with no `data` box in sight.
  const udtaAtoms: BoxSpec[] = Object.entries(options.udta ?? {}).map(([name, value]) => ({
    type: name,
    data: concat([u16be(encode(value).length), u16be(0), encode(value)]),
  }))

  const keyed = Object.entries(options.keyed ?? {})
  const keysMeta: BoxSpec[] =
    keyed.length === 0
      ? []
      : [
          {
            type: 'meta',
            full: true,
            children: [
              { type: 'hdlr', full: true, data: concat([u32(0), encode('mdta'), u32(0)]) },
              {
                type: 'keys',
                full: true,
                data: concat([
                  u32(keyed.length),
                  ...keyed.map(([name]) => {
                    const label = encode(name)
                    return concat([u32(8 + label.length), encode('mdta'), label])
                  }),
                ]),
              },
              {
                type: 'ilst',
                // Named by their one-based position in `keys`, as four raw bytes.
                children: keyed.map(([, value], index) => ({
                  type: String.fromCharCode(0, 0, (index + 1) >> 8, (index + 1) & 0xff),
                  children: [dataBox(value)],
                })),
              },
            ],
          },
        ]

  const moov = (chunkOffset: number): Uint8Array =>
    box({
      type: 'moov',
      children: [
        { type: 'mvhd', full: true, data: concat([u32(stamp), u32(stamp), new Uint8Array(88)]) },
        {
          type: 'trak',
          children: [
            {
              type: 'tkhd',
              full: true,
              data: concat([u32(stamp), u32(stamp), new Uint8Array(72)]),
            },
            {
              type: 'mdia',
              children: [
                {
                  type: 'mdhd',
                  full: true,
                  data: concat([u32(stamp), u32(stamp), new Uint8Array(12)]),
                },
                {
                  type: 'minf',
                  children: [
                    {
                      type: 'stbl',
                      children: [
                        { type: 'stsd', full: true, data: u32(0) },
                        { type: 'stco', full: true, data: concat([u32(1), u32(chunkOffset)]) },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
        ...keysMeta,
        {
          type: 'udta',
          children: [
            {
              type: 'meta',
              ...(options.quicktimeMeta ? {} : { full: true }),
              children: [
                { type: 'hdlr', full: true, data: concat([u32(0), encode('mdir'), u32(0)]) },
                { type: 'ilst', children: tags },
              ],
            },
            ...udtaAtoms,
          ],
        },
        ...(options.inMoov ?? []),
      ],
    })

  const head = ftyp(options.brand ?? 'isom', options.compatible ?? ['isom', 'mp42'])
  const extra = (options.extra ?? []).map(box)
  const before =
    head.length +
    moov(0).length +
    extra.reduce((sum, part) => sum + part.length, 0) +
    8 /* mdat header */

  return concat([head, moov(before), ...extra, box({ type: 'mdat', data: media })])
}

/** The sixteen bytes C2PA stamps its `uuid` box with, and Adobe's for XMP. */
export const C2PA_BOX_UUID = 'd8fec3d61b0e483c92975828877ec481'
export const XMP_BOX_UUID = 'be7acfcb97a942e89c71999491e3afac'
