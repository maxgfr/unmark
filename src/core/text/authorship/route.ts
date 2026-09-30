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

/** Up to this much prose, every paragraph is identified on its own. */
const PRECISE_UNTIL = 60_000
/** Past it, paragraphs are read in stretches of at least this many characters… */
const STRETCH = 1000
/** …of which this many are read. */
const STRETCH_SAMPLE = 400

/**
 * The detected language of every block, `undefined` where none was sure.
 *
 * Per paragraph on an ordinary document. On a long one, consecutive short
 * paragraphs are read together as a stretch, from its first few hundred
 * characters: identification costs time per character read, and reading all
 * of a book to route it cost more than everything else the detector does.
 * A paragraph long enough to be a stretch on its own is still read alone, so
 * a bilingual document keeps both languages; what is lost is a single short
 * paragraph in the other language, inside a long one.
 */
function detect(text: string, seg: Segmentation, words: readonly number[]): (string | undefined)[] {
  // Blocks with no kept sentence are not worth a detector call.
  const live = seg.blocks
    .map((block, index) => ({ ...block, index }))
    .filter((block) => (words[block.index] ?? 0) > 0)
  const prose = live.reduce((sum, block) => sum + block.end - block.start, 0)

  const found: (string | undefined)[] = seg.blocks.map(() => undefined)
  if (prose <= PRECISE_UNTIL) {
    const detected = passageLanguages(text, live)
    detected.forEach((passage, at) => {
      found[(live[at] as (typeof live)[number]).index] = passage.lang
    })
    return found
  }

  const stretches: { start: number; end: number; members: number[] }[] = []
  let current: { start: number; end: number; members: number[] } | undefined
  for (const block of live) {
    if (!current) current = { start: block.start, end: block.end, members: [] }
    current.end = block.end
    current.members.push(block.index)
    if (current.end - current.start >= STRETCH) {
      stretches.push(current)
      current = undefined
    }
  }
  if (current) stretches.push(current)

  const detected = passageLanguages(text, stretches, { sample: STRETCH_SAMPLE })
  detected.forEach((passage, at) => {
    for (const member of (stretches[at] as (typeof stretches)[number]).members)
      found[member] = passage.lang
  })
  return found
}

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

  const found = detect(text, seg, words)

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
