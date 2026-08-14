import { describe, expect, it } from 'vitest'
import { cleanPdf, sniffPdf } from './pdf.ts'
import { pdf, pdfXrefOffsets } from '../../test/containers.ts'
import { decodeUtf8, encode } from './types.ts'

const asText = (bytes: Uint8Array) => decodeUtf8(bytes)

describe('sniffPdf', () => {
  it('recognises a PDF by its header', () => {
    expect(sniffPdf(pdf())).toBe(true)
    expect(sniffPdf(encode('%PNG'))).toBe(false)
  })
})

describe('cleanPdf', () => {
  const marked = () =>
    pdf({
      info: {
        Producer: 'SomeGenerator 4.2',
        Author: 'Jane Doe',
        Title: 'Quarterly report',
        CreationDate: 'D:20260101120000Z',
      },
      xmp: '<x:xmpmeta><xmp:CreatorTool>SomeGenerator 4.2</xmp:CreatorTool></x:xmpmeta>',
    })

  it('never changes the file length', () => {
    // The whole design constraint. A PDF's xref table is a list of byte
    // offsets; move one byte and every offset after it is wrong.
    const before = marked()
    expect(cleanPdf(before).output.length).toBe(before.length)
  })

  it('leaves every xref offset pointing where it did', () => {
    const before = marked()
    const after = cleanPdf(before).output
    expect(pdfXrefOffsets(after)).toEqual(pdfXrefOffsets(before))

    // And those offsets still land on the objects they name.
    for (const offset of pdfXrefOffsets(after)) {
      expect(asText(after.subarray(offset, offset + 8))).toMatch(/^\d+ 0 obj/)
    }
  })

  it('blanks the information dictionary values', () => {
    const text = asText(cleanPdf(marked()).output)
    expect(text).not.toContain('SomeGenerator 4.2')
    expect(text).not.toContain('Jane Doe')
    expect(text).not.toContain('Quarterly report')
    // The key and its delimiters survive so the syntax stays legal.
    expect(text).toContain('/Producer (')
  })

  it('reports what each value was before blanking it', () => {
    const findings = cleanPdf(marked()).findings
    const producer = findings.find((f) => f.label.includes('/Producer'))
    expect(producer?.evidence).toBe('SomeGenerator 4.2')

    const author = findings.find((f) => f.label.includes('/Author'))
    expect(author?.evidence).toBe('Jane Doe')
  })

  it('blanks the XMP packet', () => {
    const result = cleanPdf(marked())
    expect(asText(result.output)).not.toContain('xmp:CreatorTool')
    expect(result.findings.some((f) => f.kind === 'xmp')).toBe(true)
  })

  it('leaves a PDF with no metadata untouched', () => {
    const clean = pdf({ info: {} })
    const result = cleanPdf(clean)
    expect([...result.output]).toEqual([...clean])
    expect(result.findings).toEqual([])
  })

  it('says so when metadata may be hiding in a compressed object stream', () => {
    // The honest half. Blanking bytes in place cannot see inside a deflated
    // ObjStm, and reporting "clean" here would be a lie.
    const result = cleanPdf(pdf({ info: { Producer: 'X' }, objectStreams: true }))
    const warning = result.findings.find((f) => f.label.includes('object stream'))
    expect(warning).toBeDefined()
    expect(warning?.evidence).toContain('may remain')
  })

  it('does not warn about object streams when there are none', () => {
    const result = cleanPdf(pdf({ info: { Producer: 'X' } }))
    expect(result.findings.some((f) => f.label.includes('object stream'))).toBe(false)
  })

  it('is idempotent', () => {
    const once = cleanPdf(marked())
    const twice = cleanPdf(once.output)
    expect(twice.findings.filter((f) => f.evidence?.includes('SomeGenerator'))).toEqual([])
    expect([...twice.output]).toEqual([...once.output])
  })
})

describe('incremental saves', () => {
  /** A PDF saved twice: the format appends rather than rewrites. */
  const incremental = () => {
    const first = pdf({ info: { Producer: 'Draft Writer 1.0' } })
    const appended = new TextEncoder().encode(
      '\n4 0 obj\n<< /Producer (Second Pass 2.0) >>\nendobj\nxref\n0 1\ntrailer\n<< >>\nstartxref\n0\n%%EOF\n',
    )
    const out = new Uint8Array(first.length + appended.length)
    out.set(first)
    out.set(appended, first.length)
    return out
  }

  it('reports that earlier versions of the document are still in the file', async () => {
    // The famous redaction failure: a black rectangle drawn over text and saved
    // incrementally leaves the text underneath perfectly recoverable.
    const result = cleanPdf(incremental())
    const warning = result.findings.find((f) => f.label.includes('earlier version'))

    expect(warning).toBeDefined()
    expect(warning?.verdict).toBe('confirmed')
    expect(warning?.evidence).toContain('covered over rather than deleted')
  })

  it('says how many earlier versions there are', async () => {
    expect(
      cleanPdf(incremental()).findings.find((f) => f.label.includes('earlier version'))?.label,
    ).toContain('1 earlier version')
  })

  it('does not warn about a document saved once', () => {
    const result = cleanPdf(pdf({ info: { Producer: 'X' } }))
    expect(result.findings.some((f) => f.label.includes('earlier version'))).toBe(false)
  })

  it('still blanks the information dictionary in an incrementally saved file', () => {
    const text = decodeUtf8(cleanPdf(incremental()).output)
    expect(text).not.toContain('Draft Writer 1.0')
  })
})
