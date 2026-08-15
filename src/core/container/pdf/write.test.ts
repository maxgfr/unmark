import { describe, expect, it } from 'vitest'
import { writePdf } from './write.ts'
import {
  asDict,
  parseIndirect,
  pdfDict,
  pdfName,
  pdfNumber,
  pdfRef,
  source,
  type PdfObject,
} from './lex.ts'
import { countPages, loadDocument, lookup } from './objects.ts'
import { readXref } from './xref.ts'
import type { StoredObject } from './objects.ts'
import { decodeUtf8, encode } from '../types.ts'
import { pdfXrefOffsets } from '../../../test/containers.ts'

const held = (object: PdfObject, gen = 0, compressed = false): StoredObject => ({
  gen,
  object,
  compressed,
})

/** Catalog, page tree, one page — the smallest graph a reader will accept. */
const document = (extra: Iterable<readonly [number, StoredObject]> = []) =>
  new Map<number, StoredObject>([
    [
      1,
      held(
        pdfDict([
          ['Type', pdfName('Catalog')],
          ['Pages', pdfRef(2)],
        ]),
      ),
    ],
    [
      2,
      held(
        pdfDict([
          ['Type', pdfName('Pages')],
          ['Kids', { type: 'array', items: [pdfRef(3)] }],
          ['Count', pdfNumber(1)],
        ]),
      ),
    ],
    [
      3,
      held(
        pdfDict([
          ['Type', pdfName('Page')],
          ['Parent', pdfRef(2)],
        ]),
      ),
    ],
    ...extra,
  ])

const text = (bytes: Uint8Array) => source(bytes).text

describe('writePdf', () => {
  it('writes a file that reads back as the same document', async () => {
    const doc = await loadDocument(source(writePdf({ objects: document(), root: pdfRef(1) })))
    expect(countPages(doc)).toBe(1)
    expect(asDict(lookup(doc, doc.trailer, 'Root'))?.entries.get('Type')).toEqual(
      pdfName('Catalog'),
    )
  })

  it('names /Root and /Size in the trailer and nothing else', async () => {
    const xref = await readXref(source(writePdf({ objects: document(), root: pdfRef(1) })))
    expect([...xref.trailer.entries.keys()].sort()).toEqual(['Root', 'Size'])
  })

  it('writes no /Prev, because there is no earlier revision to point at', () => {
    const out = text(writePdf({ objects: document(), root: pdfRef(1) }))
    expect(out).not.toContain('/Prev')
    expect(out.split('%%EOF').length - 1).toBe(1)
    expect(out.split('startxref').length - 1).toBe(1)
  })

  it('writes offsets that land on the object each row names', () => {
    // A cross-reference table is a list of byte offsets, and one that is off by
    // a byte produces a file that opens and then reports itself as damaged.
    const out = writePdf({ objects: document(), root: pdfRef(1) })
    const offsets = pdfXrefOffsets(out)

    expect(offsets).toHaveLength(3)
    for (const [i, at] of offsets.entries()) {
      expect(text(out).slice(at, at + 7)).toBe(`${i + 1} 0 obj`)
    }
  })

  it('rewrites /Length from the bytes it is actually emitting', async () => {
    // The one number in a PDF a reader believes over the evidence. Copying a
    // wrong one through would produce a file that parses and then truncates.
    const body = encode('the stream body')
    const objects = document([
      [4, held({ type: 'stream', dict: pdfDict([['Length', pdfNumber(3)]]), raw: body })],
    ])

    const out = writePdf({ objects, root: pdfRef(1) })
    const src = source(out)
    const at = (await readXref(src)).entries.get(4)
    const parsed = parseIndirect(src, at?.kind === 'offset' ? at.offset : 0)
    expect(parsed.object.type === 'stream' && decodeUtf8(parsed.object.raw)).toBe('the stream body')
    expect(text(out)).toContain(`/Length ${body.length}`)
  })

  it('writes an object that came out of an object stream as an ordinary object', () => {
    // The rule the whole rebuild rests on. Writing it back compressed would
    // rebuild the hiding place this exists to empty.
    const objects = document([
      [
        4,
        held(pdfDict([['Producer', { type: 'string', bytes: encode('Hidden Writer') }]]), 0, true),
      ],
    ])
    const out = text(writePdf({ objects, root: pdfRef(1) }))

    expect(out).toContain('4 0 obj')
    expect(out).toContain('(Hidden Writer)')
    expect(out).not.toContain('/ObjStm')
  })

  it('keeps a generation number rather than renumbering references out from under themselves', async () => {
    const objects = document([[4, held(pdfDict([['A', pdfNumber(1)]]), 3)]])
    const out = writePdf({ objects, root: pdfRef(1) })
    expect(text(out)).toContain('4 3 obj')

    const xref = await readXref(source(out))
    expect(xref.entries.get(4)).toMatchObject({ kind: 'offset', gen: 3 })
  })

  it('fills a gap in the numbering with a free row', async () => {
    const objects = document([[7, held(pdfDict([['A', pdfNumber(1)]]))]])
    const xref = await readXref(source(writePdf({ objects, root: pdfRef(1) })))
    expect([4, 5, 6].map((num) => xref.entries.get(num)?.kind)).toEqual(['free', 'free', 'free'])
    expect(xref.entries.get(7)?.kind).toBe('offset')
  })

  it('escapes a string so that any byte survives the round trip', async () => {
    const every = Uint8Array.from({ length: 256 }, (_, i) => i)
    const objects = document([[4, held(pdfDict([['V', { type: 'string', bytes: every }]]))]])

    const src = source(writePdf({ objects, root: pdfRef(1) }))
    const at = (await readXref(src)).entries.get(4)
    const parsed = parseIndirect(src, at?.kind === 'offset' ? at.offset : 0)
    const value = asDict(parsed.object)?.entries.get('V')
    expect(value?.type === 'string' && [...value.bytes]).toEqual([...every])
  })

  it('escapes a name the same way, so /A B does not become two tokens', async () => {
    const objects = document([[4, held(pdfDict([[String.raw`Odd Name#`, pdfNumber(1)]]))]])
    const src = source(writePdf({ objects, root: pdfRef(1) }))
    const at = (await readXref(src)).entries.get(4)
    const parsed = parseIndirect(src, at?.kind === 'offset' ? at.offset : 0)
    expect([...(asDict(parsed.object)?.entries.keys() ?? [])]).toEqual([String.raw`Odd Name#`])
  })

  it('writes real numbers without exponent notation', () => {
    const objects = document([[4, held(pdfDict([['V', pdfNumber(0.0000001)]]))]])
    const out = text(writePdf({ objects, root: pdfRef(1) }))
    // `1e-7` is a number to JavaScript and a syntax error to a PDF reader.
    expect(out).not.toContain('e-')
  })
})

describe('the write path', () => {
  it('contains no CompressionStream', async () => {
    // Not a style rule. A cleaner that recompresses a stream has re-encoded
    // content it was asked to leave alone, and a cleaner that recompresses an
    // object stream has put the metadata back where it could not be seen.
    // Cast because src/core is typechecked twice, once in a project that has
    // no `vite/client` types. The call shape is what Vite rewrites, and it
    // survives the cast being erased.
    type Glob = { glob: (pattern: string, options: object) => Record<string, string> }
    const modules = (import.meta as unknown as Glob).glob('./*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    })

    expect(modules['./write.ts']).toBeTypeOf('string')
    for (const [name, code] of Object.entries(modules)) {
      expect(code, `${name} constructs a compressor`).not.toContain('new CompressionStream')
      expect(code, `${name} imports a deflater`).not.toMatch(/import \{[^}]*\bdeflate\b/)
    }
  })
})
