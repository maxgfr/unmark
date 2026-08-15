import { describe, expect, it } from 'vitest'
import { readXref, scanObjects } from './xref.ts'
import { asNumber, source } from './lex.ts'
import { encode } from '../types.ts'
import { pdf, pdfPatch } from '../../../test/containers.ts'

const kinds = async (bytes: Uint8Array) => {
  const xref = await readXref(source(bytes))
  return [...xref.entries]
    .sort(([a], [b]) => a - b)
    .map(([num, entry]) => `${num}:${entry.kind}`)
    .join(' ')
}

describe('the classic table', () => {
  it('reads offsets and the trailer that follows it', async () => {
    const xref = await readXref(source(pdf({ info: { Author: 'Jane Doe' } })))
    expect(xref.trailer.entries.get('Root')).toEqual({ type: 'ref', num: 1, gen: 0 })
    expect(asNumber(xref.trailer.entries.get('Size'))).toBeGreaterThan(1)
    expect(xref.entries.get(1)).toMatchObject({ kind: 'offset' })
    expect(xref.recovered).toBe(false)
  })

  it('reads a free entry as free rather than as an offset of zero', async () => {
    // Object 0 is always free, and a reader that files it under offset 0 will
    // later parse the file header as an object.
    expect(await kinds(pdf({ freeObject: true }))).toContain('0:free')
    const withFree = await readXref(source(pdf({ freeObject: true })))
    const free = [...withFree.entries].filter(([, entry]) => entry.kind === 'free')
    expect(free.length).toBe(2)
  })

  it('leaves no gaps when the fixture asks for none', async () => {
    // The counterpart: a table with only object 0 free, so a test about free
    // objects is testing something the default does not already do.
    const dense = await readXref(source(pdf()))
    expect([...dense.entries].filter(([, entry]) => entry.kind === 'free').length).toBe(1)
  })

  it('keeps the generation number the row carries', async () => {
    const xref = await readXref(source(pdf({ generation: 3, info: { Author: 'A' } })))
    const info = [...xref.entries.values()].filter(
      (entry) => entry.kind === 'offset' && entry.gen === 3,
    )
    expect(info.length).toBe(1)
  })
})

describe('cross-reference streams', () => {
  it('reads a table written as a compressed stream with a PNG predictor', async () => {
    // Predictor 12 makes every row a difference from the row above. Skipping
    // the reversal parses cleanly and yields offsets that point nowhere.
    const xref = await readXref(source(pdf({ xrefStream: true, info: { Author: 'Jane Doe' } })))
    expect(xref.recovered).toBe(false)
    expect(xref.entries.get(1)).toMatchObject({ kind: 'offset' })
    expect(xref.trailer.entries.get('Root')).toEqual({ type: 'ref', num: 1, gen: 0 })
  })

  it('reads type-2 entries as slots inside an object stream', async () => {
    const xref = await readXref(source(pdf({ objectStreams: true, info: { Author: 'A' } })))
    const compressed = [...xref.entries.values()].filter((entry) => entry.kind === 'compressed')
    expect(compressed.length).toBe(5)
  })

  it('has no compressed entries when the file has no object streams', async () => {
    const xref = await readXref(source(pdf({ xrefStream: true })))
    expect([...xref.entries.values()].some((entry) => entry.kind === 'compressed')).toBe(false)
  })
})

describe('hybrid-reference files', () => {
  it('lets the /XRefStm win over the free rows the classic table had to write', async () => {
    // The whole point of the hybrid form: the classic half marks every object
    // that lives in an object stream as free, so that a reader from 1997 sees
    // a consistent table. A reader that stops there loses those objects.
    const xref = await readXref(source(pdf({ hybrid: true, info: { Author: 'Jane Doe' } })))
    const compressed = [...xref.entries.values()].filter((entry) => entry.kind === 'compressed')
    expect(compressed.length).toBe(1)
  })

  it('does not invent compressed entries for a plain classic file', async () => {
    const xref = await readXref(source(pdf({ info: { Author: 'Jane Doe' } })))
    expect([...xref.entries.values()].some((entry) => entry.kind === 'compressed')).toBe(false)
  })
})

describe('the /Prev chain', () => {
  it('counts one section per save', async () => {
    expect((await readXref(source(pdf()))).sections).toBe(1)
    expect((await readXref(source(pdf({ incremental: 3 })))).sections).toBe(4)
  })

  it('serves the newest definition of an object, not the oldest', async () => {
    // Walking the chain newest-first and keeping the first entry seen is the
    // rule. Reversed, the tool would clean the draft and leave the final text.
    const bytes = pdf({ incremental: 2, info: { Producer: 'Original' } })
    const xref = await readXref(source(bytes))
    const info = xref.entries.get(6)
    expect(info?.kind).toBe('offset')

    const text = source(bytes).text
    const at = info?.kind === 'offset' ? info.offset : 0
    expect(text.slice(at, at + 80)).toContain('Draft Writer 2.0')
  })

  it('does not count linearization as a save', async () => {
    // A linearized file also has two cross-reference sections, and reporting
    // it as "one earlier version of this document" would be a false alarm on
    // every optimised PDF in existence.
    const xref = await readXref(source(pdf({ linearized: true })))
    expect(xref.sections).toBe(2)
    expect(xref.linearized).toBe(true)
    expect((await readXref(source(pdf()))).linearized).toBe(false)
  })
})

describe('recovery', () => {
  it('scans for objects when startxref points at nothing', async () => {
    const good = pdf({ info: { Author: 'Jane Doe' } })
    const claimed = /startxref\n(\d+)/.exec(source(good).text)?.[1] ?? ''
    const broken = pdfPatch(
      good,
      `startxref\n${claimed}`,
      `startxref\n${'9'.repeat(claimed.length)}`,
    )
    const xref = await readXref(source(broken))

    expect(xref.recovered).toBe(true)
    expect(xref.entries.size).toBeGreaterThan(4)
    expect(xref.trailer.entries.get('Root')).toEqual({ type: 'ref', num: 1, gen: 0 })
  })

  it('does not fall back when the table is fine', async () => {
    expect((await readXref(source(pdf()))).recovered).toBe(false)
  })

  it('gives up on bytes that hold no objects at all', async () => {
    await expect(readXref(source(encode('%PDF-1.7\nnothing here\n')))).rejects.toThrow(/pdf:/)
  })
})

describe('scanObjects', () => {
  it('finds every object header and takes the last definition of each', () => {
    const found = scanObjects(source(pdf({ incremental: 1, info: { Producer: 'Original' } })))
    const info = found.get(6)
    expect(info?.kind).toBe('offset')
  })

  it('does not mistake endobj for an object header', () => {
    // `endobj` contains `obj`. Requiring two integers in front of it is the
    // only thing keeping the scan from filing one entry per object end.
    const found = scanObjects(source(encode('1 0 obj\n<< >>\nendobj\n')))
    expect([...found.keys()]).toEqual([1])
  })
})
