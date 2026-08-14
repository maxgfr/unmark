import { describe, expect, it } from 'vitest'
import { cleanZipDocument } from './zipdoc.ts'
import { readZip, writeZip, zipDocumentKind } from './zip.ts'
import { DOCX_APP, DOCX_CORE, zip } from '../../test/containers.ts'
import { decodeUtf8, encode } from './types.ts'

const docx = () =>
  zip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: '_rels/.rels', content: '<Relationships/>' },
    { name: 'docProps/core.xml', content: DOCX_CORE },
    { name: 'docProps/app.xml', content: DOCX_APP },
    { name: 'customXml/item1.xml', content: '<tracking id="4417"/>' },
    { name: 'word/document.xml', content: '<w:document>The actual text.</w:document>' },
  ])

const odt = () =>
  zip([
    { name: 'mimetype', content: 'application/vnd.oasis.opendocument.text' },
    {
      name: 'meta.xml',
      content:
        '<office:document-meta><meta:generator>Writer/7</meta:generator></office:document-meta>',
    },
    { name: 'content.xml', content: '<office:body>Text.</office:body>' },
  ])

const named = async (bytes: Uint8Array) => (await readZip(bytes)).map((e) => e.name)
const partOf = async (bytes: Uint8Array, name: string) =>
  decodeUtf8((await readZip(bytes)).find((e) => e.name === name)?.data ?? new Uint8Array())

describe('zip round trip', () => {
  it('reads what it writes, including deflated entries', async () => {
    // Entries are deflated on write, so this also proves the inflate path.
    const body = 'x'.repeat(5000)
    const written = await writeZip([{ name: 'a.txt', data: encode(body) }])
    const read = await readZip(written)
    expect(read).toHaveLength(1)
    expect(decodeUtf8(read[0]?.data ?? new Uint8Array())).toBe(body)
    expect(written.length).toBeLessThan(body.length) // it really compressed
  })

  it('reads a stored archive', async () => {
    const read = await readZip(zip([{ name: 'a.txt', content: 'hello' }]))
    expect(decodeUtf8(read[0]?.data ?? new Uint8Array())).toBe('hello')
  })

  it('rejects bytes that are not an archive', async () => {
    await expect(readZip(encode('not a zip at all'))).rejects.toThrow(/not a zip/i)
  })
})

describe('zipDocumentKind', () => {
  it('tells OOXML and ODF apart, and neither from a plain zip', async () => {
    expect(zipDocumentKind(await readZip(docx()))).toBe('ooxml')
    expect(zipDocumentKind(await readZip(odt()))).toBe('odf')
    expect(zipDocumentKind(await readZip(zip([{ name: 'a.txt', content: 'x' }])))).toBeUndefined()
  })
})

describe('cleanZipDocument', () => {
  it('empties the properties and keeps the document text', async () => {
    const result = await cleanZipDocument(docx())

    expect(await partOf(result.output, 'word/document.xml')).toBe(
      '<w:document>The actual text.</w:document>',
    )
    expect(await partOf(result.output, 'docProps/core.xml')).not.toContain('Jane Doe')
    expect(await partOf(result.output, 'docProps/app.xml')).not.toContain('ACME')
  })

  it('keeps the parts rather than deleting them', async () => {
    // _rels/.rels points at docProps/core.xml. A missing target is how a DOCX
    // becomes "corrupt and cannot be opened".
    const result = await cleanZipDocument(docx())
    expect(await named(result.output)).toEqual(await named(docx()))
  })

  it('quotes what it found so the user sees what was in there', async () => {
    const result = await cleanZipDocument(docx())
    const core = result.findings.find((f) => f.label.startsWith('docProps/core.xml'))
    expect(core?.evidence).toContain('Jane Doe')

    const app = result.findings.find((f) => f.label.startsWith('docProps/app.xml'))
    expect(app?.evidence).toContain('ACME')
  })

  it('empties a customXml tracking part', async () => {
    const result = await cleanZipDocument(docx())
    expect(await partOf(result.output, 'customXml/item1.xml')).not.toContain('4417')
    expect(result.findings.some((f) => f.label.includes('customXml'))).toBe(true)
  })

  it('strips ODF metadata and keeps the mimetype entry stored and first', async () => {
    // ODF requires it: the mimetype entry must come first and be uncompressed,
    // or the file is not a valid OpenDocument package.
    const result = await cleanZipDocument(odt())
    const entries = await readZip(result.output)

    expect(entries[0]?.name).toBe('mimetype')
    expect(entries[0]?.stored).toBe(true)
    expect(await partOf(result.output, 'meta.xml')).not.toContain('Writer/7')
    expect(await partOf(result.output, 'content.xml')).toBe('<office:body>Text.</office:body>')
  })

  it('is idempotent — a second pass changes nothing that matters', async () => {
    const once = await cleanZipDocument(docx())
    const twice = await cleanZipDocument(once.output)
    expect(await partOf(twice.output, 'docProps/core.xml')).toBe(
      await partOf(once.output, 'docProps/core.xml'),
    )
    expect(twice.findings.every((f) => !f.evidence)).toBe(true)
  })
})
