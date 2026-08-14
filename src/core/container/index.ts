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
import { cleanPdf, sniffPdf } from './pdf.ts'
import { cleanZipDocument } from './zipdoc.ts'
import { readZip, sniffZip, zipDocumentKind } from './zip.ts'
import { cleanHtml, cleanMarkdown, cleanSvg, type TextCleanResult } from './markup.ts'
import { decodeUtf8, encode, type ContainerResult } from './types.ts'

export type ContainerFormat =
  | 'PNG'
  | 'JPEG'
  | 'WebP'
  | 'GIF'
  | 'PDF'
  | 'DOCX'
  | 'ODT'
  | 'SVG'
  | 'HTML'
  | 'Markdown'
  | 'Text'
  | 'unknown'

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

  if (sniffZip(bytes)) {
    try {
      const kind = zipDocumentKind(await readZip(bytes))
      if (kind === 'ooxml') return 'DOCX'
      if (kind === 'odf') return 'ODT'
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
  options?: TextOptions,
): Promise<FileResult> {
  const binary = await sniffBinary(bytes)

  if (binary && binary !== 'unknown') {
    const result = await cleanBinary(bytes, binary)
    return { ...result, format: binary, textual: false }
  }
  if (binary === 'unknown') {
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

function cleanBinary(bytes: Uint8Array, format: ContainerFormat) {
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
      return cleanPdf(bytes)
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
  options?: TextOptions,
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
