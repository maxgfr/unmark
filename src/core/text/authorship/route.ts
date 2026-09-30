// Which catalogue reads which sentence.
//
// The French and English catalogues are different lists of habits, and running
// the English one over French prose finds nothing, which the verdict would
// then read as "few signals". So language is decided per paragraph, and a
// paragraph too short to identify borrows the language of the document rather
// than being read in neither.
//
// A document mostly in a language with no catalogue gets no verdict at all.
// Scoring German prose with French and English habits and calling it human
// would be the detector answering a question it cannot read.

import { passageLanguages } from '../language.ts'
import type { Lang, Segmentation } from './segment.ts'

export type LangOption = Lang | 'auto'

export interface Routing {
  /** The language most of the prose is in, or `und` when none could be read. */
  document: Lang | 'und'
  /** Share of prose words in paragraphs confidently in another language. */
  unsupportedShare: number
  /** One entry per `Segmentation.blocks`, `undefined` for other languages. */
  paragraphs: (Lang | undefined)[]
}

const isSupported = (lang: string | undefined): lang is Lang => lang === 'fr' || lang === 'en'

/** Route every sentence of `seg` to a catalogue, in place, and say how. */
export function route(text: string, seg: Segmentation, option: LangOption = 'auto'): Routing {
  if (option !== 'auto') {
    for (const sentence of seg.sentences) sentence.lang = option
    return {
      document: option,
      unsupportedShare: 0,
      paragraphs: seg.blocks.map(() => option),
    }
  }

  const words = seg.blocks.map(() => 0)
  for (const sentence of seg.sentences) {
    words[sentence.paragraphIndex] = (words[sentence.paragraphIndex] ?? 0) + sentence.words
  }

  // Blocks with no kept sentence are not worth a detector call.
  const detected = passageLanguages(
    text,
    seg.blocks.filter((_, index) => (words[index] ?? 0) > 0),
  )
  const byStart = new Map(detected.map((passage) => [passage.start, passage.lang]))
  const found = seg.blocks.map((block) => byStart.get(block.start))

  const totals = new Map<string, number>()
  let total = 0
  found.forEach((lang, index) => {
    const count = words[index] ?? 0
    total += count
    if (lang) totals.set(lang, (totals.get(lang) ?? 0) + count)
  })

  let document: Lang | 'und' = 'und'
  const fr = totals.get('fr') ?? 0
  const en = totals.get('en') ?? 0
  if (fr > 0 || en > 0) document = fr >= en ? 'fr' : 'en'
  else if (total > 0) {
    // No passage was readable alone — a list of short lines. Read the whole
    // prose as one piece, the way `proseLanguages` does.
    const whole = passageLanguages(text, [
      { start: seg.blocks[0]?.start ?? 0, end: seg.blocks.at(-1)?.end ?? text.length },
    ])[0]?.lang
    if (isSupported(whole)) document = whole
    else if (whole) found.fill(whole)
  }

  let unsupported = 0
  const paragraphs = found.map((lang, index) => {
    if (lang === undefined) return document === 'und' ? undefined : document
    if (isSupported(lang)) return lang
    unsupported += words[index] ?? 0
    return undefined
  })

  for (const sentence of seg.sentences) {
    const lang = paragraphs[sentence.paragraphIndex]
    if (lang) sentence.lang = lang
    else delete sentence.lang
  }

  return {
    document,
    unsupportedShare: total === 0 ? 0 : unsupported / total,
    paragraphs,
  }
}
