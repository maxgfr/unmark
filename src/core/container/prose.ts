// The prose of a file, whatever it is stored in, for the commands that read
// writing rather than containers.
//
// Text, Markdown and HTML are read as they are. A .docx gives its body
// paragraphs (see docx-text.ts) and a PDF its pages (see pdf/text.ts), and
// both come with a layout: the paragraph, section and page each stretch of the
// returned text belongs to, so a report can point at the document a reader
// holds rather than at an intermediate text file.

import { layoutFromPages, type Layout, type PageText } from '../text/authorship/locate.ts'
import { docxText, type SkipReason } from './docx-text.ts'
import { readTextual } from './index.ts'
import { pdfText } from './pdf/text.ts'
import { sniffPdf } from './pdf/index.ts'
import { ooxmlFlavour, readZip, sniffZip, zipDocumentKind } from './zip.ts'
import type { ContainerFormat } from './formats.ts'

/** What was read, and what was left out of it. */
export interface ProseSource {
  container: 'DOCX' | 'PDF'
  paragraphs: number
  /** DOCX: paragraphs left out, by reason. */
  skipped?: Partial<Record<SkipReason, number>>
  /** PDF: pages read, and those whose content could not be decoded. */
  pages?: number
  unreadablePages?: number[]
  /** DOCX: whether its own page breaks were trusted for page numbers. */
  paged?: boolean
}

export interface Prose {
  text: string
  /** The text format the prose is analysed as. */
  format: ContainerFormat
  layout?: Layout
  source?: ProseSource
}

async function isDocx(bytes: Uint8Array): Promise<boolean> {
  if (!sniffZip(bytes)) return false
  try {
    const entries = await readZip(bytes)
    return zipDocumentKind(entries) === 'ooxml' && ooxmlFlavour(entries) === 'DOCX'
  } catch {
    return false
  }
}

/** A file's prose, or `undefined` when there is none this can read. */
export async function readProse(bytes: Uint8Array, name?: string): Promise<Prose | undefined> {
  const textual = await readTextual(bytes, name)
  if (textual) return textual

  if (sniffPdf(bytes)) {
    const read = await pdfText(bytes)
    if (!read) return undefined
    const { text, layout } = layoutFromPages(read.pages)
    return {
      text,
      format: 'Text',
      layout,
      source: {
        container: 'PDF',
        paragraphs: layout.paragraphs.length,
        pages: read.pages.length,
        ...(read.unreadable.length > 0 ? { unreadablePages: read.unreadable } : {}),
      },
    }
  }

  if (await isDocx(bytes)) {
    const read = await docxText(bytes)
    if (!read) return undefined
    const skipped = Object.fromEntries(
      Object.entries(read.skipped).filter(([, count]) => count > 0),
    ) as Partial<Record<SkipReason, number>>
    return {
      text: read.text,
      format: 'Text',
      layout: { paragraphs: read.paragraphs },
      source: {
        container: 'DOCX',
        paragraphs: read.paragraphs.length,
        skipped,
        paged: read.paged,
      },
    }
  }
  return undefined
}

/** The pages of a PDF, to place another file's paragraphs on them. */
export async function printedPages(bytes: Uint8Array): Promise<PageText[] | undefined> {
  if (!sniffPdf(bytes)) return undefined
  return (await pdfText(bytes))?.pages
}
