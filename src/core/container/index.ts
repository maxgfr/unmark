// Which handler a file goes to, decided by what it is rather than what it is called.
//
// Sniffing beats the extension every time: a .jpg that is really a PNG is
// common enough that trusting the name would hand the wrong parser a file it
// will quietly mangle. The name is only consulted for the text formats, where
// there are no magic bytes to read and Markdown and HTML genuinely look alike.

import { byPosition, type Finding } from '../report.ts'
import { cleanText, type TextOptions } from '../text/unicode.ts'
import { stegoFindings } from '../text/stego.ts'
import { cleanPng, sniffPng } from './png.ts'
import { cleanJpeg, sniffJpeg } from './jpeg.ts'
import { cleanWebp, sniffWebp } from './webp.ts'
import { cleanGif, sniffGif } from './gif.ts'
import { cleanPdf, sniffPdf } from './pdf/index.ts'
import { cleanIsobmff, sniffIsobmff } from './isobmff/index.ts'
import { cleanZipDocument } from './zipdoc.ts'
import { ooxmlFlavour, readZip, sniffZip, zipDocumentKind } from './zip.ts'
import { cleanHtml, cleanMarkdown, cleanSvg, type TextCleanResult } from './markup.ts'
import { decodeUtf8, encode, type ContainerResult } from './types.ts'

export type ContainerFormat =
  | 'PNG'
  | 'JPEG'
  | 'WebP'
  | 'GIF'
  | 'PDF'
  | 'HEIC'
  | 'AVIF'
  | 'MP4'
  | 'DOCX'
  | 'PPTX'
  | 'XLSX'
  | 'ODT'
  | 'EPUB'
  | 'SVG'
  | 'HTML'
  | 'Markdown'
  | 'Text'
  | 'unknown'

/**
 * Options that are about the container rather than about the text inside it.
 *
 * One field so far. `force` exists because a signed PDF is refused by default —
 * any edit voids the signature — and the only honest way to offer the other
 * choice is to make the user ask for it by name.
 */
export interface ContainerOptions {
  force?: boolean
}

export interface FileResult extends ContainerResult {
  format: ContainerFormat
  /** True when the output is meant to be read as text rather than saved as bytes. */
  textual: boolean
}

/** Formats whose provenance lives in markup rather than in a binary structure. */
const MARKUP: Partial<Record<ContainerFormat, (text: string) => TextCleanResult>> = {
  SVG: cleanSvg,
  HTML: cleanHtml,
  Markdown: cleanMarkdown,
}

const extensionOf = (name?: string) => name?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''

/**
 * Whether these bytes are text at all.
 *
 * The text path decodes UTF-8, edits a string, and encodes it back. That round
 * trip is lossless for text and destructive for anything else: every byte that
 * is not valid UTF-8 comes back as U+FFFD, three bytes wide. A file format
 * nobody here recognises used to fall straight into that path, so
 * `unmark clean mystery.bin --in-place` corrupted the file and reported zero
 * findings — the tool doing damage while saying it had found nothing.
 *
 * A strict decode is the test. A NUL byte is checked separately because it is
 * valid UTF-8 and still means binary in every practical case.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.subarray(0, 8192).includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** Text formats have no magic bytes, so this is content first and name second. */
function sniffText(text: string, name?: string): ContainerFormat {
  const head = text.slice(0, 1024).trimStart().toLowerCase()
  const extension = extensionOf(name)

  if (head.startsWith('<svg') || (head.startsWith('<?xml') && text.includes('<svg'))) return 'SVG'
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'HTML'
  if (extension === 'svg') return 'SVG'
  if (extension === 'html' || extension === 'htm') return 'HTML'
  if (extension === 'md' || extension === 'markdown') return 'Markdown'
  if (text.startsWith('---\n') || text.startsWith('---\r\n')) return 'Markdown'
  return 'Text'
}

async function sniffBinary(bytes: Uint8Array): Promise<ContainerFormat | undefined> {
  if (sniffPng(bytes)) return 'PNG'
  if (sniffJpeg(bytes)) return 'JPEG'
  if (sniffWebp(bytes)) return 'WebP'
  if (sniffGif(bytes)) return 'GIF'
  if (sniffPdf(bytes)) return 'PDF'

  // ISOBMFF is checked after the still formats above because its `ftyp` box
  // starts at offset 4, not 0 — there is no leading magic to collide with.
  const isobmff = sniffIsobmff(bytes)
  if (isobmff) return isobmff

  if (sniffZip(bytes)) {
    try {
      const entries = await readZip(bytes)
      const kind = zipDocumentKind(entries)
      // One handler covers all three OOXML applications; the flavour is only
      // what the report calls the file.
      if (kind === 'ooxml') return ooxmlFlavour(entries)
      if (kind === 'odf') return 'ODT'
      if (kind === 'epub') return 'EPUB'
    } catch {
      // A zip we cannot read is not a document we can clean. Fall through and
      // report it as unknown rather than returning half a file.
      return 'unknown'
    }
    return 'unknown'
  }

  return undefined
}

/**
 * Strip a file's provenance metadata.
 *
 * Text formats get two passes: the markup rules that know about generator tags
 * and metadata blocks, then the invisible-character pass — an HTML page can
 * carry a zero-width watermark in its prose just as easily as a .txt can.
 *
 * A note on offsets in the report: markup findings are positions in the file as
 * given, and invisible-character findings are positions in the text after the
 * markup pass. The two differ only by whatever the markup pass removed.
 */
export async function cleanContainer(
  bytes: Uint8Array,
  name?: string,
  options?: TextOptions & ContainerOptions,
): Promise<FileResult> {
  const binary = await sniffBinary(bytes)

  if (binary && binary !== 'unknown') {
    const result = await cleanBinary(bytes, binary, options)
    return { ...result, format: binary, textual: false }
  }
  // An unreadable zip, or bytes that are not text, are both handed back exactly
  // as they arrived. Returning half a file, or a file with every invalid byte
  // replaced, is worse than saying the format is not recognised.
  if (binary === 'unknown' || !looksLikeText(bytes)) {
    return { output: bytes, findings: [], preserved: [], format: 'unknown', textual: false }
  }

  const text = decodeUtf8(bytes)
  const format = sniffText(text, name)
  const markup = MARKUP[format]

  const stage1 = markup ? markup(text) : { output: text, findings: [] as Finding[] }
  const stage2 = cleanText(stage1.output, options)

  return {
    output: encode(stage2.output),
    findings: [...stage1.findings, ...stage2.findings, ...stegoFindings(text)].sort(byPosition),
    preserved: stage2.preserved,
    format,
    textual: true,
  }
}

function cleanBinary(bytes: Uint8Array, format: ContainerFormat, options?: ContainerOptions) {
  switch (format) {
    case 'PNG': {
      return cleanPng(bytes)
    }
    case 'JPEG': {
      return cleanJpeg(bytes)
    }
    case 'WebP': {
      return cleanWebp(bytes)
    }
    case 'GIF': {
      return cleanGif(bytes)
    }
    case 'PDF': {
      return cleanPdf(bytes, options?.force === true ? { force: true } : {})
    }
    case 'HEIC':
    case 'AVIF':
    case 'MP4': {
      return cleanIsobmff(bytes)
    }
    default: {
      return cleanZipDocument(bytes)
    }
  }
}

/** Report a file's marks without changing it. */
export async function inspectContainer(
  bytes: Uint8Array,
  name?: string,
  options?: TextOptions & ContainerOptions,
): Promise<{ format: ContainerFormat; findings: Finding[]; preserved: Finding[] }> {
  const { format, findings, preserved } = await cleanContainer(bytes, name, options)
  return { format, findings: [...findings, ...preserved].sort(byPosition), preserved }
}

export {
  cleanGif,
  cleanHtml,
  cleanJpeg,
  cleanMarkdown,
  cleanPdf,
  cleanPng,
  cleanSvg,
  cleanWebp,
  cleanZipDocument,
  readZip,
}
export { writeZip } from './zip.ts'
export type { ContainerResult, TextCleanResult }
