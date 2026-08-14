// oxlint-disable no-await-in-loop -- the round-trip loop is sequential so a
// failure names the format that failed rather than reporting them as a batch.
import { describe, expect, it } from 'vitest'
import { cleanContainer, inspectContainer } from './index.ts'
import { decodeUtf8, encode } from './types.ts'
import { gif, jpeg, pdf, png, textChunkData, webp, zip, DOCX_CORE } from '../../test/containers.ts'

const cp = (...points: number[]) => String.fromCodePoint(...points)
const ZWSP = cp(0x200b)

const formatOf = async (bytes: Uint8Array, name?: string) =>
  (await cleanContainer(bytes, name)).format

describe('format detection', () => {
  it('routes each binary format by its magic bytes, not its name', async () => {
    // Every one of these is handed a misleading filename on purpose.
    expect(await formatOf(png(), 'photo.jpg')).toBe('PNG')
    expect(await formatOf(jpeg(), 'image.png')).toBe('JPEG')
    expect(await formatOf(webp(), 'a.gif')).toBe('WebP')
    expect(await formatOf(gif(), 'a.webp')).toBe('GIF')
    expect(await formatOf(pdf(), 'notes.txt')).toBe('PDF')
  })

  it('recognises a DOCX and an ODT inside their zips', async () => {
    const docx = zip([
      { name: '[Content_Types].xml', content: '<Types/>' },
      { name: 'docProps/core.xml', content: DOCX_CORE },
    ])
    const odt = zip([
      { name: 'mimetype', content: 'application/vnd.oasis.opendocument.text' },
      { name: 'meta.xml', content: '<office:document-meta/>' },
    ])
    expect(await formatOf(docx)).toBe('DOCX')
    expect(await formatOf(odt)).toBe('ODT')
  })

  it('does not claim a plain zip it has no business rewriting', async () => {
    expect(await formatOf(zip([{ name: 'a.txt', content: 'hello' }]))).toBe('unknown')
  })

  it('picks the text formats apart by content first, extension second', async () => {
    expect(await formatOf(encode('<svg xmlns="x"><rect/></svg>'))).toBe('SVG')
    expect(await formatOf(encode('<!doctype html><html></html>'))).toBe('HTML')
    expect(await formatOf(encode('# Title\n'), 'notes.md')).toBe('Markdown')
    expect(await formatOf(encode('just words'))).toBe('Text')
  })
})

describe('cleanContainer', () => {
  it('returns an unknown file exactly as it arrived', async () => {
    // Refusing to act is the correct behaviour for a format we cannot parse.
    // Returning a "cleaned" file we did not understand would be worse.
    const opaque = zip([{ name: 'a.bin', content: 'x' }])
    const result = await cleanContainer(opaque)
    expect([...result.output]).toEqual([...opaque])
    expect(result.findings).toEqual([])
  })

  it('strips a PNG text chunk through the dispatcher', async () => {
    const result = await cleanContainer(png([{ type: 'tEXt', data: textChunkData('a', 'b') }]))
    expect(result.findings.map((f) => f.kind)).toEqual(['text_chunk'])
    expect(result.textual).toBe(false)
  })

  it('runs both passes over an HTML file', async () => {
    // A generator tag *and* a zero-width character in the prose. One pass would
    // catch one of them; the point of chaining is catching both.
    const html = `<html><meta name="generator" content="X"><p>hel${ZWSP}lo</p></html>`
    const result = await cleanContainer(encode(html), 'page.html')
    const text = decodeUtf8(result.output)

    expect(text).not.toContain('generator')
    expect(text).toContain('<p>hello</p>')
    expect(result.findings.map((f) => f.kind).sort()).toEqual(['generator_tag', 'zwj_family'])
  })

  it('cleans invisible characters out of a plain text file', async () => {
    const result = await cleanContainer(encode(`a${ZWSP}b`), 'note.txt')
    expect(decodeUtf8(result.output)).toBe('ab')
    expect(result.textual).toBe(true)
  })

  it('surfaces a decoded payload alongside the carriers it came from', async () => {
    // Reading the payload matters more than deleting it, so it has to survive
    // the trip through the dispatcher.
    const { encodeStego } = await import('../text/stego.ts')
    const marked = `Report text. ${encodeStego('leaker-7', 'zero-width')}`
    const result = await cleanContainer(encode(marked), 'report.txt')

    const payload = result.findings.find((f) => f.kind === 'stego_payload')
    expect(payload?.evidence).toBe('leaker-7')
    expect(decodeUtf8(result.output)).toBe('Report text. ')
  })

  it('keeps a preserved carrier in the output and reports why', async () => {
    const family = `${cp(0x1f468)}${cp(0x200d)}${cp(0x1f469)}`
    const result = await cleanContainer(encode(family), 'note.txt')
    expect(decodeUtf8(result.output)).toBe(family)
    expect(result.preserved[0]?.preserved).toContain('emoji')
  })
})

describe('inspectContainer', () => {
  it('reports without changing anything', async () => {
    const marked = png([{ type: 'caBX', data: 'manifest' }])
    const report = await inspectContainer(marked)
    expect(report.format).toBe('PNG')
    expect(report.findings[0]).toMatchObject({ kind: 'c2pa', verdict: 'confirmed' })
  })

  it('includes preserved findings so the report shows what was kept', async () => {
    const family = `${cp(0x1f468)}${cp(0x200d)}${cp(0x1f469)}`
    const report = await inspectContainer(encode(family), 'a.txt')
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]?.verdict).toBe('likely_false_positive')
  })
})

describe('round trip', () => {
  it('leaves nothing behind on a second inspection', async () => {
    // The property that makes the report checkable rather than a claim: clean,
    // then inspect the result and find nothing.
    const cases: [string, Uint8Array][] = [
      ['PNG', png([{ type: 'tEXt', data: textChunkData('Software', 'Gen 1') }])],
      ['JPEG', jpeg([{ marker: 0xfe, data: 'a comment' }])],
      ['WebP', webp([{ fourcc: 'EXIF', data: 'exif' }], 0x08)],
      ['GIF', gif([{ label: 0xfe, data: 'note' }])],
      ['SVG', encode('<svg><metadata>who</metadata><rect/></svg>')],
      ['HTML', encode('<html><meta name="generator" content="X"></html>')],
      ['Text', encode(`a${ZWSP}b`)],
    ]

    // Sequential so a failure names the format that failed.
    for (const [label, bytes] of cases) {
      const cleaned = await cleanContainer(bytes)
      const again = await inspectContainer(cleaned.output)
      expect(again.findings, `${label} still had findings after cleaning`).toEqual([])
    }
  })
})
