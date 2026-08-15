import { describe, expect, it } from 'vitest'
import { countPages, loadDocument, lookup, reachable, resolve } from './objects.ts'
import { asDict, source } from './lex.ts'
import { encode } from '../types.ts'
import { pdf, pdfPatch } from '../../../test/containers.ts'

/**
 * A PDF with no usable cross-reference table.
 *
 * `startxref 0` sends the reader at the file header, which is not an object,
 * so every one of these goes through the recovery scan. That is deliberate:
 * these tests are about the object graph, and hand-computing byte offsets for
 * each of them would test the arithmetic in the test.
 */
const handmade = (body: string, trailer = '/Root 1 0 R') =>
  source(encode(`%PDF-1.7\n${body}trailer\n<< ${trailer} >>\nstartxref\n0\n%%EOF\n`))

describe('loadDocument', () => {
  it('reads every object the table names', async () => {
    const doc = await loadDocument(source(pdf({ info: { Author: 'Jane Doe' } })))
    expect(asDict(lookup(doc, doc.trailer, 'Root'))?.entries.get('Type')).toEqual({
      type: 'name',
      name: 'Catalog',
    })
    expect([...doc.objects.values()].every((stored) => !stored.compressed)).toBe(true)
  })

  it('unpacks the information dictionary out of a compressed object stream', async () => {
    // The case the byte-level pass cannot reach, and the reason this module
    // exists at all.
    const doc = await loadDocument(
      source(pdf({ objectStreams: true, info: { Author: 'Jane Doe' } })),
    )
    const info = asDict(lookup(doc, doc.trailer, 'Info'))
    expect(info?.entries.has('Author')).toBe(true)
    expect([...doc.objects.values()].filter((stored) => stored.compressed).length).toBe(5)
  })

  it('reads an object whose /Length lives in another object', async () => {
    const doc = await loadDocument(source(pdf({ indirectLength: true })))
    const page = asDict(lookup(doc, lookup(doc, doc.trailer, 'Root'), 'Pages'))
    expect(page).toBeDefined()
    const contents = [...doc.objects.values()].filter((stored) => stored.object.type === 'stream')
    expect(contents.length).toBe(1)
  })

  it('refuses an object stream whose index does not fit in /First', async () => {
    // A count that overruns the index is corruption, and reading past it would
    // parse whatever bytes happened to follow as objects.
    const bytes = pdfPatch(pdf({ objectStreams: true }), '/N 5', '/N 9')
    await expect(loadDocument(source(bytes))).rejects.toThrow(/ran past \/First/)
  })
})

describe('resolve', () => {
  it('follows a chain of references to the object at the end', async () => {
    const doc = await loadDocument(handmade('1 0 obj\n2 0 R\nendobj\n2 0 obj\n(end)\nendobj\n'))
    const value = resolve(doc, { type: 'ref', num: 1, gen: 0 })
    expect(value?.type).toBe('string')
  })

  it('stops rather than following a loop forever', async () => {
    const doc = await loadDocument(handmade('1 0 obj\n2 0 R\nendobj\n2 0 obj\n1 0 R\nendobj\n'))
    expect(() => resolve(doc, { type: 'ref', num: 1, gen: 0 })).toThrow(/does not end/)
  })

  it('returns undefined for a reference to an object that is not there', async () => {
    // A dangling reference is legal PDF and means null. Throwing would refuse
    // files that open everywhere.
    const doc = await loadDocument(handmade('1 0 obj\n<< /A 9 0 R >>\nendobj\n'))
    expect(lookup(doc, doc.trailer, 'Root')).toBeDefined()
    expect(resolve(doc, { type: 'ref', num: 9, gen: 0 })).toBeUndefined()
  })
})

describe('countPages', () => {
  it('counts the leaves of the page tree', async () => {
    const doc = await loadDocument(source(pdf()))
    expect(countPages(doc)).toBe(1)
  })

  it('trusts the tree over /Count, because the rebuild is checked against it', async () => {
    // /Count is a number a writer maintains by hand. Reading the same claim on
    // both sides of a verification verifies nothing.
    const doc = await loadDocument(source(pdfPatch(pdf(), '/Count 1', '/Count 7')))
    expect(countPages(doc)).toBe(1)
  })

  it('says so when there is no page tree at all', async () => {
    const doc = await loadDocument(handmade('1 0 obj\n<< /Type /Catalog >>\nendobj\n'))
    expect(() => countPages(doc)).toThrow(/no page tree/)
  })
})

describe('reachable', () => {
  it('walks the graph from the catalog', async () => {
    const doc = await loadDocument(source(pdf({ xmp: '<x:xmpmeta/>', info: { Author: 'A' } })))
    const root = doc.trailer.entries.get('Root')
    if (root?.type !== 'ref') throw new Error('fixture has no /Root')

    const before = reachable(doc, [root])
    expect(before.has(7)).toBe(true) // the XMP stream, via the catalog

    // Unlink it, and it is simply not part of the document any more. This is
    // how the rebuild removes things: it never deletes an object, it stops
    // referring to one and then writes only what is still reachable.
    asDict(resolve(doc, root))?.entries.delete('Metadata')
    expect(reachable(doc, [root]).has(7)).toBe(false)
  })

  it('never reaches the information dictionary, which only the trailer names', async () => {
    const doc = await loadDocument(source(pdf({ info: { Author: 'Jane Doe' } })))
    const root = doc.trailer.entries.get('Root')
    if (root?.type !== 'ref') throw new Error('fixture has no /Root')
    expect(reachable(doc, [root]).has(6)).toBe(false)
  })
})
