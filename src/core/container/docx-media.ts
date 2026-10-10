// Where each picture in a Word document sits, and what its caption calls it.
//
// The marks on an embedded picture are reported against its part name,
// `word/media/image24.png`, which is the one name the author never saw. Getting
// from there to "Figure 4" means following the relationship id from the
// package's `.rels` to the paragraph whose drawing points at it, then reading
// the paragraphs around it for a caption. Done by hand that took a reader the
// rels file, the document XML and a visual check; this is the same walk.

import type { Placement } from '../report.ts'
import { decodeUtf8, snippet } from './types.ts'
import type { ZipEntry } from './zip.ts'

const RELS = 'word/_rels/document.xml.rels'
const DOCUMENT = 'word/document.xml'

/** `rId7` → `word/media/image24.png`, for the relationships that point at a part. */
function relationships(xml: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = match[0]
    const id = /\bId="([^"]+)"/.exec(tag)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1]
    if (!id || !target || /\bTargetMode="External"/.test(tag)) continue
    // Targets are relative to `word/`, or absolute from the package root.
    out.set(id, target.startsWith('/') ? target.slice(1) : `word/${target.replace(/^\.\//, '')}`)
  }
  return out
}

interface Paragraph {
  text: string
  style: string
  embeds: string[]
  /** Word rendered a page break in it, or it forces one: it opens a new page. */
  breaks: boolean
}

const XML_ENTITY: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
}

const unescape = (text: string): string =>
  text.replaceAll(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    }
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
    return XML_ENTITY[name.toLowerCase()] ?? whole
  })

/**
 * Every paragraph of the body in document order, with its text and the
 * relationship ids its drawings use.
 *
 * A paragraph inside a text box sits inside another paragraph's drawing, so
 * the walk keeps a stack and gives text and pictures to the innermost one.
 */
function paragraphs(xml: string): Paragraph[] {
  const out: Paragraph[] = []
  const open: Paragraph[] = []
  const token =
    /<w:p(?=[\s>/])([^>]*?)(\/?)>|<\/w:p>|<w:pStyle\b[^>]*\bw:val="([^"]*)"|\br:(?:embed|id|link)="([^"]+)"|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|(<w:lastRenderedPageBreak\/>|<w:br\b[^>]*w:type="page"|<w:pageBreakBefore(?:\/>|\s))/g
  for (const match of xml.matchAll(token)) {
    const [whole, , selfClosing, style, rel, text, pageBreak] = match
    const current = open.at(-1)
    if (pageBreak !== undefined) {
      if (current) current.breaks = true
    } else if (whole.startsWith('<w:p') && !whole.startsWith('<w:pStyle')) {
      const paragraph: Paragraph = { text: '', style: '', embeds: [], breaks: false }
      out.push(paragraph)
      if (selfClosing !== '/') open.push(paragraph)
    } else if (whole === '</w:p>') {
      open.pop()
    } else if (!current) {
      continue
    } else if (style !== undefined) {
      current.style = style
    } else if (rel !== undefined) {
      current.embeds.push(rel)
    } else if (text !== undefined) {
      current.text += unescape(text)
    } else {
      current.text += ' '
    }
  }
  return out
}

/**
 * Caption styles in the languages Word ships, and the prefixes a caption opens
 * with. Style ids drop accents, so the French one is stored as `Lgende`.
 */
const CAPTION_STYLE = /caption|l[ée]?gende|beschriftung|didascalia|leyenda/i
const CAPTION_TEXT =
  /^\s*(?:fig(?:ure|\.)?|tableau|table|graphique|graph|sch[ée]ma|image|photo|illustration|chart|abb(?:ildung|\.)?)\s*\.?\s*(?:[0-9]+|[ivxlc]+)\b/i

const isCaption = (paragraph: Paragraph | undefined): boolean =>
  paragraph !== undefined &&
  paragraph.text.trim().length > 0 &&
  (CAPTION_STYLE.test(paragraph.style) || CAPTION_TEXT.test(paragraph.text))

/** The nearest caption on one side, stopping at another picture: its caption is its own. */
function captionToward(all: readonly Paragraph[], index: number, step: 1 | -1): number | undefined {
  // Empty paragraphs are spacing, not text between a picture and its caption,
  // so they are stepped over without counting against the distance.
  for (let at = index + step, seen = 0; seen < (step === 1 ? 3 : 2); at += step) {
    const candidate = all[at]
    if (!candidate || candidate.embeds.length > 0) return undefined
    if (isCaption(candidate)) return at
    if (candidate.text.trim().length > 0) seen += 1
  }
  return undefined
}

type Side = 'above' | 'below'

/**
 * Which side this document puts its captions on, from the pictures that have
 * a caption on one side only. Word inserts them below by default, so a tie or
 * no evidence at all says below.
 */
function captionSide(all: readonly Paragraph[], pictures: readonly number[]): Side {
  let above = 0
  let below = 0
  for (const index of pictures) {
    const up = captionToward(all, index, -1) !== undefined
    const down = captionToward(all, index, 1) !== undefined
    if (up && !down) above += 1
    if (down && !up) below += 1
  }
  return above > below ? 'above' : 'below'
}

interface Candidates {
  index: number
  up: number | undefined
  down: number | undefined
}

/**
 * Which neighbour a picture's caption is.
 *
 * Its own paragraph first. Otherwise the nearest caption above and below, and
 * when there is one on each side — figures stacked one after another, each
 * with its caption, read the same whichever way they are captioned — the one
 * on the picture's own page wins: Word records where it last broke the pages,
 * and a caption separated from its picture by a page break is the next
 * figure's. Only then does the document's own habit decide.
 */
function preferred(
  candidate: Candidates,
  pages: readonly number[],
  side: Side,
): { first?: number | undefined; second?: number | undefined } {
  const { index, up, down } = candidate
  if (up === undefined || down === undefined) return { first: up ?? down }
  const upSame = pages[up] === pages[index]
  const downSame = pages[down] === pages[index]
  const upFirst = upSame === downSame ? side === 'above' : upSame
  return upFirst ? { first: up, second: down } : { first: down, second: up }
}

/**
 * A caption for each picture, no caption shared by two.
 *
 * "Figure 4" between two pictures is one of theirs, not both. The picture that
 * prefers it most strongly — on its own page, on the document's caption side —
 * keeps it, and the other falls back to its second choice when that is free.
 */
function assignCaptions(
  all: readonly Paragraph[],
  pages: readonly number[],
  pictures: readonly number[],
  side: Side,
): Map<number, number> {
  const choices = pictures.map((index) => {
    if (isCaption(all[index])) return { index, first: index }
    return {
      index,
      ...preferred(
        { index, up: captionToward(all, index, -1), down: captionToward(all, index, 1) },
        pages,
        side,
      ),
    }
  })
  const strength = (picture: number, caption: number) =>
    caption === picture
      ? 3
      : (pages[caption] === pages[picture] ? 1 : 0) +
        ((caption < picture ? 'above' : 'below') === side ? 1 : 0)

  const owner = new Map<number, number>()
  for (const choice of choices) {
    const caption = choice.first
    if (caption === undefined) continue
    const held = owner.get(caption)
    if (held === undefined || strength(choice.index, caption) > strength(held, caption)) {
      owner.set(caption, choice.index)
    }
  }
  const assigned = new Map<number, number>()
  for (const [caption, picture] of owner) assigned.set(picture, caption)
  for (const choice of choices) {
    if (assigned.has(choice.index) || choice.second === undefined) continue
    if (!owner.has(choice.second)) {
      owner.set(choice.second, choice.index)
      assigned.set(choice.index, choice.second)
    }
  }
  return assigned
}

/**
 * Where every picture referenced by a Word body sits.
 *
 * Keyed by part name. A picture used twice keeps its first placement. Parts a
 * header, footer or comment uses are not in the body and come back absent,
 * which the caller reports as "not in the body" rather than inventing a place.
 */
export function placeMedia(entries: readonly ZipEntry[]): Map<string, Placement> {
  const placements = new Map<string, Placement>()
  const rels = entries.find((entry) => entry.name === RELS)
  const document = entries.find((entry) => entry.name === DOCUMENT)
  if (!rels || !document) return placements

  const targets = relationships(decodeUtf8(rels.data))
  const all = paragraphs(decodeUtf8(document.data))
  const pages: number[] = []
  let page = 1
  for (const paragraph of all) {
    if (paragraph.breaks) page += 1
    pages.push(page)
  }
  const pictures = all.flatMap((paragraph, index) =>
    paragraph.embeds.some((id) => targets.get(id)?.startsWith('word/media/')) ? [index] : [],
  )
  const captions = assignCaptions(all, pages, pictures, captionSide(all, pictures))

  for (const index of pictures) {
    const paragraph = all[index] as Paragraph
    for (const id of paragraph.embeds) {
      const part = targets.get(id)
      if (!part || placements.has(part)) continue
      const at = captions.get(index)
      const caption = at === undefined ? undefined : snippet((all[at] as Paragraph).text, 100)
      placements.set(part, { paragraph: index + 1, ...(caption ? { caption } : {}) })
    }
  }
  return placements
}
