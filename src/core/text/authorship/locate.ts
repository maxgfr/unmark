// Where a passage is, in the terms of the document a reader holds.
//
// A line number in an extracted text file means nothing to someone reading the
// printed thesis. What they need is the page, the section and the paragraph,
// so the report can say "p. 29, §2.6.3" instead of "line 412".
//
// Two sources feed this. A .docx gives paragraphs, the heading each sits under,
// and sometimes pages; a PDF gives pages. When both are at hand — `detect
// thesis.docx --pages thesis.pdf` — each paragraph is found in the PDF's text
// by a search that ignores everything a layout changes: spacing, line breaks,
// hyphenation at a line end, ligatures, punctuation.

import type { Location } from './report.ts'

/** A paragraph of the analysed text and what is known about where it sits. */
export interface LayoutParagraph {
  /** Offsets into the analysed text. */
  start: number
  end: number
  /** 1-based ordinal in the source document. */
  index: number
  section?: string
  page?: number
}

export interface PageText {
  page: number
  text: string
}

export interface Layout {
  paragraphs: readonly LayoutParagraph[]
  /** The printed pages, to place each paragraph on one. */
  pages?: readonly PageText[]
  /** The paragraphs' own pages are Word's layout, not a printed PDF's. */
  wordPages?: boolean
}

/** Letters and digits only, lowercase, ligatures and accents kept apart. */
export function searchable(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * A page's text without its folio: a paragraph that is only a page number,
 * first or last. Left in, it sits in the middle of every sentence that runs
 * across a page break, and the sentence is no longer found.
 */
export const withoutFolio = (text: string): string =>
  text.replace(/^\s*[\divxlc]{1,6}[^\S\n]*\n+/iu, '').replace(/\n+[^\S\n]*[\divxlc]{1,6}\s*$/iu, '')

/** A needle long enough to be unique, short enough to survive an extraction slip. */
const NEEDLE = 48
/** Shorter than this and a match says little about where the paragraph is. */
const MIN_NEEDLE = 16

interface PageIndex {
  haystack: string
  /** Start of each page in `haystack`, in page order. */
  starts: number[]
  numbers: number[]
}

function indexPages(pages: readonly PageText[]): PageIndex {
  let haystack = ''
  const starts: number[] = []
  const numbers: number[] = []
  for (const page of pages) {
    starts.push(haystack.length)
    numbers.push(page.page)
    haystack += searchable(withoutFolio(page.text))
  }
  return { haystack, starts, numbers }
}

function pageAt(index: PageIndex, at: number): number | undefined {
  let low = 0
  let high = index.starts.length - 1
  if (high < 0) return undefined
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if ((index.starts[mid] ?? 0) <= at) low = mid
    else high = mid - 1
  }
  return index.numbers[low]
}

/**
 * Each paragraph's position in the pages' text, or -1.
 *
 * Searched in order from where the previous one was found, so a phrase that
 * recurs — a cover page printed twice, a sentence repeated in the abstract
 * and the conclusion — lands on the right occurrence.
 */
function placeParagraphs(text: string, paragraphs: readonly LayoutParagraph[], pages: PageIndex) {
  const positions: number[] = []
  let cursor = 0
  for (const paragraph of paragraphs) {
    const flat = searchable(text.slice(paragraph.start, paragraph.end))
    if (flat.length < MIN_NEEDLE) {
      positions.push(-1)
      continue
    }
    const needle = flat.slice(0, NEEDLE)
    let found = pages.haystack.indexOf(needle, cursor)
    if (found === -1) found = pages.haystack.indexOf(needle)
    if (found === -1) {
      // A slip near the start: try the middle of the paragraph.
      const middle = flat.slice(Math.max(0, (flat.length >> 1) - NEEDLE / 2)).slice(0, NEEDLE)
      const at = middle.length >= MIN_NEEDLE ? pages.haystack.indexOf(middle, cursor) : -1
      found = at === -1 ? -1 : Math.max(0, at - (flat.length >> 1) + NEEDLE / 2)
    }
    positions.push(found)
    if (found !== -1) cursor = found
  }
  return positions
}

/** The section label as a reader cites it: "§2.6.3", or the heading itself. */
export function sectionLabel(section: string): string {
  const numbered = /^((?:\d+|[IVXLC]+)(?:\.\d+)*)\.?\s/u.exec(section)
  if (numbered?.[1]) return `§${numbered[1]}`
  return `“${section.length > 40 ? `${section.slice(0, 39)}…` : section}”`
}

/**
 * "p. 29, §2.6.3", "Word p. 12" when the page is Word's own, "¶14", or
 * undefined when nothing is known. `paragraph: true` always leads with the
 * paragraph number, so the two ends of a block are told in the same terms.
 */
export function describeLocation(
  location: Location | undefined,
  options: { paragraph?: boolean } = {},
): string | undefined {
  if (!location) return undefined
  const parts: string[] = []
  if (options.paragraph && location.paragraph !== undefined) parts.push(`¶${location.paragraph}`)
  if (location.page !== undefined)
    parts.push(`${location.wordPage ? 'Word p.' : 'p.'} ${location.page}`)
  if (location.section) parts.push(sectionLabel(location.section))
  if (parts.length === 0 && location.paragraph !== undefined) parts.push(`¶${location.paragraph}`)
  return parts.length > 0 ? parts.join(', ') : undefined
}

/**
 * A function from a range of the analysed text to its location.
 *
 * The paragraph and section come from the layout; the page from the layout
 * when it has one, otherwise from the pages' text — where a passage inside a
 * paragraph that spans two pages is placed on the right one of the two.
 */
export function locator(
  text: string,
  layout: Layout,
): (start: number, end?: number) => Location | undefined {
  const paragraphs = [...layout.paragraphs].sort((a, b) => a.start - b.start)
  const pages = layout.pages && layout.pages.length > 0 ? indexPages(layout.pages) : undefined
  const positions = pages ? placeParagraphs(text, paragraphs, pages) : []

  const containing = (offset: number): number => {
    let low = 0
    let high = paragraphs.length - 1
    let best = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if ((paragraphs[mid]?.start ?? 0) <= offset) {
        best = mid
        low = mid + 1
      } else high = mid - 1
    }
    return best
  }

  return (start: number, end = start) => {
    const at = containing(start)
    const paragraph = paragraphs[at]
    if (!paragraph || start > paragraph.end + 2) return undefined
    let page = paragraph.page
    let printed = false
    if (pages) {
      const base = positions[at] ?? -1
      if (base !== -1) {
        // The passage's own text, searched just past where its paragraph
        // starts; failing that, its distance into the paragraph.
        const passage = searchable(text.slice(start, Math.max(end, start + 1))).slice(0, NEEDLE)
        const into = searchable(text.slice(paragraph.start, start)).length
        const window = searchable(text.slice(paragraph.start, paragraph.end)).length + NEEDLE
        let found = -1
        if (passage.length >= MIN_NEEDLE / 2) {
          found = pages.haystack.indexOf(passage, base)
          if (found > base + window) found = -1
        }
        const at = pageAt(pages, found === -1 ? base + into : found)
        if (at !== undefined) {
          page = at
          printed = true
        }
      }
    }
    // A .docx's own page, when no printed page was found: say whose it is.
    const wordPage = page !== undefined && !printed && layout.wordPages === true
    return {
      paragraph: paragraph.index,
      ...(page === undefined ? {} : { page }),
      ...(wordPage ? { wordPage: true } : {}),
      ...(paragraph.section ? { section: paragraph.section } : {}),
    }
  }
}

/** A heading as a PDF prints it: "2.6.3 Mechanistic hypotheses", "3. Conclusion". */
const PRINTED_HEADING = /^(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+\p{Lu}[^.!?]{0,100}$/u
/** A short line in capitals or title case with no full stop: an unnumbered heading. */
const BARE_HEADING = /^\p{Lu}[^.!?:;,]{0,60}$/u
/** The heading of a reference list. */
const REFERENCES =
  /^(?:\d+\.?\s+)?(?:r[ée]f[ée]rences?(?: bibliographiques)?|references|bibliograph(?:y|ie)|works cited|literature cited)$/iu
/** A line of a table of contents: a title, dot leaders or a gap, a page number. */
const TOC_LINE = /(?:\.{3,}|…{2,}|\s{3,}|\t)\s*\d{1,4}\s*$/u
const TOC_TITLE = /^(?:table des mati[èe]res|sommaire|contents|table of contents)$/iu
/** Ends a paragraph: a full stop, a closing bracket or quote after one, a colon. */
const PARAGRAPH_END = /[.!?:;…»”"')\]]\s*$/u
/** A decimal cut at the page break: "9." then "8 %" on the next page. */
const CUT_DECIMAL = /\d[.,]$/u

/** The oath a medical thesis ends with: a fixed text, not the author's. */
const OATH = /^(?:serment(?: d['’]hippocrate)?|hippocratic oath|oath)$/iu
/** An entry of a numbered reference list: "12. Author AB…", "[12] Author…". */
const REFERENCE_ENTRY = /^(?:\[\d{1,3}\]|\d{1,3}[.)])\s+\S/u
/** A caption: "Figure 4.", "Tableau 2 –". */
const CAPTION =
  /^(?:figure|fig\.|tableau|table|graphique|chart|annexe|appendix)\s+[0-9IVX]+[a-z]?\s*[.:–—-]/iu

/**
 * The prose of a PDF's pages as one text, with each paragraph's page.
 *
 * A paragraph that is only a number is the page's folio and is dropped; a
 * short numbered line is taken as a heading, labels the paragraphs after it,
 * and is dropped too, like a short unpunctuated line in capitals. Captions
 * are dropped, and so is a numbered reference list after its heading, and a
 * thesis's oath. A paragraph cut by a page break stays two paragraphs: the PDF does not say
 * they are one.
 */
export function layoutFromPages(pages: readonly PageText[]): { text: string; layout: Layout } {
  const parts: string[] = []
  const paragraphs: LayoutParagraph[] = []
  let length = 0
  let index = 0
  let section: string | undefined
  let references = false
  let oath = false
  // The last paragraph kept, while nothing but a folio has come after it: the
  // one the first paragraph of the next page may continue.
  let open = false
  let firstOfPage = true
  for (const { page, text } of pages) {
    firstOfPage = true
    for (const block of text.split(/\n{2,}/u)) {
      const flat = block.replaceAll(/\s*\n\s*/gu, ' ').trim()
      if (!flat || /^[\d\s\-–—./ivxlc]+$/iu.test(flat)) continue
      // A paragraph cut by the page break: the previous page's last paragraph
      // has no end, or ends on a hyphen or a cut decimal, and this one goes on
      // in lower case or with the rest of the number.
      const previous = parts.at(-1)
      if (open && firstOfPage && previous !== undefined) {
        const hyphen = /\p{L}-$/u.test(previous) && /^\p{Ll}/u.test(flat)
        const decimal = CUT_DECIMAL.test(previous) && /^\d/u.test(flat)
        if (hyphen || decimal || (!PARAGRAPH_END.test(previous) && /^[\p{Ll}\d(]/u.test(flat))) {
          const joined = hyphen
            ? `${previous.slice(0, -1)}${flat}`
            : decimal
              ? `${previous}${flat}`
              : `${previous} ${flat}`
          parts[parts.length - 1] = joined
          length += joined.length - previous.length
          const last = paragraphs.at(-1)
          if (last) last.end = length
          firstOfPage = false
          continue
        }
      }
      firstOfPage = false
      open = false
      index += 1
      const lines = block.split(/\n/u).filter((line) => line.trim())
      if (
        TOC_TITLE.test(flat) ||
        (lines.length > 0 &&
          lines.filter((l) => TOC_LINE.test(l)).length * 2 >= lines.length &&
          lines.some((l) => TOC_LINE.test(l)))
      )
        continue
      if (REFERENCES.test(flat)) {
        references = true
        continue
      }
      if (references && REFERENCE_ENTRY.test(flat)) continue
      references = false
      const words = flat.split(/\s+/u).length
      if (PRINTED_HEADING.test(flat) && words <= 14) {
        section = flat
        oath = false
        continue
      }
      if (BARE_HEADING.test(flat) && words <= 6) {
        section = flat
        oath = OATH.test(flat)
        continue
      }
      if (oath || CAPTION.test(flat)) continue
      if (parts.length > 0) length += 2
      parts.push(flat)
      paragraphs.push({
        start: length,
        end: length + flat.length,
        index,
        page,
        ...(section ? { section } : {}),
      })
      length += flat.length
      open = true
    }
  }
  return { text: parts.join('\n\n'), layout: { paragraphs } }
}
