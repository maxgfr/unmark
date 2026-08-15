import { describe, expect, it } from 'vitest'
import { cleanPdf } from './clean.ts'
import { source } from './lex.ts'
import { loadDocument } from './objects.ts'
import { encode } from '../types.ts'
import { pdf, pdfPatch, type PdfOptions } from '../../../test/containers.ts'

const marked = (options: PdfOptions = {}) =>
  pdf({
    info: {
      Producer: 'SomeGenerator 4.2',
      Author: 'Jane Doe',
      // Balanced inner parentheses: the value a regex-based reader truncates.
      Title: 'Quarterly (Q1 (draft)) report',
      CreationDate: 'D:20260101120000Z',
    },
    xmp: '<x:xmpmeta><xmp:CreatorTool>SomeGenerator 4.2</xmp:CreatorTool></x:xmpmeta>',
    ...options,
  })

const cleaned = async (bytes: Uint8Array, options?: { force?: boolean }) => {
  const result = await cleanPdf(bytes, options)
  return {
    ...result,
    text: source(result.output).text,
    labels: result.findings.map((f) => f.label),
  }
}

const has = (labels: string[], fragment: string) => labels.some((label) => label.includes(fragment))

/** The raw, still-encoded bytes of the one stream in a single-stream fixture. */
const onlyStream = async (bytes: Uint8Array) => {
  const doc = await loadDocument(source(bytes))
  const held = [...doc.objects.values()].find((stored) => stored.object.type === 'stream')
  return held?.object.type === 'stream' ? held.object.raw : new Uint8Array()
}

describe('the rebuild path', () => {
  it('removes every information-dictionary value and reports what each one was', async () => {
    const result = await cleaned(marked())

    expect(result.text).not.toContain('SomeGenerator 4.2')
    expect(result.text).not.toContain('Jane Doe')
    expect(result.text).not.toContain('Quarterly')
    expect(result.text).not.toContain('D:20260101')

    const producer = result.findings.find((f) => f.label.includes('/Producer'))
    expect(producer?.evidence).toBe('SomeGenerator 4.2')
    // Read whole, not truncated at the first inner parenthesis.
    const title = result.findings.find((f) => f.label.includes('/Title'))
    expect(title?.evidence).toBe('Quarterly (Q1 (draft)) report')
  })

  it('drops the /Info entry from the trailer instead of blanking its values', async () => {
    // A blanked dictionary is still a dictionary the trailer points at. The
    // rebuild stops naming it, and then never writes it.
    const result = await cleaned(marked())
    expect(result.text).not.toContain('/Info')
    expect(has(result.labels, 'structural rebuild')).toBe(true)
  })

  it('removes the XMP packet and the catalog entry that referred to it', async () => {
    const result = await cleaned(marked())
    expect(result.text).not.toContain('xpacket')
    expect(result.text).not.toContain('/Metadata')
    expect(result.findings.some((f) => f.kind === 'xmp')).toBe(true)
  })

  it('quotes the tool named inside the XMP packet', async () => {
    const result = await cleaned(marked())
    expect(result.findings.find((f) => f.kind === 'xmp')?.evidence).toBe('SomeGenerator 4.2')
  })

  it('leaves the page content exactly where it was', async () => {
    // The half that must not change. A metadata cleaner that re-encodes the
    // content has altered the thing the user was trying to keep.
    const result = await cleaned(marked({ text: 'Hello oracle' }))
    expect(result.text).toContain('(Hello oracle) Tj')
  })

  it('copies a compressed stream through byte for byte, filter and all', async () => {
    // The rule the PNG and JPEG handlers follow too: strip provenance, never
    // re-encode content. Inflating and redeflating a content stream would
    // produce different bytes for the same page, which is a change the user
    // did not ask for and cannot see.
    const input = pdf({ compressedContent: true, info: { Author: 'Jane Doe' } })
    const result = await cleanPdf(input)

    expect(source(result.output).text).toContain('/Filter /FlateDecode')
    expect([...(await onlyStream(result.output))]).toEqual([...(await onlyStream(input))])
  })

  it('removes /PieceInfo, and says nothing about it when there is none', async () => {
    expect(has((await cleaned(marked({ pieceInfo: true }))).labels, '/PieceInfo')).toBe(true)
    expect((await cleaned(marked({ pieceInfo: true }))).text).not.toContain('session-4711')
    expect(has((await cleaned(marked())).labels, '/PieceInfo')).toBe(false)
  })

  it('removes document-level JavaScript, and says nothing about it when there is none', async () => {
    const withScript = await cleaned(marked({ javaScript: true }))
    expect(has(withScript.labels, '/JavaScript')).toBe(true)
    expect(withScript.text).not.toContain('app.alert')
    expect(has((await cleaned(marked())).labels, '/JavaScript')).toBe(false)
  })

  it('reads the same file whichever cross-reference form it uses', async () => {
    for (const shape of [{}, { xrefStream: true }, { hybrid: true }, { linearized: true }]) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await cleaned(marked(shape))
      expect(result.text, JSON.stringify(shape)).not.toContain('Jane Doe')
      expect(has(result.labels, 'byte pass'), JSON.stringify(shape)).toBe(false)
    }
  })

  it('reads an object whose /Length is stored somewhere else', async () => {
    const result = await cleaned(marked({ indirectLength: true }))
    expect(result.text).toContain('(Hello oracle) Tj')
    expect(has(result.labels, 'byte pass')).toBe(false)
  })

  it('reads a document whose information dictionary has a generation number', async () => {
    // Generation 0 is so nearly universal that assuming it is an easy bug and
    // a silent one: the reference resolves to nothing and /Info looks empty.
    const result = await cleaned(marked({ generation: 3 }))
    expect(result.findings.find((f) => f.label.includes('/Author'))?.evidence).toBe('Jane Doe')
  })
})

describe('compressed object streams', () => {
  it('reaches the information dictionary hidden inside one', async () => {
    // The bug the old pass could only apologise for. Deflated bytes do not
    // match a regex for `/Author (…)`, so a byte scan reported the file clean.
    const result = await cleaned(marked({ objectStreams: true }))
    expect(result.text).not.toContain('Jane Doe')
    expect(result.findings.find((f) => f.label.includes('/Author'))?.evidence).toBe('Jane Doe')
    expect(has(result.labels, 'compressed object streams')).toBe(true)
  })

  it('writes those objects back expanded rather than repacking them', async () => {
    const result = await cleaned(marked({ objectStreams: true }))
    expect(result.text).not.toContain('/ObjStm')
    expect(result.text).toContain('1 0 obj')
  })

  it('says nothing about object streams in a file that has none', async () => {
    expect(has((await cleaned(marked())).labels, 'compressed object stream')).toBe(false)
  })
})

describe('incremental saves', () => {
  it('drops every earlier revision and says how many there were', async () => {
    // The famous redaction failure: a black rectangle drawn over text and
    // saved incrementally leaves the text underneath perfectly recoverable.
    const result = await cleaned(marked({ incremental: 3 }))
    const history = result.findings.find((f) => f.label.includes('earlier version'))

    expect(history?.label).toContain('3 earlier version')
    expect(history?.verdict).toBe('confirmed')
    expect(result.text.split('%%EOF').length - 1).toBe(1)
    expect(result.text).not.toContain('Draft Writer 1.0')
  })

  it('does not report history in a document that was saved once', async () => {
    expect(has((await cleaned(marked())).labels, 'earlier version')).toBe(false)
  })

  it('does not mistake linearization for a second save', async () => {
    // A linearized file also carries two cross-reference sections. Counting
    // sections without allowing for that raises a false alarm on every
    // optimised PDF in existence.
    expect(has((await cleaned(marked({ linearized: true }))).labels, 'earlier version')).toBe(false)
  })
})

describe('encrypted documents', () => {
  it('refuses to read or write anything, and says the file is not clean', async () => {
    // The shipped bug this fixes: encrypted strings do not match the metadata
    // regexes, so the old pass found nothing and reported nothing.
    const bytes = marked({ encrypted: true })
    const result = await cleaned(bytes)

    expect([...result.output]).toEqual([...bytes])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.label).toContain('Encrypted')
    expect(result.findings[0]?.verdict).toBe('confirmed')
    expect(result.findings[0]?.label).toContain('no pass ran')
  })

  it('does not report an ordinary document as encrypted', async () => {
    expect(has((await cleaned(marked())).labels, 'Encrypted')).toBe(false)
  })
})

describe('signed documents', () => {
  it('leaves a signed file exactly as it arrived and explains why', async () => {
    const bytes = marked({ signature: true })
    const result = await cleaned(bytes)

    expect([...result.output]).toEqual([...bytes])
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0]?.label).toContain('Digitally signed')
    expect(result.findings[0]?.evidence).toContain('force')
  })

  it('cleans it anyway when asked, and reports the signature as void', async () => {
    const result = await cleaned(marked({ signature: true }), { force: true })
    expect(result.text).not.toContain('Jane Doe')
    expect(has(result.labels, 'signature is now void')).toBe(true)
  })

  it('does not claim an unsigned document is signed', async () => {
    expect(has((await cleaned(marked())).labels, 'signed')).toBe(false)
    expect(has((await cleaned(marked())).labels, 'void')).toBe(false)
  })
})

describe('falling back to the byte pass', () => {
  it('blanks values in place when the document cannot be parsed', async () => {
    const junk = encode('%PDF-1.7\n/Producer (Ghostwriter 9.0)\nnot a document\n')
    const result = await cleaned(junk)

    expect(result.text).not.toContain('Ghostwriter 9.0')
    expect(result.output.length).toBe(junk.length)
    expect(has(result.labels, 'Structural rebuild was not possible')).toBe(true)
    expect(has(result.labels, 'byte pass')).toBe(true)
  })

  it('says what the fallback leaves behind rather than implying the file is clean', async () => {
    const result = await cleaned(encode('%PDF-1.7\n/Author (Jane Doe)\nnot a document\n'))
    const excuse = result.findings.find((f) => f.label.includes('not possible'))
    expect(excuse?.evidence).toContain('earlier revision')
    expect(excuse?.evidence).toContain('compressed')
  })

  it('discards its own rebuild when the result does not verify', async () => {
    // Deliberately conservative. A content stream that happens to contain the
    // bytes `%%EOF` makes the output fail the "exactly one end-of-file marker"
    // check, and a rebuild that cannot be verified is not one to hand back.
    const result = await cleaned(marked({ text: 'a %%EOF b' }))
    const excuse = result.findings.find((f) => f.label.includes('not possible'))
    expect(excuse?.evidence).toContain('%%EOF markers')
  })

  it('never mentions the byte pass on a document it could rebuild', async () => {
    expect(has((await cleaned(marked())).labels, 'byte pass')).toBe(false)
    expect(has((await cleaned(marked({ objectStreams: true }))).labels, 'byte pass')).toBe(false)
  })

  it('scans for objects when the cross-reference stream is unreadable', async () => {
    // A table that cannot be followed does not make the objects unfindable,
    // and the rebuild is safe to attempt from a scan because the result is
    // verified before it is handed back either way.
    const broken = pdfPatch(marked({ xrefStream: true }), '/W [1 4 2]', '/W [0 0 0]')
    const result = await cleaned(broken)

    expect(result.text).not.toContain('Jane Doe')
    expect(has(result.labels, 'byte pass')).toBe(false)
  })
})

describe('every finding names the pass that produced it', () => {
  it('so a reader can tell a rebuild from a fallback', async () => {
    const cases = [
      marked(),
      marked({ objectStreams: true }),
      marked({ incremental: 2 }),
      marked({ encrypted: true }),
      marked({ signature: true }),
      encode('%PDF-1.7\n/Producer (X)\nnot a document\n'),
    ]

    for (const bytes of cases) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await cleaned(bytes)
      expect(result.findings.length).toBeGreaterThan(0)
      for (const found of result.findings) {
        expect(found.label, found.label).toMatch(/\((structural rebuild|byte pass|no pass ran)\)$/)
      }
    }
  })
})

describe('doing nothing', () => {
  it('returns a document with no metadata byte for byte', async () => {
    // Refusing to churn a file we found nothing in is a stronger statement
    // than handing back an equivalent one.
    const plain = pdf({ info: {} })
    const result = await cleanPdf(plain)
    expect([...result.output]).toEqual([...plain])
    expect(result.findings).toEqual([])
  })

  it('is idempotent', async () => {
    const once = await cleanPdf(marked())
    const twice = await cleanPdf(once.output)
    expect(twice.findings).toEqual([])
    expect([...twice.output]).toEqual([...once.output])
  })
})
