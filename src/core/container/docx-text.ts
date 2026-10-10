// The prose of a Word document, paragraph by paragraph, with where each one is.
//
// `detect` reads prose, and a .docx is a zip of XML that holds prose alongside
// a great deal that is not: tables of numbers, figure captions, a table of
// contents, a reference list. Scoring those as writing measures the layout,
// so they are left out here and counted, and what remains is the body text
// with, for each paragraph, its ordinal, the heading it sits under and — when
// Word left enough page breaks behind to trust — its page.
//
// Pure and environment-free like the rest of the core: a zip reader, a tag
// scanner and string work. It reads `word/document.xml` only; headers,
// footers, footnotes and comments are not the body of the text.

import { readZip, type ZipEntry } from './zip.ts'
import { decodeUtf8 } from './types.ts'

/** Why a paragraph of the document is not in the prose. */
export type SkipReason = 'table' | 'caption' | 'references' | 'toc' | 'heading' | 'textbox'

export interface DocParagraph {
  /**
   * 1-based, among every paragraph of the body in document order — empty ones
   * included — so it is the same number `inspect` gives a picture's paragraph.
   */
  index: number
  /** Where it sits in `DocText.text`. */
  start: number
  end: number
  /** The heading it sits under, as written: "2.6.3 Mechanistic hypotheses". */
  section?: string
  /** The page it starts on, when the document's page breaks can be trusted. */
  page?: number
}

export interface DocText {
  /** Kept paragraphs, separated by a blank line. */
  text: string
  paragraphs: DocParagraph[]
  /** Paragraphs left out, by reason. */
  skipped: Record<SkipReason, number>
  /**
   * Whether `page` was filled in. Word records the page breaks it last
   * rendered; a file saved by another program records few or none, and a page
   * number computed from those would be wrong without saying so.
   */
  paged: boolean
}

interface Style {
  name: string
  basedOn?: string
  outline?: number
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** XML character references and the five predefined entities. */
export function decodeXmlText(value: string): string {
  return value.replaceAll(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X'))
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10))
    return ENTITY[body] ?? whole
  })
}

const attribute = (attributes: string, name: string): string | undefined =>
  new RegExp(`\\b${name}="([^"]*)"`, 'u').exec(attributes)?.[1]

/** styleId → its display name, parent and outline level. */
function readStyles(xml: string | undefined): Map<string, Style> {
  const styles = new Map<string, Style>()
  if (!xml) return styles
  for (const match of xml.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/gu)) {
    const id = attribute(match[1] ?? '', 'w:styleId')
    if (!id) continue
    const body = match[2] ?? ''
    const name = attribute(/<w:name\b([^>]*)\/?>/u.exec(body)?.[1] ?? '', 'w:val') ?? id
    const basedOn = attribute(/<w:basedOn\b([^>]*)\/?>/u.exec(body)?.[1] ?? '', 'w:val')
    const outline = attribute(/<w:outlineLvl\b([^>]*)\/?>/u.exec(body)?.[1] ?? '', 'w:val')
    styles.set(id, {
      name,
      ...(basedOn ? { basedOn } : {}),
      ...(outline === undefined ? {} : { outline: Number(outline) }),
    })
  }
  return styles
}

const HEADING_NAME = /^(?:heading|titre|title|überschrift|titolo|título)\s*(\d)?$/iu
const CAPTION_NAME = /^(?:caption|l[ée]gende|beschriftung|didascalia)$/iu
const TOC_NAME = /^(?:toc|tm|table of contents|verzeichnis)\s*\d*$|^toc heading$/iu

/** A heading level from 1, or undefined; following `basedOn` a few steps. */
function headingLevel(styles: Map<string, Style>, id: string | undefined): number | undefined {
  let current = id
  for (let depth = 0; current && depth < 8; depth += 1) {
    const style = styles.get(current)
    if (!style) {
      const named = HEADING_NAME.exec(current)
      return named ? Number(named[1] ?? 1) : undefined
    }
    if (style.outline !== undefined && style.outline < 9) return style.outline + 1
    const named = HEADING_NAME.exec(style.name) ?? HEADING_NAME.exec(current)
    if (named) return Number(named[1] ?? 1)
    current = style.basedOn
  }
  return undefined
}

const styleName = (styles: Map<string, Style>, id: string | undefined): string =>
  id === undefined ? '' : (styles.get(id)?.name ?? id)

/** A caption, by what it says: "Figure 4.", "Tableau 2 –", "Fig. 3:". */
const CAPTION_TEXT =
  /^\s*(?:figure|fig\.|tableau|table|graphique|graph|chart|annexe|appendix|sch[ée]ma|illustration|encadr[ée])\s+[0-9IVXLC]+[a-z]?\s*[.:–—-]/iu
/** The heading of a reference list. */
const REFERENCES_HEADING =
  /^\s*(?:[\dIVX]+(?:\.\d+)*\.?\s+)?(?:r[ée]f[ée]rences?(?: bibliographiques)?|references|bibliograph(?:y|ie)|works cited|literature cited|literatur(?:verzeichnis)?)\s*:?\s*$/iu

/** The heading of a table of contents typed by hand, with no TOC field behind it. */
const TOC_HEADING =
  /^\s*(?:table des mati[èe]res|sommaire|contents|table of contents|inhaltsverzeichnis|[ií]ndice)\s*$/iu
/** A line of a table of contents: a short title ending in its page number. */
const TOC_LINE = /^\S.{0,160}?\s*\.{0,}\s*\d{1,4}$/u

/** A cell needs this many words to be read as prose rather than as data. */
const PROSE_CELL_WORDS = 30

interface RawParagraph {
  /** 1-based, among every `w:p` of the body in document order, empty ones too. */
  ordinal: number
  text: string
  style?: string
  outline?: number
  toc: boolean
  /** Page breaks before any of its text, and after it. */
  breaksBefore: number
  breaksAfter: number
  /** Inside a table, and its cell's word count. */
  inTable: boolean
  textbox: boolean
}

const wordCount = (text: string) => text.split(/\s+/u).filter(Boolean).length

/**
 * Paragraphs of `word/document.xml` in document order, with their properties.
 *
 * A scanner over tags rather than a DOM: the core has none, and the handful of
 * elements that matter here — paragraphs, runs, text, tabs, breaks, field
 * codes, tables — are read with a depth counter each.
 */
function scanParagraphs(xml: string): RawParagraph[] {
  const out: RawParagraph[] = []
  const TAG = /<(\/?)([\w:]+)((?:[^>"]|"[^"]*")*?)(\/?)>|([^<]+)/gu
  let paragraph: RawParagraph | undefined
  let table = 0
  let textbox = 0
  let fallback = 0
  let deleted = 0
  let inText = false
  let inInstruction = false
  let instruction = ''
  let pending = 0 // page breaks seen outside a paragraph's text
  let ordinal = 0

  for (const match of xml.matchAll(TAG)) {
    const [, closing, name, attributes = '', selfClosing, text] = match
    if (text !== undefined) {
      if (!paragraph || fallback > 0 || deleted > 0) continue
      if (inText) paragraph.text += decodeXmlText(text)
      else if (inInstruction) instruction += text
      continue
    }
    const open = closing !== '/'
    const empty = selfClosing === '/'

    switch (name) {
      case 'mc:Fallback': {
        // AlternateContent says the same thing twice; the fallback is the copy.
        if (!empty) fallback += open ? 1 : -1
        break
      }
      case 'w:tbl': {
        if (!empty) table += open ? 1 : -1
        break
      }
      case 'w:txbxContent': {
        if (!empty) textbox += open ? 1 : -1
        break
      }
      case 'w:del':
      case 'w:moveFrom': {
        if (!empty) deleted += open ? 1 : -1
        break
      }
      case 'w:p': {
        // Every paragraph is counted, the duplicates inside a fallback too, so
        // the ordinal is the one `inspect` gives a picture's paragraph.
        if (open) ordinal += 1
        if (fallback > 0) break
        if (open && !empty) {
          paragraph = {
            ordinal,
            text: '',
            toc: false,
            breaksBefore: pending,
            breaksAfter: 0,
            inTable: table > 0,
            textbox: textbox > 0,
          }
          pending = 0
        } else if (!open && paragraph) {
          out.push(paragraph)
          paragraph = undefined
        } else if (empty) {
          out.push({
            ordinal,
            text: '',
            toc: false,
            breaksBefore: pending,
            breaksAfter: 0,
            inTable: table > 0,
            textbox: textbox > 0,
          })
          pending = 0
        }
        break
      }
      case 'w:pStyle': {
        if (paragraph && open) {
          const value = attribute(attributes, 'w:val')
          if (value) paragraph.style = value
        }
        break
      }
      case 'w:outlineLvl': {
        if (paragraph && open) {
          const value = attribute(attributes, 'w:val')
          if (value !== undefined) paragraph.outline = Number(value)
        }
        break
      }
      case 'w:t': {
        if (!empty) inText = open
        break
      }
      case 'w:instrText': {
        if (empty) break
        inInstruction = open
        if (!open && paragraph && /\b(?:TOC|PAGEREF)\b/u.test(instruction)) paragraph.toc = true
        if (!open) instruction = ''
        break
      }
      case 'w:tab': {
        // `w:tab` is also a tab stop inside paragraph properties, which has a
        // `w:pos`; only the run-level one is a character.
        if (paragraph && open && !/\bw:pos=/u.test(attributes)) paragraph.text += '\t'
        break
      }
      case 'w:br':
      case 'w:cr': {
        if (!open) break
        if (attribute(attributes, 'w:type') === 'page') {
          if (paragraph?.text.trim()) paragraph.breaksAfter += 1
          else if (paragraph) paragraph.breaksBefore += 1
          else pending += 1
        } else if (paragraph && attribute(attributes, 'w:type') !== 'column') {
          paragraph.text += '\n'
        }
        break
      }
      case 'w:lastRenderedPageBreak': {
        if (paragraph?.text.trim()) paragraph.breaksAfter += 1
        else if (paragraph) paragraph.breaksBefore += 1
        else pending += 1
        break
      }
      case 'w:noBreakHyphen': {
        if (paragraph && open) paragraph.text += '-'
        break
      }
      default: {
        break
      }
    }
  }
  return out
}

/** "2.6.3 Mechanistic hypotheses" stays as it is; the label is the heading. */
const sectionLabel = (heading: string): string => heading.replaceAll(/\s+/gu, ' ').trim()

/**
 * The body prose of a .docx, or `undefined` when the bytes are not one.
 *
 * Left out, and counted in `skipped`: tables whose cells are data rather than
 * prose (a layout table holding a page of text is kept), captions — by style
 * or by a leading "Figure 4." —, the table of contents, headings (they label
 * the paragraphs instead) and everything under a "References" heading until
 * the next heading.
 */
export async function docxText(bytes: Uint8Array): Promise<DocText | undefined> {
  let entries: ZipEntry[]
  try {
    entries = await readZip(bytes)
  } catch {
    return undefined
  }
  const part = (name: string) => entries.find((entry) => entry.name === name)?.data
  const document = part('word/document.xml')
  if (!document) return undefined
  const styles = readStyles(
    part('word/styles.xml') ? decodeUtf8(part('word/styles.xml') as Uint8Array) : undefined,
  )
  const declaredPages = Number(
    /<Pages>(\d+)<\/Pages>/u.exec(decodeUtf8(part('docProps/app.xml') ?? new Uint8Array()))?.[1] ??
      0,
  )

  const raw = scanParagraphs(decodeUtf8(document))
  const skipped: Record<SkipReason, number> = {
    table: 0,
    caption: 0,
    references: 0,
    toc: 0,
    heading: 0,
    textbox: 0,
  }

  // Page numbers are only worth giving when Word's rendered breaks account for
  // most of the pages it says the document has.
  const breaks = raw.reduce((sum, p) => sum + p.breaksBefore + p.breaksAfter, 0)
  const paged = declaredPages > 1 && breaks + 1 >= 0.9 * declaredPages

  const parts: string[] = []
  const paragraphs: DocParagraph[] = []
  let length = 0
  let page = 1
  let section: string | undefined
  let referencesLevel: number | undefined
  let inToc = false

  for (const p of raw) {
    page += p.breaksBefore
    const text = p.text.replaceAll(/[\t ]+/gu, ' ').trim()
    const startPage = page
    page += p.breaksAfter
    if (!text) continue
    const index = p.ordinal

    const name = styleName(styles, p.style)
    const level =
      p.outline !== undefined && p.outline < 9 ? p.outline + 1 : headingLevel(styles, p.style)
    const shortLine = wordCount(text) <= 6 && !/[.!?;:]$/u.test(text)

    if (TOC_HEADING.test(text) && shortLine) {
      inToc = true
      skipped.toc += 1
      continue
    }
    if (inToc && wordCount(text) <= 16 && TOC_LINE.test(text)) {
      skipped.toc += 1
      continue
    }
    inToc = false

    if (level !== undefined || (REFERENCES_HEADING.test(text) && shortLine)) {
      skipped.heading += 1
      const own = level ?? 1
      if (REFERENCES_HEADING.test(text)) {
        referencesLevel = own
        continue
      }
      // A subheading inside the reference list is still the reference list.
      if (referencesLevel !== undefined && own > referencesLevel) continue
      referencesLevel = undefined
      section = sectionLabel(text)
      continue
    }
    if (referencesLevel !== undefined) {
      skipped.references += 1
      continue
    }
    if (p.toc || TOC_NAME.test(name)) {
      skipped.toc += 1
      continue
    }
    if (p.textbox) {
      skipped.textbox += 1
      continue
    }
    if (CAPTION_NAME.test(name) || CAPTION_TEXT.test(text)) {
      skipped.caption += 1
      continue
    }
    if (p.inTable && wordCount(text) < PROSE_CELL_WORDS) {
      skipped.table += 1
      continue
    }

    if (parts.length > 0) length += 2
    const start = length
    parts.push(text)
    length += text.length
    paragraphs.push({
      index,
      start,
      end: length,
      ...(section ? { section } : {}),
      ...(paged ? { page: startPage } : {}),
    })
  }

  return { text: parts.join('\n\n'), paragraphs, skipped, paged }
}
