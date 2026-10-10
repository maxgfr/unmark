// The pictures and attachments inside a PDF, which is where its marks hide.
//
// A PDF exported from a word processor drops the document's own metadata into
// `/Info` and an XMP stream, and both are handled in clean.ts. A picture placed
// in that document keeps its own: EXIF from the camera, an XMP packet from the
// editor, a C2PA manifest from the tool that produced it. Those ride inside the
// image XObjects, and a report that only lists `/Info` cannot say whether a
// manifest was lost on export or simply never looked for. This pass looks, and
// says how much it looked at either way.
//
// What it can rewrite it rewrites. A /DCTDecode stream with no other filter is
// a JPEG file byte for byte, so its marker segments go exactly as they would
// from a .jpg — the scan data is copied, never re-encoded. Anything wrapped in
// another filter, or a JPEG 2000 codestream, is reported and left alone, and
// says so on the finding. An attached C2PA manifest store is unlinked from the
// catalog, which is enough: the writer only emits what is still reachable.
//
// oxlint-disable no-await-in-loop -- one stream at a time, in object order.

import type { Finding, FindingKind } from '../../report.ts'
import { findC2pa, withC2pa } from '../c2pa.ts'
import { cleanGif, sniffGif } from '../gif.ts'
import { cleanJpeg, sniffJpeg } from '../jpeg.ts'
import { cleanPng, sniffPng } from '../png.ts'
import { cleanWebp, sniffWebp } from '../webp.ts'
import type { ContainerResult } from '../types.ts'
import {
  asArray,
  asDict,
  asList,
  asName,
  decodeStream,
  pdfArray,
  pdfDict,
  type PdfObject,
  type PdfStream,
} from './lex.ts'
import { resolve, type PdfDocument } from './objects.ts'

export interface MediaScan {
  findings: Finding[]
  coverage: string[]
}

interface Tally {
  images: number
  jpeg: number
  jpx: number
  other: number
  c2pa: number
  exif: number
  xmp: number
}

const NOT_REWRITTEN = (where: string) =>
  `inside ${where} — reported, not rewritten: removing it means re-encoding the stream`

/**
 * A finding from inside a stream, addressed by the stream rather than by an
 * offset. The offset the image handler reports is into the image, and printed
 * next to a PDF it reads as a position in the PDF.
 */
const located = (finding: Finding, where: string): Finding => ({
  ...finding,
  offset: 0,
  length: 0,
  where,
})

const count = (tally: Tally, kind: FindingKind) => {
  if (kind === 'c2pa') tally.c2pa += 1
  else if (kind === 'exif') tally.exif += 1
  else if (kind === 'xmp') tally.xmp += 1
}

const filtersOf = (doc: PdfDocument, stream: PdfStream): string[] =>
  asList(resolve(doc, stream.dict.entries.get('Filter'))).map(
    (filter) => asName(resolve(doc, filter)) ?? '?',
  )

const isFlate = (name: string) => name === 'FlateDecode' || name === 'Fl'

/**
 * The bytes under every leading Flate filter, or undefined when another filter
 * comes first. A JPEG that a writer deflated a second time is still a JPEG
 * once the deflate is off.
 */
async function peelFlate(
  doc: PdfDocument,
  stream: PdfStream,
  filters: readonly string[],
): Promise<Uint8Array | undefined> {
  const flate = filters.findIndex((filter) => !isFlate(filter))
  const leading = flate === -1 ? filters.length : flate
  if (leading === 0) return stream.raw
  const parms = asList(resolve(doc, stream.dict.entries.get('DecodeParms')))
  const peeled: PdfStream = {
    type: 'stream',
    dict: pdfDict([
      ['Filter', pdfArray(filters.slice(0, leading).map((name) => ({ type: 'name', name })))],
      ['DecodeParms', pdfArray(parms.slice(0, leading))],
    ]),
    raw: stream.raw,
  }
  try {
    return await decodeStream(peeled, (object) => resolve(doc, object))
  } catch {
    return undefined
  }
}

/** Marks a JPEG 2000 codestream or an unknown blob can carry, found by their signatures. */
function searchBlob(bytes: Uint8Array, label: string): Finding[] {
  const findings: Finding[] = []
  const c2pa = findC2pa(bytes)
  if (c2pa) {
    findings.push(
      withC2pa(
        {
          kind: 'c2pa',
          verdict: 'confirmed',
          offset: 0,
          length: 0,
          label: `${label} — C2PA provenance manifest`,
        },
        bytes.subarray(c2pa.offset, c2pa.offset + c2pa.length),
      ),
    )
  }
  const text = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1 << 20)))
  if (text.includes('<x:xmpmeta') || text.includes('http://ns.adobe.com/xap/1.0/')) {
    const tool = /<(?:xmp:CreatorTool|tiff:Software)>([^<]+)</.exec(text)?.[1]
    findings.push({
      kind: 'xmp',
      verdict: 'probable',
      offset: 0,
      length: 0,
      label: `${label} — XMP packet`,
      ...(tool ? { evidence: tool } : {}),
    })
  }
  if (text.includes('Exif\0\0')) {
    findings.push({
      kind: 'exif',
      verdict: 'informational',
      offset: 0,
      length: 0,
      label: `${label} — EXIF block`,
    })
  }
  return findings
}

async function scanImages(
  doc: PdfDocument,
  live: ReadonlySet<number>,
  rewrite: boolean,
  findings: Finding[],
): Promise<Tally> {
  const tally: Tally = { images: 0, jpeg: 0, jpx: 0, other: 0, c2pa: 0, exif: 0, xmp: 0 }

  for (const num of [...live].sort((a, b) => a - b)) {
    const stored = doc.objects.get(num)
    const stream = stored?.object
    if (!stored || stream?.type !== 'stream') continue
    if (asName(resolve(doc, stream.dict.entries.get('Subtype'))) !== 'Image') continue
    tally.images += 1
    const where = `image XObject ${num}`
    // An image's own /Metadata stream is removed with every other one in
    // clean.ts. It is counted here so the coverage line adds up.
    if (stream.dict.entries.has('Metadata')) tally.xmp += 1

    const filters = filtersOf(doc, stream)
    const last = filters.at(-1)

    if (last === 'DCTDecode' || last === 'DCT') {
      tally.jpeg += 1
      const jpeg = await peelFlate(doc, stream, filters.slice(0, -1).concat('DCTDecode'))
      if (!jpeg || !sniffJpeg(jpeg)) continue
      const cleaned = cleanJpeg(jpeg)
      const direct = filters.length === 1
      for (const finding of cleaned.findings) {
        count(tally, finding.kind)
        findings.push({
          ...located(finding, where),
          ...(rewrite && direct
            ? {}
            : { preserved: NOT_REWRITTEN(`a ${filters.join(' + ')} image`) }),
        })
      }
      if (rewrite && direct && cleaned.findings.length > 0) {
        // Same dictionary, new bytes. /Length is rewritten by the writer from
        // the bytes it emits.
        stored.object = { type: 'stream', dict: stream.dict, raw: cleaned.output }
      }
      continue
    }

    if (last === 'JPXDecode') {
      tally.jpx += 1
      const codestream = await peelFlate(doc, stream, filters.slice(0, -1).concat('JPXDecode'))
      if (!codestream) continue
      for (const finding of searchBlob(codestream, 'JPEG 2000 image')) {
        count(tally, finding.kind)
        findings.push({ ...located(finding, where), preserved: NOT_REWRITTEN('a JPEG 2000 image') })
      }
      continue
    }

    // Flate, LZW, CCITT, JBIG2 or no filter at all: pixel data, which has no
    // place to keep a metadata block.
    tally.other += 1
  }

  return tally
}

// ---------------------------------------------------------- embedded files

const textOf = (object: PdfObject | undefined): string | undefined => {
  if (object?.type !== 'string') return undefined
  const bytes = object.bytes
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  return String.fromCharCode(...bytes)
}

/** A picture attached as a file, cleaned by the handler that already knows its format. */
function sniffImage(bytes: Uint8Array): ContainerResult | undefined {
  if (sniffPng(bytes)) return cleanPng(bytes)
  if (sniffJpeg(bytes)) return cleanJpeg(bytes)
  if (sniffWebp(bytes)) return cleanWebp(bytes)
  if (sniffGif(bytes)) return cleanGif(bytes)
  return undefined
}

/**
 * Drop every reference to one object from `/AF` arrays and name-tree leaves.
 *
 * Recursive, because the catalog usually holds its name tree inline —
 * `/Names << /EmbeddedFiles << /Names [(a) 12 0 R] >> >>` — where a pass over
 * the stored objects alone never reaches it.
 */
function unlink(doc: PdfDocument, target: number): void {
  const isTarget = (object: PdfObject | undefined) =>
    object?.type === 'ref' && object.num === target

  const visit = (object: PdfObject, depth: number): void => {
    if (depth > 32) return
    if (object.type === 'array') {
      for (const item of object.items) visit(item, depth + 1)
      return
    }
    const dict = object.type === 'stream' ? object.dict : asDict(object)
    if (!dict) return
    const af = dict.entries.get('AF')
    if (isTarget(af)) dict.entries.delete('AF')
    const afItems = asArray(af)
    if (afItems?.some(isTarget)) {
      const kept = afItems.filter((item) => !isTarget(item))
      if (kept.length > 0) dict.entries.set('AF', pdfArray(kept))
      else dict.entries.delete('AF')
    }
    // A name-tree leaf: [name ref name ref …]. Pairs go together.
    const names = asArray(dict.entries.get('Names'))
    if (names?.some(isTarget)) {
      const kept: PdfObject[] = []
      for (let index = 0; index + 1 < names.length; index += 2) {
        if (!isTarget(names[index + 1])) {
          kept.push(names[index] as PdfObject, names[index + 1] as PdfObject)
        }
      }
      dict.entries.set('Names', pdfArray(kept))
    }
    for (const value of dict.entries.values()) visit(value, depth + 1)
  }

  for (const stored of doc.objects.values()) visit(stored.object, 0)
}

async function scanAttachments(
  doc: PdfDocument,
  live: ReadonlySet<number>,
  rewrite: boolean,
  findings: Finding[],
): Promise<{ files: number; c2pa: number }> {
  let files = 0
  let c2pa = 0

  for (const num of [...live].sort((a, b) => a - b)) {
    const spec = asDict(doc.objects.get(num)?.object)
    const ef = asDict(resolve(doc, spec?.entries.get('EF')))
    if (!spec || !ef) continue
    const file = resolve(doc, ef.entries.get('UF') ?? ef.entries.get('F'))
    if (file?.type !== 'stream') continue
    files += 1

    const name =
      textOf(resolve(doc, spec.entries.get('UF'))) ??
      textOf(resolve(doc, spec.entries.get('F'))) ??
      `embedded file ${num}`
    const subtype = asName(resolve(doc, file.dict.entries.get('Subtype'))) ?? ''
    const relationship = asName(resolve(doc, spec.entries.get('AFRelationship'))) ?? ''
    let data: Uint8Array | undefined
    try {
      data = await decodeStream(file, (object) => resolve(doc, object))
    } catch {
      data = undefined
    }
    const where = `attached file ${name}`

    // A picture first: a PNG carrying a caBX chunk contains a C2PA store too,
    // and it is a figure someone attached, not the document's own manifest.
    const picture = data ? sniffImage(data) : undefined
    if (picture) {
      for (const finding of picture.findings) {
        if (finding.kind === 'c2pa') c2pa += 1
        findings.push({ ...located(finding, where), preserved: NOT_REWRITTEN('an attached file') })
      }
      continue
    }

    const store = data ? findC2pa(data) : undefined
    if (data && (store || /c2pa/i.test(subtype) || relationship === 'C2PA_Manifest')) {
      c2pa += 1
      const jumbf = store ? data.subarray(store.offset, store.offset + store.length) : data
      findings.push({
        ...withC2pa(
          {
            kind: 'c2pa',
            verdict: 'confirmed',
            offset: 0,
            length: 0,
            where,
            label: 'C2PA manifest store',
          },
          jumbf,
        ),
        ...(rewrite ? {} : { preserved: 'a signed document — left exactly as it arrived' }),
      })
      // The document's own manifest goes with the rest of its provenance.
      if (rewrite) unlink(doc, num)
    }
  }

  return { files, c2pa }
}

/**
 * Scan every live image XObject and attached file; rewrite what can be
 * rewritten when `rewrite` is set; report the coverage either way.
 */
export async function scanPdfMedia(
  doc: PdfDocument,
  live: ReadonlySet<number>,
  rewrite: boolean,
): Promise<MediaScan> {
  const findings: Finding[] = []
  const images = await scanImages(doc, live, rewrite, findings)
  const attachments = await scanAttachments(doc, live, rewrite, findings)

  const kinds = [
    images.jpeg > 0 ? `${images.jpeg} JPEG` : '',
    images.jpx > 0 ? `${images.jpx} JPEG 2000` : '',
    images.other > 0 ? `${images.other} raw pixel data, which holds no metadata` : '',
  ].filter(Boolean)
  const coverage = [
    `${images.images} image XObject${images.images === 1 ? '' : 's'}` +
      (kinds.length > 0 ? ` (${kinds.join(', ')})` : '') +
      `: ${images.c2pa} C2PA, ${images.exif} EXIF, ${images.xmp} XMP`,
    `${attachments.files} attached file${attachments.files === 1 ? '' : 's'}: ${attachments.c2pa} C2PA`,
  ]
  return { findings, coverage }
}
