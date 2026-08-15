import { describe, expect, it } from 'vitest'
import { cleanZipDocument } from './zipdoc.ts'
import { cleanContainer } from './index.ts'
import { readZip, writeZip, zipDocumentKind } from './zip.ts'
import { DOCX_APP, DOCX_CORE, exifSegment, jpeg, zip } from '../../test/containers.ts'
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
    const core = result.findings.find((f) => f.where === 'docProps/core.xml')
    expect(core?.evidence).toContain('Jane Doe')

    const app = result.findings.find((f) => f.where === 'docProps/app.xml')
    expect(app?.evidence).toContain('ACME')
  })

  it('empties a customXml tracking part', async () => {
    const result = await cleanZipDocument(docx())
    expect(await partOf(result.output, 'customXml/item1.xml')).not.toContain('4417')
    expect(result.findings.some((f) => f.where?.includes('customXml'))).toBe(true)
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

// A real .docx carries identity far outside docProps: on every tracked change,
// in every comment, and in word/people.xml, which lists everyone who has ever
// opened the file. Accepting all changes in Word removes none of it.
const TRACKED = `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:ins w:id="1" w:author="Jane Doe" w:date="2026-01-04T10:00:00Z"><w:r><w:t>added text</w:t></w:r></w:ins>
<w:del w:id="2" w:author="Bob Smith" w:date="2026-01-05T11:00:00Z"><w:r><w:delText>cut text</w:delText></w:r></w:del>
</w:document>`

const PEOPLE = `<?xml version="1.0"?>
<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
<w15:person w15:author="Jane Doe"><w15:presenceInfo w15:providerId="AD" w15:userId="jane@example.com"/></w15:person>
</w15:people>`

const SETTINGS = `<?xml version="1.0"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:rsids><w:rsidRoot w:val="00A12B34"/><w:rsid w:val="00B56C78"/></w:rsids>
</w:settings>`

const tracked = () =>
  zip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: 'word/document.xml', content: TRACKED },
    { name: 'word/people.xml', content: PEOPLE },
    { name: 'word/settings.xml', content: SETTINGS },
    { name: 'docProps/thumbnail.jpeg', content: 'PRETEND-JPEG-OF-PAGE-ONE'.repeat(40) },
  ])

describe('identity outside docProps', () => {
  it('clears the author and date on every tracked change', async () => {
    const result = await cleanZipDocument(tracked())
    const document = await partOf(result.output, 'word/document.xml')

    expect(document).not.toContain('Jane Doe')
    expect(document).not.toContain('Bob Smith')
    expect(document).not.toContain('2026-01-04')
    // The change itself survives — only who and when is gone.
    expect(document).toContain('<w:ins')
    expect(document).toContain('added text')
    expect(document).toContain('cut text')
  })

  it('clears word/people.xml, which lists everyone who ever opened the file', async () => {
    const result = await cleanZipDocument(tracked())
    const people = await partOf(result.output, 'word/people.xml')
    expect(people).not.toContain('Jane Doe')
    expect(people).not.toContain('jane@example.com')
  })

  it('removes the revision save ids that fingerprint editing sessions', async () => {
    const result = await cleanZipDocument(tracked())
    const settings = await partOf(result.output, 'word/settings.xml')
    expect(settings).not.toContain('00A12B34')
    expect(settings).not.toContain('<w:rsids>')
  })

  it('reports the names it found so the user sees what was in there', async () => {
    const result = await cleanZipDocument(tracked())
    const evidence = result.findings.map((f) => f.evidence ?? '').join(' ')
    expect(evidence).toContain('Jane Doe')
  })

  it('replaces the first-page thumbnail rather than deleting it', async () => {
    // It is a rendered picture of page one, and no text-level clean touches it.
    // Deleting the part would dangle the relationship in _rels/.rels.
    const result = await cleanZipDocument(tracked())
    const names = (await readZip(result.output)).map((e) => e.name)
    expect(names).toContain('docProps/thumbnail.jpeg')

    const thumbnail = (await readZip(result.output)).find(
      (e) => e.name === 'docProps/thumbnail.jpeg',
    )
    expect(decodeUtf8(thumbnail?.data ?? new Uint8Array())).not.toContain('PRETEND-JPEG')
    expect(thumbnail?.data[0]).toBe(0xff) // still a JPEG
    expect(thumbnail?.data[1]).toBe(0xd8)
    expect(result.findings.some((f) => f.label.includes('first page'))).toBe(true)
  })

  it('leaves a document with no identity in it untouched', async () => {
    const plain = zip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: '<w:document>Just text.</w:document>' },
    ])
    const result = await cleanZipDocument(plain)
    expect(await partOf(result.output, 'word/document.xml')).toBe(
      '<w:document>Just text.</w:document>',
    )
    expect(result.findings).toEqual([])
  })
})

// The eval contract: every new format and every new rule carries a case that
// must fire and a case that must not.

describe('the OOXML family beyond Word', () => {
  it('recognises a presentation', async () => {
    const bytes = zip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'ppt/presentation.xml', content: '<p:presentation/>' },
      { name: 'docProps/core.xml', content: DOCX_CORE },
    ])
    expect((await cleanContainer(bytes)).format).toBe('PPTX')
  })

  it('recognises a workbook', async () => {
    const bytes = zip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'xl/workbook.xml', content: '<workbook/>' },
      { name: 'docProps/core.xml', content: DOCX_CORE },
    ])
    expect((await cleanContainer(bytes)).format).toBe('XLSX')
  })

  it('still calls a document a DOCX', async () => {
    const bytes = zip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: '<w:document/>' },
    ])
    expect((await cleanContainer(bytes)).format).toBe('DOCX')
  })

  it('strips the same properties whichever application wrote it', async () => {
    // One handler covers all three, because the parts that leak are the same
    // three parts. The flavour is what the report calls the file, nothing more.
    const bytes = zip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'xl/workbook.xml', content: '<workbook/>' },
      { name: 'docProps/core.xml', content: DOCX_CORE },
    ])
    const result = await cleanContainer(bytes)
    const core = (await readZip(result.output)).find((e) => e.name === 'docProps/core.xml')
    expect(decodeUtf8(core!.data)).not.toContain('Jane')
  })
})

describe('EPUB', () => {
  const epub = (opf: string) =>
    zip([
      { name: 'mimetype', content: 'application/epub+zip' },
      { name: 'META-INF/container.xml', content: '<container/>' },
      { name: 'OEBPS/content.opf', content: opf },
    ])

  it('is recognised', async () => {
    expect((await cleanContainer(epub('<package><metadata/></package>'))).format).toBe('EPUB')
  })

  it('empties the creator without removing the element', async () => {
    // Same reasoning as the OOXML parts: a reader that expects <dc:creator> to
    // be there should still find it.
    const bytes = epub(
      '<package><metadata><dc:title>A Book</dc:title><dc:creator>Jane Q. Smith</dc:creator></metadata></package>',
    )
    const result = await cleanContainer(bytes)
    const opf = decodeUtf8(
      (await readZip(result.output)).find((e) => e.name.endsWith('.opf'))!.data,
    )

    expect(opf).not.toContain('Jane Q. Smith')
    expect(opf).toContain('<dc:creator>')
  })

  it('keeps the title, which is the book and not the person', async () => {
    const bytes = epub('<package><metadata><dc:title>A Book</dc:title></metadata></package>')
    const result = await cleanContainer(bytes)
    const opf = decodeUtf8(
      (await readZip(result.output)).find((e) => e.name.endsWith('.opf'))!.data,
    )
    expect(opf).toContain('A Book')
  })

  it('survives a self-closing meta sitting above the fields it must keep', async () => {
    // The shape that broke this: `<meta name="cover"/>` is self-closing, and an
    // open-tag pattern that ignored the `/` ran forward to the next `</meta>`
    // anywhere later in the file — swallowing the title, the language and the
    // identifier in between, leaving a file that is no longer a valid EPUB.
    // Both halves are in every real book: EPUB 2 writes the cover meta, EPUB 3
    // is required to carry a paired dcterms:modified.
    const bytes = epub(
      [
        '<package unique-identifier="uid"><metadata>',
        '<meta name="cover" content="cover-image"/>',
        '<dc:title>My Actual Book Title</dc:title>',
        '<dc:identifier id="uid">urn:isbn:9780000000001</dc:identifier>',
        '<dc:language>en</dc:language>',
        '<dc:creator>Jane Q. Smith</dc:creator>',
        '<meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>',
        '</metadata></package>',
      ].join(''),
    )
    const result = await cleanContainer(bytes)
    const opf = decodeUtf8(
      (await readZip(result.output)).find((e) => e.name.endsWith('.opf'))!.data,
    )

    expect(opf).not.toContain('Jane Q. Smith')
    expect(opf).toContain('My Actual Book Title')
    expect(opf).toContain('<dc:language>en</dc:language>')
    // The identifier stays, id and all: `unique-identifier` points at it.
    expect(opf).toContain('<dc:identifier id="uid">urn:isbn:9780000000001</dc:identifier>')
    // EPUB 3 requires this one to exist.
    expect(opf).toContain('dcterms:modified')
  })

  it('keeps the attributes on a field it empties', async () => {
    const bytes = epub(
      '<package><metadata><dc:creator id="author" opf:role="aut">Jane</dc:creator></metadata></package>',
    )
    const result = await cleanContainer(bytes)
    const opf = decodeUtf8(
      (await readZip(result.output)).find((e) => e.name.endsWith('.opf'))!.data,
    )
    expect(opf).toContain('<dc:creator id="author" opf:role="aut"></dc:creator>')
    expect(opf).not.toContain('Jane')
  })

  it('removes reading-software bookkeeping', async () => {
    const bytes = epub(
      '<package><metadata><meta name="calibre:timestamp" content="2024-01-01"/><dc:title>Book</dc:title></metadata></package>',
    )
    const result = await cleanContainer(bytes)
    const opf = decodeUtf8(
      (await readZip(result.output)).find((e) => e.name.endsWith('.opf'))!.data,
    )
    expect(opf).not.toContain('calibre')
    expect(opf).toContain('Book')
  })

  it('cleans a photograph wherever the book keeps it', async () => {
    // An EPUB's content directory is declared in container.xml and is routinely
    // not OEBPS. Anchoring to three directory names meant a GPS-bearing
    // photograph in any other layout survived with no finding at all.
    const photo = jpeg([{ marker: 0xe1, data: exifSegment('GPSLatitude=48.8566') }])
    const bytes = zip([
      { name: 'mimetype', content: 'application/epub+zip' },
      { name: 'META-INF/container.xml', content: '<container/>' },
      { name: 'item/content.opf', content: '<package><metadata/></package>' },
      { name: 'item/images/cover.jpg', content: photo },
    ])

    const result = await cleanContainer(bytes)
    const entries = await readZip(result.output)
    const cleaned = entries.find((e) => e.name === 'item/images/cover.jpg')
    expect(decodeUtf8(cleaned!.data)).not.toContain('GPSLatitude')
  })
})

describe('pictures pasted into a document', () => {
  const withPhoto = (photo: Uint8Array) =>
    zip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'word/document.xml', content: '<w:document/>' },
      { name: 'word/media/image1.jpeg', content: photo },
    ])

  it('cleans the EXIF out of an embedded photograph', async () => {
    // The leak users are most surprised by, and the one every XML-reading pass
    // walks straight past: a document could be reported clean while carrying
    // the coordinates of where a picture in it was taken.
    const photo = jpeg([{ marker: 0xe1, data: exifSegment('Make=Canon GPSLatitude=48.8566') }])
    const result = await cleanContainer(withPhoto(photo))

    const cleaned = (await readZip(result.output)).find((e) => e.name === 'word/media/image1.jpeg')
    expect(decodeUtf8(cleaned!.data)).not.toContain('GPSLatitude')
    expect(result.findings.some((f) => f.where === 'word/media/image1.jpeg')).toBe(true)
  })

  it('names the entry it cleaned, so the report is not a silent success', async () => {
    const photo = jpeg([{ marker: 0xe1, data: exifSegment('Make=Canon') }])
    const result = await cleanContainer(withPhoto(photo))
    const finding = result.findings.find((f) => f.where === 'word/media/image1.jpeg')
    expect(finding).toBeDefined()
  })

  it('leaves a photograph that carries nothing byte-identical', async () => {
    const photo = jpeg([])
    const result = await cleanContainer(withPhoto(photo))
    const cleaned = (await readZip(result.output)).find((e) => e.name === 'word/media/image1.jpeg')
    expect([...cleaned!.data]).toEqual([...photo])
  })
})
