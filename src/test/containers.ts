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
  content: string
}

/** A stored (uncompressed) zip — enough for DOCX and ODT fixtures. */
export function zip(entries: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encode(entry.name)
    const data = encode(entry.content)
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

export interface PdfOptions {
  info?: Record<string, string>
  xmp?: string
  /** Add a compressed-object-stream marker so the honest-warning path fires. */
  objectStreams?: boolean
}

/**
 * A small but structurally real PDF: header, objects, xref, trailer.
 *
 * The xref offsets are computed from the actual byte positions, so a test can
 * assert that cleaning did not move them.
 */
export function pdf(options: PdfOptions = {}): Uint8Array {
  const infoEntries = Object.entries(options.info ?? {})
    .map(([key, value]) => `/${key} (${value})`)
    .join(' ')

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n',
    `4 0 obj\n<< ${infoEntries} >>\nendobj\n`,
  ]
  if (options.xmp) {
    objects.push(
      `5 0 obj\n<< /Type /Metadata /Subtype /XML >>\nstream\n<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>${options.xmp}<?xpacket end="w"?>\nendstream\nendobj\n`,
    )
  }
  if (options.objectStreams) {
    objects.push('6 0 obj\n<< /Type /ObjStm /N 2 /First 10 >>\nendobj\n')
  }

  const header = '%PDF-1.7\n'
  const offsets: number[] = []
  let body = ''
  for (const object of objects) {
    offsets.push(header.length + body.length)
    body += object
  }

  const xrefStart = header.length + body.length
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`

  return encode(header + body + xref + trailer)
}

/** The byte offsets the xref table claims, so a test can re-read them. */
export function pdfXrefOffsets(bytes: Uint8Array): number[] {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return [...text.matchAll(/^(\d{10}) \d{5} n $/gm)].map((m) => Number(m[1]))
}

export const DOCX_CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:creator>Jane Doe</dc:creator><cp:lastModifiedBy>Jane Doe</cp:lastModifiedBy>
</cp:coreProperties>`

export const DOCX_APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
<Application>Microsoft Office Word</Application><Company>ACME</Company>
</Properties>`
