// The independent check.
//
// Our own parser saying the rebuilt file is valid proves nothing: the same
// assumptions wrote it and read it back. So every cleaned document here is
// handed to Mozilla's pdf.js — a reader with no shared code and no shared
// opinions — and asked three questions. Does it open? Is the metadata gone?
// Is the text on page one still the text that was there before?
//
// pdf.js is a devDependency and lives only in this file. Nothing in src/core
// imports it, and the page still ships with no runtime dependencies at all.

import { describe, expect, it } from 'vitest'
import { cleanPdf, sniffPdf } from './index.ts'
import { encode } from '../types.ts'
import { pdf, type PdfOptions } from '../../../test/containers.ts'

const STANDARD_FONTS = new URL(
  '../../../../node_modules/pdfjs-dist/standard_fonts/',
  import.meta.url,
).href

interface Reading {
  pages: number
  info: Record<string, unknown>
  xmp: unknown
  text: string
}

/** Open a document with pdf.js and read back everything the tests care about. */
async function read(data: Uint8Array): Promise<Reading> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({
    // A copy: pdf.js takes ownership of the buffer it is handed.
    data: data.slice(),
    standardFontDataUrl: STANDARD_FONTS,
    useSystemFonts: false,
  })

  const doc = await task.promise
  const meta = await doc.getMetadata()
  const page = await doc.getPage(1)
  const content = await page.getTextContent()

  const reading: Reading = {
    pages: doc.numPages,
    info: meta.info as unknown as Record<string, unknown>,
    xmp: meta.metadata,
    text: content.items.map((item) => ('str' in item ? item.str : '')).join(''),
  }
  await task.destroy()
  return reading
}

const marked = (options: PdfOptions = {}) =>
  pdf({
    info: {
      Producer: 'SomeGenerator 4.2',
      Author: 'Jane Doe',
      Title: 'Quarterly (Q1 (draft)) report',
      Creator: 'Acme Publisher',
    },
    xmp: '<x:xmpmeta><xmp:CreatorTool>SomeGenerator 4.2</xmp:CreatorTool></x:xmpmeta>',
    ...options,
  })

const SHAPES: [string, PdfOptions][] = [
  ['a classic cross-reference table', {}],
  ['a cross-reference stream with a predictor', { xrefStream: true }],
  ['objects packed into a compressed stream', { objectStreams: true }],
  ['a hybrid-reference file', { hybrid: true }],
  ['three incremental saves', { incremental: 3 }],
  ['a linearized file', { linearized: true }],
  ['a free object in the table', { freeObject: true }],
  ['an information dictionary at generation 3', { generation: 3 }],
  ['a stream whose /Length is elsewhere', { indirectLength: true }],
  ['deflated page content', { compressedContent: true }],
  ['deflated content with an indirect length', { compressedContent: true, indirectLength: true }],
  ['an editor blob in /PieceInfo', { pieceInfo: true }],
  ['a script that runs on open', { javaScript: true }],
]

describe('sniffPdf', () => {
  it('recognises a PDF by its header and nothing else', () => {
    expect(sniffPdf(pdf())).toBe(true)
    expect(sniffPdf(encode('%PNG'))).toBe(false)
    expect(sniffPdf(encode('PDF'))).toBe(false)
  })
})

describe('pdf.js opens what the fixtures build', () => {
  it('and finds the metadata in them, so the oracle is not blind', async () => {
    // If pdf.js could not see the marks in the input, "no marks in the output"
    // would be true of an empty file too.
    const before = await read(marked())
    expect(before.info.Author).toBe('Jane Doe')
    expect(before.info.Producer).toBe('SomeGenerator 4.2')
    expect(before.info.Title).toBe('Quarterly (Q1 (draft)) report')
    expect(before.xmp).not.toBeNull()
    expect(before.text).toBe('Hello oracle')
  })
})

describe('pdf.js reads the cleaned file', () => {
  const INFO_KEYS = ['Author', 'Producer', 'Title', 'Creator', 'Subject', 'Keywords']

  for (const [name, options] of SHAPES) {
    it(`opens it, and finds no metadata left: ${name}`, async () => {
      const input = marked(options)
      const before = await read(input)
      expect(before.text, 'the fixture itself is wrong').toBe('Hello oracle')

      const result = await cleanPdf(input)
      const after = await read(result.output)

      expect(after.pages).toBe(before.pages)
      // The content is the thing the user wanted to keep.
      expect(after.text).toBe(before.text)
      expect(after.xmp).toBeNull()
      for (const key of INFO_KEYS) {
        expect(after.info[key], `${key} survived`).toBeUndefined()
      }
    })
  }

  it('opens a signed document that was cleaned with force', async () => {
    const result = await cleanPdf(marked({ signature: true }), { force: true })
    const after = await read(result.output)
    expect(after.text).toBe('Hello oracle')
    expect(after.info.Author).toBeUndefined()
  })

  it('opens the untouched file it is handed back when nothing was found', async () => {
    const plain = pdf({ info: {} })
    const result = await cleanPdf(plain)
    expect((await read(result.output)).text).toBe('Hello oracle')
  })
})
