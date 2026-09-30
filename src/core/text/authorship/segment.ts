// Sentences, with the coordinates a reader needs to find them.
//
// The authorship report is read next to the document, so every passage it
// names has to come with a line and a column, and has to be a sentence the
// reader recognises — not a fragment cut at "M." or at the decimal point of
// "3.5". French adds its own traps: a no-break space before "!" and a closing
// guillemet after it, so « Non ! » dit-il is one sentence, not two.
//
// Only prose is segmented. Code, blockquotes and quotations come from
// `protectedMask`, the same seal every style pass respects: quoting a sentence
// is not writing it, and a report that scored someone's quotation of a chatbot
// as their own chatbot prose would be accusing them of the quote.

import { blocksOf, protectedMask } from '../regions.ts'
import { lineIndex, type LineIndex } from '../lines.ts'

export type Lang = 'fr' | 'en'

export interface Sentence {
  /** UTF-16 offsets into the original text, trimmed of surrounding space. */
  start: number
  end: number
  /** 1-based line and code-point column of `start`, and the line of `end`. */
  line: number
  col: number
  endLine: number
  /** Words of unsealed prose. Quoted and code words do not count. */
  words: number
  /** Which prose block this sentence belongs to. A list item is its own block. */
  paragraphIndex: number
  /** Set by routing. Absent until then, and on passages in no supported language. */
  lang?: Lang
}

export interface Segmentation {
  sentences: Sentence[]
  /** Unsealed prose words across all kept sentences. */
  words: number
  /** Every prose block, kept sentences or not, indexed by `paragraphIndex`. */
  blocks: { start: number; end: number }[]
  mask: Uint8Array
  index: LineIndex
}

export interface Token {
  start: number
  end: number
  /** Lowercase, with the typographic apostrophe folded to ASCII. */
  norm: string
}

/**
 * A pattern that matches `source` only as a whole word, in any script.
 *
 * `\b` is ASCII-only in JavaScript: it sees a boundary inside "été" and none
 * before "É". Lookarounds on `\p{L}\p{N}` are the Unicode-aware equivalent,
 * and every catalogue pattern goes through this so none of them forgets.
 */
export function word(source: string): RegExp {
  // A match that ends on an elided article ("d'", "l'") ends inside a word on
  // purpose: the apostrophe is the boundary.
  return new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${source})(?:(?<=['’])|(?![\p{L}\p{N}]))`, 'giu')
}

const TOKEN = /\p{L}[\p{L}\p{M}'’-]*/gu

/** French elided words that lean on the next one: l'école is two words. */
const CLITIC = /^(?:l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu|quoiqu)['’](?=\p{L})/iu

const norm = (raw: string) => raw.toLowerCase().replaceAll('’', "'")

/** The words between `start` and `end`, French clitics split off. */
export function tokens(text: string, start = 0, end = text.length): Token[] {
  const out: Token[] = []
  const pattern = new RegExp(TOKEN.source, 'gu')
  pattern.lastIndex = start
  for (let match = pattern.exec(text); match && match.index < end; match = pattern.exec(text)) {
    let at = match.index
    let raw = match[0].replace(/['’-]+$/u, '')
    if (at + raw.length > end) raw = raw.slice(0, end - at)
    const clitic = CLITIC.exec(raw)
    if (clitic) {
      const lean = clitic[0].length
      out.push({ start: at, end: at + lean - 1, norm: norm(raw.slice(0, lean - 1)) })
      at += lean
      raw = raw.slice(lean)
    }
    if (raw.length > 0) out.push({ start: at, end: at + raw.length, norm: norm(raw) })
  }
  return out
}

/**
 * Tokens that end in a full stop and do not end a sentence.
 *
 * Lowercased, dots included. A sentence that genuinely ends on "etc." merges
 * with the next one; that costs one longer passage in a report, where cutting
 * at every "etc." would cost a sentence split in the wrong place every time.
 */
const ABBREVIATIONS = new Set([
  // French
  'm.',
  'mm.',
  'mme.',
  'mmes.',
  'mlle.',
  'mlles.',
  'me.',
  'mgr.',
  'dr.',
  'pr.',
  'st.',
  'ste.',
  'p.',
  'pp.',
  'ex.',
  'cf.',
  'etc.',
  'c.-à-d.',
  'c-à-d.',
  'art.',
  'al.',
  'vol.',
  'éd.',
  'chap.',
  'env.',
  'av.',
  'apr.',
  'j.-c.',
  'fig.',
  'hab.',
  'min.',
  'max.',
  'sq.',
  'op.',
  'cit.',
  'ibid.',
  'n.',
  'no.',
  'nos.',
  // English
  'mr.',
  'mrs.',
  'ms.',
  'prof.',
  'sr.',
  'jr.',
  'vs.',
  'e.g.',
  'i.e.',
  'u.s.',
  'u.k.',
  'inc.',
  'ltd.',
  'co.',
  'corp.',
  'approx.',
  'dept.',
  'est.',
  'a.m.',
  'p.m.',
  'jan.',
  'feb.',
  'mar.',
  'apr.',
  'jun.',
  'jul.',
  'aug.',
  'sep.',
  'sept.',
  'oct.',
  'nov.',
  'dec.',
])

const TERMINATOR = /[.!?…]+/gu
/** Closing quotes and brackets that belong to the sentence they end. */
const CLOSER = /^(?:[\s  ]?[»”"’')\]]){1,3}/u
const LIST_MARKER = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/u
/** A sealed share above this and the sentence is someone else's words, or code. */
const MAX_SEALED = 0.5

function isAbbreviation(text: string, dot: number): boolean {
  const before = text.slice(Math.max(0, dot - 15), dot + 1)
  const token = /(?:^|[^\p{L}.-])([\p{L}.-]+\.)$/u.exec(before)?.[1]
  if (!token) return false
  if (ABBREVIATIONS.has(token.toLowerCase())) return true
  // An initial: "J. K. Rowling". A capital alone before a dot is almost never
  // the end of a sentence.
  return /^\p{Lu}\.$/u.test(token)
}

/** The offsets where sentences end inside `[start, end)`. */
function boundaries(text: string, start: number, end: number): number[] {
  const cuts: number[] = []
  const pattern = new RegExp(TERMINATOR.source, 'gu')
  pattern.lastIndex = start
  for (let match = pattern.exec(text); match && match.index < end; match = pattern.exec(text)) {
    let stop = match.index + match[0].length
    if (stop > end) break
    const closer = CLOSER.exec(text.slice(stop, Math.min(end, stop + 8)))
    if (closer) stop += closer[0].length

    if (stop >= end) {
      cuts.push(end)
      break
    }
    // A sentence ends before whitespace, and the next one does not open in
    // lower case: « Non ! » dit-il continues, "Non ! Il part." does not.
    if (!/\s/u.test(text[stop] ?? '')) continue
    const next = /\S/u.exec(text.slice(stop, Math.min(end, stop + 12)))?.[0] ?? ''
    if (/\p{Ll}/u.test(next)) continue
    if (match[0] === '.' && isAbbreviation(text, match.index)) continue
    cuts.push(stop)
  }
  return cuts
}

function sealedShare(mask: Uint8Array, start: number, end: number): number {
  let sealed = 0
  for (let at = start; at < end; at += 1) sealed += mask[at] ?? 0
  return end > start ? sealed / (end - start) : 1
}

/**
 * Split `text` into sentences of unsealed prose.
 *
 * Paragraphs and list items only: a heading is a label, not a sentence, and a
 * table is data. Sentences keep their place in the document even when a
 * mostly-quoted one is dropped, so every offset still addresses the input.
 */
export function segment(
  text: string,
  mask = protectedMask(text),
  index: LineIndex = lineIndex(text),
): Segmentation {
  const sentences: Sentence[] = []
  let words = 0
  const blocks: { start: number; end: number }[] = []

  for (const block of blocksOf(text)) {
    if (block.kind !== 'paragraph' && block.kind !== 'list_item') continue
    const paragraphIndex = blocks.length
    blocks.push({ start: block.start, end: block.end })

    let from = block.start
    if (block.kind === 'list_item') {
      from += LIST_MARKER.exec(text.slice(block.start, block.end))?.[0].length ?? 0
    }

    for (const cut of [...boundaries(text, from, block.end), block.end]) {
      let start = from
      let end = cut
      from = cut
      while (start < end && /\s/u.test(text[start] ?? '')) start += 1
      while (end > start && /\s/u.test(text[end - 1] ?? '')) end -= 1
      if (end <= start) continue
      if (sealedShare(mask, start, end) > MAX_SEALED) continue

      const count = tokens(text, start, end).filter((token) => mask[token.start] !== 1).length
      if (count === 0) continue

      const at = index.locate(start)
      sentences.push({
        start,
        end,
        line: at.line,
        col: at.col,
        endLine: index.locate(end).line,
        words: count,
        paragraphIndex,
      })
      words += count
    }
  }

  return { sentences, words, blocks, mask, index }
}
