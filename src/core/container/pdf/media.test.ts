import { describe, expect, it } from 'vitest'
import { cleanPdf } from './clean.ts'
import { asName, source } from './lex.ts'
import { loadDocument } from './objects.ts'
import { concat, encode } from '../types.ts'
import { inspectContainer } from '../index.ts'
import { c2paStore, CLAUDE_STORE } from '../../../test/c2pa.ts'
import {
  exifSegment,
  jpeg,
  png,
  pdf,
  zlibStored,
  type PdfOptions,
} from '../../../test/containers.ts'

const store = c2paStore(CLAUDE_STORE)
const app11 = concat([encode('JP'), new Uint8Array([0, 1, 0, 0, 0, 1]), store])

const run = async (options: PdfOptions, force = false) => {
  const result = await cleanPdf(pdf(options), force ? { force: true } : {})
  return { ...result, all: [...result.findings, ...result.preserved] }
}

/** Every image stream left in a PDF, as raw bytes. */
const imageStreams = async (bytes: Uint8Array) => {
  const doc = await loadDocument(source(bytes))
  return [...doc.objects.values()].flatMap((stored) =>
    stored.object.type === 'stream' && asName(stored.object.dict.entries.get('Subtype')) === 'Image'
      ? [stored.object.raw]
      : [],
  )
}

describe('image XObjects', () => {
  it('strips EXIF from a DCT image without touching its scan data', async () => {
    const result = await run({
      images: [
        { data: jpeg([{ marker: 0xe1, data: exifSegment('GPS') }]), filters: ['DCTDecode'] },
      ],
    })
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        kind: 'exif',
        where: expect.stringMatching(/^image XObject \d+$/),
        offset: 0,
        length: 0,
      }),
    )
    expect(await imageStreams(result.output)).toEqual([jpeg()])
    expect(result.coverage?.[0]).toBe('1 image XObject (1 JPEG): 0 C2PA, 1 EXIF, 0 XMP')
  })

  it('decodes a C2PA manifest inside a deflated JPEG and says why it stays', async () => {
    const data = zlibStored(jpeg([{ marker: 0xeb, data: app11 }]))
    const result = await run({ images: [{ data, filters: ['FlateDecode', 'DCTDecode'] }] })
    const c2pa = result.preserved.find((finding) => finding.kind === 'c2pa')
    expect(c2pa?.c2pa?.origin).toBe('ai_tool')
    expect(c2pa?.preserved).toContain('FlateDecode + DCTDecode image — reported, not rewritten')
    expect(await imageStreams(result.output)).toEqual([data])
  })

  it('finds a manifest, XMP and EXIF in a JPEG 2000 codestream and leaves it', async () => {
    const codestream = concat([
      encode('jP  ....'),
      store,
      encode('<x:xmpmeta><xmp:CreatorTool>Gen</xmp:CreatorTool>Exif\0\0'),
    ])
    const result = await run({ images: [{ data: codestream, filters: ['JPXDecode'] }] })
    expect(result.preserved.map((finding) => finding.kind).sort()).toEqual(['c2pa', 'exif', 'xmp'])
    expect(result.preserved.find((finding) => finding.kind === 'xmp')?.evidence).toBe('Gen')
    expect(result.coverage?.[0]).toBe('1 image XObject (1 JPEG 2000): 1 C2PA, 1 EXIF, 1 XMP')
  })

  it('counts raw pixel data as scanned and holding nothing', async () => {
    const result = await run({
      images: [
        { data: new Uint8Array(3), filters: ['FlateDecode'] },
        { data: zlibStored(jpeg()), filters: ['FlateDecode', 'DCTDecode'] },
      ],
    })
    expect(result.coverage?.[0]).toBe(
      '2 image XObjects (1 JPEG, 1 raw pixel data, which holds no metadata): 0 C2PA, 0 EXIF, 0 XMP',
    )
  })

  it('says so when there are no images at all', async () => {
    const result = await run({})
    expect(result.coverage).toEqual([
      '0 image XObjects: 0 C2PA, 0 EXIF, 0 XMP',
      '0 attached files: 0 C2PA',
    ])
  })
})

describe('attached files', () => {
  it('decodes an attached C2PA manifest store and unlinks it from the catalog', async () => {
    const result = await run({
      attachments: [
        {
          name: 'manifest.c2pa',
          data: store,
          subtype: 'application#2Fc2pa',
          relationship: 'C2PA_Manifest',
        },
      ],
    })
    const c2pa = result.findings.find((finding) => finding.kind === 'c2pa')
    expect(c2pa).toMatchObject({
      where: 'attached file manifest.c2pa',
      label: expect.stringContaining('C2PA manifest store: file passed through an AI tool'),
    })
    expect(source(result.output).text).not.toContain('jumdc2pa')
    expect(source(result.output).text).not.toContain('/AF')
    expect(result.coverage?.[1]).toBe('1 attached file: 1 C2PA')
  })

  it('reports marks on an attached picture without rewriting the attachment', async () => {
    const picture = png([{ type: 'caBX', data: store }])
    const result = await run({ attachments: [{ name: 'figure.png', data: picture }] })
    expect(result.preserved).toContainEqual(
      expect.objectContaining({
        kind: 'c2pa',
        where: 'attached file figure.png',
        preserved: expect.stringContaining('an attached file'),
      }),
    )
    expect(result.coverage?.[1]).toBe('1 attached file: 1 C2PA')
  })

  it('counts an attachment that holds nothing of interest', async () => {
    const result = await run({ attachments: [{ name: 'notes.txt', data: encode('plain') }] })
    expect(result.coverage?.[1]).toBe('1 attached file: 0 C2PA')
  })
})

describe('coverage when the document is not rebuilt', () => {
  it('scans a signed document read-only and keeps every mark', async () => {
    const result = await run({
      signature: true,
      images: [{ data: jpeg([{ marker: 0xe1, data: exifSegment('x') }]), filters: ['DCTDecode'] }],
    })
    expect(result.findings).toEqual([])
    expect(result.preserved.find((finding) => finding.kind === 'exif')?.preserved).toBe(
      'a signed document — left exactly as it arrived',
    )
    expect(result.coverage?.[0]).toContain('1 EXIF')
  })

  it('says an encrypted document was not scanned', async () => {
    expect((await run({ encrypted: true })).coverage).toEqual([
      'images and attached files not scanned: the document is encrypted',
    ])
  })

  it('says the byte pass does not open streams', async () => {
    const result = await cleanPdf(encode('%PDF-1.4\n/Author (x)\n%%EOF'))
    expect(result.coverage?.[0]).toContain('could not be rebuilt')
  })

  it('carries the coverage through inspectContainer', async () => {
    const report = await inspectContainer(pdf({}))
    expect(report.coverage).toHaveLength(2)
  })
})
